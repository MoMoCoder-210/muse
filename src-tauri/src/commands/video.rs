// 视频编辑 — 将片段选中分镜视频拼接为完整视频（ffmpeg concat）

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;

use serde::Deserialize;
use serde::Serialize;
use tauri::Emitter;

use crate::app_paths;
use crate::commands::util;

/// 可拼接的分镜视频片段（前端展示用，按 seq_num 排序）
#[derive(Debug, Serialize)]
pub struct ConcatSegment {
    pub seq: i32,
    pub clip_title: String,
    pub storyboard_id: String,
    pub file_path: String,
    pub file_name: String,
    pub duration: Option<f64>,
}

/// 查询指定片段「已选中分镜视频」的有序列表（按 seq_num 升序）
#[tauri::command]
pub fn list_clip_concat_videos(
    clip_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<ConcatSegment>, String> {
    let conn = util::open_app_conn(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT sb.seq_num, c.title, sb.id, sv.file_path, sv.file_name, sv.duration
             FROM storyboards sb
             JOIN clips c ON c.id = sb.clip_id
             LEFT JOIN storyboard_videos sv ON sv.id = sb.selected_video_id
             WHERE sb.clip_id = ?1 AND sb.selected_video_id IS NOT NULL
             ORDER BY sb.seq_num ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(rusqlite::params![&clip_id], |row| {
            Ok(ConcatSegment {
                seq: row.get(0)?,
                clip_title: row.get::<_, String>(1).unwrap_or_default(),
                storyboard_id: row.get(2)?,
                file_path: row.get::<_, String>(3)?,
                file_name: row.get::<_, String>(4).unwrap_or_default(),
                duration: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 拼接输入：前端传递「有序、已启用」的片段文件路径
#[derive(Debug, Deserialize)]
pub struct ConcatClipsInput {
    pub clip_id: String,
    /// 有序的视频文件路径（即最终拼接顺序）
    pub segments: Vec<String>,
    /// 目标高度（px）；为 0 时采用首个片段的原生分辨率（视频默认）
    #[serde(default = "default_height")]
    pub height: u32,
    /// 目标宽高比，如 "16:9"；为空时采用首个片段的原生比例（视频默认）
    #[serde(default = "default_aspect")]
    pub aspect_ratio: String,
    /// 输出文件名（不含扩展名），默认 final
    pub output_name: Option<String>,
}

fn default_height() -> u32 {
    0
}
fn default_aspect() -> String {
    String::new()
}

/// 拼接结果
#[derive(Debug, Serialize)]
pub struct ConcatResult {
    pub output_path: String,
    pub file_name: String,
    pub duration: f64,
    pub segment_count: usize,
    pub audio_included: bool,
}

/// 进度事件载荷（通过 Tauri event 推送到前端）
#[derive(Debug, Serialize, Clone)]
struct ConcatProgressPayload {
    percent: f64,
    stage: String,
}

/// ffprobe 探测结果
struct ProbeInfo {
    duration: f64,
    has_audio: bool,
    width: u32,
    height: u32,
}

/// 用 ffprobe 读取单个文件的时长、是否含音轨与原生分辨率
fn probe_file(ffprobe: &Path, path: &str) -> Result<ProbeInfo, String> {
    let out = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-show_entries",
            "stream=codec_type,width,height",
            "-of",
            "json",
            path,
        ])
        .output()
        .map_err(|e| format!("执行 ffprobe 失败：{}", e))?;

    if !out.status.success() {
        return Err(format!(
            "ffprobe 解析失败：{}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe 输出解析失败：{}", e))?;

    let duration: f64 = v
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let streams = v.get("streams").and_then(|s| s.as_array());

    let has_audio = streams
        .map(|arr| {
            arr.iter()
                .any(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("audio"))
        })
        .unwrap_or(false);

    // 取首个视频流的原始宽高
    let (mut width, mut height) = (0u32, 0u32);
    if let Some(arr) = streams {
        for s in arr {
            if s.get("codec_type").and_then(|c| c.as_str()) == Some("video") {
                width = s
                    .get("width")
                    .and_then(|w| w.as_u64())
                    .map(|w| w as u32)
                    .unwrap_or(0);
                height = s
                    .get("height")
                    .and_then(|h| h.as_u64())
                    .map(|h| h as u32)
                    .unwrap_or(0);
                break;
            }
        }
    }

    Ok(ProbeInfo {
        duration,
        has_audio,
        width,
        height,
    })
}

/// 解析 "W:H" 宽高比
fn parse_aspect(s: &str) -> Result<(u32, u32), String> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 {
        return Err(format!("无效的宽高比：{}", s));
    }
    let w = parts[0]
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("无效的宽高比宽度：{}", s))?;
    let h = parts[1]
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("无效的宽高比高度：{}", s))?;
    if w == 0 || h == 0 {
        return Err(format!("宽高比不能为 0：{}", s));
    }
    Ok((w, h))
}

/// 从 ffmpeg 状态行解析当前处理时间（秒）
fn parse_time(line: &str) -> Option<f64> {
    let idx = line.find("time=")?;
    let rest = &line[idx + 5..];
    let token = rest.split_whitespace().next()?;
    let parts: Vec<&str> = token.split(':').collect();
    let secs = if parts.len() == 3 {
        let h: f64 = parts[0].parse().ok()?;
        let m: f64 = parts[1].parse().ok()?;
        let s: f64 = parts[2].parse().ok()?;
        h * 3600.0 + m * 60.0 + s
    } else if parts.len() == 1 {
        parts[0].parse().ok()?
    } else {
        return None;
    };
    Some(secs)
}

/// 清洗输出文件名（保留字母数字、下划线、连字符、点）
fn sanitize_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed: &str = s.trim_matches('_');
    if trimmed.is_empty() {
        "final".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 将片段选中视频拼接为完整视频（ffmpeg filter_complex concat，统一缩放+黑边填充）
#[tauri::command]
pub fn concat_clip_videos(
    input: ConcatClipsInput,
    app: tauri::AppHandle,
) -> Result<ConcatResult, String> {
    if input.segments.is_empty() {
        return Err("没有可拼接的视频片段".to_string());
    }

    let ffmpeg =
        app_paths::ffmpeg_path(&app).ok_or_else(|| "未找到 ffmpeg，无法拼接".to_string())?;
    let ffprobe = app_paths::ffprobe_path(&app);

    // 校验文件存在 + 逐段探测：时长、是否含音轨、原生分辨率
    let mut total_duration = 0.0_f64;
    let mut seg_audio: Vec<bool> = Vec::with_capacity(input.segments.len());
    let mut seg_durations: Vec<f64> = Vec::with_capacity(input.segments.len());
    let mut native_w = 0u32;
    let mut native_h = 0u32;
    for (idx, p) in input.segments.iter().enumerate() {
        if !Path::new(p).exists() {
            return Err(format!("视频文件不存在：{}", p));
        }
        let mut has_audio = false;
        let mut dur = 0.0_f64;
        match &ffprobe {
            Some(fp) => match probe_file(fp, p) {
                Ok(info) => {
                    total_duration += info.duration;
                    dur = info.duration;
                    has_audio = info.has_audio;
                    if idx == 0 {
                        native_w = info.width;
                        native_h = info.height;
                    }
                }
                Err(e) => {
                    // 探测失败不致命，仅视为无音轨；原生分辨率回退到最小有效值
                    let _ = e;
                }
            },
            None => {
                // 无 ffprobe：视为无音轨，分辨率走默认回退
            }
        }
        // 记录每段时长（供无音轨时生成静音使用）
        seg_durations.push(dur);
        seg_audio.push(has_audio);
    }

    let any_audio = seg_audio.iter().any(|&b| b);

    // 目标画布：若未明确指定高度/比例，则采用首个片段的原生分辨率（视频默认）
    let (w, h) = if input.height == 0 || input.aspect_ratio.trim().is_empty() {
        let mut w = native_w.max(2);
        let mut h = native_h.max(2);
        if w % 2 != 0 {
            w += 1;
        }
        if h % 2 != 0 {
            h += 1;
        }
        (w, h)
    } else {
        let (aw, ah) = parse_aspect(&input.aspect_ratio)?;
        let h = input.height.max(2);
        let mut w = ((h as f64) * (aw as f64) / (ah as f64)).round() as u32;
        if w % 2 != 0 {
            w += 1;
        }
        let h = if h % 2 == 0 { h } else { h - 1 };
        (w, h)
    };

    // 构建 filter_complex：逐段缩放+黑边填充，并统一音频（无音轨段用静音填充），
    // 保证每段都恰好「1 路视频 + 1 路音频」，避免 concat 因流数量不一致报 Invalid argument(-22)。
    let n = input.segments.len();
    let mut filter = String::new();
    for i in 0..n {
        // 视频：缩放 + 黑边填充至统一画布
        filter.push_str(&format!(
            "[{}:v]scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v{}];",
            i, w, h, w, h, i
        ));
        // 音频：统一采样率/声道，无音轨段用等时长静音填充
        if seg_audio[i] {
            filter.push_str(&format!(
                "[{}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a{}];",
                i, i
            ));
        } else if any_audio {
            let d = seg_durations[i].max(0.1);
            filter.push_str(&format!("anullsrc=r=48000:cl=stereo:d={:.3}[a{}];", d, i));
        }
    }
    let mut concat = String::new();
    for i in 0..n {
        concat.push_str(&format!("[v{}]", i));
        if any_audio {
            concat.push_str(&format!("[a{}]", i));
        }
    }
    if any_audio {
        concat.push_str(&format!("concat=n={}:v=1:a=1[outv][outa]", n));
    } else {
        concat.push_str(&format!("concat=n={}:v=1:a=0[outv]", n));
    }
    filter.push_str(&concat);

    // 输出路径：<workspace>/output/<name>.mp4
    let conn = util::open_app_conn(&app)?;
    let (project_id, _clip_title): (String, String) = conn
        .query_row(
            "SELECT c.project_id, c.title FROM clips c WHERE c.id = ?1",
            rusqlite::params![&input.clip_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1).unwrap_or_default(),
                ))
            },
        )
        .map_err(|e| format!("片段不存在：{}", e))?;

    let workspace = util::get_project_workspace_path(&app, &project_id)?;
    let out_dir = Path::new(&workspace).join("output");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建输出目录失败：{}", e))?;

    let base = input
        .output_name
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "final".to_string());
    let safe = sanitize_name(&base);
    let out_path = out_dir.join(format!("{}.mp4", safe));
    let out_str = out_path.to_string_lossy().to_string();

    // 组装 ffmpeg 命令
    let mut cmd = Command::new(&ffmpeg);
    cmd.arg("-y");
    for p in &input.segments {
        cmd.arg("-i").arg(p);
    }
    cmd.arg("-filter_complex").arg(&filter);
    cmd.arg("-map").arg("[outv]");
    if any_audio {
        cmd.arg("-map").arg("[outa]");
        cmd.args(["-c:a", "aac", "-b:a", "192k"]);
    } else {
        cmd.arg("-an");
    }
    cmd.args([
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
    ]);
    cmd.arg(&out_str);
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 ffmpeg 失败：{}", e))?;

    // 进度线程：解析 stderr 的 time= 行并推送进度事件；同时缓存 stderr 以便失败时回显
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法获取 ffmpeg 输出".to_string())?;
    let log: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log_for_thread = log.clone();
    let progress_app = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            if let Ok(mut v) = log_for_thread.lock() {
                if v.len() >= 200 {
                    v.remove(0);
                }
                v.push(line.clone());
            }
            if let Some(t) = parse_time(&line) {
                let pct = if total_duration > 0.0 {
                    (t / total_duration * 100.0).min(99.0)
                } else {
                    0.0
                };
                let _ = progress_app.emit(
                    "concat-progress",
                    ConcatProgressPayload {
                        percent: pct,
                        stage: "processing".to_string(),
                    },
                );
            }
        }
    });

    let _ = app.emit(
        "concat-progress",
        ConcatProgressPayload {
            percent: 0.0,
            stage: "processing".to_string(),
        },
    );

    let status = child
        .wait()
        .map_err(|e| format!("等待 ffmpeg 结束失败：{}", e))?;
    if !status.success() {
        // 详细错误写入日志文件，与 lib.rs 使用相同的路径解析方式
        let captured = log.lock().map(|v| v.join("\n")).unwrap_or_default();
        let detail = if captured.trim().is_empty() {
            "(ffmpeg 无输出)".to_string()
        } else {
            captured.trim().to_string()
        };

        if let Ok(app_data_dir) = crate::app_paths::resolve_app_data_dir(&app) {
            let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
            crate::project_log::append_log(
                &log_path,
                "视频拼接",
                "ERROR",
                &format!(
                    "ffmpeg 拼接失败（退出码 {:?}）：\n{}",
                    status.code(),
                    detail
                ),
            );
        }

        return Err("视频拼接失败".to_string());
    }

    let _ = app.emit(
        "concat-progress",
        ConcatProgressPayload {
            percent: 100.0,
            stage: "done".to_string(),
        },
    );

    {
        if let Ok(app_data_dir) = crate::app_paths::resolve_app_data_dir(&app) {
            let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
            crate::project_log::append_log(
                &log_path,
                "视频拼接",
                "INFO",
                &format!(
                    "拼接成功 clipId={} 片段数={} 时长={:.1}s 音频={}",
                    input.clip_id, n, total_duration, any_audio
                ),
            );
        }
    }

    Ok(ConcatResult {
        output_path: out_str,
        file_name: format!("{}.mp4", safe),
        duration: total_duration,
        segment_count: n,
        audio_included: any_audio,
    })
}

