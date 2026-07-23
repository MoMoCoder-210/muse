//! 公共音色（火山 TTS）数据表与试听缓存

use base64::Engine;
use serde::Serialize;
use std::io::Read;
use tauri::{AppHandle, Manager};

const PREVIEW_TEXT: &str = "你好，很高兴认识你！今天天气真不错，我们一起来听听这个声音吧。";
const VOICES_DIR: &str = "voices";

#[derive(Serialize)]
pub struct PreviewVoiceResult {
    pub sample_path: String,
    pub cached: bool,
}

/// 从 settings.json 读取活跃语音渠道的 V3 凭证
struct VoiceConfig {
    api_key: String,
    resource_id: String,
    base_url: String,
    sample_rate: u32,
    timeout_ms: u64,
}

fn load_voice_config(app: &AppHandle) -> Result<VoiceConfig, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(app)?;
    let settings_path = app_data_dir.join("settings.json");
    let content =
        std::fs::read_to_string(&settings_path).map_err(|e| format!("读取设置失败：{}", e))?;
    let settings: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("解析设置失败：{}", e))?;
    let settings = crate::commands::util::sanitize_settings(settings);

    let voice = settings
        .get("voice")
        .and_then(|v| v.as_object())
        .ok_or("设置中缺少 voice 配置节")?;
    let channels = voice
        .get("channels")
        .and_then(|v| v.as_array())
        .ok_or("voice 配置缺少 channels")?;
    let active_id = voice
        .get("activeId")
        .and_then(|v| v.as_str())
        .unwrap_or("default");
    let active = channels
        .iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(active_id))
        .or_else(|| channels.first())
        .and_then(|v| v.as_object())
        .ok_or("voice 配置缺少可用渠道")?;

    let api_key = active
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let resource_id = active
        .get("resourceId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let base_url = active
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let sample_rate = active
        .get("sampleRate")
        .and_then(|v| v.as_u64())
        .unwrap_or(24000) as u32;
    let timeout_ms = settings
        .get("voiceParams")
        .and_then(|v| v.get("timeoutMs"))
        .and_then(|v| v.as_u64())
        .unwrap_or(300000);

    Ok(VoiceConfig {
        api_key,
        resource_id,
        base_url,
        sample_rate,
        timeout_ms,
    })
}

/// 应用启动时播种公共音色清单，清除不在清单中的旧残留音色
pub fn seed_public_voices(conn: &rusqlite::Connection) -> Result<(), String> {
    let json_str = include_str!("../../../src/data/public-voices.json");
    let voices: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("解析公共音色清单失败：{}", e))?;
    let arr = voices
        .as_array()
        .ok_or("公共音色清单格式错误（应为数组）")?;

    // 1. 清除不在当前清单中的旧残留音色
    let ids: Vec<&str> = arr
        .iter()
        .filter_map(|v| v.get("id").and_then(|x| x.as_str()))
        .filter(|s| !s.is_empty())
        .collect();
    if !ids.is_empty() {
        let placeholders = std::iter::repeat("?")
            .take(ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "DELETE FROM public_voices WHERE voice_id NOT IN ({})",
            placeholders
        );
        conn.execute(&sql, rusqlite::params_from_iter(ids.iter().copied()))
            .map_err(|e| e.to_string())?;
    }

    for v in arr {
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let gender = v.get("gender").and_then(|x| x.as_str()).unwrap_or("");
        let age = v.get("age").and_then(|x| x.as_str()).unwrap_or("");
        let language = v.get("language").and_then(|x| x.as_str()).unwrap_or("");
        let tags = v
            .get("tags")
            .map(|x| x.to_string())
            .unwrap_or_else(|| "[]".to_string());

        conn.execute(
            "INSERT INTO public_voices (voice_id, name, gender, age, language, tags, sample_audio_path) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL) \
             ON CONFLICT(voice_id) DO UPDATE SET \
               name = excluded.name, \
               gender = excluded.gender, \
               age = excluded.age, \
               language = excluded.language, \
               tags = excluded.tags",
            rusqlite::params![id, name, gender, age, language, tags],
        )
        .map_err(|e| e.to_string())?;
    }
    log::info!("公共音色清单播种完成（{} 条）", arr.len());
    Ok(())
}

