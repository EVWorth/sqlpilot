use mas_core::connection::{ConnectionManager, ConnectionStore};
use mas_core::models::{ConnectionProfile, ConnectionInfo, TestConnectionResult, QueryResult};
use mas_core::query::QueryExecutor;
use mas_core::schema::SchemaInspector;
use mas_core::schema::inspector::{DatabaseInfo, TableInfo, ColumnInfo, IndexInfo};
use mas_admin::AdminService;
use std::sync::Arc;
use tauri::State;

pub struct AppState {
    pub connection_manager: Arc<ConnectionManager>,
    pub connection_store: ConnectionStore,
    pub query_executor: QueryExecutor,
    pub schema_inspector: SchemaInspector,
    pub admin_service: AdminService,
}

// Connection commands
#[tauri::command]
pub async fn save_connection_profile(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> Result<String, String> {
    state.connection_store.save(&profile).map_err(|e| e.to_string())?;
    Ok(profile.id.clone())
}

#[tauri::command]
pub async fn list_connection_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionProfile>, String> {
    state.connection_store.list().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_connection_profile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), String> {
    state.connection_store.delete(&profile_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_connection(
    profile: ConnectionProfile,
) -> Result<TestConnectionResult, String> {
    ConnectionManager::test_connection(&profile).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<ConnectionInfo, String> {
    let profile = state.connection_store.get(&profile_id).map_err(|e| e.to_string())?;
    state.connection_manager.connect(&profile).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disconnect(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    state.connection_manager.disconnect(&connection_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionInfo>, String> {
    Ok(state.connection_manager.list_connections())
}

// Query commands
#[tauri::command]
pub async fn execute_query(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> Result<Vec<QueryResult>, String> {
    state.query_executor.execute(&connection_id, &sql).await.map_err(|e| e.to_string())
}

// Schema commands
#[tauri::command]
pub async fn get_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DatabaseInfo>, String> {
    state.schema_inspector.get_databases(&connection_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_tables(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<TableInfo>, String> {
    state.schema_inspector.get_tables(&connection_id, &database).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_columns(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<ColumnInfo>, String> {
    state.schema_inspector.get_columns(&connection_id, &database, &table).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_indexes(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<IndexInfo>, String> {
    state.schema_inspector.get_indexes(&connection_id, &database, &table).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_table_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<String, String> {
    state.schema_inspector.get_table_ddl(&connection_id, &database, &table).await.map_err(|e| e.to_string())
}

// Export commands
#[tauri::command]
pub async fn export_results(
    result: QueryResult,
    format: String,
    table_name: Option<String>,
) -> Result<String, String> {
    match format.as_str() {
        "csv" => Ok(mas_export::export_csv(&result)),
        "json" => Ok(mas_export::export_json(&result)),
        "sql" => Ok(mas_export::export_sql_insert(&result, &table_name.unwrap_or("table".to_string()))),
        "markdown" => Ok(mas_export::export_markdown(&result)),
        _ => Err(format!("Unknown format: {}", format)),
    }
}

// Admin commands
#[tauri::command]
pub async fn get_process_list(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<mas_admin::ProcessInfo>, String> {
    state.admin_service.get_process_list(&connection_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_server_variables(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<mas_admin::ServerVariable>, String> {
    state.admin_service.get_server_variables(&connection_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kill_process(
    state: State<'_, AppState>,
    connection_id: String,
    process_id: i64,
) -> Result<(), String> {
    state.admin_service.kill_process(&connection_id, process_id).await.map_err(|e| e.to_string())
}
