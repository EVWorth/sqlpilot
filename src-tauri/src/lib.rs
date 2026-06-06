mod commands;
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

fn init_keyring() {
    #[cfg(target_os = "linux")]
    {
        let store = linux_keyutils_keyring_store::Store::new()
            .expect("Failed to initialize Linux keyring store");
        mas_core::connection::init_keyring(store);
    }
    #[cfg(target_os = "windows")]
    {
        let store = windows_native_keyring_store::Store::new()
            .expect("Failed to initialize Windows keyring store");
        mas_core::connection::init_keyring(store);
    }
    #[cfg(target_os = "macos")]
    {
        let store = apple_native_keyring_store::keychain::Store::new()
            .expect("Failed to initialize macOS keyring store");
        mas_core::connection::init_keyring(store);
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
pub fn run() {
    #[cfg(target_os = "macos")]
    augment_macos_path();

    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("sqlpilot");
    std::fs::create_dir_all(&data_dir).expect("Failed to create data directory");

    let log_dir = data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).expect("Failed to create log directory");

    // Console layer: colored, human-readable, INFO+ (or overridden by RUST_LOG)
    let console_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("info,sqlpilot_lib=debug,mas_core=debug,mas_admin=debug,mas_export=debug")
    });
    let console_layer = tracing_subscriber::fmt::layer().with_filter(console_filter);

    // File layer: JSON-structured, rolling daily, DEBUG level
    let file_appender = tracing_appender::rolling::daily(&log_dir, "sqlpilot.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
    let file_filter =
        EnvFilter::new("debug,sqlpilot_lib=debug,mas_core=debug,mas_admin=debug,mas_export=debug");
    let file_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_writer(non_blocking)
        .with_filter(file_filter);

    tracing_subscriber::registry()
        .with(console_layer)
        .with(file_layer)
        .init();

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
    std::mem::forget(_guard);

    init_keyring();

    let store = ConnectionStore::new(&data_dir.join("connections.db"))
        .expect("Failed to initialize connection store");

    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let inspector = SchemaInspector::new(manager.clone());
    let admin = AdminService::new(manager.clone());
    #[cfg(feature = "beta-ai")]
    let ai = mas_ai::AiService::new(manager.clone());

    let sqlite_manager = Arc::new(mas_sqlite::connection::SqliteConnectionManager::new());
    let sqlite_executor = Arc::new(mas_sqlite::query::SqliteQueryExecutor::new(
        sqlite_manager.clone(),
    ));
    let sqlite_inspector = Arc::new(mas_sqlite::schema::SqliteSchemaInspector::new(
        sqlite_manager.clone(),
    ));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
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
        .manage(AppState {
            connection_manager: manager,
            connection_store: store,
            query_executor: executor,
            schema_inspector: inspector,
            admin_service: admin,
            #[cfg(feature = "beta-ai")]
            ai_service: Some(ai),
            sqlite_manager,
            sqlite_executor,
            sqlite_inspector,
        })
        .invoke_handler(tauri::generate_handler![
            commands::save_connection_profile,
            commands::list_connection_profiles,
            commands::delete_connection_profile,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::list_connections,
            commands::execute_query,
            commands::get_databases,
            commands::get_tables,
            commands::get_columns,
            commands::get_indexes,
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
            commands::read_file_contents,
            commands::pick_file,
            commands::write_file_contents,
            commands::pick_save_file,
            #[cfg(feature = "beta-ai")]
            commands::ai::ai_chat,
            #[cfg(feature = "beta-ai")]
            commands::ai::ai_get_status,
            #[cfg(feature = "beta-ai")]
            commands::ai::ai_set_config,
            #[cfg(feature = "beta-ai")]
            commands::ai::ai_cancel,
            #[cfg(feature = "beta-ai")]
            commands::ai::ai_approve_permission,
            commands::sqlite::sqlite_open,
            commands::sqlite::sqlite_close,
            commands::sqlite::sqlite_list,
            commands::sqlite::sqlite_execute,
            commands::sqlite::sqlite_get_tables,
            commands::sqlite::sqlite_get_columns,
            commands::sqlite::sqlite_get_indexes,
            commands::sqlite::sqlite_get_table_ddl,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