/// 试听公共音色：打包离线 → 本地缓存 → API 合成（优先级递减）
#[tauri::command]
pub fn preview_public_voice(
    app: AppHandle,
    voice_id: String,
) -> Result<PreviewVoiceResult, String> {
    let conn = crate::commands::util::open_app_conn(&app)?;
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    // 0. 打包离线音频
    if let Some(p) = resolve_bundled_voice(&app, &voice_id) {
        let p_str = p.to_string_lossy().to_string();
        let _ = upsert_sample_path(&conn, &voice_id, &p_str);
        crate::project_log::append_log(
            &log_path,
            "语音",
            "INFO",
            &format!("试听命中打包离线音频：voiceId={} path={}", voice_id, p_str),
        );
        return Ok(PreviewVoiceResult {
            sample_path: p_str,
            cached: true,
        });
    }

    let voices_dir = app_data_dir.join(VOICES_DIR);
    std::fs::create_dir_all(&voices_dir).map_err(|e| e.to_string())?;
    let sample_path = voices_dir.join(format!("{}.mp3", sanitize_voice_filename(&voice_id)));
    let sample_path_str = sample_path.to_string_lossy().to_string();

    // 1. 本地缓存
    if sample_path.exists() {
        crate::project_log::append_log(
            &log_path,
            "语音",
            "INFO",
            &format!(
                "试听命中本地缓存：voiceId={} path={}",
                voice_id, sample_path_str
            ),
        );
        return Ok(PreviewVoiceResult {
            sample_path: sample_path_str,
            cached: true,
        });
    }

    // 2. 调用 V3 API 合成
    let cfg = load_voice_config(&app)?;
    if cfg.api_key.is_empty() {
        return Err("请先在「设置 → 语音」配置 API Key（火山控制台「语音合成」获取）".into());
    }
    let resource_id = cfg.resource_id.trim().to_string();
    let url = cfg.base_url.trim().trim_end_matches('/').to_string();

    crate::project_log::append_log(
        &log_path,
        "语音",
        "INFO",
        &format!(
            "试听合成请求(V3)：voiceId={} url={} resourceId={}",
            voice_id, url, resource_id
        ),
    );

    let audio_bytes = synthesize_via_v3(
        &url,
        &cfg.api_key,
        &resource_id,
        &voice_id,
        cfg.sample_rate,
        cfg.timeout_ms,
        &log_path,
    )?;

    // 3. 落盘：优先 resource_dir，回退 app_data_dir
    let save_path = bundled_voice_save_path(&app, &voice_id);
    if let Some(parent) = save_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let save_path_str = if std::fs::write(&save_path, &audio_bytes).is_ok() {
        save_path.to_string_lossy().to_string()
    } else {
        let fallback = app_data_dir
            .join(VOICES_DIR)
            .join(format!("{}.mp3", sanitize_voice_filename(&voice_id)));
        std::fs::create_dir_all(fallback.parent().unwrap_or(&fallback))
            .map_err(|e| format!("创建音频缓存目录失败：{}", e))?;
        std::fs::write(&fallback, &audio_bytes).map_err(|e| format!("写入音频缓存失败：{}", e))?;
        fallback.to_string_lossy().to_string()
    };

    upsert_sample_path(&conn, &voice_id, &save_path_str).map_err(|e| e.to_string())?;
    crate::project_log::append_log(
        &log_path,
        "语音",
        "INFO",
        &format!(
            "试听合成成功并缓存：voiceId={} path={} bytes={}",
            voice_id,
            save_path_str,
            audio_bytes.len()
        ),
    );

    Ok(PreviewVoiceResult {
        sample_path: save_path_str,
        cached: false,
    })
}

/// 批量查询已缓存的公共音色（复用 resolve_bundled_voice + TTS 缓存，不触发合成）
#[tauri::command]
pub fn check_voices_cached(app: AppHandle, voice_ids: Vec<String>) -> Result<Vec<String>, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let mut cached = Vec::new();
    for id in voice_ids {
        if resolve_bundled_voice(&app, &id).is_some() {
            cached.push(id);
            continue;
        }
        let p = app_data_dir
            .join(VOICES_DIR)
            .join(format!("{}.mp3", sanitize_voice_filename(&id)));
        if p.exists() {
            cached.push(id);
        }
    }
    Ok(cached)
}

