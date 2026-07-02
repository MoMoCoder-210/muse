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
            log::info!("Application data directory: {:?}", app_data_dir);

            let log_path = project_log::log_path_for_app_data(&app_data_dir);
            project_log::append_log(&log_path, "app", "INFO", "Application starting");

            commands::prepare_app_runtime(app.handle()).map_err(std::io::Error::other)?;
            log::info!("Application database prepared at startup");
            project_log::append_log(&log_path, "app", "INFO", "Database prepared");

            let sidecar_manager: sidecar::SharedSidecarManager =
                std::sync::Mutex::new(sidecar::SidecarManager::new());
            app.manage(sidecar_manager);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_version,
            commands::create_project,
            commands::get_project,
            commands::list_projects,
            commands::import_script,
            commands::list_clips,
            commands::get_script_source,
            commands::get_settings,
            commands::save_settings,
            commands::start_worker,
            commands::stop_worker,
            commands::delete_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
