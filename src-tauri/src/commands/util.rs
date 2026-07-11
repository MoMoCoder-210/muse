//! 共享工具函数
//!
//! @author yt @date 20260703

use crate::sidecar::SharedSidecarManager;
use serde_json::{Map, Value};

/// 返回默认设置 JSON
///
/// 每种类型使用 ChannelList + Params 双层结构。
/// 渠道仅含 key+url+models，调优参数统一在 xxxParams 中管理。
///
/// 同步点：须与 src/types/settings.ts 及 worker/src/config/defaults.ts 的
/// DEFAULT_* 三处保持一致（改一处需同步另外两处）。
///
/// @author yt @date 20260703
pub(crate) fn default_settings_json() -> Value {
    serde_json::json!({
        "text": {
            "channels": [{
                "id": "default", "name": "默认", "apiKey": "", "baseUrl": "",
                "models": [{ "id": "m1", "modelId": "" }],
                "activeModelId": "m1"
            }],
            "activeId": "default"
        },
        "textParams": { "timeoutMs": 300000, "maxTokens": 131072, "temperature": 0.7 },
        "image": {
            "channels": [{
                "id": "default", "name": "默认", "apiKey": "", "baseUrl": "",
                "models": [{ "id": "m1", "modelId": "" }],
                "activeModelId": "m1"
            }],
            "activeId": "default"
        },
        "imageParams": { "timeoutMs": 300000 },
        "voice": {
            "channels": [{
                "id": "default", "name": "默认", "apiKey": "", "baseUrl": "",
                "models": [{ "id": "m1", "modelId": "" }],
                "activeModelId": "m1"
            }],
            "activeId": "default"
        },
        "voiceParams": { "timeoutMs": 300000, "speed": 1.0 },
        "asset": {
            "channels": [{
                "id": "default", "name": "默认", "apiKey": "", "baseUrl": ""
            }],
            "activeId": "default"
        },
        "assetParams": { "timeoutMs": 300000 }
    })
}

/// 清洗并补全设置 JSON，兼容旧版扁平格式自动迁移
pub(crate) fn sanitize_settings(input: Value) -> Value {
    let mut root = Map::new();
    let source = input.as_object();

    // text 渠道（含 apiFormat）
    root.insert("text".to_string(), sanitize_channel_list(
        source.and_then(|obj| obj.get("text")),
        &[("apiKey", ""), ("baseUrl", "")],
        &[("id", "m1"), ("modelId", "")],
    ));
    // text 全局参数
    root.insert("textParams".to_string(), sanitize_section(
        source.and_then(|obj| obj.get("textParams")),
        &[("timeoutMs", "300000"), ("maxTokens", "131072"), ("temperature", "0.7")],
    ));

    // image 渠道
    root.insert("image".to_string(), sanitize_channel_list(
        source.and_then(|obj| obj.get("image")),
        &[("apiKey", ""), ("baseUrl", "")],
        &[("id", "m1"), ("modelId", "")],
    ));
    // image 参数
    root.insert("imageParams".to_string(), sanitize_section(
        source.and_then(|obj| obj.get("imageParams")),
        &[("timeoutMs", "300000")],
    ));

    // voice 渠道
    root.insert("voice".to_string(), sanitize_channel_list(
        source.and_then(|obj| obj.get("voice")),
        &[("apiKey", ""), ("baseUrl", "")],
        &[("id", "m1"), ("modelId", "")],
    ));
    // voice 参数
    root.insert("voiceParams".to_string(), sanitize_section(
        source.and_then(|obj| obj.get("voiceParams")),
        &[("timeoutMs", "300000"), ("speed", "1.0")],
    ));

    // asset 渠道（无 models）
    root.insert("asset".to_string(), sanitize_channel_list(
        source.and_then(|obj| obj.get("asset")),
        &[("apiKey", ""), ("baseUrl", "")],
        &[],
    ));
    // asset 参数
    root.insert("assetParams".to_string(), sanitize_section(
        source.and_then(|obj| obj.get("assetParams")),
        &[("timeoutMs", "300000")],
    ));

    Value::Object(root)
}

