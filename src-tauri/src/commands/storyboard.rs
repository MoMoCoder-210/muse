// 分镜查询与关联资产管理

use serde::Deserialize;
use serde::Serialize;

use super::util;
use crate::sidecar::SharedSidecarManager;

/// 分镜信息（前端展示用）
#[derive(Debug, Serialize)]
pub struct StoryboardInfo {
    pub id: String,
    pub project_id: String,
    pub clip_id: String,
    pub sbid: String,
    pub seq_num: i32,
    pub source_text: String,
    pub summary: String,
    pub dialogue: String,
    pub visual_description: String,
    pub video_prompt: String,
    pub character_ids_json: String,
    pub scene_ids_json: String,
    pub item_ids_json: String,
    pub image_param_json: Option<String>,
    pub video_param_json: Option<String>,
    pub voice_param_json: Option<String>,
    pub image_state: String,
    pub voice_state: String,
    pub video_state: String,
    pub voice_path: Option<String>,
    pub voice_duration: Option<f64>,
    pub video_duration: Option<f64>,
    pub selected_video_id: Option<String>,
}

/// 分镜关联资产简要信息
#[derive(Debug, Serialize)]
pub struct StoryboardAssetInfo {
    pub asset_id: String,
    pub r#type: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub selected_image_path: Option<String>,
    /// 分镜专属的稳定图片编号；未被该分镜引用时为 null。
    pub index: Option<i32>,
    /// 完整引用文本（资产名(@图片N)）；前端用它精确水合为一个胶囊。
    #[serde(rename = "assetTag")]
    pub asset_tag: Option<String>,
}

