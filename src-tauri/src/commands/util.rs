//! 共享工具函数

use crate::sidecar::SharedSidecarManager;
use serde_json::{Map, Value};

/// 返回默认设置 JSON

pub(crate) fn default_settings_json() -> Value {
    serde_json::from_str(include_str!("../../../src/config/default-settings.json"))
        .expect("默认设置 JSON 解析失败（src/config/default-settings.json）")
}

// ── 渠道清洗 DSL ──────────────────────────────────────

/// 定义一组渠道 + 参数的清洗规格
struct ChannelSpec<'a> {
    key: &'a str,
    channel_fields: &'a [(&'a str, &'a str)],
    model_fields: &'a [(&'a str, &'a str)],
    param_keys: &'a [&'a str],
}

/// 清洗并补全设置 JSON，兼容旧版扁平格式自动迁移。

pub(crate) fn sanitize_settings(input: Value) -> Value {
    let default = default_settings_json();
    let source = input.as_object();
    let mut root = Map::new();

    // general 通用设置
    root.insert(
        "general".to_string(),
        sanitize_section(
            source.and_then(|obj| obj.get("general")),
            &default["general"],
            &["defaultProjectDir"],
        ),
    );

    // 渠道规格表 — 每个渠道类型一套
    let specs: &[ChannelSpec] = &[
        ChannelSpec {
            key: "text",
            channel_fields: &[("apiKey", ""), ("baseUrl", "")],
            model_fields: &[("id", "m1"), ("modelId", "")],
            param_keys: &["timeoutMs", "maxTokens", "temperature"],
        },
        ChannelSpec {
            key: "image",
            channel_fields: &[("apiKey", ""), ("baseUrl", "")],
            model_fields: &[("id", "m1"), ("modelId", "")],
            param_keys: &["timeoutMs"],
        },
        ChannelSpec {
            key: "voice",
            channel_fields: &[
                ("apiKey", ""),
                ("resourceId", ""),
                ("baseUrl", "https://openspeech.bytedance.com/api/v3/tts/unidirectional"),
                ("sampleRate", "24000"),
            ],
            model_fields: &[],
            param_keys: &["timeoutMs", "speed"],
        },
        ChannelSpec {
            key: "asset",
            channel_fields: &[("apiKey", ""), ("baseUrl", "")],
            model_fields: &[],
            param_keys: &["timeoutMs"],
        },
        ChannelSpec {
            key: "video",
            channel_fields: &[("apiKey", ""), ("baseUrl", "")],
            model_fields: &[("id", "m1"), ("modelId", "")],
            param_keys: &["timeoutMs"],
        },
    ];

    for spec in specs {
        root.insert(
            spec.key.to_string(),
            sanitize_channel_list(
                source.and_then(|obj| obj.get(spec.key)),
                &default[spec.key],
                spec.channel_fields,
                spec.model_fields,
            ),
        );
        let params_key = format!("{}Params", spec.key);
        root.insert(
            params_key.clone(),
            sanitize_section(
                source.and_then(|obj| obj.get(&params_key)),
                &default[&params_key],
                spec.param_keys,
            ),
        );
    }

    Value::Object(root)
}

/// 按默认值补全单个配置节字段（默认值取自 default_section）
fn sanitize_section(source: Option<&Value>, default_section: &Value, keys: &[&str]) -> Value {
    let source_obj = source.and_then(Value::as_object);
    let mut section = Map::new();
    for key in keys {
        let value = source_obj
            .and_then(|obj| obj.get(*key))
            .cloned()
            .unwrap_or_else(|| default_section.get(*key).cloned().unwrap_or(Value::Null));
        section.insert((*key).to_string(), value);
    }
    Value::Object(section)
}

/// 清洗 ChannelList 节：支持旧版扁平对象迁移
fn sanitize_channel_list(
    source: Option<&Value>,
    default_section: &Value,
    channel_fields: &[(&str, &str)],
    model_fields: &[(&str, &str)],
) -> Value {
    let src = match source {
        Some(v) => v,
        None => return default_channel_list(default_section, channel_fields, model_fields),
    };

    // 新格式：{ channels: [...], activeId: "..." }
    if let Some(obj) = src.as_object() {
        if let Some(arr) = obj.get("channels").and_then(|v| v.as_array()) {
            let sanitized: Vec<Value> = arr
                .iter()
                .map(|ch| sanitize_channel(Some(ch), default_section, channel_fields, model_fields))
                .collect();
            let active_id = obj
                .get("activeId")
                .and_then(|v| v.as_str())
                .unwrap_or("default")
                .to_string();

            let mut result = Map::new();
            result.insert(
                "channels".to_string(),
                if sanitized.is_empty() {
                    Value::Array(vec![default_channel(
                        default_section,
                        channel_fields,
                        model_fields,
                    )])
                } else {
                    Value::Array(sanitized)
                },
            );
            result.insert("activeId".to_string(), Value::String(active_id));
            return Value::Object(result);
        }
    }

    // 旧格式：扁平对象 → 迁移为单渠道列表
    let channel = sanitize_channel(source, default_section, channel_fields, model_fields);
    let mut result = Map::new();
    result.insert("channels".to_string(), Value::Array(vec![channel]));
    result.insert("activeId".to_string(), Value::String("default".to_string()));
    Value::Object(result)
}

