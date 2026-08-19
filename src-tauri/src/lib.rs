mod audio;
mod bandcamp;
mod commands;
mod db;
mod error;
mod jobs;
mod metadata;
mod models;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // Remember and restore the window size/position across restarts (desktop).
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder
        .manage(bandcamp::session::BandcampState::default())
        .manage(jobs::ScanState::default())
        .manage(jobs::DedupeState::default())
        .manage(jobs::WatchState::default())
        .manage(jobs::BandcampDownloadState::default())
        .setup(|app| {
            // The self-updater only exists on desktop targets.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // Open the library database and, on the first start after the
            // update, pull the library out of the legacy JSON store. A failure
            // here must not stop the app from starting: without a database the
            // library is empty and the next scan rebuilds it, which is far
            // better than refusing to launch.
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            match db::Db::open(&dir) {
                Ok(database) => {
                    match db::migrate::run(app.handle(), &database) {
                        Ok(imported) if imported.tracks > 0 => {
                            println!(
                                "Imported {} tracks, {} edits and {} duplicate groups from the JSON store",
                                imported.tracks, imported.edits, imported.duplicate_groups
                            );
                        }
                        Ok(_) => {}
                        Err(e) => eprintln!("Library import from the JSON store failed: {e}"),
                    }
                    // A new app version may analyze differently than the one
                    // that filled the cache, so mark every row for one re-probe.
                    match database.conn().map(|conn| {
                        db::invalidate_on_version_change(&conn, env!("CARGO_PKG_VERSION"))
                    }) {
                        Ok(Ok(n)) if n > 0 => {
                            println!("App version changed — {n} cached analyses invalidated")
                        }
                        Ok(Err(e)) => eprintln!("Cache invalidation failed: {e}"),
                        Err(e) => eprintln!("Cache invalidation failed: {e}"),
                        Ok(Ok(_)) => {}
                    }
                    app.manage(database);
                }
                Err(e) => eprintln!("Could not open the library database: {e}"),
            }

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
            commands::list_audio_files,
            commands::library_load,
            commands::library_delete,
            commands::library_dir_available,
            commands::library_relocate,
            commands::edits_load,
            commands::edit_set,
            commands::edit_clear,
            commands::duplicates_load,
            commands::duplicates_save,
            commands::duplicates_dismiss,
            commands::start_library_watch,
            commands::suggest_metadata,
            commands::cover_preview,
            commands::cover_thumbnail,
            commands::convert_tracks,
            commands::dedupe_status,
            commands::dedupe_result,
            commands::cancel_dedupe,
            commands::write_metadata,
            commands::undo_peek,
            commands::undo_last,
            commands::delete_files,
            commands::delete_album,
            commands::prune_empty_dirs,
            commands::bandcamp_login,
            commands::bandcamp_connect,
            commands::bandcamp_disconnect,
            commands::bandcamp_status,
            commands::bandcamp_collection,
            commands::bandcamp_download,
            commands::cancel_bandcamp_download,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
