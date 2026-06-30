mod commands;
mod db;
mod sidecar;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 初始化应用数据目录
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;

            // 初始化日志
            log::info!("应用数据目录: {:?}", app_data_dir);

            // 启动 Node sidecar worker
            let sidecar_manager = sidecar::SidecarManager::new();
            app.manage(sidecar_manager);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_version,
            commands::create_project,
            commands::get_project,
            commands::list_projects,
            commands::start_worker,
            commands::stop_worker,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
