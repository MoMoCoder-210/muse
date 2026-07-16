//! 项目相关命令

use crate::commands::util;
use crate::sidecar::SharedSidecarManager;
use serde::{Deserialize, Serialize};

/// 创建项目输入参数
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateProjectInput {
    pub name: String,
    pub description: Option<String>,
    pub workspace_path: String,
    pub input_mode: Option<String>,
    pub style_mode: Option<String>,
}

/// 项目信息
#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub workspace_path: String,
    pub status: String,
    pub current_step: String,
    pub style_mode: String,
    pub created_at: String,
}

pub fn prepare_app_runtime(app: &tauri::AppHandle) -> Result<(), String> {
    let db_path = crate::app_paths::app_db_path(app)?;
    util::ensure_project_schema(&db_path, app)
}

/// 创建新项目
#[tauri::command]
pub fn create_project(
    input: CreateProjectInput,
    app: tauri::AppHandle,
) -> Result<ProjectInfo, String> {
    let project_id = uuid::Uuid::new_v4().to_string();
    let input_mode = input.input_mode.unwrap_or_else(|| "empty".to_string());
    let style_mode = input.style_mode.unwrap_or_else(|| "国漫".to_string());
    let workspace = util::resolve_workspace_path(&input.workspace_path, &input.name, &project_id);

    let dirs = [
        "source/scripts",
        "clips",
        "assets/characters",
        "assets/scenes",
        "assets/items",
        "storyboards/draft",
        "storyboards/final",
        "audio",
        "video",
        "exports",
        "cache",
    ];
    for dir in &dirs {
        std::fs::create_dir_all(workspace.join(dir))
            .map_err(|e| format!("Failed to create directory {}: {}", dir, e))?;
    }

    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    crate::project_log::append_log(
        &log_path,
        "项目",
        "INFO",
        &format!(
            "创建项目 name={} mode={} style={}",
            input.name, input_mode, style_mode
        ),
    );

    let now = chrono::Utc::now().to_rfc3339();
    let conn = util::open_app_conn(&app)?;
    conn.execute(
        "INSERT INTO projects (id, name, description, workspace_path, input_mode, style_mode, status, current_step, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', 'project', ?7, ?7)",
        rusqlite::params![
            &project_id,
            &input.name,
            input.description.as_deref().unwrap_or(""),
            workspace.to_string_lossy().to_string(),
            &input_mode,
            &style_mode,
            &now,
        ],
    )
    .map_err(|e| e.to_string())?;

    let manifest = serde_json::json!({
        "projectId": &project_id,
        "projectName": &input.name,
        "workspaceVersion": 1,
        "schemaVersion": 1,
        "createdAt": &now,
        "updatedAt": &now,
        "defaultInputMode": &input_mode,
        "defaultStyleMode": &style_mode
    });
    let manifest_path = workspace.join("manifest.json");
    std::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .map_err(|e| format!("Failed to write manifest.json: {}", e))?;
    crate::project_log::append_log(
        &log_path,
        "项目",
        "INFO",
        &format!("项目已创建 projectId={}", project_id),
    );

    Ok(ProjectInfo {
        id: project_id,
        name: input.name,
        description: input.description.unwrap_or_default(),
        workspace_path: workspace.to_string_lossy().to_string(),
        status: "active".to_string(),
        current_step: "project".to_string(),
        style_mode,
        created_at: now,
    })
}

