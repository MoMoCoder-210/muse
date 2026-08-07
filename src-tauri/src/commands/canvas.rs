//! Agent canvas 的项目范围只读层级快照。
//!
//! 这个命令只读取一个项目的已存在记录，绝不写业务数据，也不会通过镜头引用
//! 推断或改变素材所有权。前端以该快照作为唯一的画布刷新来源。

use std::collections::HashMap;

use serde::Serialize;

use super::util;

#[derive(Debug, Serialize)]
pub struct ProjectCanvasReadModel {
    pub project: CanvasProject,
    pub clips: Vec<CanvasClip>,
    /// 每个真实 asset 恰好出现一次。`clip_id == None` 表示项目共享素材。
    pub assets: Vec<CanvasAsset>,
    pub storyboards: Vec<CanvasStoryboard>,
    /// Real persisted final-output versions; this read model never manufactures one.
    pub concat_outputs: Vec<CanvasConcatOutput>,
}

#[derive(Debug, Serialize)]
pub struct CanvasProject {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub current_step: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct CanvasClip {
    pub id: String,
    pub project_id: String,
    pub sort_index: i64,
    pub title: String,
    pub summary: String,
    pub estimated_duration: Option<f64>,
    pub status: String,
    pub current_step: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct CanvasAsset {
    pub id: String,
    pub project_id: String,
    /// NULL 或遗留空字符串都规范为 None，表示项目共享素材。
    pub clip_id: Option<String>,
    pub r#type: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub selected_image_path: Option<String>,
    pub images: Vec<CanvasAssetImage>,
    pub tasks: Vec<CanvasAssetTask>,
}

#[derive(Debug, Serialize)]
pub struct CanvasAssetImage {
    pub id: String,
    pub image_path: String,
    pub size: Option<String>,
    pub is_selected: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct CanvasAssetTask {
    pub id: String,
    pub task_type: String,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct CanvasStoryboard {
    pub id: String,
    pub project_id: String,
    pub clip_id: String,
    /// The user-selected video when one exists; canvas readiness never guesses a selection.
    pub selected_video_id: Option<String>,
    pub sbid: String,
    pub seq_num: i32,
    pub summary: String,
    pub dialogue: String,
    pub image_state: String,
    pub voice_state: String,
    pub video_state: String,
    pub video_duration: Option<f64>,
    /// 仅来自本镜头 video_param_json.mention_map，且只保留本项目的 canonical asset。
    pub asset_references: Vec<CanvasAssetReference>,
    pub video_tasks: Vec<CanvasStoryboardTask>,
    pub videos: Vec<CanvasStoryboardVideo>,
    /// 仅 task_type='video' 的真实镜头超分任务。
    pub upscale_tasks: Vec<CanvasUpscaleTask>,
}

#[derive(Debug, Serialize)]
pub struct CanvasAssetReference {
    pub asset_id: String,
    pub index: i32,
    pub asset_tag: String,
}

#[derive(Debug, Serialize)]
pub struct CanvasStoryboardTask {
    pub id: String,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct CanvasStoryboardVideo {
    pub id: String,
    pub file_path: String,
    pub file_name: String,
    pub source: String,
    pub task_id: Option<String>,
    pub duration: Option<f64>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct CanvasUpscaleTask {
    pub id: String,
    pub video_id: String,
    pub model: String,
    pub scale: i64,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: String,
}

/// A persisted concat/upscale output. This is deliberately read-only so the
/// canvas can distinguish a real final version from an empty/waiting state.
#[derive(Debug, Serialize)]
pub struct CanvasConcatOutput {
    pub id: String,
    pub project_id: String,
    pub clip_id: String,
    pub output_path: String,
    pub file_name: String,
    pub duration: f64,
    pub segment_count: i64,
    pub audio_included: bool,
    pub source: String,
    pub created_at: String,
}

#[derive(Debug)]
struct RawStoryboard {
    id: String,
    project_id: String,
    clip_id: String,
    sbid: String,
    seq_num: i32,
    summary: String,
    dialogue: String,
    image_state: String,
    voice_state: String,
    video_state: String,
    video_duration: Option<f64>,
    selected_video_id: Option<String>,
    video_param_json: Option<String>,
}

/// 一次性读取画布所需的、项目范围内的全部只读实体。
///
/// 每个查询都以 project_id 参数化限定；镜头和素材额外通过存活的 clip 校验，
/// 从而不会因旧的跨项目/已删除引用把数据泄漏到该项目画布。
#[tauri::command]
pub fn get_project_canvas_read_model(
    project_id: String,
    app: tauri::AppHandle,
) -> Result<ProjectCanvasReadModel, String> {
    let conn = util::open_app_conn(&app)?;

    let project = conn
        .query_row(
            "SELECT id, name, description, status, current_step, created_at
             FROM projects WHERE id = ?1",
            rusqlite::params![&project_id],
            |row| {
                Ok(CanvasProject {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    status: row.get(3)?,
                    current_step: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )
        .map_err(|_| "作品不存在".to_string())?;

    let clips = {
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, sort_index, title, summary, estimated_duration,
                        status, current_step, updated_at
                 FROM clips
                 WHERE project_id = ?1 AND deleted_at IS NULL
                 ORDER BY sort_index ASC, id ASC",
            )
            .map_err(|e| e.to_string())?;
        let clips = stmt
            .query_map(rusqlite::params![&project_id], |row| {
                Ok(CanvasClip {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    sort_index: row.get(2)?,
                    title: row.get(3)?,
                    summary: row.get(4)?,
                    estimated_duration: row.get(5)?,
                    status: row.get(6)?,
                    current_step: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        clips
    };

    let mut assets = {
        let mut stmt = conn
            .prepare(
                "SELECT a.id, a.project_id, a.clip_id, a.type, a.name, a.description, a.status,
                        (SELECT ai.image_path FROM asset_images ai
                         WHERE ai.id = a.selected_image_id LIMIT 1)
                 FROM assets a
                 WHERE a.project_id = ?1
                   AND (
                     a.clip_id IS NULL OR trim(a.clip_id) = ''
                     OR EXISTS (
                       SELECT 1 FROM clips c
                       WHERE c.id = a.clip_id AND c.project_id = ?1 AND c.deleted_at IS NULL
                     )
                   )
                 ORDER BY CASE WHEN a.clip_id IS NULL OR trim(a.clip_id) = '' THEN 0 ELSE 1 END,
                          a.clip_id ASC, a.type ASC, a.name ASC, a.id ASC",
            )
            .map_err(|e| e.to_string())?;
        let assets = stmt
            .query_map(rusqlite::params![&project_id], |row| {
                let clip_id: Option<String> = row.get(2)?;
                Ok(CanvasAsset {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    clip_id: clip_id.filter(|id| !id.trim().is_empty()),
                    r#type: row.get(3)?,
                    name: row.get(4)?,
                    description: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    status: row.get(6)?,
                    selected_image_path: row.get(7)?,
                    images: Vec::new(),
                    tasks: Vec::new(),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        assets
    };

    for asset in &mut assets {
        let mut image_stmt = conn
            .prepare(
                "SELECT id, image_path, size, is_selected, created_at
                 FROM asset_images WHERE asset_id = ?1
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| e.to_string())?;
        asset.images = image_stmt
            .query_map(rusqlite::params![&asset.id], |row| {
                Ok(CanvasAssetImage {
                    id: row.get(0)?,
                    image_path: row.get(1)?,
                    size: row.get(2)?,
                    is_selected: row.get::<_, i64>(3)? != 0,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        let mut task_stmt = conn
            .prepare(
                "SELECT id, type, status, error_message, created_at
                 FROM tasks
                 WHERE project_id = ?1 AND asset_id = ?2
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| e.to_string())?;
        asset.tasks = task_stmt
            .query_map(rusqlite::params![&project_id, &asset.id], |row| {
                Ok(CanvasAssetTask {
                    id: row.get(0)?,
                    task_type: row.get(1)?,
                    status: row.get(2)?,
                    error_message: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
    }
    let asset_ids: std::collections::HashSet<String> =
        assets.iter().map(|asset| asset.id.clone()).collect();

    let raw_storyboards = {
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.project_id, s.clip_id, s.sbid, s.seq_num, s.summary, s.dialogue,
                        s.image_state, s.voice_state, s.video_state, s.video_duration, s.selected_video_id, s.video_param_json
                 FROM storyboards s
                 JOIN clips c ON c.id = s.clip_id
                 WHERE s.project_id = ?1 AND c.project_id = ?1 AND c.deleted_at IS NULL
                 ORDER BY c.sort_index ASC, s.seq_num ASC, s.id ASC",
            )
            .map_err(|e| e.to_string())?;
        let storyboards = stmt
            .query_map(rusqlite::params![&project_id], |row| {
                Ok(RawStoryboard {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    clip_id: row.get(2)?,
                    sbid: row.get(3)?,
                    seq_num: row.get(4)?,
                    summary: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    dialogue: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    image_state: row.get(7)?,
                    voice_state: row.get(8)?,
                    video_state: row.get(9)?,
                    video_duration: row.get(10)?,
                    selected_video_id: row.get(11)?,
                    video_param_json: row.get(12)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        storyboards
    };

    let mut storyboards = Vec::with_capacity(raw_storyboards.len());
    for storyboard in raw_storyboards {
        let references = canonical_mentions(storyboard.video_param_json.as_deref(), &asset_ids);
        let mut task_stmt = conn
            .prepare(
                "SELECT id, status, error_message, created_at
                 FROM tasks
                 WHERE project_id = ?1 AND storyboard_id = ?2
                   AND type = 'generate_video'
                   AND status IN ('pending', 'running', 'failed')
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| e.to_string())?;
        let video_tasks = task_stmt
            .query_map(rusqlite::params![&project_id, &storyboard.id], |row| {
                Ok(CanvasStoryboardTask {
                    id: row.get(0)?,
                    status: row.get(1)?,
                    error_message: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        let mut video_stmt = conn
            .prepare(
                "SELECT id, file_path, file_name, source, task_id, duration, created_at
                 FROM storyboard_videos WHERE storyboard_id = ?1
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| e.to_string())?;
        let videos = video_stmt
            .query_map(rusqlite::params![&storyboard.id], |row| {
                Ok(CanvasStoryboardVideo {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    file_name: row.get(2)?,
                    source: row.get(3)?,
                    task_id: row.get(4)?,
                    duration: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        let mut upscale_stmt = conn
            .prepare(
                "SELECT id, video_id, model, scale, status, error_message, created_at
                 FROM upscale_jobs
                 WHERE storyboard_id = ?1 AND task_type = 'video'
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| e.to_string())?;
        let upscale_tasks = upscale_stmt
            .query_map(rusqlite::params![&storyboard.id], |row| {
                Ok(CanvasUpscaleTask {
                    id: row.get(0)?,
                    video_id: row.get(1)?,
                    model: row.get(2)?,
                    scale: row.get(3)?,
                    status: row.get(4)?,
                    error_message: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        storyboards.push(CanvasStoryboard {
            id: storyboard.id,
            project_id: storyboard.project_id,
            clip_id: storyboard.clip_id,
            selected_video_id: storyboard.selected_video_id,
            sbid: storyboard.sbid,
            seq_num: storyboard.seq_num,
            summary: storyboard.summary,
            dialogue: storyboard.dialogue,
            image_state: storyboard.image_state,
            voice_state: storyboard.voice_state,
            video_state: storyboard.video_state,
            video_duration: storyboard.video_duration,
            asset_references: references,
            video_tasks,
            videos,
            upscale_tasks,
        });
    }

    let concat_outputs = {
        let mut stmt = conn
            .prepare(
                "SELECT o.id, o.project_id, o.clip_id, o.output_path, o.file_name, o.duration,
                        o.segment_count, o.audio_included, o.source, o.created_at
                 FROM concat_outputs o
                 JOIN clips c ON c.id = o.clip_id
                 WHERE o.project_id = ?1 AND c.project_id = ?1 AND c.deleted_at IS NULL
                 ORDER BY o.clip_id ASC, o.created_at DESC, o.id DESC",
            )
            .map_err(|e| e.to_string())?;
        let outputs = stmt
            .query_map(rusqlite::params![&project_id], |row| {
                Ok(CanvasConcatOutput {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    clip_id: row.get(2)?,
                    output_path: row.get(3)?,
                    file_name: row.get(4)?,
                    duration: row.get(5)?,
                    segment_count: row.get(6)?,
                    audio_included: row.get::<_, i64>(7)? != 0,
                    source: row.get(8)?,
                    created_at: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        outputs
    };

    Ok(ProjectCanvasReadModel { project, clips, assets, storyboards, concat_outputs })
}

/// 从 mention_map 读取引用；不合规 JSON、无 canonical asset 的引用均安全忽略。
fn canonical_mentions(
    video_param_json: Option<&str>,
    canonical_asset_ids: &std::collections::HashSet<String>,
) -> Vec<CanvasAssetReference> {
    let Some(raw) = video_param_json else { return Vec::new() };
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(raw) else { return Vec::new() };
    let Some(entries) = payload.get("mention_map").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };

    let mut references = HashMap::<String, CanvasAssetReference>::new();
    for entry in entries {
        let Some(asset_id) = entry.get("assetId").and_then(serde_json::Value::as_str) else { continue };
        let Some(index) = entry.get("n").and_then(serde_json::Value::as_i64) else { continue };
        let Some(name) = entry.get("name").and_then(serde_json::Value::as_str) else { continue };
        if !(1..=i32::MAX as i64).contains(&index) || !canonical_asset_ids.contains(asset_id) {
            continue;
        }
        let asset_tag = entry
            .get("assetTag")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{}(@图片{})", name, index));
        references.insert(
            asset_id.to_owned(),
            CanvasAssetReference { asset_id: asset_id.to_owned(), index: index as i32, asset_tag },
        );
    }
    let mut values: Vec<_> = references.into_values().collect();
    values.sort_by(|left, right| left.index.cmp(&right.index).then_with(|| left.asset_id.cmp(&right.asset_id)));
    values
}