/// 调用 OpenSpeech V3 单向流式接口合成，返回 mp3 字节。文件落盘由调用方处理。
fn synthesize_via_v3(
    url: &str,
    api_key: &str,
    resource_id: &str,
    voice_id: &str,
    sample_rate: u32,
    timeout_ms: u64,
    log_path: &std::path::Path,
) -> Result<Vec<u8>, String> {
    let body = serde_json::json!({
        "req_params": {
            "text": PREVIEW_TEXT,
            "speaker": voice_id,
            "audio_params": { "format": "mp3", "sample_rate": sample_rate }
        }
    });

    let agent = ureq::AgentBuilder::new()
        .timeout_read(std::time::Duration::from_millis(timeout_ms))
        .timeout_write(std::time::Duration::from_millis(timeout_ms))
        .build();

    let resp = match agent
        .post(url)
        .set("Content-Type", "application/json")
        .set("X-Api-Key", api_key)
        .set("X-Api-Resource-Id", resource_id)
        .set("Connection", "keep-alive")
        .send_json(body)
    {
        Ok(r) => r,
        Err(ureq::Error::Status(status, r)) => {
            let detail = r
                .into_string()
                .unwrap_or_else(|e| format!("<读取响应体失败: {}>", e));
            let msg = classify_voice_error(status, &detail);
            crate::project_log::append_log(
                &log_path,
                "语音",
                "ERROR",
                &format!(
                    "试听合成失败（V3 HTTP {}）：voiceId={} detail={}",
                    status, voice_id, detail
                ),
            );
            return Err(msg);
        }
        Err(e) => {
            let msg = format!("语音合成请求失败：{}", e);
            crate::project_log::append_log(
                &log_path,
                "语音",
                "ERROR",
                &format!("试听合成请求异常：voiceId={} {}", voice_id, msg),
            );
            return Err(msg);
        }
    };

    let status = resp.status();
    if status < 200 || status >= 300 {
        let detail = resp
            .into_string()
            .unwrap_or_else(|e| format!("<读取响应体失败: {}>", e));
        let msg = classify_voice_error(status, &detail);
        crate::project_log::append_log(
            &log_path,
            "语音",
            "ERROR",
            &format!(
                "试听合成 HTTP 错误：voiceId={} status={} detail={}",
                voice_id, status, detail
            ),
        );
        return Err(msg);
    }

    let mut raw = Vec::new();
    resp.into_reader()
        .read_to_end(&mut raw)
        .map_err(|e| format!("读取音频流失败：{}", e))?;

    let audio_bytes: Vec<u8> = if raw.first().copied() == Some(b'{') {
        let mut data_b64 = String::new();
        let mut err_log: Option<(i64, String)> = None;
        for item in serde_json::Deserializer::from_slice(&raw).into_iter::<serde_json::Value>() {
            let v = match item {
                Ok(v) => v,
                Err(e) => {
                    err_log = Some((-1, format!("解析语音响应分集失败：{}", e)));
                    break;
                }
            };
            let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
            if code != 0 && code != 20000000 {
                let msg = v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .or_else(|| {
                        v.get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                    })
                    .unwrap_or("未知错误")
                    .to_string();
                err_log = Some((code, msg));
                break;
            }
            if let Some(d) = v.get("data").and_then(|d| d.as_str()) {
                data_b64.push_str(d);
            }
        }
        if let Some((code, msg)) = err_log {
            crate::project_log::append_log(
                &log_path,
                "语音",
                "ERROR",
                &format!(
                    "试听合成失败（V3 code={}）：voiceId={} message={}",
                    code, voice_id, msg
                ),
            );
            return Err(format!("语音合成失败：{}", msg));
        }
        if data_b64.is_empty() {
            return Err("语音响应未包含任何音频数据（data 为空）".into());
        }
        base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|e| format!("解码语音音频失败：{}", e))?
    } else {
        raw
    };

    // 校验 mp3 魔数
    let is_mp3 = audio_bytes.starts_with(b"ID3")
        || (audio_bytes.len() >= 2 && audio_bytes[0] == 0xFF && (audio_bytes[1] & 0xE0) == 0xE0);
    if !is_mp3 {
        crate::project_log::append_log(
            &log_path,
            "语音",
            "ERROR",
            &format!(
                "试听合成返回非 mp3 数据：voiceId={} head={:02X?}",
                voice_id,
                &audio_bytes[..audio_bytes.len().min(4)]
            ),
        );
        return Err("语音合成返回的数据不是 mp3 音频".into());
    }
    if audio_bytes.is_empty() {
        crate::project_log::append_log(
            &log_path,
            "语音",
            "ERROR",
            &format!("试听合成返回空音频：voiceId={}", voice_id),
        );
        return Err("语音合成返回空音频".into());
    }
    Ok(audio_bytes)
}

