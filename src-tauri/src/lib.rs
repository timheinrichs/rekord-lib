mod audio;
mod bandcamp;
mod commands;
mod error;
mod jobs;
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
        .manage(jobs::ScanState::default())
        .manage(jobs::DedupeState::default())
        .setup(|app| {
            // Restore the saved Bandcamp session on startup.
            let state = app.state::<bandcamp::session::BandcampState>();
            bandcamp::session::restore(app.handle(), &state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::analyze_files,
            commands::start_scan,
            commands::scan_status,
            commands::cancel_scan,
            commands::suggest_metadata,
            commands::cover_preview,
            commands::cover_thumbnail,
            commands::convert_tracks,
            commands::start_dedupe,
            commands::dedupe_status,
            commands::dedupe_result,
            commands::cancel_dedupe,
            commands::delete_files,
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