/// 在系统文件管理器中打开文件所在文件夹（并选中该文件）。
///
/// - Windows: explorer.exe /select,"<path>"（已验证：正确打开所在文件夹并选中文件）
/// - macOS:   open -R "<path>"
/// - Linux:   xdg-open "<dir>"（多数桌面环境无法选中文件，仅打开目录）
#[tauri::command]
pub fn open_in_folder(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{}", path));
    }

    #[cfg(target_os = "windows")]
    {
        // 规范化绝对路径：正斜杠 → 反斜杠，去掉 canonicalize 引入的 \\?\ 长路径前缀
        let norm = p
            .canonicalize()
            .map(|cp| {
                let s = cp.to_string_lossy().to_string();
                s.strip_prefix("\\\\?\\").unwrap_or(&s).replace('/', "\\")
            })
            .unwrap_or_else(|_| path.replace('/', "\\"));
        // 用 /select, + 路径 两个参数形式调用，可正确处理含空格的路径
        Command::new("explorer.exe")
            .arg("/select,")
            .arg(&norm)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开文件夹失败：{}", e))
    }

    #[cfg(target_os = "macos")]
    {
        // 解析为规范化绝对路径（正斜杠 → 反斜杠）
        let norm = p
            .canonicalize()
            .map(|cp| cp.to_string_lossy().replace('/', "\\"))
            .unwrap_or_else(|_| path.clone());
        Command::new("open")
            .arg("-R")
            .arg(&norm)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开文件夹失败：{}", e))
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let parent_dir = p
            .parent()
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        Command::new("xdg-open")
            .arg(&parent_dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开文件夹失败：{}", e))
    }
}

