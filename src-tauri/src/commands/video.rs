// 视频编辑 — 将分集选中镜头视频拼接为完整视频（ffmpeg concat）

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::Deserialize;
use serde::Serialize;
use tauri::Emitter;

use crate::app_paths;
use crate::commands::util;

// 超分任务管理与取消见 upscale_manager 模块（单一事实来源）。
// 历史命令/状态已迁移：upscale_storyboard_video → upscale_manager::enqueue_upscale，
// cancel_upscale → upscale_manager::cancel_upscale_job。

/// 可拼接的镜头视频分集（前端展示用，按 seq_num 排序）
#[derive(Debug, Serialize)]
pub struct ConcatSegment {
    pub seq: i32,
    pub clip_title: String,
    pub storyboard_id: String,
    pub file_path: String,
    pub file_name: String,
    pub duration: Option<f64>,
}

/// 查询指定分集「已选中镜头视频」的有序列表（按 seq_num 升序）
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

/// 拼接输入：前端传递「有序、已启用」的分集文件路径
#[derive(Debug, Deserialize)]
pub struct ConcatClipsInput {
    pub clip_id: String,
    /// 有序的视频文件路径（即最终拼接顺序）
    pub segments: Vec<String>,
    /// 目标高度（px）；为 0 时采用首个分集的原生分辨率（视频默认）
    #[serde(default = "default_height")]
    pub height: u32,
    /// 目标宽高比，如 "16:9"；为空时采用首个分集的原生比例（视频默认）
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
    let mut probe_cmd = Command::new(ffprobe);
    probe_cmd.args([
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-show_entries",
        "stream=codec_type,width,height",
        "-of",
        "json",
        path,
    ]);
    #[cfg(target_os = "windows")]
    probe_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let out = probe_cmd
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

/// 将分集选中视频拼接为完整视频（ffmpeg filter_complex concat，统一缩放+黑边填充）
#[tauri::command]
pub fn concat_clip_videos(
    input: ConcatClipsInput,
    app: tauri::AppHandle,
) -> Result<ConcatResult, String> {
    if input.segments.is_empty() {
        return Err("没有可拼接的视频分集".to_string());
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

    // 目标画布：若未明确指定高度/比例，则采用首个分集的原生分辨率（视频默认）
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
        .map_err(|e| format!("分集不存在：{}", e))?;

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
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 ffmpeg 失败：{}", e))?;
    crate::job_guard::assign_child(&child);

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
                    "拼接成功 clipId={} 分集数={} 时长={:.1}s 音频={}",
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
    /// 记录来源：concat（拼接成片）| upscale（超分产物），默认 concat
    #[serde(default = "default_concat_source")]
    pub source: String,
}

fn default_concat_source() -> String {
    "concat".to_string()
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
        .map_err(|e| format!("查询分集失败：{}", e))?;

    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO concat_outputs (id, project_id, clip_id, output_path, file_name, duration, segment_count, audio_included, source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            &id,
            &project_id,
            &input.clip_id,
            &input.output_path,
            &input.file_name,
            input.duration,
            input.segment_count as i64,
            input.audio_included as i64,
            &input.source,
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
                "已保存成片记录 id={} clipId={} 时长={:.1}s 分集数={}",
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

    // 在删记录前读取所属作品工作区；提交后仅清理该工作区内的输出文件。
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

/// 查询指定分集的所有拼接成片
#[derive(Debug, Serialize)]
pub struct ConcatOutputRow {
    pub id: String,
    pub output_path: String,
    pub file_name: String,
    pub duration: f64,
    pub segment_count: usize,
    pub audio_included: bool,
    pub source: String,
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
            "SELECT id, output_path, file_name, duration, segment_count, audio_included, source, created_at
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
                source: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

// ── 本地 AI 超分（ncnn-vulkan 子进程方案） ─────────────────────────────

/// 检测当前机器是否支持本地 GPU 超分。
///
/// 超分统一走 ncnn-vulkan（Vulkan）：realesrgan.exe 存在且能用 Vulkan
/// 跑通一张 64x64 测试图即认为支持画质优化。
#[tauri::command]
pub async fn detect_gpu_support(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || detect_gpu_support_blocking(&app))
        .await
        .map_err(|e| format!("GPU 探测线程异常：{}", e))?
}

fn detect_gpu_support_blocking(app: &tauri::AppHandle) -> Result<bool, String> {
    let exe = crate::app_paths::ncnn_realesrgan_exe(app)
        .ok_or_else(|| "未找到 realesrgan.exe，无法探测 GPU".to_string())?;
    let ffmpeg = crate::app_paths::ffmpeg_path(app)
        .ok_or_else(|| "未找到 ffmpeg，无法探测 GPU".to_string())?;
    Ok(probe_ncnn_gpu(&exe, &ffmpeg))
}

/// 探测 ncnn-vulkan（Vulkan GPU）是否可用。
///
/// 用 ffmpeg 生成 64x64 灰色测试图，交给 realesr-animevideov3-x2 模型推理，
/// 子进程成功退出且产出输出文件即认为可用（无 Vulkan 设备时 realesrgan 会报错退出）。
fn probe_ncnn_gpu(realesrgan_exe: &Path, ffmpeg: &Path) -> bool {
    let temp = std::env::temp_dir().join(format!("muse_gpu_probe_{}", uuid::Uuid::new_v4()));
    let in_dir = temp.join("in");
    let out_dir = temp.join("out");
    if std::fs::create_dir_all(&in_dir).is_err() || std::fs::create_dir_all(&out_dir).is_err() {
        return false;
    }
    // 用 ffmpeg 生成 64x64 灰色测试图（避免引入 image 依赖）
    let in_file = in_dir.join("probe.jpg");
    let mut gen_cmd = Command::new(ffmpeg);
    gen_cmd
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=gray:s=64x64",
            "-frames:v",
            "1",
        ])
        .arg(win32_child_path(&in_file))
        .stderr(Stdio::null())
        .stdout(Stdio::null());
    #[cfg(target_os = "windows")]
    gen_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let gen_status = gen_cmd.status();
    if !gen_status.map(|s| s.success()).unwrap_or(false) {
        let _ = std::fs::remove_dir_all(&temp);
        return false;
    }
    // 模型目录 = exe 同级 models/（与打包布局一致）
    let models_dir = realesrgan_exe.parent().map(|p| p.join("models"));
    let mut cmd = Command::new(realesrgan_exe);
    cmd.arg("-i")
        .arg(win32_child_path(&in_dir))
        .arg("-o")
        .arg(win32_child_path(&out_dir))
        .arg("-n")
        .arg("realesr-animevideov3")
        .arg("-s")
        .arg("2")
        .arg("-f")
        .arg("jpg");
    if let Some(m) = &models_dir {
        cmd.arg("-m").arg(win32_child_path(m));
    }
    cmd.stderr(Stdio::null()).stdout(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let ok = match cmd.output() {
        Ok(out) => {
            out.status.success()
                && std::fs::read_dir(&out_dir)
                    .map(|it| it.count() > 0)
                    .unwrap_or(false)
        }
        Err(_) => false,
    };
    let _ = std::fs::remove_dir_all(&temp);
    ok
}

/// 将路径转为子进程可用的 Win32 路径字符串。
///
/// Tauri 的 resource_dir() 在 Windows 上返回带 `\\?\` 前缀的 verbatim 路径，
/// ncnn/ffmpeg 等命令行工具不识别该前缀（会导致崩溃或找不到文件），
/// 统一去掉前缀后再作为子进程参数传入。
fn win32_child_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    s.to_string()
}

/// 超分输入
#[derive(Debug, Deserialize)]
pub struct UpscaleVideoInput {
    /// 源成片绝对路径（concat 输出）
    pub input_path: String,
    /// 输出文件绝对路径（超分结果，.mp4）
    pub output_path: String,
    /// 超分模型：anime / x4plus（默认 anime，适配动漫风格）
    #[serde(default = "default_upscale_model")]
    pub model: String,
}

fn default_upscale_model() -> String {
    "anime".to_string()
}

/// 超分结果
#[derive(Debug, Serialize)]
pub struct UpscaleResult {
    pub output_path: String,
    pub duration: f64,
    pub model_name: String,
    pub scale: u32,
}

/// 用 ffprobe 探测视频帧率
fn probe_fps(ffprobe: &Path, path: &str) -> Result<f64, String> {
    let mut probe_cmd = Command::new(ffprobe);
    probe_cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate",
        "-of",
        "json",
        path,
    ]);
    #[cfg(target_os = "windows")]
    probe_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let out = probe_cmd
        .output()
        .map_err(|e| format!("执行 ffprobe 失败：{}", e))?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe 探测帧率失败：{}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe 输出解析失败：{}", e))?;
    let rate = v
        .get("streams")
        .and_then(|s| s.as_array())
        .and_then(|arr| arr.first())
        .and_then(|s| s.get("r_frame_rate"))
        .and_then(|r| r.as_str())
        .unwrap_or("");
    // "30000/1001" 或 "23.98" 形式
    let fps = if let Some((num, den)) = rate.split_once('/') {
        let n: f64 = num.trim().parse().unwrap_or(0.0);
        let d: f64 = den.trim().parse().unwrap_or(1.0);
        if d > 0.0 {
            n / d
        } else {
            0.0
        }
    } else {
        rate.parse().unwrap_or(0.0)
    };
    Ok(if fps > 0.0 {
        (fps * 100.0).round() / 100.0
    } else {
        24.0
    })
}

