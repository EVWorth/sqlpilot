mod commands;

use commands::AppState;
use mas_core::connection::{ConnectionManager, ConnectionStore};
use mas_core::query::QueryExecutor;
use mas_core::schema::SchemaInspector;
use mas_admin::AdminService;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,mysql_ai_studio=debug,mas_core=debug")),
        )
        .init();

    tracing::info!("Starting MySQL AI Studio");

    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("mysql-ai-studio");
    std::fs::create_dir_all(&data_dir).expect("Failed to create data directory");

    let store = ConnectionStore::new(&data_dir.join("connections.db"))
        .expect("Failed to initialize connection store");

    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let inspector = SchemaInspector::new(manager.clone());
    let admin = AdminService::new(manager.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            connection_manager: manager,
            connection_store: store,
            query_executor: executor,
            schema_inspector: inspector,
            admin_service: admin,
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
            commands::export_results,
            commands::get_process_list,
            commands::get_server_variables,
            commands::kill_process,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