/// 按默认值补全单个配置节字段
fn sanitize_section(source: Option<&Value>, fields: &[(&str, &str)]) -> Value {
    let source_obj = source.and_then(Value::as_object);
    let mut section = Map::new();
    for (key, default) in fields {
        let value = source_obj.and_then(|obj| obj.get(*key)).cloned()
            .unwrap_or_else(|| {
                if let Ok(n) = default.parse::<f64>() { serde_json::json!(n) }
                else { Value::String(default.to_string()) }
            });
        section.insert((*key).to_string(), value);
    }
    Value::Object(section)
}

/// 清洗 ChannelList 节：支持旧版扁平对象迁移
fn sanitize_channel_list(
    source: Option<&Value>,
    channel_fields: &[(&str, &str)],
    model_fields: &[(&str, &str)],
) -> Value {
    let src = match source {
        Some(v) => v,
        None => return default_channel_list(channel_fields, model_fields),
    };

    // 新格式：{ channels: [...], activeId: "..." }
    if let Some(obj) = src.as_object() {
        if let Some(arr) = obj.get("channels").and_then(|v| v.as_array()) {
            let sanitized: Vec<Value> = arr.iter()
                .map(|ch| sanitize_channel(Some(ch), channel_fields, model_fields))
                .collect();
            let active_id = obj.get("activeId")
                .and_then(|v| v.as_str())
                .unwrap_or("default")
                .to_string();

            let mut result = Map::new();
            result.insert("channels".to_string(),
                if sanitized.is_empty() { Value::Array(vec![default_channel(channel_fields, model_fields)]) }
                else { Value::Array(sanitized) });
            result.insert("activeId".to_string(), Value::String(active_id));
            return Value::Object(result);
        }
    }

    // 旧格式：扁平对象 → 迁移为单渠道列表
    let channel = sanitize_channel(source, channel_fields, model_fields);
    let mut result = Map::new();
    result.insert("channels".to_string(), Value::Array(vec![channel]));
    result.insert("activeId".to_string(), Value::String("default".to_string()));
    Value::Object(result)
}

/// 默认 ChannelList（单渠道）
fn default_channel_list(
    channel_fields: &[(&str, &str)],
    model_fields: &[(&str, &str)],
) -> Value {
    let channel = default_channel(channel_fields, model_fields);
    let mut result = Map::new();
    result.insert("channels".to_string(), Value::Array(vec![channel]));
    result.insert("activeId".to_string(), Value::String("default".to_string()));
    Value::Object(result)
}

/// 清洗单个渠道对象
fn sanitize_channel(
    source: Option<&Value>,
    channel_fields: &[(&str, &str)],
    model_fields: &[(&str, &str)],
) -> Value {
    let src = source.and_then(Value::as_object);
    let mut ch = Map::new();

    // 渠道 ID 和名称
    let id = src.and_then(|o| o.get("id")).and_then(|v| v.as_str()).unwrap_or("default").to_string();
    let name = src.and_then(|o| o.get("name")).and_then(|v| v.as_str()).unwrap_or("默认").to_string();
    ch.insert("id".to_string(), Value::String(id));
    ch.insert("name".to_string(), Value::String(name));

    // 渠道字段
    for (key, default) in channel_fields {
        let val = src.and_then(|o| o.get(*key)).cloned()
            .unwrap_or_else(|| {
                if let Ok(n) = default.parse::<f64>() {
                    serde_json::json!(n)
                } else {
                    Value::String(default.to_string())
                }
            });
        ch.insert((*key).to_string(), val);
    }

    // 模型列表
    if !model_fields.is_empty() {
        let models = src.and_then(|o| o.get("models")).and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter().map(|m| {
                    let m_src = m.as_object();
                    let mut mm = Map::new();
                    for (mk, md) in model_fields {
                        let mv = m_src.and_then(|o| o.get(*mk)).cloned()
                            .unwrap_or_else(|| {
                                if let Ok(n) = md.parse::<f64>() {
                                    serde_json::json!(n)
                                } else {
                                    Value::String(md.to_string())
                                }
                            });
                        mm.insert((*mk).to_string(), mv);
                    }
                    Value::Object(mm)
                }).collect::<Vec<_>>()
            }).unwrap_or_else(|| {
                vec![default_model_entry(model_fields)]
            });
        ch.insert("models".to_string(), Value::Array(models));

        let active_model = src.and_then(|o| o.get("activeModelId"))
            .and_then(|v| v.as_str())
            .unwrap_or("m1")
            .to_string();
        ch.insert("activeModelId".to_string(), Value::String(active_model));
    }

    Value::Object(ch)
}