/// 超分核心逻辑（运行在后台线程，避免阻塞主进程 UI）。
///
/// 流程：ffmpeg 抽帧 → ncnn-vulkan（realesrgan.exe）批量超分 → ffmpeg 重组+合成音频。
/// 进度经 Tauri event `upscale-progress` 推送（携带 storyboard_id/video_id）。
/// 单次超分执行结果
#[derive(Default)]
pub(crate) struct UpscaleRunOutcome {
    /// 是否复用已有抽帧目录（跳过抽帧阶段）
    pub reused_frames: bool,
    /// 是否复用已有超分帧目录（跳过 ncnn 阶段）
    pub reused_out: bool,
}

// ── 超分辅助：抽帧 / ncnn 批量超分（供 run_upscale_blocking 内部调用） ──

/// 用 ffmpeg 抽帧到 frame_dir，返回帧数。
/// 失败时按 keep_on_error 决定是否清理 frames/out（取消时总是清理）。
fn extract_frames(
    ffmpeg: &Path,
    input_path: &str,
    frame_dir: &Path,
    out_dir: &Path,
    keep_on_error: bool,
    cancel: &std::sync::atomic::AtomicBool,
    emit_progress: &(dyn Fn(f64, &str) + Send + Sync),
    log_stage: &(dyn Fn(&str, &str) + Send + Sync),
) -> Result<usize, String> {
    log::info!(
        "[超分] 开始抽帧: 输入={} 帧目录={}",
        input_path,
        frame_dir.display()
    );
    emit_progress(2.0, "抽帧中…");
    let extract_start = std::time::Instant::now();
    let frame_pat = frame_dir.join("frame%08d.jpg");
    let frame_pat_str = frame_pat.to_string_lossy().to_string();
    let mut extract_cmd = Command::new(ffmpeg);
    extract_cmd.args([
        "-y",
        "-i",
        input_path,
        "-qscale:v",
        "1",
        "-qmin",
        "1",
        "-qmax",
        "1",
        "-vsync",
        "0",
        &frame_pat_str,
    ]);
    extract_cmd.stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    extract_cmd.creation_flags(0x08000000);
    let mut extract_child = extract_cmd
        .spawn()
        .map_err(|e| format!("启动 ffmpeg 抽帧失败：{}", e))?;
    crate::job_guard::assign_child(&extract_child);
    let extract_status = loop {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = extract_child.kill();
            let _ = extract_child.wait();
            let _ = std::fs::remove_dir_all(frame_dir);
            let _ = std::fs::remove_dir_all(out_dir);
            return Err("超分已取消".to_string());
        }
        match extract_child
            .try_wait()
            .map_err(|e| format!("等待抽帧失败：{}", e))?
        {
            Some(status) => break status,
            None => thread::sleep(std::time::Duration::from_millis(120)),
        }
    };
    if !extract_status.success() {
        log::error!(
            "[超分] ffmpeg 抽帧失败，命令: {:?}，返回码: {:?}",
            extract_cmd,
            extract_status.code()
        );
        if !keep_on_error {
            let _ = std::fs::remove_dir_all(frame_dir);
            let _ = std::fs::remove_dir_all(out_dir);
        }
        return Err("ffmpeg 抽帧失败".to_string());
    }
    let frame_count = std::fs::read_dir(frame_dir)
        .map(|it| {
            it.flatten()
                .filter(|e| e.path().extension().map(|x| x == "jpg").unwrap_or(false))
                .count()
        })
        .unwrap_or(0);
    if frame_count == 0 {
        log::error!("[超分] 抽帧结果为空，源文件可能是空视频或不可解码");
        if !keep_on_error {
            let _ = std::fs::remove_dir_all(frame_dir);
            let _ = std::fs::remove_dir_all(out_dir);
        }
        return Err("抽帧结果为空，请检查源成片".to_string());
    }
    log::info!(
        "[超分] 抽帧完成: 帧数={} 耗时={:.1}s",
        frame_count,
        extract_start.elapsed().as_secs_f64()
    );
    log_stage("INFO", &format!("抽帧完成: 共 {} 帧", frame_count));
    emit_progress(15.0, &format!("已抽 {} 帧，开始 AI 超分…", frame_count));
    Ok(frame_count)
}

