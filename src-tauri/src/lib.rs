mod commands;
pub mod mcp;
#[cfg(target_os = "macos")]
mod menu;

use commands::AppState;
use mas_admin::AdminService;
use mas_core::connection::{ConnectionManager, ConnectionStore};
use mas_core::query::QueryExecutor;
use mas_core::schema::SchemaInspector;
use std::sync::Arc;
#[cfg(target_os = "macos")]
use tauri::Emitter;
#[cfg(target_os = "windows")]
use tauri::Manager;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

/// Attach the platform credential store, if there is one.
///
/// This used to `.expect()`, so a locked GNOME Keyring, a Flatpak sandbox
/// without a Secret Service, or a headless session took the whole app down
/// before it drew a window (#278). A missing keyring is a degraded mode, not
/// a fatal condition: profiles still work, passwords just are not remembered.
fn init_keyring() {
    let result: Result<(), String> = {
        #[cfg(target_os = "linux")]
        {
            linux_keyutils_keyring_store::Store::new()
                .map(|store| mas_core::connection::init_keyring(store))
                .map_err(|e| e.to_string())
        }
        #[cfg(target_os = "windows")]
        {
            windows_native_keyring_store::Store::new()
                .map(|store| mas_core::connection::init_keyring(store))
                .map_err(|e| e.to_string())
        }
        #[cfg(target_os = "macos")]
        {
            apple_native_keyring_store::keychain::Store::new()
                .map(|store| mas_core::connection::init_keyring(store))
                .map_err(|e| e.to_string())
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
        {
            Err("no credential store for this platform".to_string())
        }
    };

    match result {
        Ok(()) => {
            commands::set_keyring_available(true);
            tracing::info!("OS credential store initialized");
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "No OS credential store available — starting without one. Connection \
                 passwords will not be remembered between sessions."
            );
        }
    }
}