/// 默认 ChannelList（单渠道），字段默认值取自 default_section
fn default_channel_list(
    default_section: &Value,
    channel_fields: &[(&str, &str)],
    model_fields: &[(&str, &str)],
) -> Value {
    let channel = default_channel(default_section, channel_fields, model_fields);
    let mut result = Map::new();
    result.insert("channels".to_string(), Value::Array(vec![channel]));
    result.insert("activeId".to_string(), Value::String("default".to_string()));
    Value::Object(result)
}

/// 清洗单个渠道对象，字段默认值取自 default_section["channels"][0]
fn sanitize_channel(
    source: Option<&Value>,
    default_section: &Value,
    channel_fields: &[(&str, &str)],
    model_fields: &[(&str, &str)],
) -> Value {
    let default_ch = default_section
        .get("channels")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let src = source.and_then(Value::as_object);
    let mut ch = Map::new();

    // 渠道 ID 和名称
    let id = src
        .and_then(|o| o.get("id"))
        .and_then(|v| v.as_str())
        .or_else(|| default_ch.get("id").and_then(|v| v.as_str()))
        .unwrap_or("default")
        .to_string();
    let name = src
        .and_then(|o| o.get("name"))
        .and_then(|v| v.as_str())
        .or_else(|| default_ch.get("name").and_then(|v| v.as_str()))
        .unwrap_or("默认")
        .to_string();
    ch.insert("id".to_string(), Value::String(id));
    ch.insert("name".to_string(), Value::String(name));

    // 渠道字段
    for (key, _default) in channel_fields {
        let val = src
            .and_then(|o| o.get(*key))
            .cloned()
            .or_else(|| default_ch.get(*key).cloned())
            .unwrap_or(Value::String(String::new()));
        ch.insert((*key).to_string(), val);
    }

    // 模型列表
    if !model_fields.is_empty() {
        let models = src
            .and_then(|o| o.get("models"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|m| {
                        let m_src = m.as_object();
                        let mut mm = Map::new();
                        for (mk, _md) in model_fields {
                            let mv = m_src
                                .and_then(|o| o.get(*mk))
                                .cloned()
                                .or_else(|| {
                                    default_ch
                                        .get("models")
                                        .and_then(Value::as_array)
                                        .and_then(|a| a.first())
                                        .and_then(|o| o.get(*mk))
                                        .cloned()
                                })
                                .unwrap_or(Value::String(String::new()));
                            mm.insert((*mk).to_string(), mv);
                        }
                        // 保留用户在视频渠道配置的模型分辨率（数组），无则省略
                        if let Some(res) = m_src
                            .and_then(|o| o.get("resolutions"))
                            .and_then(|v| v.as_array())
                        {
                            mm.insert("resolutions".to_string(), Value::Array(res.clone()));
                        }
                        Value::Object(mm)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec![default_model_entry(default_section, model_fields)]);
        ch.insert("models".to_string(), Value::Array(models));

        let active_model = src
            .and_then(|o| o.get("activeModelId"))
            .and_then(|v| v.as_str())
            .or_else(|| default_ch.get("activeModelId").and_then(|v| v.as_str()))
            .unwrap_or("m1")
            .to_string();
        ch.insert("activeModelId".to_string(), Value::String(active_model));
    }

    Value::Object(ch)
}

/// 默认渠道（单条），字段默认值取自 default_section["channels"][0]
fn default_channel(
    default_section: &Value,
    channel_fields: &[(&str, &str)],
    model_fields: &[(&str, &str)],
) -> Value {
    let default_ch = default_section
        .get("channels")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let mut ch = Map::new();
    ch.insert("id".to_string(), json_str(&default_ch, "id", "default"));
    ch.insert("name".to_string(), json_str(&default_ch, "name", "默认"));

    for (key, _default) in channel_fields {
        let val = default_ch
            .get(*key)
            .cloned()
            .unwrap_or(Value::String(String::new()));
        ch.insert((*key).to_string(), val);
    }

    if !model_fields.is_empty() {
        ch.insert(
            "models".to_string(),
            Value::Array(vec![default_model_entry(default_section, model_fields)]),
        );
        ch.insert(
            "activeModelId".to_string(),
            json_str(&default_ch, "activeModelId", "m1"),
        );
    }

    Value::Object(ch)
}

fn json_str(v: &Value, key: &str, fallback: &str) -> Value {
    Value::String(
        v.get(key)
            .and_then(|x| x.as_str())
            .unwrap_or(fallback)
            .to_string(),
    )
}

fn default_model_entry(default_section: &Value, fields: &[(&str, &str)]) -> Value {
    let default_model = default_section
        .get("channels")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|c| c.get("models"))
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let mut m = Map::new();
    for (key, _default) in fields {
        let val = default_model
            .get(*key)
            .cloned()
            .unwrap_or(Value::String(String::new()));
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

/// 初始化数据库 Schema：启动时对比 schema.sql 与实际库结构，自动补全缺失的表/列/索引。
pub(crate) fn ensure_project_schema(
    db_path: &std::path::Path,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let conn = crate::db::init_db(db_path).map_err(|e| e.to_string())?;
    let schema_path = resolve_schema_path(app)?;
    crate::db::sync_schema(&conn, &schema_path).map_err(|e| e.to_string())?;
    // 播种公共音色清单（仅插元数据，不覆盖已缓存的样例音频）
    crate::commands::voice::seed_public_voices(&conn).map_err(|e| e.to_string())?;
    Ok(())
}

/// 打开应用数据库连接
pub(crate) fn open_app_conn(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    let db_path = crate::app_paths::app_db_path(app)?;
    crate::db::init_db(&db_path).map_err(|e| e.to_string())
}

/// 查询指定项目的工作区路径。
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

/// 解析 schema.sql 路径（权威 Schema 定义文件）
fn resolve_schema_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(app)?;
    let cwd = std::env::current_dir().unwrap_or_default();
    let candidates = [
        app_data_dir.join("migrations").join("schema.sql"),
        cwd.join("migrations").join("schema.sql"),
        cwd.join("..").join("migrations").join("schema.sql"),
    ];

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| "schema.sql not found".to_string())
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
pub(crate) fn ensure_worker_running(
    state: &SharedSidecarManager,
    app: &tauri::AppHandle,
    project_id: &str,
) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(app)?;
    let config_path = app_data_dir
        .join("settings.json")
        .to_string_lossy()
        .to_string();
    let db_path = crate::app_paths::app_db_path(app)?
        .to_string_lossy()
        .to_string();
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let log_path_str = log_path.to_string_lossy().to_string();

    let mut manager = state.lock().map_err(|e| e.to_string())?;

    // Worker 已运行 → 无需操作（全局唯一 Worker，不按项目区分）
    if manager.is_running() {
        return Ok(());
    }

    // Worker 未运行 → 启动（使用全局默认 workspace）
    crate::project_log::append_log(
        &log_path,
        "项目",
        "INFO",
        &format!("Worker 未运行，启动中（由 projectId={} 触发）", project_id),
    );

    let default_workspace = app_data_dir.join("workspace").to_string_lossy().to_string();
    std::fs::create_dir_all(&default_workspace).map_err(|e| e.to_string())?;

    let ffmpeg_path = crate::app_paths::ffmpeg_path(app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let ffprobe_path = crate::app_paths::ffprobe_path(app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    manager
        .start(
            &db_path,
            &default_workspace,
            &config_path,
            &log_path_str,
            &ffmpeg_path,
            &ffprobe_path,
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 向 Worker 发送 enqueue 命令，触发立即调度。
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
fn load_ark_config(app: &tauri::AppHandle) -> Result<ArkConfig, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(app)?;
    let settings_path = app_data_dir.join("settings.json");
    let settings_content =
        std::fs::read_to_string(&settings_path).map_err(|e| format!("读取设置文件失败：{}", e))?;
    let settings: Value =
        serde_json::from_str(&settings_content).map_err(|e| format!("解析设置文件失败：{}", e))?;
    let settings = sanitize_settings(settings);

    let asset = settings
        .get("asset")
        .and_then(|v| v.as_object())
        .ok_or("设置中缺少 asset 配置节")?;
    let channels = asset
        .get("channels")
        .and_then(|v| v.as_array())
        .ok_or("asset 配置缺少 channels")?;
    let active_id = asset
        .get("activeId")
        .and_then(|v| v.as_str())
        .unwrap_or("default");

    let active = channels
        .iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(active_id))
        .or_else(|| channels.first())
        .and_then(|v| v.as_object())
        .ok_or("asset 配置缺少可用渠道")?;

    let api_key = active
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let base_url = active
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // timeoutMs 从 assetParams 统一读取
    let timeout_ms = settings
        .get("assetParams")
        .and_then(|v| v.get("timeoutMs"))
        .and_then(|v| v.as_u64())
        .unwrap_or(300000);

    if api_key.is_empty() {
        return Err("素材管理 API Key 未配置".to_string());
    }
    if base_url.is_empty() {
        return Err("素材管理 Base URL 未配置".to_string());
    }

    Ok(ArkConfig {
        api_key,
        base_url,
        timeout_ms,
    })
}

/// 同步从方舟平台删除文件（直接 HTTP DELETE，不经过 Worker）
pub(crate) fn delete_ark_file_sync(app: &tauri::AppHandle, file_id: &str) -> Result<(), String> {
    let config = load_ark_config(app)?;

    let base_url = config.base_url.trim_end_matches('/');
    let encoded_id =
        percent_encoding::utf8_percent_encode(file_id, percent_encoding::NON_ALPHANUMERIC);
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