/// 获取项目详情
#[tauri::command]
pub fn get_project(project_id: String, app: tauri::AppHandle) -> Result<ProjectInfo, String> {
    let conn = util::open_app_conn(&app)?;
    conn.query_row(
        "SELECT id, name, description, workspace_path, status, current_step, style_mode, created_at
         FROM projects WHERE id = ?1",
        rusqlite::params![&project_id],
        |row| {
            Ok(ProjectInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                workspace_path: row.get(3)?,
                status: row.get(4)?,
                current_step: row.get(5)?,
                style_mode: row.get(6)?,
                created_at: row.get(7)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// 列出所有项目
#[tauri::command]
pub fn list_projects(app: tauri::AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let conn = util::open_app_conn(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, workspace_path, status, current_step, style_mode, created_at
             FROM projects ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([], |row| {
            Ok(ProjectInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                workspace_path: row.get(3)?,
                status: row.get(4)?,
                current_step: row.get(5)?,
                style_mode: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(projects)
}

/// 启动后台 Worker 进程
#[tauri::command]
pub fn start_worker(
    state: tauri::State<'_, SharedSidecarManager>,
    app: tauri::AppHandle,
    project_id: Option<String>,
) -> Result<String, String> {
    let project_id = project_id.ok_or_else(|| "project_id is required".to_string())?;
    util::ensure_worker_running(&state, &app, &project_id)?;
    Ok(state
        .lock()
        .map_err(|e| e.to_string())?
        .worker_id()
        .to_string())
}

/// 停止后台 Worker 进程
#[tauri::command]
pub fn stop_worker(state: tauri::State<'_, SharedSidecarManager>) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.shutdown(30000).map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除项目及关联数据
#[tauri::command]
pub fn delete_project(
    project_id: String,
    delete_files: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedSidecarManager>,
) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    // 先查出 workspace_path（删文件要用）
    let workspace_path = util::get_project_workspace_path(&app, &project_id)?;

    let mut conn = util::open_app_conn(&app)?;

    // ── 先取消 Worker 中该项目的 running 任务，避免写入冲突 ──
    // 查出该项目所有 running 状态的任务 ID
    let running_task_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM tasks WHERE project_id = ?1 AND status = 'running'")
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map(rusqlite::params![&project_id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?;
        ids.filter_map(|r| r.ok()).collect()
    };

    // 通知 Worker 取消每个正在运行的任务
    for task_id in &running_task_ids {
        if let Err(e) = util::send_cancel_to_worker(&state, task_id) {
            crate::project_log::append_log(
                &log_path,
                "项目",
                "WARN",
                &format!("取消运行中任务失败（任务可能已完成）：{}", e),
            );
        }
    }

    // ── 按外键依赖顺序删除关联记录 ──────────────────────────────
    // 依赖关系图（箭头表示 "被引用"，箭头尾端是子表/引用方）：
    //   task_locks ──► tasks ──► projects
    //   storyboard_videos ──► tasks ──► projects
    //   storyboard_videos ──► storyboards ──► projects
    //   storyboards (selected_video_id) ──► storyboard_videos (需先 NULL 再删)
    //   storyboard_assets ──► storyboards ──► projects
    //   asset_images ──► assets ──► projects
    //   clip_scripts ──► clips ──► projects
    //   concat_outputs ──► clips ──► projects   ← concat_outputs 必须在 clips 之前删除
    //   script_sources ──► projects
    //   exports ──► projects
    //
    // 删除口诀：子表先删，父表后删。新增表时请同步更新此列表。
    // ───────────────────────────────────────────────────────────
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 使用闭包包装事务操作，确保 ? 提前返回时自动 rollback
    let tx_result = (|| -> Result<(), String> {
        // 0. 前置：记录运行中任务数量（子查询不受后续删除影响）
        let split_task_count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE project_id = ?1 AND type = 'split_script' AND status IN ('pending', 'running')",
                rusqlite::params![&project_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let clip_task_count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE project_id = ?1 AND type = 'generate_clip_script' AND status IN ('pending', 'running')",
                rusqlite::params![&project_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // 1. task_locks（依赖 tasks.lock_key）
        tx.execute(
            "DELETE FROM task_locks WHERE lock_key IN (SELECT lock_key FROM tasks WHERE project_id = ?1)",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 2. 解除 storyboards → storyboard_videos 的循环引用
        tx.execute(
            "UPDATE storyboards SET selected_video_id = NULL WHERE project_id = ?1",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 3. storyboard_videos（依赖 storyboards.id + tasks.id，必须在这两张表之前删除）
        tx.execute(
            "DELETE FROM storyboard_videos WHERE storyboard_id IN (SELECT id FROM storyboards WHERE project_id = ?1)",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 4. tasks（storyboard_videos.task_id 已清，安全删除）
        tx.execute(
            "DELETE FROM tasks WHERE project_id = ?1",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 5. storyboard_assets（依赖 storyboards.id）
        tx.execute(
            "DELETE FROM storyboard_assets WHERE storyboard_id IN (SELECT id FROM storyboards WHERE project_id = ?1)",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 6. storyboards
        tx.execute(
            "DELETE FROM storyboards WHERE project_id = ?1",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 7. asset_images（依赖 assets.id）
        tx.execute(
            "DELETE FROM asset_images WHERE asset_id IN (SELECT id FROM assets WHERE project_id = ?1)",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 8. assets
        tx.execute(
            "DELETE FROM assets WHERE project_id = ?1",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 9. clip_scripts（依赖 clips.id）
        tx.execute(
            "DELETE FROM clip_scripts WHERE project_id = ?1",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 10. concat_outputs（依赖 clips.id，必须在 clips 之前删除）
        tx.execute(
            "DELETE FROM concat_outputs WHERE project_id = ?1",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 11. clips
        tx.execute(
            "DELETE FROM clips WHERE project_id = ?1",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 12. script_sources
        tx.execute(
            "DELETE FROM script_sources WHERE project_id = ?1",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 13. exports
        tx.execute(
            "DELETE FROM exports WHERE project_id = ?1",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 14. projects（根表，最后删除）
        tx.execute(
            "DELETE FROM projects WHERE id = ?1",
            rusqlite::params![&project_id],
        )
        .map_err(|e| e.to_string())?;

        // 记录已取消的任务
        if split_task_count > 0 {
            crate::project_log::append_log(
                &log_path,
                "拆解",
                "INFO",
                &format!("剧本拆解任务已取消（共{}个）", split_task_count),
            );
        }
        if clip_task_count > 0 {
            crate::project_log::append_log(
                &log_path,
                "拆解",
                "INFO",
                &format!("片段拆解任务已取消（共{}个）", clip_task_count),
            );
        }

        Ok(())
    })();

    match tx_result {
        Ok(()) => tx.commit().map_err(|e| e.to_string())?,
        Err(e) => {
            // 事务自动 rollback，记录错误
            crate::project_log::append_log(
                &log_path,
                "项目",
                "ERROR",
                &format!("删除项目事务失败，已回滚：{}", e),
            );
            return Err(e);
        }
    }

    crate::project_log::append_log(
        &log_path,
        "项目",
        "INFO",
        &format!(
            "项目已删除：projectId={} deleteFiles={}",
            project_id, delete_files
        ),
    );

    // 可选：删除工作区文件
    if delete_files {
        let ws = std::path::Path::new(&workspace_path);
        if ws.exists() {
            std::fs::remove_dir_all(ws).map_err(|e| {
                let msg = format!("删除工作区失败：{}", e);
                crate::project_log::append_log(&log_path, "项目", "ERROR", &msg);
                msg
            })?;
            crate::project_log::append_log(
                &log_path,
                "项目",
                "INFO",
                &format!("工作区已删除：{}", workspace_path),
            );
        }
    }

    Ok(())
}
