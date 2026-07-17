mod audio;
mod bandcamp;
mod commands;
mod error;
mod metadata;
mod models;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(bandcamp::session::BandcampState::default())
        .setup(|app| {
            // Gespeicherte Bandcamp-Sitzung beim Start wiederherstellen.
            let state = app.state::<bandcamp::session::BandcampState>();
            bandcamp::session::restore(app.handle(), &state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::analyze_files,
            commands::scan_library,
            commands::suggest_metadata,
            commands::cover_preview,
            commands::convert_tracks,
            commands::bandcamp_login,
            commands::bandcamp_connect,
            commands::bandcamp_disconnect,
            commands::bandcamp_status,
            commands::bandcamp_collection,
            commands::bandcamp_download,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