/// 执行一次 ncnn-vulkan 批量超分（输入目录 → 输出目录），返回输出帧数。
///
/// - offset_done：断点续跑时 out_dir 已完成的连续帧数（用于进度偏移，不参与本次输入）
/// - 取消时总是清理 frames/out；其他错误按 keep_on_error 决定是否清理
fn run_ncnn_batch(
    ncnn_exe: &Path,
    input_dir: &Path,
    output_dir: &Path,
    model_name: &str,
    scale: u32,
    models_dir: &Path,
    frame_dir: &Path,
    out_dir: &Path,
    frame_count: usize,
    offset_done: usize,
    keep_on_error: bool,
    cancel: &std::sync::atomic::AtomicBool,
    emit_progress: &(dyn Fn(f64, &str) + Send + Sync),
    log_stage: &(dyn Fn(&str, &str) + Send + Sync),
) -> Result<usize, String> {
    log::info!(
        "[超分] 启动 ncnn 超分: exe={} 模型={} 缩放={}x 输入目录={} 输出目录={}",
        ncnn_exe.display(),
        model_name,
        scale,
        input_dir.display(),
        output_dir.display()
    );
    let upscale_start = std::time::Instant::now();
    let mut ncnn_cmd = Command::new(ncnn_exe);
    ncnn_cmd
        .arg("-i")
        .arg(win32_child_path(input_dir))
        .arg("-o")
        .arg(win32_child_path(output_dir))
        .arg("-n")
        .arg(model_name)
        .arg("-s")
        .arg(scale.to_string())
        .arg("-m")
        .arg(win32_child_path(models_dir))
        .arg("-f")
        .arg("jpg");
    // 不指定 -g：ncnn 自动选择可用 GPU（auto）；-t 默认 0=auto tile 划分
    ncnn_cmd.stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    ncnn_cmd.creation_flags(0x08000000);
    let mut ncnn_child = ncnn_cmd
        .spawn()
        .map_err(|e| format!("启动 realesrgan 失败：{}", e))?;
    crate::job_guard::assign_child(&ncnn_child);
    let ncnn_status = loop {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = ncnn_child.kill();
            let _ = ncnn_child.wait();
            let _ = std::fs::remove_dir_all(frame_dir);
            let _ = std::fs::remove_dir_all(out_dir);
            return Err("超分已取消".to_string());
        }
        match ncnn_child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {}
            Err(e) => {
                if !keep_on_error {
                    let _ = std::fs::remove_dir_all(frame_dir);
                    let _ = std::fs::remove_dir_all(out_dir);
                }
                return Err(format!("等待 realesrgan 失败：{}", e));
            }
        }
        let done = std::fs::read_dir(output_dir)
            .map(|it| {
                it.flatten()
                    .filter(|e| e.path().extension().map(|x| x == "jpg").unwrap_or(false))
                    .count()
            })
            .unwrap_or(0);
        let ratio = ((offset_done + done) as f64 / frame_count as f64).clamp(0.0, 1.0);
        // 15% → 90% 是 75 个百分点：ratio×75 随帧数线性推进
        let mapped = 15.0 + ratio * 75.0;
        emit_progress(
            mapped.min(90.0),
            &format!("AI 超分中… {}/{}", offset_done + done, frame_count),
        );
        thread::sleep(std::time::Duration::from_millis(150));
    };
    if !ncnn_status.success() {
        log::error!(
            "[超分] realesrgan 失败，命令: {:?}，返回码: {:?}",
            ncnn_cmd,
            ncnn_status.code()
        );
        if !keep_on_error {
            let _ = std::fs::remove_dir_all(frame_dir);
            let _ = std::fs::remove_dir_all(out_dir);
        }
        return Err(format!("realesrgan 超分失败（{}）", model_name));
    }
    let out_count = std::fs::read_dir(output_dir)
        .map(|it| {
            it.flatten()
                .filter(|e| e.path().extension().map(|x| x == "jpg").unwrap_or(false))
                .count()
        })
        .unwrap_or(0);
    log::info!(
        "[超分] ncnn 超分完成: model={} scale={}x 帧数={} 耗时={:.1}s",
        model_name,
        scale,
        out_count,
        upscale_start.elapsed().as_secs_f64()
    );
    log_stage("INFO", &format!("AI 超分完成: model={} scale={}x 帧数={}", model_name, scale, out_count));
    Ok(out_count)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_upscale_blocking(
    input: UpscaleVideoInput,
    app: tauri::AppHandle,
    scale: u32,
    job_id: String,
    keep_on_error: bool,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    on_progress: std::sync::Arc<dyn Fn(f64, &str) + Send + Sync>,
) -> Result<(UpscaleResult, UpscaleRunOutcome), String> {
    let start_ts = std::time::Instant::now();
    let mut outcome = UpscaleRunOutcome::default();
    // 取消标志（manager 传入，任务级独立）
    let is_canceled = || cancel.load(std::sync::atomic::Ordering::Relaxed);

    let ffmpeg =
        app_paths::ffmpeg_path(&app).ok_or_else(|| "未找到 ffmpeg，无法超分".to_string())?;
    let ffprobe = app_paths::ffprobe_path(&app);
    // 超分统一走 ncnn-vulkan 子进程（realesrgan.exe）：
    // - 动漫模型 realesr-animevideov3：-s 自动匹配 x2/x3/x4 三套专用模型
    // - 通用模型 realesrgan-x4plus：-s 指定目标倍率（4x 模型内部处理）
    let ncnn_exe = app_paths::ncnn_realesrgan_exe(&app)
        .ok_or_else(|| "未找到 realesrgan.exe，超分不可用".to_string())?;
    if !ncnn_exe.exists() {
        return Err(format!("未找到 realesrgan.exe（{}）", ncnn_exe.display()));
    }

    log::info!(
        "[超分] 超分开始 input={} output={} ffmpeg={} engine=ncnn-vulkan exe={} model={} scale={}",
        input.input_path,
        input.output_path,
        ffmpeg.to_string_lossy(),
        ncnn_exe.display(),
        input.model,
        scale
    );

    // 模型 → ncnn 模型名映射（前端展示用）
    let model_name = match input.model.as_str() {
        "x4plus" => "realesrgan-x4plus",
        "x4plus-anime" => "realesrgan-x4plus-anime",
        _ => "realesr-animevideov3",
    };
    // x4plus / x4plus-anime 是原生 4x 模型：ncnn 只支持 -s 4（非 4x 会 tile 拼接错乱），
    // 且模型设计上限 1080p 输入（4x 输出约 4K，更高分辨率会超出模型训练分布/显存）。
    let is_fixed_4x_model = input.model.as_str() == "x4plus" || input.model.as_str() == "x4plus-anime";
    let scale = if is_fixed_4x_model { 4 } else { scale };

    // ── 探测源视频：时长、帧率、分辨率、是否含音频 ──
    let fps = match &ffprobe {
        Some(fp) => probe_fps(fp, &input.input_path)?,
        None => 24.0,
    };
    let (total_duration, has_audio, src_w, src_h) = match &ffprobe {
        Some(fp) => match probe_file(fp, &input.input_path) {
            Ok(info) => (info.duration, info.has_audio, info.width, info.height),
            Err(_) => (0.0, false, 0, 0),
        },
        None => (0.0, false, 0, 0),
    };
    log::info!(
        "[超分] 源视频信息: 分辨率={}x{} 时长={:.1}s 帧率={:.2}fps 含音频={}",
        src_w,
        src_h,
        total_duration,
        fps,
        has_audio
    );

    // 4x 固定模型（x4plus 系列）输入上限 1080p：超出则拒绝并提示改用动漫模型
    if is_fixed_4x_model && src_h > 1080 {
        return Err(format!(
            "{} 最高支持 1080p 视频超分（当前 {}x{}），请改用动漫优化模型",
            model_name, src_w, src_h
        ));
    }

    // 进度回调：统一 0-100（manager 会做 min(100) 兜底），直接透传 stage。
    // on_progress 是 Arc<dyn Fn>：主流程用借用，重组 stderr 线程 clone 共享。
    let emit_progress = |percent: f64, stage: &str| {
        on_progress(percent, stage);
    };

    // 阶段日志（写入 muse.log，source=视频超分；尽力型操作）
    let log_app = app.clone();
    let log_stage = |level: &str, message: &str| {
        if let Ok(app_data_dir) = crate::app_paths::resolve_app_data_dir(&log_app) {
            let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
            crate::project_log::append_log(
                &log_path,
                "视频超分",
                level,
                &format!("{} 输入={} 输出={}", message, input.input_path, input.output_path),
            );
        }
    };

    // ── 临时目录：抽帧 / 超分输出（续跑时复用同一 job_id 的目录） ──
    let work_dir = Path::new(&input.output_path)
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "输出路径缺少父目录".to_string())?;
    let frame_dir = work_dir.join(format!("_upscale_{}_frames", job_id));
    let out_dir = work_dir.join(format!("_upscale_{}_out", job_id));
    std::fs::create_dir_all(&frame_dir).map_err(|e| format!("创建帧目录失败：{}", e))?;
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建输出帧目录失败：{}", e))?;

    // 清理临时目录：取消时总是清理（用户主动放弃，不应再续跑）；
    // 其他错误按 keep_on_error 决定（续跑失败保留目录以便下次再续跑，新任务失败则清理）。
    let cleanup = |frame_dir: &Path, out_dir: &Path| {
        let _ = std::fs::remove_dir_all(frame_dir);
        let _ = std::fs::remove_dir_all(out_dir);
    };
    let cleanup_on_error = |frame_dir: &Path, out_dir: &Path| {
        if !keep_on_error {
            cleanup(frame_dir, out_dir);
        }
    };

    // ── 第1步：ffmpeg 抽帧（进度 0-15%；续跑时若已有帧则校验连续性后复用） ──
    // 检测已有帧目录：解析编号，若从 1 开始连续（无跳号）则视为完整可复用。
    // 注意：不能用时长×帧率估算期望帧数（12.1s×24fps≈290 与实际 289 有舍入偏差，
    // 会导致误判"抽帧不完整"而清空重抽，破坏断点续跑）。
    fn parse_frame_no(name: &std::ffi::OsStr) -> Option<u32> {
        let s = name.to_str()?;
        let digits = s.strip_prefix("frame")?;
        let digits = digits.strip_suffix(".jpg")?;
        digits.parse::<u32>().ok()
    }
    let mut existing_frame_nos: Vec<u32> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&frame_dir) {
        for entry in entries.flatten() {
            if let Some(no) = parse_frame_no(&entry.file_name()) {
                existing_frame_nos.push(no);
            }
        }
    }
    existing_frame_nos.sort_unstable();
    let existing_frames = existing_frame_nos.len();
    // 是否从 1 开始连续（无跳号）
    let frames_continuous = existing_frame_nos
        .iter()
        .enumerate()
        .all(|(i, no)| *no as usize == i + 1);
    let frame_count = if existing_frames > 0 && frames_continuous {
        // 断点续跑：已有连续帧目录，复用
        outcome.reused_frames = true;
        log::info!(
            "[超分] 复用已有抽帧目录: {} 帧（连续无跳号），跳过抽帧",
            existing_frames
        );
        log_stage(
            "INFO",
            &format!("抽帧完成（复用已有帧 {} 帧，跳过抽帧）", existing_frames),
        );
        existing_frames
    } else {
        // 抽帧目录为空，或编号断裂（上次中断在抽帧阶段）：清空后重新抽帧
        if existing_frames > 0 {
            log::warn!(
                "[超分] 抽帧目录编号断裂（{} 帧），清空重新抽帧",
                existing_frames
            );
            if let Ok(entries) = std::fs::read_dir(&frame_dir) {
                for entry in entries.flatten() {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        extract_frames(
            &ffmpeg,
            &input.input_path,
            &frame_dir,
            &out_dir,
            keep_on_error,
            &cancel,
            &emit_progress,
            &log_stage,
        )?
    };

    // ── 第2步：ncnn-vulkan 子进程批量超分（进度 15%-90%；支持断点续跑） ──
    // 断点检测：解析 out_dir 已有帧的编号，判断是否形成从 1 开始的连续序列。
    // - 已有完整超分帧（编号连续且数量 >= frame_count）→ 跳过 ncnn；
    // - out_dir 为空 → 新任务，直接全量超分；
    // - 编号中间断裂/跳号 → 输出不可信，清空 out_dir 全部重跑；
    // - 0 < 已有帧 < frame_count 且编号连续 → 断点续跑：只超分缺失帧
    //   （已有帧原样保留，缺失帧从 frame_dir 补算，不重复跑已完成帧）。
    let mut existing_nos: Vec<u32> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&out_dir) {
        for entry in entries.flatten() {
            if let Some(no) = parse_frame_no(&entry.file_name()) {
                existing_nos.push(no);
            }
        }
    }
    existing_nos.sort_unstable();
    // 检查是否是从 1 开始的连续前缀（无跳号）
    let mut continuous_to = 0u32;
    for (i, no) in existing_nos.iter().enumerate() {
        if *no as usize == i + 1 {
            continuous_to = *no;
        } else {
            break;
        }
    }
    let has_gap = continuous_to as usize != existing_nos.len();
    let existing_out = existing_nos.len();
    let models_dir = app_paths::ncnn_models_dir(&app).ok_or_else(|| "未找到超分模型目录".to_string())?;

    if existing_out >= frame_count && !has_gap {
        // 断点续跑：已有完整超分帧，跳过 ncnn
        outcome.reused_out = true;
        log::info!(
            "[超分] 复用已有超分帧目录: {} 帧，跳过 ncnn",
            existing_out
        );
        emit_progress(92.0, "重组视频…");
    } else if existing_out == 0 {
        // 新任务（out_dir 为空）：直接全量超分
        log::info!(
            "[超分] 新任务（输出帧为空），直接全量超分: 输入={} 输出={}",
            frame_dir.display(),
            out_dir.display()
        );
        log_stage("INFO", &format!("开始 AI 超分（新任务，共 {} 帧）", frame_count));
        let out_count = run_ncnn_batch(
            &ncnn_exe, &frame_dir, &out_dir, model_name, scale, &models_dir,
            &frame_dir, &out_dir, frame_count, 0, keep_on_error, &cancel,
            &emit_progress, &log_stage,
        )?;
        if out_count != frame_count {
            log::error!("[超分] ncnn 输出帧数不完整: {}/{}", out_count, frame_count);
            if !keep_on_error {
                cleanup(&frame_dir, &out_dir);
            }
            return Err(format!("超分输出帧数不完整：{}/{}", out_count, frame_count));
        }
        emit_progress(92.0, "重组视频…");
    } else if has_gap {
        // 编号断裂（如缺了中间的某帧）：输出帧不完整且编号错乱，清空全部重跑
        log::warn!(
            "[超分] 输出帧编号断裂（共 {} 帧，连续到 {}），清空后全部重跑",
            existing_out,
            continuous_to
        );
        log_stage(
            "WARN",
            &format!("输出帧编号断裂（共 {} 帧，连续到 {}），全部重跑", existing_out, continuous_to),
        );
        if let Ok(entries) = std::fs::read_dir(&out_dir) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let out_count = run_ncnn_batch(
            &ncnn_exe, &frame_dir, &out_dir, model_name, scale, &models_dir,
            &frame_dir, &out_dir, frame_count, 0, keep_on_error, &cancel,
            &emit_progress, &log_stage,
        )?;
        if out_count != frame_count {
            log::error!("[超分] ncnn 输出帧数不完整: {}/{}", out_count, frame_count);
            if !keep_on_error {
                cleanup(&frame_dir, &out_dir);
            }
            return Err(format!("超分输出帧数不完整：{}/{}", out_count, frame_count));
        }
        emit_progress(92.0, "重组视频…");
    } else {
        // 断点续跑（0 < 已有帧 < 总帧数，编号连续）：只超分缺失帧。
        // 已有帧编号为 1..=continuous_to，缺失帧为 continuous_to+1..=frame_count。
        //
        // 关键设计：ncnn 的输出目录**直接指向项目 _out 目录**（不是中转目录）。
        // ncnn 输出文件名 = 输入文件名（frame%08d.jpg 同名），缺失帧从
        // continuous_to+1 起算，输出会实时写入 out_dir，与已有 1..=continuous_to
        // 帧自然衔接。这样即使中途进程被杀，已算出的帧也已落盘到 out_dir，
        // 下次续跑从最新断点继续，不丢进度。
        //
        // 输入目录用系统 temp（只放缺失帧副本），项目目录下始终只有
        // _upscale_{job}_frames / _upscale_{job}_out 两个文件夹。
        let missing_start = continuous_to + 1;
        let missing_count = frame_count - continuous_to as usize;
        log::info!(
            "[超分] 断点续跑: 复用抽帧 {} 帧，已有超分帧 {} 帧，仅补算缺失帧 {}-{}（共 {} 帧）",
            frame_count,
            continuous_to,
            missing_start,
            frame_count,
            missing_count
        );
        log_stage(
            "INFO",
            &format!("断点续跑: 已有超分帧 {} 帧，仅补算缺失 {} 帧", continuous_to, missing_count),
        );

        // 临时输入目录：系统 temp（不污染项目目录）
        let temp_root = std::env::temp_dir().join(format!("muse_upscale_{}", job_id));
        let temp_in_dir = temp_root.join("in");
        // 上次异常退出可能残留同名临时目录，先清掉再重建
        let _ = std::fs::remove_dir_all(&temp_root);
        if std::fs::create_dir_all(&temp_in_dir).is_err() {
            let _ = std::fs::remove_dir_all(&temp_root);
            return Err("创建续跑临时目录失败".to_string());
        }
        // 复制缺失帧到临时输入目录（保留 frame%08d.jpg 编号）
        let mut copied = 0usize;
        for no in (missing_start as u32)..=(frame_count as u32) {
            let src = frame_dir.join(format!("frame{:08}.jpg", no));
            let dst = temp_in_dir.join(format!("frame{:08}.jpg", no));
            if src.exists() && std::fs::copy(&src, &dst).is_ok() {
                copied += 1;
            }
        }
        if copied != missing_count {
            log::error!(
                "[超分] 续跑缺失帧复制不完整: {}/{}",
                copied,
                missing_count
            );
            let _ = std::fs::remove_dir_all(&temp_root);
            if !keep_on_error {
                cleanup(&frame_dir, &out_dir);
            }
            return Err(format!("续跑缺失帧复制不完整：{}/{}", copied, missing_count));
        }

        let upscale_start = std::time::Instant::now();
        // 输出目录直接指向 out_dir：ncnn 输出同名帧实时写入，与已有帧衔接。
        // 进度 offset 传 0：out_dir 计数已包含已有帧（done 从 16/289 起算）。
        // 注意：run_ncnn_batch 取消/失败时会清掉 frame_dir/out_dir（取消=放弃），
        // 这里统一把系统 temp 输入目录也清掉，避免残留。
        let ncnn_result = run_ncnn_batch(
            &ncnn_exe, &temp_in_dir, &out_dir, model_name, scale, &models_dir,
            &frame_dir, &out_dir, frame_count, 0, keep_on_error, &cancel,
            &emit_progress, &log_stage,
        );
        if let Err(e) = ncnn_result {
            let _ = std::fs::remove_dir_all(&temp_root);
            return Err(e);
        }
        let _ = std::fs::remove_dir_all(&temp_root);
        // 校验 out_dir 完整（含已有帧 + 补算帧）
        let final_count = std::fs::read_dir(&out_dir)
            .map(|it| {
                it.flatten()
                    .filter(|e| e.path().extension().map(|x| x == "jpg").unwrap_or(false))
                    .count()
            })
            .unwrap_or(0);
        if final_count != frame_count {
            log::error!(
                "[超分] 续跑后输出帧总数不完整: {}/{}",
                final_count,
                frame_count
            );
            if !keep_on_error {
                cleanup(&frame_dir, &out_dir);
            }
            return Err(format!("续跑后输出帧总数不完整：{}/{}", final_count, frame_count));
        }
        log::info!(
            "[超分] ncnn 断点续跑完成: model={} scale={}x 帧数={} 耗时={:.1}s",
            model_name,
            scale,
            frame_count,
            upscale_start.elapsed().as_secs_f64()
        );
        log_stage(
            "INFO",
            &format!("AI 超分完成（断点续跑补算）: model={} scale={}x 帧数={}", model_name, scale, frame_count),
        );
        emit_progress(92.0, "重组视频…");
    }

    // ── 第3步：ffmpeg 重组 + 合成音频（进度 92%-100%；续跑时若输出已存在则跳过） ──
    let output_exists = Path::new(&input.output_path).exists()
        && std::fs::metadata(&input.output_path)
            .map(|m| m.len() > 0)
            .unwrap_or(false);
    if output_exists {
        log::info!(
            "[超分] 输出文件已存在，跳过重组: {}",
            input.output_path
        );
        emit_progress(100.0, "完成");
    } else {
    log::info!(
        "[超分] 开始重组: 帧率={}fps 含音频={} 输出={}",
        fps,
        has_audio,
        input.output_path
    );
    let reassemble_start = std::time::Instant::now();
    let out_pat = out_dir.join("frame%08d.jpg");
    let out_pat_str = out_pat.to_string_lossy().to_string();
    let mut reassemble_cmd = Command::new(&ffmpeg);
    reassemble_cmd
        .arg("-y")
        .arg("-i")
        .arg(&out_pat_str)
        .arg("-i")
        .arg(&input.input_path)
        .arg("-map")
        .arg("0:v:0")
        .arg("-r")
        .arg(fps.to_string())
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("slow")
        .arg("-crf")
        .arg("18")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-movflags")
        .arg("+faststart");
    if has_audio {
        reassemble_cmd
            .arg("-map")
            .arg("1:a:0")
            .arg("-c:a")
            .arg("aac")
            .arg("-b:a")
            .arg("192k");
    }
    reassemble_cmd.arg(&input.output_path);
    reassemble_cmd.stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    reassemble_cmd.creation_flags(0x08000000);

    let mut child2 = reassemble_cmd
        .spawn()
        .map_err(|e| format!("启动 ffmpeg 重组失败：{}", e))?;
    crate::job_guard::assign_child(&child2);
    let stderr2 = child2
        .stderr
        .take()
        .ok_or_else(|| "无法获取 ffmpeg 重组输出".to_string())?;
    let log2: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log2_for_thread = log2.clone();
    let on_progress2 = on_progress.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr2);
        for line in reader.lines().flatten() {
            if let Ok(mut v) = log2_for_thread.lock() {
                if v.len() >= 200 {
                    v.remove(0);
                }
                v.push(line.clone());
            }
            if let Some(t) = parse_time(&line) {
                if total_duration > 0.0 {
                    let pct = (t / total_duration * 100.0).min(100.0);
                    let mapped = 92.0 + pct * 0.08;
                    on_progress2(mapped.min(100.0), "重组视频…");
                }
            }
        }
    });

    // 轮询等待，支持取消（取消时终止子进程，stderr 线程随之读到 EOF 退出）
    let status2 = loop {
        if is_canceled() {
            let _ = child2.kill();
            let _ = child2.wait();
            cleanup(&frame_dir, &out_dir);
            // 重组可能已写出部分文件，取消时删除不完整产物
            let _ = std::fs::remove_file(&input.output_path);
            return Err("超分已取消".to_string());
        }
        match child2
            .try_wait()
            .map_err(|e| format!("等待 ffmpeg 重组失败：{}", e))?
        {
            Some(status) => break status,
            None => thread::sleep(std::time::Duration::from_millis(150)),
        }
    };
    if !status2.success() {
        let detail = log2.lock().map(|v| v.join("\n")).unwrap_or_default();
        cleanup_on_error(&frame_dir, &out_dir);
        return Err(format!("ffmpeg 重组失败：{}", detail.trim()));
    }
    log::info!(
        "[超分] 重组完成: 耗时={:.1}s",
        reassemble_start.elapsed().as_secs_f64()
    );

    emit_progress(100.0, "完成");
    }

    // 统一清理临时目录（新任务或续跑复用后均清理）
    cleanup(&frame_dir, &out_dir);

    let total_secs = start_ts.elapsed().as_secs_f64();
    let out_size_mb = std::fs::metadata(&input.output_path)
        .map(|m| m.len() as f64 / 1024.0 / 1024.0)
        .unwrap_or(0.0);
    log::info!(
        "[超分] 全部完成: 输出={} 大小={:.1}MB 帧数={} 时长={:.1}s 总耗时={:.1}s 复用帧={} 复用超分帧={}",
        input.output_path,
        out_size_mb,
        frame_count,
        total_duration,
        total_secs,
        outcome.reused_frames,
        outcome.reused_out
    );

    if let Ok(app_data_dir) = crate::app_paths::resolve_app_data_dir(&app) {
        let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
        crate::project_log::append_log(
            &log_path,
            "视频超分",
            "INFO",
            &format!(
                "超分成功 {} → {} model={} scale={}x 帧数={} 时长={:.1}s 音频={} 总耗时={:.1}s",
                input.input_path,
                input.output_path,
                model_name,
                scale,
                frame_count,
                total_duration,
                has_audio,
                total_secs
            ),
        );
    }

    Ok((
        UpscaleResult {
            output_path: input.output_path,
            duration: total_duration,
            model_name: model_name.to_string(),
            scale,
        },
        outcome,
    ))
}