/// 生成默认渠道（单条）
fn default_channel(
    channel_fields: &[(&str, &str)],
    model_fields: &[(&str, &str)],
) -> Value {
    let mut ch = Map::new();
    ch.insert("id".to_string(), Value::String("default".to_string()));
    ch.insert("name".to_string(), Value::String("默认".to_string()));

    for (key, default) in channel_fields {
        let val = if let Ok(n) = default.parse::<f64>() {
            serde_json::json!(n)
        } else {
            Value::String(default.to_string())
        };
        ch.insert((*key).to_string(), val);
    }

    if !model_fields.is_empty() {
        ch.insert("models".to_string(), Value::Array(vec![default_model_entry(model_fields)]));
        ch.insert("activeModelId".to_string(), Value::String("m1".to_string()));
    }

    Value::Object(ch)
}

fn default_model_entry(fields: &[(&str, &str)]) -> Value {
    let mut m = Map::new();
    for (key, default) in fields {
        let val = if let Ok(n) = default.parse::<f64>() {
            serde_json::json!(n)
        } else {
            Value::String(default.to_string())
        };
        m.insert((*key).to_string(), val);
    }
    Value::Object(m)
}

/// 解析工作区路径
/// 始终为项目创建独立子目录，避免多个项目文件混在同一目录下。
pub(crate) fn resolve_workspace_path(
    workspace_path: &str,
    project_name: &str,
    project_id: &str,
) -> std::path::PathBuf {
    let slug = crate::app_paths::sanitize_project_dir_name(project_name);
    let short_id: String = project_id.chars().take(8).collect();
    let dir_name = format!("{}-{}", slug, short_id);

    if !workspace_path.trim().is_empty() {
        return std::path::PathBuf::from(workspace_path).join(dir_name);
    }

    crate::app_paths::default_projects_root().join(dir_name)
}

/// 初始化数据库 Schema 并运行迁移
pub(crate) fn ensure_project_schema(
    db_path: &std::path::Path,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let conn = crate::db::init_db(db_path).map_err(|e| e.to_string())?;
    let migrations_dir = resolve_migrations_dir(app)?;
    crate::db::run_migrations(&conn, &migrations_dir).map_err(|e| e.to_string())?;
    Ok(())
}

/// 打开应用数据库连接
pub(crate) fn open_app_conn(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    let db_path = crate::app_paths::app_db_path(app)?;
    crate::db::init_db(&db_path).map_err(|e| e.to_string())
}

/// 查询指定项目的工作区路径。
///
/// @author yt @date 20260703
pub(crate) fn get_project_workspace_path(
    app: &tauri::AppHandle,
    project_id: &str,
) -> Result<String, String> {
    let conn = open_app_conn(app)?;
    conn.query_row(
        "SELECT workspace_path FROM projects WHERE id = ?1",
        rusqlite::params![project_id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|e| e.to_string())
}

/// 解析迁移脚本目录
fn resolve_migrations_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(app)?;
    let cwd = std::env::current_dir().unwrap_or_default();
    let candidates = [
        app_data_dir.join("migrations"),
        cwd.join("migrations"),
        cwd.join("..").join("migrations"),
    ];

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| "Migrations directory not found".to_string())
}

