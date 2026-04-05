mod commands;

use commands::AppState;
use mas_core::connection::{ConnectionManager, ConnectionStore};
use mas_core::query::QueryExecutor;
use mas_core::schema::SchemaInspector;
use mas_admin::AdminService;
use std::sync::Arc;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("mysql-ai-studio");
    std::fs::create_dir_all(&data_dir).expect("Failed to create data directory");

    let log_dir = data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).expect("Failed to create log directory");

    // Console layer: colored, human-readable, INFO+ (or overridden by RUST_LOG)
    let console_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,mysql_ai_studio_lib=debug,mas_core=debug,mas_admin=debug,mas_export=debug"));
    let console_layer = tracing_subscriber::fmt::layer()
        .with_filter(console_filter);

    // File layer: JSON-structured, rolling daily, DEBUG level
    let file_appender = tracing_appender::rolling::daily(&log_dir, "mysql-ai-studio.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
    let file_filter = EnvFilter::new("debug,mysql_ai_studio_lib=debug,mas_core=debug,mas_admin=debug,mas_export=debug");
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
        "Starting MySQL AI Studio"
    );

    // Keep the non-blocking guard alive for the lifetime of the app
    // by leaking it (it flushes on drop, but we need it alive until exit)
    std::mem::forget(_guard);

    let store = ConnectionStore::new(&data_dir.join("connections.db"))
        .expect("Failed to initialize connection store");

    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let inspector = SchemaInspector::new(manager.clone());
    let admin = AdminService::new(manager.clone());
    let ai = mas_ai::AiService::new(manager.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            connection_manager: manager,
            connection_store: store,
            query_executor: executor,
            schema_inspector: inspector,
            admin_service: admin,
            ai_service: ai,
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
            commands::ai::ai_chat,
            commands::ai::ai_get_status,
            commands::ai::ai_set_config,
            commands::ai::ai_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