/// 将 V3 错误码/响应体转为用户可操作的提示
fn classify_voice_error(status: u16, detail: &str) -> String {
    // 优先提取响应体里的 message 字段（V3 错误 JSON 的常见形态）
    let parsed_msg = serde_json::from_str::<serde_json::Value>(detail)
        .ok()
        .and_then(|v| {
            v.get("message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        });

    if status == 401 {
        return format!("语音合成鉴权失败（HTTP 401）detail={}", detail);
    }
    if status == 403 {
        return format!("语音合成被拒绝（HTTP 403）detail={}", detail);
    }
    if status == 404 {
        return format!("语音合成失败（HTTP 404）detail={}", detail);
    }
    if let Some(msg) = parsed_msg {
        return format!("语音合成失败（HTTP {}）：{}", status, msg);
    }
    format!("语音合成失败 (HTTP {})：{}", status, detail)
}

/// 把 voice_id 规整为安全文件名（仅保留字母/数字/下划线）
fn sanitize_voice_filename(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 将试听音频路径回填到 public_voices 表（不存在则插入占位行）
fn upsert_sample_path(
    conn: &rusqlite::Connection,
    voice_id: &str,
    path: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO public_voices (voice_id, name, gender, age, language, tags, sample_audio_path) \
         VALUES (?1, ?1, '', '', '', '[]', ?2) \
         ON CONFLICT(voice_id) DO UPDATE SET sample_audio_path = excluded.sample_audio_path",
        rusqlite::params![voice_id, path],
    )?;
    Ok(())
}

/// 解析打包进应用的试听音频路径（兼容 Tauri 版本差异的扁平化行为）
fn resolve_bundled_voice(app: &AppHandle, voice_id: &str) -> Option<std::path::PathBuf> {
    let fname = format!("{}.mp3", sanitize_voice_filename(voice_id));
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(res_dir.join("resources").join("voices").join(&fname));
        // 某些情况下 `resources` 前缀被扁平化
        candidates.push(res_dir.join("voices").join(&fname));
    }
    // dev 源码树回退（cwd 通常为 src-tauri）
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("resources").join("voices").join(&fname));
        candidates.push(cwd.join("..").join("voices").join(&fname));
    }
    candidates.into_iter().find(|p| p.exists())
}

/// 计算试听音频应写入的源目录路径（src-tauri/resources/voices/<id>.mp3）
/// dev 时写入源树以便 git 提交和打包；prod 时写入 resource_dir。
fn bundled_voice_save_path(app: &AppHandle, voice_id: &str) -> std::path::PathBuf {
    let fname = format!("{}.mp3", sanitize_voice_filename(voice_id));
    // dev 优先：写到 src-tauri/resources/voices/（源树，git + 打包入口）
    if let Ok(cwd) = std::env::current_dir() {
        let dev_path = cwd.join("resources").join("voices").join(&fname);
        if dev_path.parent().map_or(false, |p| p.exists()) {
            return dev_path;
        }
    }
    // prod 回退：写到 resource_dir（打包后的资源目录）
    if let Ok(res_dir) = app.path().resource_dir() {
        return res_dir.join("resources").join("voices").join(&fname);
    }
    std::path::PathBuf::from("resources")
        .join("voices")
        .join(&fname)
}