/// On macOS GUI apps, the PATH is restricted to /usr/bin:/bin:/usr/sbin:/sbin.
/// Augment it with directories where tools like the Copilot CLI are commonly installed.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn augment_macos_path() {
    use std::env;

    let mut extra_paths: Vec<std::path::PathBuf> = vec![
        "/opt/homebrew/bin".into(), // Homebrew (Apple Silicon)
        "/opt/homebrew/sbin".into(),
        "/usr/local/bin".into(), // Homebrew (Intel) / npm global default
        "/usr/local/sbin".into(),
        "/opt/local/bin".into(), // MacPorts
    ];

    if let Ok(home) = env::var("HOME") {
        extra_paths.push(format!("{home}/.npm-global/bin").into());
        extra_paths.push(format!("{home}/.volta/bin").into());
    }

    let current_path = env::var("PATH").unwrap_or_default();
    let existing: Vec<&str> = current_path.split(':').collect();

    let mut new_paths: Vec<String> = extra_paths
        .iter()
        .filter(|p| p.exists() && !existing.contains(&p.to_str().unwrap_or("")))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    if !new_paths.is_empty() {
        new_paths.extend(existing.iter().map(|s| s.to_string()));
        env::set_var("PATH", new_paths.join(":"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// The single source of truth for which commands exist.
///
/// Used by `run()` for the live invoke handler and by the binding-export test,
/// so the generated TypeScript and the runtime handler are built from one list
/// and cannot drift apart.
pub fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    // tauri-specta owns the command list, so the generated bindings and the
    // runtime handler are built from the same source and cannot disagree.
    //
    // This used to be two whole branches, because `collect_commands!` does not
    // accept `#[cfg]` the way `generate_handler!` does and the AI commands sat
    // behind a feature flag. ADR-011 removed that feature, and the duplication
    // with it.
    let specta_builder = tauri_specta::Builder::<tauri::Wry>::new()
        // Serialize/Deserialize phases are kept deliberately. ConnectionProfile
        // marks password, ssh password and passphrase #[serde(skip_serializing)]
        // — the frontend sends them, the backend never sends them back. Phased
        // types put that in the type system: ConnectionProfile_Deserialize has
        // the credential fields, ConnectionProfile_Serialize does not, so code
        // reading a profile cannot reach for a password that is never populated.
        // (disable_serde_phases() also cannot represent skip_serializing_if.)
        .commands(tauri_specta::collect_commands![
            commands::save_connection_profile,
            commands::list_connection_profiles,
            commands::delete_connection_profile,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::list_connections,
            commands::execute_query,
            commands::explain_query,
            commands::cancel_query,
            commands::connection_health,
            commands::ping_connection,
            commands::pool_stats,
            commands::startup_problems,
            commands::get_databases,
            commands::get_tables,
            commands::get_columns,
            commands::get_indexes,
            commands::get_foreign_keys,
            commands::get_events,
            commands::get_partitions,
            commands::get_table_ddl,
            commands::get_views,
            commands::get_routines,
            commands::get_triggers,
            commands::get_view_ddl,
            commands::get_routine_ddl,
            commands::get_trigger_ddl,
            commands::export_results,
            commands::get_process_list,
            commands::get_server_variables,
            commands::kill_process,
            commands::kill_query,
            commands::get_own_thread_ids,
            commands::read_file_contents,
            commands::pick_file,
            commands::write_file_contents,
            commands::pick_save_file,
            commands::backup::backup_database,
            commands::backup::cancel_backup,
            commands::backup::default_backup_options,
            commands::backup::restore_database,
            commands::backup::default_restore_options,
            commands::backup::read_file_head,
            commands::get_platform_info,
            commands::history_add,
            commands::history_list,
            commands::history_remove,
            commands::history_clear,
            commands::history_count,
            commands::history_prune,
            commands::history_import,
            commands::history_count_matching,
            commands::history_facets,
            commands::history_export,
            commands::history_prune_older_than,
            commands::keyring_available,
            commands::sqlite::sqlite_open,
            commands::sqlite::sqlite_close,
            commands::sqlite::sqlite_list,
            commands::sqlite::sqlite_execute,
            commands::sqlite::sqlite_get_tables,
            commands::sqlite::sqlite_get_columns,
            commands::sqlite::sqlite_get_indexes,
            commands::sqlite::sqlite_get_table_ddl,
        ])
        .events(tauri_specta::collect_events![
            commands::backup::BackupProgressEvent,
            commands::backup::RestoreProgressEvent,
            commands::ConnectionHealthEvent
        ]);
    specta_builder
}

/// Something that went wrong before the window existed.
///
/// Reported to the frontend rather than panicked over: a process that
/// vanishes tells the user nothing, and most of these are recoverable in the
/// sense that matters — the app can run, with something missing, and say what.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartupProblem {
    /// Which part of startup: `data-directory`, `connection-store`,
    /// `history-store`.
    pub kind: String,
    /// What the user loses by it, in their terms.
    pub summary: String,
    /// The underlying error, for a bug report.
    pub detail: String,
}

/// A directory the app can write to, preferring the platform's own.
///
/// Falls back to a temp directory, then to the working directory. Only the
/// last is really a failure, and even then the app runs — with settings that
/// do not survive a restart.
fn usable_data_dir() -> (std::path::PathBuf, Option<StartupProblem>) {
    let preferred = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("sqlpilot");
    match std::fs::create_dir_all(&preferred) {
        Ok(()) => (preferred, None),
        Err(e) => {
            let fallback = std::env::temp_dir().join("sqlpilot");
            let detail = format!("{}: {e}", preferred.display());
            if std::fs::create_dir_all(&fallback).is_ok() {
                (
                    fallback.clone(),
                    Some(StartupProblem {
                        kind: "data-directory".to_string(),
                        summary: format!(
                            "Could not use the usual data folder, so this session is working in {} —                              connections and settings saved now may not be there next time.",
                            fallback.display()
                        ),
                        detail,
                    }),
                )
            } else {
                (
                    std::path::PathBuf::from("."),
                    Some(StartupProblem {
                        kind: "data-directory".to_string(),
                        summary: "Could not create a data folder anywhere writable. Connections                                   and settings will not be saved."
                            .to_string(),
                        detail,
                    }),
                )
            }
        }
    }
}

/// Open the profile store, falling back to one that lives only in memory.
fn open_connection_store(data_dir: &std::path::Path) -> (ConnectionStore, Option<StartupProblem>) {
    let path = data_dir.join("connections.db");
    match ConnectionStore::new(&path) {
        Ok(store) => (store, None),
        Err(e) => {
            let detail = format!("{}: {e}", path.display());
            tracing::error!(error = %e, path = %path.display(), "Could not open the connection store");
            // In memory, so the app runs and the file is left exactly as it
            // is — whatever is wrong with it is still there to be recovered.
            let fallback = ConnectionStore::in_memory()
                .expect("an in-memory SQLite database cannot fail to open");
            (
                fallback,
                Some(StartupProblem {
                    kind: "connection-store".to_string(),
                    summary: "Your saved connections could not be opened, so none are listed.                               The file has been left alone; nothing you do now will overwrite it."
                        .to_string(),
                    detail,
                }),
            )
        }
    }
}

/// Open the history store, falling back to one that lives only in memory.
fn open_history_store(
    data_dir: &std::path::Path,
) -> (mas_core::history::HistoryStore, Option<StartupProblem>) {
    let path = data_dir.join("history.db");
    match mas_core::history::HistoryStore::new(&path) {
        Ok(store) => (store, None),
        Err(e) => {
            let detail = format!("{}: {e}", path.display());
            tracing::error!(error = %e, path = %path.display(), "Could not open the history store");
            let fallback = mas_core::history::HistoryStore::in_memory()
                .expect("an in-memory SQLite database cannot fail to open");
            (
                fallback,
                Some(StartupProblem {
                    kind: "history-store".to_string(),
                    summary: "Query history could not be opened, so this session's history will                               not be kept. Everything else works."
                        .to_string(),
                    detail,
                }),
            )
        }
    }
}

pub fn run() {
    #[cfg(target_os = "macos")]
    augment_macos_path();

    // Nothing here may panic. A panic before the window exists is a process
    // that vanishes with a message in a terminal the user does not have open;
    // every failure below degrades to something the app can report from
    // inside itself instead (#278 was the same shape, for the keyring).
    let mut startup_problems: Vec<StartupProblem> = Vec::new();

    let (data_dir, data_dir_problem) = usable_data_dir();
    if let Some(problem) = data_dir_problem {
        startup_problems.push(problem);
    }

    let log_dir = data_dir.join("logs");
    let file_logging = std::fs::create_dir_all(&log_dir).is_ok();

    // Console layer: colored, human-readable, INFO+ (or overridden by RUST_LOG)
    let console_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("info,sqlpilot_lib=debug,mas_core=debug,mas_admin=debug,mas_export=debug")
    });
    let console_layer = tracing_subscriber::fmt::layer().with_filter(console_filter);

    // File layer: JSON-structured, rolling daily, DEBUG level. Skipped when
    // the directory could not be made — logging to a file is worth having,
    // and not worth refusing to start over.
    let mut guard = None;
    let file_layer = file_logging.then(|| {
        let file_appender = tracing_appender::rolling::daily(&log_dir, "sqlpilot.log");
        let (non_blocking, g) = tracing_appender::non_blocking(file_appender);
        guard = Some(g);
        let file_filter = EnvFilter::new(
            "debug,sqlpilot_lib=debug,mas_core=debug,mas_admin=debug,mas_export=debug",
        );
        tracing_subscriber::fmt::layer()
            .json()
            .with_writer(non_blocking)
            .with_filter(file_filter)
    });

    tracing_subscriber::registry()
        .with(console_layer)
        .with(file_layer)
        .init();

    if !file_logging {
        tracing::warn!(
            log_dir = %log_dir.display(),
            "Could not create the log directory; logging to the console only"
        );
    }

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        data_dir = %data_dir.display(),
        log_dir = %log_dir.display(),
        "Starting SQLPilot"
    );

    #[cfg(target_os = "macos")]
    tracing::debug!(path = %std::env::var("PATH").unwrap_or_default(), "PATH after macOS augmentation");

    // Keep the non-blocking guard alive for the lifetime of the app
    // by leaking it (it flushes on drop, but we need it alive until exit)
    if let Some(g) = guard {
        std::mem::forget(g);
    }

    init_keyring();

    // A store that cannot be opened — a corrupt file, a read-only disk, a
    // half-written migration — used to panic here. The app now starts with an
    // in-memory one and says so: the profiles for this session are lost, but
    // the window opens and the message explains why, which is the difference
    // between a bug report and a mystery.
    let (store, store_problem) = open_connection_store(&data_dir);
    if let Some(problem) = store_problem {
        startup_problems.push(problem);
    }

    // Its own file rather than a table in connections.db: history is append-only
    // and much larger, and keeping it separate means a corrupt or oversized
    // history cannot take the connection profiles down with it (#585). The
    // `.expect()` here undid that — a corrupt history.db took the whole app
    // with it, profiles and all.
    let (history_store, history_problem) = open_history_store(&data_dir);
    if let Some(problem) = history_problem {
        startup_problems.push(problem);
    }

    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let inspector = SchemaInspector::new(manager.clone());
    let admin = AdminService::new(manager.clone());

    let sqlite_manager = Arc::new(mas_sqlite::connection::SqliteConnectionManager::new());
    let sqlite_executor = Arc::new(mas_sqlite::query::SqliteQueryExecutor::new(
        sqlite_manager.clone(),
    ));
    let sqlite_inspector = Arc::new(mas_sqlite::schema::SqliteSchemaInspector::new(
        sqlite_manager.clone(),
    ));

    let specta_builder = specta_builder();
    let health_manager = Arc::clone(&manager);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .setup(move |app| {
            // One forwarder for the whole app: the connection manager
            // broadcasts health changes, this turns them into events the
            // frontend can listen for (#276).
            commands::forward_health_events(health_manager, app.handle().clone());

            #[cfg(target_os = "macos")]
            {
                let menu = menu::build_menu(&app.handle())?;
                app.set_menu(menu)?;
            }
            #[cfg(target_os = "windows")]
            {
                app.remove_menu()?;
                if let Some(window) = app.get_webview_window("main") {
                    window.set_decorations(false)?;
                    window.set_resizable(true)?;
                }
            }
            #[cfg(target_os = "linux")]
            {
                app.remove_menu()?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            #[cfg(target_os = "macos")]
            app.emit("menu-action", event.id().0.as_str()).ok();
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        })
        .manage(commands::StartupReport(startup_problems))
        .manage(AppState {
            connection_manager: manager,
            connection_store: store,
            query_executor: executor,
            schema_inspector: inspector,
            history_store,
            admin_service: admin,
            sqlite_manager,
            sqlite_executor,
            sqlite_inspector,
        })
        .invoke_handler(specta_builder.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod startup_tests {
    use super::*;

    /// A path that cannot be a directory, so `create_dir_all` fails the way a
    /// read-only or full disk would.
    fn blocked_path() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("in-the-way");
        std::fs::write(&file, b"not a directory").unwrap();
        (dir, file.join("sqlpilot"))
    }

    #[test]
    fn a_corrupt_connection_store_does_not_stop_the_app() {
        // It used to `.expect()`, so the process vanished before a window
        // existed — a message in a terminal the user does not have open.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("connections.db"), b"this is not a database").unwrap();

        let (store, problem) = open_connection_store(dir.path());
        let problem = problem.expect("the user has to be told their profiles are missing");
        assert_eq!(problem.kind, "connection-store");
        assert!(
            problem.summary.contains("saved connections"),
            "{}",
            problem.summary
        );
        // The detail carries the real error, for a bug report.
        assert!(
            problem.detail.contains("connections.db"),
            "{}",
            problem.detail
        );

        // And the store works, so the app runs with none saved.
        assert!(store.list().is_ok());
    }

    #[test]
    fn a_corrupt_connection_store_is_left_exactly_as_it_was() {
        // Whatever is wrong with it is still there to be recovered; the
        // fallback is in memory precisely so nothing overwrites it.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.db");
        std::fs::write(&path, b"this is not a database").unwrap();

        let _ = open_connection_store(dir.path());

        assert_eq!(std::fs::read(&path).unwrap(), b"this is not a database");
    }

    #[test]
    fn a_corrupt_history_does_not_take_the_profiles_with_it() {
        // #585 put history in its own file so it could not; the `.expect()`
        // at the call site undid that.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("history.db"), b"not a database either").unwrap();

        let (_store, problem) = open_history_store(dir.path());
        let problem = problem.expect("the user has to be told history is not being kept");
        assert_eq!(problem.kind, "history-store");
        assert!(
            problem.summary.contains("Everything else works"),
            "{}",
            problem.summary
        );
    }

    #[test]
    fn a_working_store_reports_no_problem() {
        let dir = tempfile::tempdir().unwrap();
        assert!(open_connection_store(dir.path()).1.is_none());
        assert!(open_history_store(dir.path()).1.is_none());
    }

    #[test]
    fn a_data_directory_that_cannot_be_made_falls_back_rather_than_panicking() {
        // `create_dir_all` under a *file* fails the way a read-only home or a
        // full disk does.
        let (_guard, blocked) = blocked_path();
        assert!(std::fs::create_dir_all(&blocked).is_err());
    }

    #[test]
    fn the_ordinary_data_directory_reports_no_problem() {
        let (dir, problem) = usable_data_dir();
        assert!(problem.is_none(), "{problem:?}");
        assert!(dir.ends_with("sqlpilot"));
    }
}