// ── 镜头视频超分（在镜头管理页对单个分镜批次视频超分） ──────────────────


/// 清理上次超分异常退出残留的孤儿子进程（realesrgan / ffmpeg）。
///
/// 超分过程中应用被强制关闭时，ncnn（realesrgan.exe）与 ffmpeg 子进程不会随父进程
/// 结束而退出，会残留为孤儿进程并持续占用 upscaler/ffmpeg 目录下的资源文件
/// （如 vcomp140.dll、ffmpeg.exe），导致重启后编译或超分初始化失败。
/// 这里通过进程名匹配并终止本应用启动的残留进程（不误杀其他同名系统进程：
/// 进程可执行路径必须位于项目的 upscaler/ 或 ffmpeg/ 目录）。
pub fn cleanup_orphan_upscale_processes() {
    #[cfg(target_os = "windows")]
    {
        // 通过 tasklist 枚举 + 路径匹配，避免引入额外依赖（隐藏控制台窗口）
        let mut tasklist_cmd = std::process::Command::new("tasklist");
        tasklist_cmd.args(["/FO", "CSV", "/NH"]);
        #[cfg(target_os = "windows")]
        tasklist_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let output = match tasklist_cmd.output() {
            Ok(o) => o,
            Err(_) => return,
        };
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            // CSV 格式: "imageName","pid","sessionName","session#","memUsage"
            let fields: Vec<&str> = line.split(',').collect();
            if fields.len() < 2 {
                continue;
            }
            let name = fields[0].trim_matches('"');
            let pid: u32 = match fields[1].trim_matches('"').parse() {
                Ok(p) => p,
                Err(_) => continue,
            };
            if name != "realesrgan.exe" && name != "ffmpeg.exe" {
                continue;
            }
            // 校验进程路径位于项目 upscaler/ 或 ffmpeg/ 目录，避免误杀系统同名进程
            let mut wmic_cmd = std::process::Command::new("wmic");
            wmic_cmd.args(["process", "where", &format!("ProcessId={pid}"), "get", "ExecutablePath"]);
            #[cfg(target_os = "windows")]
            wmic_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            let cmd = wmic_cmd.output();
            let exe_path = match cmd {
                Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
                Err(_) => continue,
            };
            let exe_path = exe_path
                .lines()
                .map(|l| l.trim())
                .find(|l| !l.is_empty() && !l.eq_ignore_ascii_case("ExecutablePath"))
                .unwrap_or("");
            let lower = exe_path.to_ascii_lowercase();
            if lower.contains("\\upscaler\\realesrgan.exe")
                || lower.contains("\\ffmpeg\\ffmpeg.exe")
            {
                log::warn!("[超分] 清理残留孤儿进程: {} (PID={})", exe_path, pid);
                let mut kill_cmd = std::process::Command::new("taskkill");
                kill_cmd.args(["/PID", &pid.to_string(), "/F"]);
                #[cfg(target_os = "windows")]
                kill_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
                let _ = kill_cmd.status();
            }
        }
    }
}