/// 规范化文本内容
pub(crate) fn normalize_text(text: &str) -> String {
    let text = text.trim_start_matches('\u{FEFF}');
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text: String = text
        .chars()
        .filter(|&c| c != '\u{200B}' && c != '\u{200C}' && c != '\u{200D}' && c != '\u{FEFF}')
        .collect();
    text.trim().to_string()
}

/// 确保 Worker 进程在线：已运行则跳过，否则启动。
///
/// Worker 随应用启动后全局唯一，通过全局 db 访问所有项目数据，
/// 不再按项目 workspace_path 区分。切换项目不会导致 Worker 重启。
///
/// @author yt @date 20260703
pub(crate) fn ensure_worker_running(
    state: &SharedSidecarManager,
    app: &tauri::AppHandle,
    project_id: &str,
) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(app)?;
    let config_path = app_data_dir.join("settings.json").to_string_lossy().to_string();
    let db_path = crate::app_paths::app_db_path(app)?.to_string_lossy().to_string();
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let log_path_str = log_path.to_string_lossy().to_string();

    let mut manager = state.lock().map_err(|e| e.to_string())?;

    // Worker 已运行 → 无需操作（全局唯一 Worker，不按项目区分）
    if manager.is_running() {
        return Ok(());
    }

    // Worker 未运行 → 启动（使用全局默认 workspace）
    crate::project_log::append_log(
        &log_path, "项目", "INFO",
        &format!("Worker 未运行，启动中（由 projectId={} 触发）", project_id),
    );

    let default_workspace = app_data_dir
        .join("workspace")
        .to_string_lossy()
        .to_string();
    std::fs::create_dir_all(&default_workspace).map_err(|e| e.to_string())?;

    let ffmpeg_path = crate::app_paths::ffmpeg_path(app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let ffprobe_path = crate::app_paths::ffprobe_path(app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    manager
        .start(&db_path, &default_workspace, &config_path, &log_path_str, &ffmpeg_path, &ffprobe_path)
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 向 Worker 发送 enqueue 命令，触发立即调度。
///
/// @author yt @date 20260703
pub(crate) fn send_enqueue_to_worker(
    state: &SharedSidecarManager,
    task_id: &str,
    task_type: &str,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager
        .send_enqueue(task_id, task_type)
        .map_err(|e| e.to_string())
}

/// 向 Worker 发送 cancel 命令，中止指定任务。
///
/// @author yt @date 20260703
pub(crate) fn send_cancel_to_worker(
    state: &SharedSidecarManager,
    task_id: &str,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.send_cancel(task_id).map_err(|e| e.to_string())
}

/// 方舟平台 API 配置（从 settings.json 的 asset 节读取）
struct ArkConfig {
    api_key: String,
    base_url: String,
    timeout_ms: u64,
}

/// 从 settings.json 的 asset.channels 中取活跃渠道
///
/// @author yt @date 20260707
fn load_ark_config(app: &tauri::AppHandle) -> Result<ArkConfig, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(app)?;
    let settings_path = app_data_dir.join("settings.json");
    let settings_content = std::fs::read_to_string(&settings_path)
        .map_err(|e| format!("读取设置文件失败：{}", e))?;
    let settings: Value = serde_json::from_str(&settings_content)
        .map_err(|e| format!("解析设置文件失败：{}", e))?;
    let settings = sanitize_settings(settings);

    let asset = settings.get("asset").and_then(|v| v.as_object())
        .ok_or("设置中缺少 asset 配置节")?;
    let channels = asset.get("channels").and_then(|v| v.as_array())
        .ok_or("asset 配置缺少 channels")?;
    let active_id = asset.get("activeId").and_then(|v| v.as_str()).unwrap_or("default");

    let active = channels.iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(active_id))
        .or_else(|| channels.first())
        .and_then(|v| v.as_object())
        .ok_or("asset 配置缺少可用渠道")?;

    let api_key = active.get("apiKey").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let base_url = active.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // timeoutMs 从 assetParams 统一读取
    let timeout_ms = settings.get("assetParams")
        .and_then(|v| v.get("timeoutMs"))
        .and_then(|v| v.as_u64())
        .unwrap_or(300000);

    if api_key.is_empty() { return Err("素材管理 API Key 未配置".to_string()); }
    if base_url.is_empty() { return Err("素材管理 Base URL 未配置".to_string()); }

    Ok(ArkConfig { api_key, base_url, timeout_ms })
}

