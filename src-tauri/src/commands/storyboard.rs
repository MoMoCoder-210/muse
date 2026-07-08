// 分镜查询与关联资产管理
//
// @author yt @date 20260707

use serde::Serialize;
use serde::Deserialize;

use super::util;

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
    pub video_path: Option<String>,
    pub video_duration: Option<f64>,
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
                    voice_path, voice_duration,
                    video_path, video_duration
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
                character_ids_json: row.get::<_, Option<String>>(10)?.unwrap_or_else(|| "[]".to_string()),
                scene_ids_json: row.get::<_, Option<String>>(11)?.unwrap_or_else(|| "[]".to_string()),
                item_ids_json: row.get::<_, Option<String>>(12)?.unwrap_or_else(|| "[]".to_string()),
                image_param_json: row.get(13)?,
                video_param_json: row.get(14)?,
                voice_param_json: row.get(15)?,
                image_state: row.get::<_, Option<String>>(16)?.unwrap_or_else(|| "pending".to_string()),
                voice_state: row.get::<_, Option<String>>(17)?.unwrap_or_else(|| "pending".to_string()),
                video_state: row.get::<_, Option<String>>(18)?.unwrap_or_else(|| "pending".to_string()),
                voice_path: row.get(19)?,
                voice_duration: row.get(20)?,
                video_path: row.get(21)?,
                video_duration: row.get(22)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

/// 查询指定片段的所有资产（含绑定图片路径），供分镜详情展示
#[tauri::command]
pub fn list_clip_assets(
    clip_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<StoryboardAssetInfo>, String> {
    let conn = util::open_app_conn(&app)?;

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
            Ok(StoryboardAssetInfo {
                asset_id: row.get(0)?,
                r#type: row.get(1)?,
                name: row.get(2)?,
                description: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                prompt: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                selected_image_path: row.get(5)?,
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
            insert.execute(rusqlite::params![&link_id, &input.storyboard_id, asset_id, "character"])
                .map_err(|e| e.to_string())?;
        }
        for asset_id in &input.scene_ids {
            let link_id = uuid::Uuid::new_v4().to_string();
            insert.execute(rusqlite::params![&link_id, &input.storyboard_id, asset_id, "scene"])
                .map_err(|e| e.to_string())?;
        }
        for asset_id in &input.item_ids {
            let link_id = uuid::Uuid::new_v4().to_string();
            insert.execute(rusqlite::params![&link_id, &input.storyboard_id, asset_id, "item"])
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
    let conn = util::open_app_conn(&app)?;

    // 获取当前片段的最大 seq_num
    let max_seq: Option<i32> = conn
        .query_row(
            "SELECT MAX(seq_num) FROM storyboards WHERE clip_id = ?1",
            rusqlite::params![&input.clip_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let next_seq = max_seq.unwrap_or(0) + 1;
    let sbid = if next_seq == 1 {
        "1-1".to_string()
    } else {
        format!("1-{}", next_seq)
    };

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();

    conn.execute(
        "INSERT INTO storyboards (id, project_id, clip_id, sbid, seq_num, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![&id, &input.project_id, &input.clip_id, &sbid, next_seq, &now, &now],
    )
    .map_err(|e| e.to_string())?;

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
        video_path: None,
        video_duration: None,
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

    // 删除分镜本身
    tx.execute(
        "DELETE FROM storyboards WHERE id = ?1",
        rusqlite::params![&input.storyboard_id],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "分镜",
        "INFO",
        &format!("已删除分镜 storyboardId={}", input.storyboard_id),
    );

    Ok(())
}