// ── 成片持久化 ──────────────────────────────────────────────

/// 拼接成功后写入 concat_outputs 表
#[derive(Debug, Deserialize)]
pub struct SaveConcatOutputInput {
    pub clip_id: String,
    pub output_path: String,
    pub file_name: String,
    pub duration: f64,
    pub segment_count: usize,
    pub audio_included: bool,
}

#[tauri::command]
pub fn save_concat_output(
    input: SaveConcatOutputInput,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let conn = util::open_app_conn(&app)?;
    let (project_id,): (String,) = conn
        .query_row(
            "SELECT project_id FROM clips WHERE id = ?1",
            rusqlite::params![&input.clip_id],
            |row| Ok((row.get(0)?,)),
        )
        .map_err(|e| format!("查询片段失败：{}", e))?;

    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO concat_outputs (id, project_id, clip_id, output_path, file_name, duration, segment_count, audio_included)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            &id,
            &project_id,
            &input.clip_id,
            &input.output_path,
            &input.file_name,
            input.duration,
            input.segment_count as i64,
            input.audio_included as i64,
        ],
    )
    .map_err(|e| format!("保存拼接记录失败：{}", e))?;

    // 日志为尽力型操作，失败不应影响主流程
    if let Ok(app_data_dir) = crate::app_paths::resolve_app_data_dir(&app) {
        let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
        crate::project_log::append_log(
            &log_path,
            "视频拼接",
            "INFO",
            &format!(
                "已保存成片记录 id={} clipId={} 时长={:.1}s 片段数={}",
                id, input.clip_id, input.duration, input.segment_count
            ),
        );
    }

    Ok(id)
}

