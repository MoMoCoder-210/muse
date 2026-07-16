//! Muse 应用库入口，注册插件与命令

mod app_paths;
mod commands;
mod db;
mod project_log;
mod sidecar;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_data_dir =
                app_paths::resolve_app_data_dir(app.handle()).map_err(std::io::Error::other)?;
            log::info!("应用数据目录已就绪");

            let log_path = project_log::log_path_for_app_data(&app_data_dir);
            project_log::append_log(&log_path, "应用", "INFO", "应用启动");

            commands::prepare_app_runtime(app.handle()).map_err(std::io::Error::other)?;
            log::info!("应用数据库启动时已就绪");
            project_log::append_log(&log_path, "应用", "INFO", "数据库就绪");

            let sidecar_manager: sidecar::SharedSidecarManager =
                std::sync::Mutex::new(sidecar::SidecarManager::new(app.handle().clone()));
            app.manage(sidecar_manager);

            // 应用启动时自动启动 Worker（使用全局数据库，不绑定具体项目）
            // Worker 启动后即可处理所有项目的 pending 任务
            let config_path = app_data_dir
                .join("settings.json")
                .to_string_lossy()
                .to_string();
            let db_path = crate::app_paths::app_db_path(app.handle())
                .map_err(|e| std::io::Error::other(e))?
                .to_string_lossy()
                .to_string();
            // 使用全局默认 workspace（非项目特定），Worker 只需 db + config 即可工作
            let default_workspace = app_data_dir.join("workspace").to_string_lossy().to_string();
            std::fs::create_dir_all(&default_workspace).ok();

            // 解析 FFmpeg/FFprobe 路径
            let ffmpeg_path = app_paths::ffmpeg_path(app.handle())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let ffprobe_path = app_paths::ffprobe_path(app.handle())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            let state = app.state::<sidecar::SharedSidecarManager>();
            let mut mgr = state
                .lock()
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            match mgr.start(
                &db_path,
                &default_workspace,
                &config_path,
                &log_path.to_string_lossy(),
                &ffmpeg_path,
                &ffprobe_path,
            ) {
                Ok(()) => {
                    project_log::append_log(&log_path, "应用", "INFO", "Worker 已随应用启动");
                }
                Err(e) => {
                    // Worker 启动失败不应阻止应用启动（如 worker/dist/index.js 不存在）
                    project_log::append_log(
                        &log_path,
                        "应用",
                        "WARN",
                        &format!("Worker 启动失败（应用仍可正常运行）：{}", e),
                    );
                }
            }
            drop(mgr);

            // 启动心跳监控：每 5 秒检查 Worker 是否存活，超时 30 秒自动重启
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        let state = handle.state::<sidecar::SharedSidecarManager>();
                        let mut mgr = match state.lock() {
                            Ok(m) => m,
                            Err(_) => break,
                        };
                        if !mgr.is_running() {
                            continue;
                        }
                        match mgr.check_heartbeat() {
                            Ok(()) => {
                                // 心跳正常，继续
                            }
                            Err(sidecar::SidecarError::Crashed(msg)) => {
                                log::warn!("Worker 心跳超时：{}", msg);
                                project_log::append_log(
                                    &log_path,
                                    "应用",
                                    "WARN",
                                    &format!("Worker 心跳超时，尝试重启：{}", msg),
                                );
                                // 清理锁
                                if let Ok(db_path) = crate::app_paths::app_db_path(&handle) {
                                    if let Ok(conn) = crate::db::init_db(&db_path) {
                                        let _ = mgr.cleanup_locks(&conn);
                                    }
                                }
                                // 重启
                                match mgr.restart() {
                                    Ok(()) => {
                                        project_log::append_log(
                                            &log_path,
                                            "应用",
                                            "INFO",
                                            "Worker 已自动重启",
                                        );
                                    }
                                    Err(e) => {
                                        project_log::append_log(
                                            &log_path,
                                            "应用",
                                            "ERROR",
                                            &format!("Worker 自动重启失败：{}", e),
                                        );
                                    }
                                }
                            }
                            Err(_) => {
                                // NotRunning，无需处理
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_version,
            commands::create_project,
            commands::get_project,
            commands::list_projects,
            commands::import_script,
            commands::list_script_sources,
            commands::create_clip,
            commands::list_clips,
            commands::get_script_source,
            commands::get_settings,
            commands::save_settings,
            commands::start_worker,
            commands::stop_worker,
            commands::delete_project,
            commands::delete_clips,
            commands::delete_assets,
            commands::update_clip,
            commands::split_clip,
            commands::generate_clip_script,
            commands::generate_asset_image,
            commands::add_asset_to_clip,
            commands::delete_asset_from_clip,
            commands::update_asset_in_clip,
            commands::list_workspace_voice_files,
            commands::import_voice_file,
            commands::get_asset_image_info,
            commands::list_asset_images,
            commands::select_asset_image,
            commands::delete_asset_image,
            commands::list_asset_image_tasks,
            commands::batch_get_asset_selected_images,
            commands::batch_get_asset_generating,
            commands::import_local_asset_image,
            commands::list_project_asset_images,
            commands::copy_asset_image_from,
            commands::cancel_clip_script,
            commands::get_clip_scripts,
            commands::list_storyboards,
            commands::list_clip_assets,
            commands::update_storyboard_assets,
            commands::create_storyboard,
            commands::delete_storyboard,
            commands::insert_storyboard,
            commands::update_storyboard_params,
            commands::generate_storyboard_video,
            commands::update_storyboard_duration,
            commands::import_video_file,
            commands::add_storyboard_video,
            commands::select_storyboard_video,
            commands::list_storyboard_videos,
            commands::delete_storyboard_video,
            commands::list_clip_concat_videos,
            commands::concat_clip_videos,
            commands::detect_ffmpeg,
            commands::test_connection,
            commands::open_in_folder,
            commands::save_concat_output,
            commands::delete_concat_output,
            commands::list_concat_outputs,
            commands::preview_public_voice,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