/// 查询指定片段的分镜列表（按 seq_num 排序）
#[tauri::command]
pub fn list_storyboards(
    clip_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<StoryboardInfo>, String> {
    let conn = util::open_app_conn(&app)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, clip_id, sbid, seq_num, source_text, summary, dialogue,
                    visual_description, video_prompt,
                    character_ids_json, scene_ids_json, item_ids_json,
                    image_param_json, video_param_json, voice_param_json,
                    image_state, voice_state, video_state,
                    voice_path, voice_duration, video_duration,
                    selected_video_id
             FROM storyboards
             WHERE clip_id = ?1
             ORDER BY seq_num ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(rusqlite::params![&clip_id], |row| {
            Ok(StoryboardInfo {
                id: row.get(0)?,
                project_id: row.get(1)?,
                clip_id: row.get(2)?,
                sbid: row.get::<_, String>(3)?.to_string(),
                seq_num: row.get(4)?,
                source_text: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                summary: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                dialogue: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                visual_description: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                video_prompt: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
                character_ids_json: row
                    .get::<_, Option<String>>(10)?
                    .unwrap_or_else(|| "[]".to_string()),
                scene_ids_json: row
                    .get::<_, Option<String>>(11)?
                    .unwrap_or_else(|| "[]".to_string()),
                item_ids_json: row
                    .get::<_, Option<String>>(12)?
                    .unwrap_or_else(|| "[]".to_string()),
                image_param_json: row.get(13)?,
                video_param_json: row.get(14)?,
                voice_param_json: row.get(15)?,
                image_state: row
                    .get::<_, Option<String>>(16)?
                    .unwrap_or_else(|| "pending".to_string()),
                voice_state: row
                    .get::<_, Option<String>>(17)?
                    .unwrap_or_else(|| "pending".to_string()),
                video_state: row
                    .get::<_, Option<String>>(18)?
                    .unwrap_or_else(|| "pending".to_string()),
                voice_path: row.get(19)?,
                voice_duration: row.get(20)?,
                video_duration: row.get(21)?,
                selected_video_id: row.get(22)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

/// 查询指定片段的资产；传入 storyboard_id 时，后端会按该分镜的 mention_map
/// 为每一项补齐 index 与 assetTag（资产名(@图片N)）。
#[tauri::command]
pub fn list_clip_assets(
    clip_id: String,
    storyboard_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<Vec<StoryboardAssetInfo>, String> {
    let conn = util::open_app_conn(&app)?;
    let mut mention_by_asset = std::collections::HashMap::<String, (i32, String)>::new();

    if let Some(id) = storyboard_id {
        let raw: Option<String> = conn
            .query_row(
                "SELECT video_param_json FROM storyboards WHERE id = ?1 AND clip_id = ?2",
                rusqlite::params![&id, &clip_id],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        if let Some(raw) = raw {
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(entries) = payload
                    .get("mention_map")
                    .and_then(|value| value.as_array())
                {
                    for entry in entries {
                        let asset_id = entry.get("assetId").and_then(|value| value.as_str());
                        let n = entry.get("n").and_then(|value| value.as_i64());
                        let name = entry.get("name").and_then(|value| value.as_str());
                        if let (Some(asset_id), Some(n), Some(name)) = (asset_id, n, name) {
                            if n < 1 || n > i32::MAX as i64 {
                                continue;
                            }
                            let tag = entry
                                .get("assetTag")
                                .and_then(|value| value.as_str())
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("{}(@图片{})", name, n));
                            mention_by_asset.insert(asset_id.to_string(), (n as i32, tag));
                        }
                    }
                }
            }
        }
    }

    let mut stmt = conn
        .prepare(
            "SELECT a.id, a.type, a.name, a.description, a.prompt,
                    (SELECT ai.image_path FROM asset_images ai WHERE ai.id = a.selected_image_id LIMIT 1)
             FROM assets a
             WHERE a.clip_id = ?1
             ORDER BY a.type, a.name",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(rusqlite::params![&clip_id], |row| {
            let asset_id: String = row.get(0)?;
            let mention = mention_by_asset.get(&asset_id);
            Ok(StoryboardAssetInfo {
                asset_id,
                r#type: row.get(1)?,
                name: row.get(2)?,
                description: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                prompt: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                selected_image_path: row.get(5)?,
                index: mention.map(|(index, _)| *index),
                asset_tag: mention.map(|(_, asset_tag)| asset_tag.clone()),
            })
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

/// 更新分镜关联资产输入
#[derive(Debug, Deserialize)]
pub struct UpdateStoryboardAssetsInput {
    pub storyboard_id: String,
    pub character_ids: Vec<String>,
    pub scene_ids: Vec<String>,
    pub item_ids: Vec<String>,
}

/// 更新分镜关联资产
///
/// 同时写入 storyboards 表的 *_ids_json 列和 storyboard_assets 关联表。
#[tauri::command]
pub fn update_storyboard_assets(
    input: UpdateStoryboardAssetsInput,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let char_json = serde_json::to_string(&input.character_ids).map_err(|e| e.to_string())?;
    let scene_json = serde_json::to_string(&input.scene_ids).map_err(|e| e.to_string())?;
    let item_json = serde_json::to_string(&input.item_ids).map_err(|e| e.to_string())?;

    // 更新 storyboards 表的 JSON 列
    tx.execute(
        "UPDATE storyboards SET character_ids_json = ?1, scene_ids_json = ?2, item_ids_json = ?3, updated_at = datetime('now') WHERE id = ?4",
        rusqlite::params![&char_json, &scene_json, &item_json, &input.storyboard_id],
    )
    .map_err(|e| e.to_string())?;

    // 重建 storyboard_assets 关联表
    tx.execute(
        "DELETE FROM storyboard_assets WHERE storyboard_id = ?1",
        rusqlite::params![&input.storyboard_id],
    )
    .map_err(|e| e.to_string())?;

    {
        let mut insert = tx.prepare(
            "INSERT INTO storyboard_assets (id, storyboard_id, asset_id, asset_type) VALUES (?1, ?2, ?3, ?4)",
        ).map_err(|e| e.to_string())?;

        for asset_id in &input.character_ids {
            let link_id = uuid::Uuid::new_v4().to_string();
            insert
                .execute(rusqlite::params![
                    &link_id,
                    &input.storyboard_id,
                    asset_id,
                    "character"
                ])
                .map_err(|e| e.to_string())?;
        }
        for asset_id in &input.scene_ids {
            let link_id = uuid::Uuid::new_v4().to_string();
            insert
                .execute(rusqlite::params![
                    &link_id,
                    &input.storyboard_id,
                    asset_id,
                    "scene"
                ])
                .map_err(|e| e.to_string())?;
        }
        for asset_id in &input.item_ids {
            let link_id = uuid::Uuid::new_v4().to_string();
            insert
                .execute(rusqlite::params![
                    &link_id,
                    &input.storyboard_id,
                    asset_id,
                    "item"
                ])
                .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "分镜",
        "INFO",
        &format!(
            "已更新分镜资产关联 storyboardId={} characters={} scenes={} items={}",
            input.storyboard_id,
            input.character_ids.len(),
            input.scene_ids.len(),
            input.item_ids.len()
        ),
    );

    Ok(())
}

// ── 分镜增删 ────────────────────────────────────────────

/// 新增分镜输入
#[derive(Debug, Deserialize)]
pub struct CreateStoryboardInput {
    pub clip_id: String,
    pub project_id: String,
}

/// 在当前片段的最大 seq_num 之后新增一个空分镜
#[tauri::command]
pub fn create_storyboard(
    input: CreateStoryboardInput,
    app: tauri::AppHandle,
) -> Result<StoryboardInfo, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 获取当前片段的最大 seq_num（事务内查询，防止并发竞争）
    let max_seq: Option<i32> = tx
        .query_row(
            "SELECT MAX(seq_num) FROM storyboards WHERE clip_id = ?1",
            rusqlite::params![&input.clip_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let next_seq = max_seq.unwrap_or(0) + 1;
    let sbid = next_seq.to_string();
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();

    tx.execute(
        "INSERT INTO storyboards (id, project_id, clip_id, sbid, seq_num, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            &id,
            &input.project_id,
            &input.clip_id,
            &sbid,
            next_seq,
            &now,
            &now
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "分镜",
        "INFO",
        &format!(
            "已新增分镜 id={} clipId={} sbid={} seq={}",
            id, input.clip_id, sbid, next_seq
        ),
    );

    Ok(StoryboardInfo {
        id: id.clone(),
        project_id: input.project_id,
        clip_id: input.clip_id,
        sbid,
        seq_num: next_seq,
        source_text: String::new(),
        summary: String::new(),
        dialogue: String::new(),
        visual_description: String::new(),
        video_prompt: String::new(),
        character_ids_json: "[]".to_string(),
        scene_ids_json: "[]".to_string(),
        item_ids_json: "[]".to_string(),
        image_param_json: None,
        video_param_json: None,
        voice_param_json: None,
        image_state: "pending".to_string(),
        voice_state: "pending".to_string(),
        video_state: "pending".to_string(),
        voice_path: None,
        voice_duration: None,
        video_duration: None,
        selected_video_id: None,
    })
}

/// 删除分镜输入
#[derive(Debug, Deserialize)]
pub struct DeleteStoryboardInput {
    pub storyboard_id: String,
}

/// 删除一个分镜，同时清理关联的 storyboard_assets 记录
#[tauri::command]
pub fn delete_storyboard(
    input: DeleteStoryboardInput,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 先删除关联表记录
    tx.execute(
        "DELETE FROM storyboard_assets WHERE storyboard_id = ?1",
        rusqlite::params![&input.storyboard_id],
    )
    .map_err(|e| e.to_string())?;

    // 获取被删除分镜的 clip_id 和 seq_num
    let (clip_id, deleted_seq): (String, i32) = tx
        .query_row(
            "SELECT clip_id, seq_num FROM storyboards WHERE id = ?1",
            rusqlite::params![&input.storyboard_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("分镜不存在：{}", e))?;

    // 删除分镜本身
    let affected = tx
        .execute(
            "DELETE FROM storyboards WHERE id = ?1",
            rusqlite::params![&input.storyboard_id],
        )
        .map_err(|e| e.to_string())?;

    if affected == 0 {
        return Err("分镜已被删除或不存在".to_string());
    }

    // 将后续分镜前移，消除序号空洞
    tx.execute(
        "UPDATE storyboards SET seq_num = seq_num - 1, updated_at = datetime('now') WHERE clip_id = ?1 AND seq_num > ?2",
        rusqlite::params![&clip_id, deleted_seq],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "分镜",
        "INFO",
        &format!(
            "已删除分镜 storyboardId={} clipId={} seq={}",
            input.storyboard_id, clip_id, deleted_seq
        ),
    );

    Ok(())
}

// ── 插入分镜（指定位置 + 自动重排） ──────────────

/// 插入分镜输入
#[derive(Debug, Deserialize)]
pub struct InsertStoryboardInput {
    pub clip_id: String,
    pub project_id: String,
    /// 插入到此分镜 ID 之后；为 None 则插入到最前面
    pub after_storyboard_id: Option<String>,
}

/// 在指定位置插入分镜，自动重排后续 seq_num
#[tauri::command]
pub fn insert_storyboard(
    input: InsertStoryboardInput,
    app: tauri::AppHandle,
) -> Result<StoryboardInfo, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 确定插入位置
    let insert_seq: i32 = match &input.after_storyboard_id {
        Some(target_id) => {
            let target_seq: i32 = tx
                .query_row(
                    "SELECT seq_num FROM storyboards WHERE id = ?1",
                    rusqlite::params![target_id],
                    |row| row.get(0),
                )
                .map_err(|e| format!("目标分镜不存在：{}", e))?;
            target_seq
        }
        None => 0, // 插入到最前面
    };

    let new_seq = insert_seq + 1;

    // 将 >= new_seq 的分镜后移一位
    tx.execute(
        "UPDATE storyboards SET seq_num = seq_num + 1, updated_at = datetime('now') WHERE clip_id = ?1 AND seq_num >= ?2",
        rusqlite::params![&input.clip_id, new_seq],
    )
    .map_err(|e| e.to_string())?;

    // 生成 sbid
    let sbid = new_seq.to_string();
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();

    tx.execute(
        "INSERT INTO storyboards (id, project_id, clip_id, sbid, seq_num, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            &id,
            &input.project_id,
            &input.clip_id,
            &sbid,
            new_seq,
            &now,
            &now
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "分镜",
        "INFO",
        &format!(
            "已插入分镜 id={} clipId={} sbid={} seq={} after={:?}",
            id, input.clip_id, sbid, new_seq, input.after_storyboard_id
        ),
    );

    Ok(StoryboardInfo {
        id: id.clone(),
        project_id: input.project_id,
        clip_id: input.clip_id,
        sbid,
        seq_num: new_seq,
        source_text: String::new(),
        summary: String::new(),
        dialogue: String::new(),
        visual_description: String::new(),
        video_prompt: String::new(),
        character_ids_json: "[]".to_string(),
        scene_ids_json: "[]".to_string(),
        item_ids_json: "[]".to_string(),
        image_param_json: None,
        video_param_json: None,
        voice_param_json: None,
        image_state: "pending".to_string(),
        voice_state: "pending".to_string(),
        video_state: "pending".to_string(),
        voice_path: None,
        voice_duration: None,
        video_duration: None,
        selected_video_id: None,
    })
}

// ── 更新分镜视频参数 ──────────────────────────────

/// 视频参数 JSON（前端自行序列化）
#[derive(Debug, Deserialize)]
pub struct UpdateStoryboardParamsInput {
    pub storyboard_id: String,
    /// JSON 字符串：{ model, duration, resolution, aspect_ratio }
    pub video_param_json: Option<String>,
    pub video_prompt: Option<String>,
}

/// 请求生成一个分镜视频。
///
/// 提示词与 mention_map 已在分镜上持久化，Worker 会在执行时再次从数据库读取，
/// 从而保证任务提交使用的是用户最后一次保存的 AST 序列化文本与稳定图片编号。
#[derive(Debug, Deserialize)]
pub struct GenerateStoryboardVideoInput {
    pub storyboard_id: String,
}

#[tauri::command]
pub fn generate_storyboard_video(
    input: GenerateStoryboardVideoInput,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedSidecarManager>,
) -> Result<serde_json::Value, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let mut conn = util::open_app_conn(&app)?;

    let (project_id, clip_id, prompt): (String, String, String) = conn
        .query_row(
            "SELECT project_id, clip_id, video_prompt FROM storyboards WHERE id = ?1",
            rusqlite::params![&input.storyboard_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            },
        )
        .map_err(|_| "分镜不存在".to_string())?;
    if prompt.trim().is_empty() {
        return Err("提示词为空，无法生成视频".to_string());
    }

    let lock_key = format!("generate_video:{}", input.storyboard_id);
    let duplicated: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE lock_key = ?1 AND status IN ('pending', 'running'))",
            rusqlite::params![&lock_key],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if duplicated {
        return Err("该分镜已有进行中的视频生成任务".to_string());
    }

    // 任务消费者必须先就绪，避免页面显示已提交但 Worker 永远不处理。
    util::ensure_worker_running(&state, &app, &project_id)?;

    let task_id = uuid::Uuid::new_v4().to_string();
    let input_json = serde_json::json!({
        "projectId": &project_id,
        "clipId": &clip_id,
        "storyboardId": &input.storyboard_id,
    })
    .to_string();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO tasks (id, project_id, clip_id, storyboard_id, type, status, lock_key, input_json, max_retry)
         VALUES (?1, ?2, ?3, ?4, 'generate_video', 'pending', ?5, ?6, 2)",
        rusqlite::params![&task_id, &project_id, &clip_id, &input.storyboard_id, &lock_key, &input_json],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE storyboards SET video_state = 'pending', updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![&input.storyboard_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "视频生成",
        "INFO",
        &format!(
            "视频任务已入队 storyboardId={} taskId={}",
            input.storyboard_id, task_id
        ),
    );
    if let Err(error) = util::send_enqueue_to_worker(&state, &task_id, "generate_video") {
        crate::project_log::append_log(
            &log_path,
            "视频生成",
            "WARN",
            &format!("发送 enqueue 通知失败（Worker 仍会轮询任务）：{}", error),
        );
    }

    Ok(serde_json::json!({ "task_id": task_id }))
}

/// 更新分镜的视频生成参数和提示词（失焦保存）
#[tauri::command]
pub fn update_storyboard_params(
    input: UpdateStoryboardParamsInput,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let conn = util::open_app_conn(&app)?;

    conn.execute(
        "UPDATE storyboards SET video_param_json = ?1, video_prompt = ?2, updated_at = datetime('now') WHERE id = ?3",
        rusqlite::params![&input.video_param_json, &input.video_prompt, &input.storyboard_id],
    )
    .map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "分镜",
        "INFO",
        &format!("已更新分镜视频参数 storyboardId={}", input.storyboard_id),
    );

    Ok(())
}

/// 实时更新分镜时长（秒），写回分镜记录本身（模型拆解的分镜秒数）
#[tauri::command]
pub fn update_storyboard_duration(
    input: UpdateStoryboardDurationInput,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let conn = util::open_app_conn(&app)?;

    conn.execute(
        "UPDATE storyboards SET video_duration = ?1, updated_at = datetime('now') WHERE id = ?2",
        rusqlite::params![&input.duration, &input.storyboard_id],
    )
    .map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "分镜",
        "INFO",
        &format!("已更新分镜时长 storyboardId={}", input.storyboard_id),
    );

    Ok(())
}

#[derive(Deserialize)]
pub struct UpdateStoryboardDurationInput {
    pub storyboard_id: String,
    /// 时长（秒）；null 表示清空
    pub duration: Option<f64>,
}

/// 将视频文件导入项目工作区
#[derive(Debug, Serialize)]
pub struct ImportVideoResult {
    pub file_path: String,
    pub file_name: String,
}

#[tauri::command]
pub fn import_video_file(
    clip_id: String,
    source_path: String,
    app: tauri::AppHandle,
) -> Result<ImportVideoResult, String> {
    let conn = util::open_app_conn(&app)?;
    let workspace: String = conn
        .query_row(
            "SELECT p.workspace_path FROM clips c JOIN projects p ON c.project_id = p.id WHERE c.id = ?1",
            rusqlite::params![&clip_id],
            |row| row.get(0),
        )
        .map_err(|_| "未找到项目工作区".to_string())?;

    let video_dir = std::path::PathBuf::from(&workspace).join("video");
    std::fs::create_dir_all(&video_dir).map_err(|e| format!("创建视频目录失败：{}", e))?;

    // 原始文件名仅用于界面展示，磁盘存储使用唯一名，避免同名视频互相覆盖
    let display_name = std::path::Path::new(&source_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("video.mp4")
        .to_string();

    // 生成唯一文件名：保留原始扩展名，前缀用 UUID，杜绝重名覆盖
    let ext = std::path::Path::new(&display_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    let unique_name = format!("{}{}", uuid::Uuid::new_v4().to_string(), ext);
    let dest = video_dir.join(&unique_name);

    std::fs::copy(&source_path, &dest).map_err(|e| format!("复制视频文件失败：{}", e))?;

    Ok(ImportVideoResult {
        file_path: dest.to_string_lossy().to_string(),
        file_name: display_name,
    })
}

/// 分镜视频记录（storyboard_videos 表）
#[derive(Debug, Serialize)]
pub struct StoryboardVideoInfo {
    pub id: String,
    pub storyboard_id: String,
    pub file_path: String,
    pub file_name: String,
    pub source: String,
    pub duration: Option<f64>,
}

/// 追加视频到分镜（INSERT storyboard_videos + 自动选中）
#[derive(Deserialize)]
pub struct AddStoryboardVideoInput {
    pub storyboard_id: String,
    pub video_path: String,
    pub file_name: Option<String>,
}

#[tauri::command]
pub fn add_storyboard_video(
    input: AddStoryboardVideoInput,
    app: tauri::AppHandle,
) -> Result<StoryboardVideoInfo, String> {
    let conn = util::open_app_conn(&app)?;
    let id = uuid::Uuid::new_v4().to_string();
    let fname = input.file_name.unwrap_or_else(|| {
        std::path::Path::new(&input.video_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("video.mp4")
            .to_string()
    });

    conn.execute(
        "INSERT INTO storyboard_videos (id, storyboard_id, file_path, file_name, source)
         VALUES (?1, ?2, ?3, ?4, 'manual')",
        rusqlite::params![&id, &input.storyboard_id, &input.video_path, &fname],
    )
    .map_err(|e| e.to_string())?;

    // 仅当分镜尚未绑定视频时才自动选中新上传的视频
    conn.execute(
        "UPDATE storyboards SET selected_video_id = ?1, updated_at = datetime('now')
         WHERE id = ?2 AND selected_video_id IS NULL",
        rusqlite::params![&id, &input.storyboard_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(StoryboardVideoInfo {
        id,
        storyboard_id: input.storyboard_id,
        file_path: input.video_path,
        file_name: fname,
        source: "manual".to_string(),
        duration: None,
    })
}

/// 切换分镜选中的视频
#[derive(Deserialize)]
pub struct SelectStoryboardVideoInput {
    pub storyboard_id: String,
    pub video_id: String,
}

#[tauri::command]
pub fn select_storyboard_video(
    input: SelectStoryboardVideoInput,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let conn = util::open_app_conn(&app)?;
    conn.execute(
        "UPDATE storyboards SET selected_video_id = ?1, updated_at = datetime('now') WHERE id = ?2",
        rusqlite::params![&input.video_id, &input.storyboard_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 列出分镜的所有视频
#[tauri::command]
pub fn list_storyboard_videos(
    storyboard_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<StoryboardVideoInfo>, String> {
    let conn = util::open_app_conn(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, storyboard_id, file_path, file_name, source, duration
             FROM storyboard_videos WHERE storyboard_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(rusqlite::params![&storyboard_id], |row| {
            Ok(StoryboardVideoInfo {
                id: row.get(0)?,
                storyboard_id: row.get(1)?,
                file_path: row.get(2)?,
                file_name: row.get(3)?,
                source: row.get(4)?,
                duration: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for r in rows {
        results.push(r.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

/// 删除分镜视频输入
#[derive(Deserialize)]
pub struct DeleteStoryboardVideoInput {
    pub storyboard_id: String,
    pub video_id: String,
    /// 是否同时删除磁盘视频文件，默认 true
    #[serde(default = "default_delete_file")]
    pub delete_file: bool,
}

fn default_delete_file() -> bool {
    true
}

/// 删除分镜视频（数据库记录，可选同时删除文件）
#[tauri::command]
pub fn delete_storyboard_video(
    input: DeleteStoryboardVideoInput,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let conn = util::open_app_conn(&app)?;

    // 获取文件路径（仅在需要删除文件时）
    let file_path = if input.delete_file {
        conn.query_row(
            "SELECT file_path FROM storyboard_videos WHERE id = ?1 AND storyboard_id = ?2",
            rusqlite::params![&input.video_id, &input.storyboard_id],
            |row| row.get::<_, String>(0),
        )
        .ok()
    } else {
        None
    };

    // 删除数据库记录——若该视频被 storyboards.selected_video_id 引用，
    // SQLite 外键约束会阻止删除并返回 FOREIGN KEY 错误
    let affected = conn
        .execute(
            "DELETE FROM storyboard_videos WHERE id = ?1 AND storyboard_id = ?2",
            rusqlite::params![&input.video_id, &input.storyboard_id],
        )
        .map_err(|e| {
            let msg = e.to_string();
            if msg.to_lowercase().contains("foreign key") {
                "该视频已被设为分镜最终视频，请先更换或取消选中后再删除".to_string()
            } else {
                format!("删除失败：{}", msg)
            }
        })?;

    if affected == 0 {
        return Err("视频记录不存在".to_string());
    }

    // 可选删除磁盘文件
    if let Some(p) = file_path {
        let _ = std::fs::remove_file(&p);
    }

    // 清除该分镜对该视频的选中引用（若刚刚删除的并非当前选中视频则无影响）
    let _ = conn.execute(
        "UPDATE storyboards SET selected_video_id = NULL, updated_at = datetime('now')
         WHERE id = ?1 AND selected_video_id = ?2",
        rusqlite::params![&input.storyboard_id, &input.video_id],
    );

    Ok(())
}