/// 同步上传本地图片到方舟平台，返回 file_id。
///
/// 使用 ureq 直接发起 HTTP 请求，阻塞当前线程直到完成。
/// 用于导入本地图片时同步上传到方舟平台。
///
/// @author yt @date 20260707
pub(crate) fn upload_ark_file_sync(
    app: &tauri::AppHandle,
    file_path: &str,
) -> Result<String, String> {
    use std::fs;

    let config = load_ark_config(app)?;

    // 读取文件内容
    let file_data = fs::read(file_path)
        .map_err(|e| format!("读取文件失败：{}", e))?;
    let file_name = std::path::Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown.png");

    // 推断 MIME 类型
    let ext = std::path::Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let mime_type = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    };

    // 构建 multipart/form-data
    let boundary = format!("----MuseUpload{}", chrono::Utc::now().timestamp_millis());
    let mut body = Vec::new();

    // file 字段
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(format!("Content-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\n", file_name).as_bytes());
    body.extend_from_slice(format!("Content-Type: {}\r\n\r\n", mime_type).as_bytes());
    body.extend_from_slice(&file_data);
    body.extend_from_slice(b"\r\n");

    // purpose 字段
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"purpose\"\r\n\r\n");
    body.extend_from_slice(b"user_data");
    body.extend_from_slice(b"\r\n");

    // 结束边界
    body.extend_from_slice(format!("--{}--\r\n", boundary).as_bytes());

    let base_url = config.base_url.trim_end_matches('/');
    let url = format!("{}/v3/files", base_url);

    let timeout = std::time::Duration::from_millis(config.timeout_ms);
    let agent = ureq::AgentBuilder::new()
        .timeout_read(timeout)
        .timeout_write(timeout)
        .build();

    let response = agent
        .post(&url)
        .set("Authorization", &format!("Bearer {}", config.api_key))
        .set("Content-Type", &format!("multipart/form-data; boundary={}", boundary))
        .send_bytes(&body)
        .map_err(|e| format!("方舟文件上传失败：{}", e))?;

    if response.status() >= 400 {
        return Err(format!("方舟文件上传失败：HTTP {}", response.status()));
    }

    let response_body: Value = response.into_json()
        .map_err(|e| format!("解析响应失败：{}", e))?;

    let file_id = response_body.get("id")
        .and_then(|v| v.as_str())
        .ok_or("响应中缺少 file id")?
        .to_string();

    Ok(file_id)
}

/// 同步从方舟平台删除文件（直接 HTTP DELETE，不经过 Worker）。
///
/// 从 settings.json 的 asset 节读取 apiKey / baseUrl / timeoutMs。
/// 若配置缺失或 API 调用失败则返回错误。
///
/// @author yt @date 20260707
pub(crate) fn delete_ark_file_sync(
    app: &tauri::AppHandle,
    file_id: &str,
) -> Result<(), String> {
    let config = load_ark_config(app)?;

    let base_url = config.base_url.trim_end_matches('/');
    let encoded_id = percent_encoding::utf8_percent_encode(
        file_id,
        percent_encoding::NON_ALPHANUMERIC,
    );
    let url = format!("{}/v3/files/{}", base_url, encoded_id);

    let timeout = std::time::Duration::from_millis(config.timeout_ms);
    let agent = ureq::AgentBuilder::new()
        .timeout_read(timeout)
        .timeout_write(timeout)
        .build();

    let resp = agent
        .delete(&url)
        .set("Authorization", &format!("Bearer {}", config.api_key))
        .call()
        .map_err(|e| format!("方舟文件删除失败：{}", e))?;

    if resp.status() >= 400 {
        return Err(format!("方舟文件删除失败：HTTP {}", resp.status()));
    }

    Ok(())
}


