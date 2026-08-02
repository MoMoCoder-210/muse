//! Muse 应用库入口，注册插件与命令

mod app_paths;
mod commands;
mod db;
mod job_guard;
mod project_log;
mod sidecar;
mod upscale_manager;

use std::sync::Mutex as StdMutex;
use tauri::Emitter;
use tauri::Manager;
/// 前端主动查询启动状态。
///
/// 由于 Tauri 的 `setup()` 可能在 WebView 加载完成前执行，
/// `startup-status` 事件可能在前端 listener 注册前就发出了。
/// 前端在 `StartupScreen` 挂载时调用此命令来获取当前状态。
#[tauri::command]
fn get_startup_status(
    state: tauri::State<'_, StdMutex<Option<sidecar::StartupStatusPayload>>>,
) -> Option<sidecar::StartupStatusPayload> {
    state.lock().ok().and_then(|s| s.clone())
}

/// 前端轮询的运行时服务健康状态。
///
/// 后端 IPC 能成功响应即代表后端可用；数据库、FFmpeg 和 Worker 均实时检查，
/// 用于标题栏的简约状态标志。
#[tauri::command]
fn get_runtime_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, sidecar::SharedSidecarManager>,
) -> sidecar::StartupStatusPayload {
    let db_ok = match app_paths::app_db_path(&app) {
        Ok(path) => match db::init_db(&path) {
            Ok(conn) => conn
                .query_row("SELECT 1", [], |row| row.get::<_, i32>(0))
                .is_ok(),
            Err(_) => false,
        },
        Err(_) => false,
    };
    let ffmpeg_ok = app_paths::ffmpeg_path(&app).is_some_and(|path| path.exists())
        && app_paths::ffprobe_path(&app).is_some_and(|path| path.exists());
    let worker_ok = state
        .lock()
        .map(|mut manager| manager.is_running())
        .unwrap_or(false);
    let status = if db_ok && ffmpeg_ok && worker_ok {
        "ready"
    } else {
        "error"
    };
    sidecar::StartupStatusPayload {
        status: status.to_string(),
        db_ok,
        ffmpeg_ok,
        worker_ok,
        message: if status == "ready" {
            "所有服务已就绪".to_string()
        } else {
            "存在未就绪服务".to_string()
        },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 第二个实例启动时，恢复并聚焦已有窗口
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // ── Job Object：超分子进程随本进程退出自动终止（含强杀），杜绝孤儿进程 ──
            job_guard::init_job();

            let app_data_dir =
                app_paths::resolve_app_data_dir(app.handle()).map_err(std::io::Error::other)?;
            log::info!("应用数据目录已就绪");

            // ── 超分任务管理器：注册全局 state + 启动 worker（含断点续跑） ──
            // manager 启动时从 DB 加载未完成任务入队续跑，并串行执行所有超分任务。
            // 孤儿进程清理放到后台任务（wmic/tasklist 逐个查询较慢，同步执行会推迟
            // worker 启动；放到后台既保证续跑尽快开始，又能清掉占用资源文件的旧进程）。
            upscale_manager::setup_manager(app.handle());

            // ── 清理上次超分异常退出残留的临时目录（`_upscale_*`） ──
            // 仅删除不属于活跃任务（queued/running）的孤儿目录；断点续跑任务
            // 的 frames/out 目录会被跳过保留。放后台执行，不阻塞启动。
            {
                let app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let active = upscale_manager::active_job_ids(&app);
                    let root = app_paths::default_projects_root();
                    commands::video::cleanup_orphan_upscale_dirs(&root, &active, 0);
                    // 清理系统临时目录中的续跑中转目录（muse_upscale_{job}）
                    // 仅清理不属于活跃任务的残留；正在续跑的任务其中转目录可能
                    // 已被 worker 复用，跳过活跃 job 避免误删。
                    if let Ok(temp_root) = std::env::temp_dir().canonicalize() {
                        commands::video::cleanup_orphan_upscale_dirs(&temp_root, &active, 0);
                    }
                });
            }

            // ── 清理上次超分异常退出残留的孤儿进程（realesrgan/ffmpeg） ──
            // 超分过程中被强制关闭时，ncnn/ffmpeg 子进程可能残留并占用 upscaler/ffmpeg
            // 资源文件（如 vcomp140.dll），导致重启时 build script 或超分初始化失败。
            // 放后台执行：先启动续跑 worker，再清理旧进程，互不冲突。
            tauri::async_runtime::spawn(async {
                commands::video::cleanup_orphan_upscale_processes();
            });

            // ── 扩展 asset 协议作用域，确保前端能加载作品目录中的图片/视频 ──
            let asset_scope = app.handle().asset_protocol_scope();
            let projects_root = app_paths::default_projects_root();
            log::info!("asset scope: 作品根目录 = {:?}", projects_root);
            match asset_scope.allow_directory(&projects_root, true) {
                Ok(_) => log::info!("asset scope: 已添加作品根目录 {:?}", projects_root),
                Err(e) => log::warn!("asset scope: 无法添加作品根目录 {:?}: {}", projects_root, e),
            }
            if let Some(home) = dirs::home_dir() {
                log::info!("asset scope: 用户主目录 = {:?}", home);
                match asset_scope.allow_directory(&home, true) {
                    Ok(_) => log::info!("asset scope: 已添加用户主目录"),
                    Err(e) => log::warn!("asset scope: 无法添加用户主目录: {}", e),
                }
            }
            if let Some(docs) = dirs::document_dir() {
                log::info!("asset scope: 文档目录 = {:?}", docs);
                match asset_scope.allow_directory(&docs, true) {
                    Ok(_) => log::info!("asset scope: 已添加文档目录"),
                    Err(e) => log::warn!("asset scope: 无法添加文档目录: {}", e),
                }
            }
            // 允许所有常见磁盘驱动器（Windows: C:/D:/E:/F: 等）
            for drive_letter in b'A'..=b'Z' {
                let drive_path = std::path::PathBuf::from(format!("{}:\\", drive_letter as char));
                if drive_path.exists() {
                    let _ = asset_scope.allow_directory(&drive_path, true);
                }
            }
            log::info!("asset scope: 初始化完成");

            let log_path = project_log::log_path_for_app_data(&app_data_dir);
            project_log::append_log(&log_path, "应用", "INFO", "应用启动");

            // ═══════════════════════════════════════════════
            // 启动健康检测：DB → FFmpeg → Worker，三项全部通过才继续
            // ═══════════════════════════════════════════════

            let handle = app.handle().clone();

            // 共享启动状态（setup 可能在 WebView 加载前完成，前端需通过 command 主动查询）
            let startup_state: StdMutex<Option<sidecar::StartupStatusPayload>> =
                StdMutex::new(None);
            app.manage(startup_state);

            // ── 第1步：数据库初始化 ──
            let _db_ok = match commands::prepare_app_runtime(app.handle()) {
                Ok(()) => {
                    log::info!("应用数据库启动时已就绪");
                    project_log::append_log(&log_path, "应用", "INFO", "数据库就绪");
                    true
                }
                Err(e) => {
                    let msg = format!("数据库初始化失败：{}", e);
                    log::error!("{}", msg);
                    project_log::append_log(&log_path, "应用", "ERROR", &msg);
                    let payload = sidecar::StartupStatusPayload {
                        status: "error".to_string(),
                        db_ok: false,
                        ffmpeg_ok: false,
                        worker_ok: false,
                        message: msg,
                    };
                    let _ = handle.emit("startup-status", &payload);
                    // 存入共享状态供前端主动查询
                    if let Ok(mut state) = app
                        .state::<StdMutex<Option<sidecar::StartupStatusPayload>>>()
                        .lock()
                    {
                        *state = Some(payload);
                    }
                    return Err(Box::new(std::io::Error::other(e)));
                }
            };

            // ── 第2步：FFmpeg 检测 ──
            let ffmpeg_path_str = app_paths::ffmpeg_path(app.handle())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let ffprobe_path_str = app_paths::ffprobe_path(app.handle())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            let ffmpeg_exists =
                !ffmpeg_path_str.is_empty() && std::path::Path::new(&ffmpeg_path_str).exists();
            let ffprobe_exists =
                !ffprobe_path_str.is_empty() && std::path::Path::new(&ffprobe_path_str).exists();
            let ffmpeg_ok = ffmpeg_exists && ffprobe_exists;

            if !ffmpeg_ok {
                let mut details = Vec::new();
                if !ffmpeg_exists {
                    details.push(format!("ffmpeg.exe 未找到（{}）", ffmpeg_path_str));
                }
                if !ffprobe_exists {
                    details.push(format!("ffprobe.exe 未找到（{}）", ffprobe_path_str));
                }
                let msg = format!("FFmpeg 检测失败：{}", details.join("；"));
                log::error!("{}", msg);
                project_log::append_log(&log_path, "应用", "ERROR", &msg);
                let payload = sidecar::StartupStatusPayload {
                    status: "error".to_string(),
                    db_ok: true,
                    ffmpeg_ok: false,
                    worker_ok: false,
                    message: msg,
                };
                let _ = handle.emit("startup-status", &payload);
                if let Ok(mut state) = app
                    .state::<StdMutex<Option<sidecar::StartupStatusPayload>>>()
                    .lock()
                {
                    *state = Some(payload);
                }
                return Err(Box::new(std::io::Error::other("FFmpeg/FFprobe 未就绪")));
            }

            log::info!(
                "FFmpeg 检测通过：{} / {}",
                ffmpeg_path_str,
                ffprobe_path_str
            );
            project_log::append_log(&log_path, "应用", "INFO", "FFmpeg 就绪");

            // ── 第3步：Worker 进程启动 ──
            let sidecar_manager: sidecar::SharedSidecarManager =
                std::sync::Mutex::new(sidecar::SidecarManager::new(app.handle().clone()));
            app.manage(sidecar_manager);

            let config_path_buf = app_data_dir.join("settings.json");
            // 首次启动时自动写入默认配置，确保 Worker 能读到配置文件
            if !config_path_buf.exists() {
                let default_json = commands::util::default_settings_json();
                if let Ok(content) = serde_json::to_string_pretty(&default_json) {
                    let _ = std::fs::write(&config_path_buf, content);
                    project_log::append_log(
                        &log_path,
                        "应用",
                        "INFO",
                        "已自动生成默认 settings.json",
                    );
                }
            }
            let config_path = config_path_buf.to_string_lossy().to_string();
            let db_path = crate::app_paths::app_db_path(app.handle())
                .map_err(|e| std::io::Error::other(e))?
                .to_string_lossy()
                .to_string();
            let default_workspace = app_data_dir.join("workspace").to_string_lossy().to_string();
            std::fs::create_dir_all(&default_workspace).ok();

            let state = app.state::<sidecar::SharedSidecarManager>();
            let mut mgr = state
                .lock()
                .map_err(|e| std::io::Error::other(e.to_string()))?;

            let _worker_ok = match mgr.start(
                &db_path,
                &default_workspace,
                &config_path,
                &log_path.to_string_lossy(),
                &ffmpeg_path_str,
                &ffprobe_path_str,
            ) {
                Ok(()) => {
                    project_log::append_log(&log_path, "应用", "INFO", "Worker 已随应用启动");
                    true
                }
                Err(e) => {
                    let msg = format!("Worker 进程启动失败：{}", e);
                    log::error!("{}", msg);
                    project_log::append_log(&log_path, "应用", "ERROR", &msg);
                    let payload = sidecar::StartupStatusPayload {
                        status: "error".to_string(),
                        db_ok: true,
                        ffmpeg_ok: true,
                        worker_ok: false,
                        message: msg,
                    };
                    let _ = handle.emit("startup-status", &payload);
                    if let Ok(mut state) = app
                        .state::<StdMutex<Option<sidecar::StartupStatusPayload>>>()
                        .lock()
                    {
                        *state = Some(payload);
                    }
                    drop(mgr);
                    return Err(Box::new(std::io::Error::other(e.to_string())));
                }
            };
            drop(mgr);

            // ── 全部通过，通知前端 ──
            let payload = sidecar::StartupStatusPayload {
                status: "ready".to_string(),
                db_ok: true,
                ffmpeg_ok: true,
                worker_ok: true,
                message: "所有服务已就绪".to_string(),
            };
            let _ = handle.emit("startup-status", &payload);
            // 存入共享状态供前端主动查询
            if let Ok(mut state) = app
                .state::<StdMutex<Option<sidecar::StartupStatusPayload>>>()
                .lock()
            {
                *state = Some(payload);
            }

            // ── 启动心跳监控 ──
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
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
                        Ok(()) => {}
                        Err(sidecar::SidecarError::Crashed(msg)) => {
                            log::warn!("Worker 心跳超时：{}", msg);
                            project_log::append_log(
                                &log_path,
                                "应用",
                                "WARN",
                                &format!("Worker 心跳超时，尝试重启：{}", msg),
                            );
                            if let Ok(db_path) = crate::app_paths::app_db_path(&handle) {
                                if let Ok(conn) = crate::db::init_db(&db_path) {
                                    let _ = mgr.cleanup_locks(&conn);
                                }
                            }
                            match mgr.restart() {
                                Ok(()) => {
                                    project_log::append_log(
                                        &log_path,
                                        "应用",
                                        "INFO",
                                        "Worker 已自动重启",
                                    );
                                }
                                Err(sidecar::SidecarError::MaxRestartsExceeded) => {
                                    project_log::append_log(
                                        &log_path,
                                        "应用",
                                        "ERROR",
                                        "Worker 已达最大重启次数上限，请检查日志或重启应用",
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
                        Err(_) => {}
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_startup_status,
            get_runtime_status,
            commands::get_app_version,
            commands::open_app_data_dir,
            commands::open_log_dir,
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
            commands::retry_asset_image_task,
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
            commands::optimize_script,
            commands::list_optimizations,
            commands::select_optimization,
            commands::delete_optimization,
            commands::update_optimization_text,
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
            commands::list_storyboard_video_tasks,
            commands::delete_storyboard_video_task,
            commands::delete_storyboard_video,
            commands::util::check_channel_pending_tasks,
            commands::util::poll_task_result,
            commands::list_clip_concat_videos,
            commands::concat_clip_videos,
            commands::detect_ffmpeg,
            commands::detect_gpu_support,
            upscale_manager::enqueue_upscale,
            upscale_manager::list_upscale_jobs,
            upscale_manager::cancel_upscale_job,
            commands::test_connection,
            commands::open_in_folder,
            commands::save_concat_output,
            commands::delete_concat_output,
            commands::list_concat_outputs,
            commands::preview_public_voice,
            commands::check_voices_cached,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // 应用退出时清理超分子进程（realesrgan/ffmpeg），避免孤儿进程占用
            // upscaler/ffmpeg 资源文件导致下次编译或启动失败。
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                commands::video::cleanup_orphan_upscale_processes();
            }
        });
}