/// 递归清理超分异常退出时残留的临时帧目录。
///
/// 识别两种目录命名：
/// - 项目目录：`_upscale_{job_id}_frames` / `_upscale_{job_id}_out`
/// - 系统临时目录：`muse_upscale_{job_id}`（续跑中转输入）
/// 仅删除 job_id 不在 `active_job_ids` 中的孤儿目录，避免误删正在续跑的任务目录。
pub(crate) fn cleanup_orphan_upscale_dirs(
    root: &std::path::Path,
    active_job_ids: &std::collections::HashSet<String>,
    depth: usize,
) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // 系统 temp 续跑中转：muse_upscale_{uuid}
        if let Some(rest) = name.strip_prefix("muse_upscale_") {
            if active_job_ids.contains(rest) {
                continue; // 活跃任务目录，保留
            }
            if std::fs::remove_dir_all(&path).is_ok() {
                log::info!("[超分] 已清理残留临时目录：{:?}", path);
            }
            continue;
        }
        // 项目目录：_upscale_{uuid}_frames / _upscale_{uuid}_out
        if let Some(rest) = name.strip_prefix("_upscale_") {
            let job_id = rest
                .strip_suffix("_frames")
                .or_else(|| rest.strip_suffix("_out"))
                .unwrap_or(rest)
                .to_string();
            if active_job_ids.contains(&job_id) {
                continue; // 活跃任务目录，保留
            }
            if std::fs::remove_dir_all(&path).is_ok() {
                log::info!("[超分] 已清理残留临时目录：{:?}", path);
            }
        } else {
            cleanup_orphan_upscale_dirs(&path, active_job_ids, depth + 1);
        }
    }
}