/// 删除一条拼接成片（数据库记录，可选同时删除磁盘文件）
#[derive(Debug, Deserialize)]
pub struct DeleteConcatOutputInput {
    pub id: String,
    #[serde(default = "default_delete_concat_file")]
    pub delete_file: bool,
}

fn default_delete_concat_file() -> bool {
    true
}

#[tauri::command]
pub fn delete_concat_output(
    input: DeleteConcatOutputInput,
    app: tauri::AppHandle,
) -> Result<crate::commands::clip::DeleteClipsResult, String> {
    let conn = util::open_app_conn(&app)?;

    // 在删记录前读取所属项目工作区；提交后仅清理该工作区内的输出文件。
    let file_candidate = if input.delete_file {
        let (file_path, workspace_path): (String, String) = conn
            .query_row(
                "SELECT co.output_path, p.workspace_path
                 FROM concat_outputs co
                 JOIN projects p ON p.id = co.project_id
                 WHERE co.id = ?1",
                rusqlite::params![&input.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "成片记录不存在".to_string())?;
        Some(crate::commands::clip::ClipFileCandidate {
            workspace_path: std::path::PathBuf::from(workspace_path),
            file_path: std::path::PathBuf::from(file_path),
        })
    } else {
        None
    };

    let affected = conn
        .execute(
            "DELETE FROM concat_outputs WHERE id = ?1",
            rusqlite::params![&input.id],
        )
        .map_err(|e| e.to_string())?;
    if affected != 1 {
        return Err("成片记录不存在".to_string());
    }

    let result = match file_candidate {
        Some(candidate) => crate::commands::clip::delete_managed_files(vec![candidate]),
        None => crate::commands::clip::DeleteClipsResult {
            deleted_file_count: 0,
            skipped_file_count: 0,
            failed_file_count: 0,
        },
    };

    if let Ok(app_data_dir) = crate::app_paths::resolve_app_data_dir(&app) {
        let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
        crate::project_log::append_log(
            &log_path,
            "视频拼接",
            if result.failed_file_count > 0 {
                "WARN"
            } else {
                "INFO"
            },
            &format!(
                "已删除成片记录 id={} deleteFile={}；本地文件已删除 {}，失败 {}",
                input.id, input.delete_file, result.deleted_file_count, result.failed_file_count,
            ),
        );
    }

    Ok(result)
}

/// 查询指定片段的所有拼接成片
#[derive(Debug, Serialize)]
pub struct ConcatOutputRow {
    pub id: String,
    pub output_path: String,
    pub file_name: String,
    pub duration: f64,
    pub segment_count: usize,
    pub audio_included: bool,
    pub created_at: String,
}

#[tauri::command]
pub fn list_concat_outputs(
    clip_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<ConcatOutputRow>, String> {
    let conn = util::open_app_conn(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, output_path, file_name, duration, segment_count, audio_included, created_at
             FROM concat_outputs WHERE clip_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![&clip_id], |row| {
            Ok(ConcatOutputRow {
                id: row.get(0)?,
                output_path: row.get(1)?,
                file_name: row.get(2)?,
                duration: row.get(3)?,
                segment_count: row.get::<_, i64>(4)? as usize,
                audio_included: row.get::<_, i64>(5)? != 0,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}
