#[cfg(feature = "beta-ai")]
pub mod ai;
pub mod sqlite;

use mas_admin::AdminService;
use mas_core::connection::{ConnectionManager, ConnectionStore};
use mas_core::models::{
    ConnectionInfo, ConnectionProfile, ConnectionProfileSummary, QueryResult, TestConnectionResult,
};
use mas_core::query::QueryExecutor;
use mas_core::schema::inspector::{
    ColumnInfo, DatabaseInfo, IndexInfo, RoutineInfo, TableInfo, TriggerInfo, ViewInfo,
};
use mas_core::schema::SchemaInspector;
use mas_sqlite::connection::SqliteConnectionManager;
use mas_sqlite::query::SqliteQueryExecutor;
use mas_sqlite::schema::SqliteSchemaInspector;
#[cfg(target_os = "linux")]
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

pub struct AppState {
    pub connection_manager: Arc<ConnectionManager>,
    pub connection_store: ConnectionStore,
    pub query_executor: QueryExecutor,
    pub schema_inspector: SchemaInspector,
    pub admin_service: AdminService,
    #[cfg(feature = "beta-ai")]
    pub ai_service: Option<mas_ai::AiService>,
    pub sqlite_manager: Arc<SqliteConnectionManager>,
    pub sqlite_executor: Arc<SqliteQueryExecutor>,
    pub sqlite_inspector: Arc<SqliteSchemaInspector>,
}

// Connection commands
#[tauri::command]
#[tracing::instrument(skip(state, profile), fields(profile_name = %profile.name))]
pub async fn save_connection_profile(
    state: State<'_, AppState>,
    mut profile: ConnectionProfile,
) -> Result<String, String> {
    // If the frontend omitted the password (edit mode), preserve the stored one
    if profile.password.is_empty() {
        if let Ok(stored) = state.connection_store.get(&profile.id) {
            profile.password = stored.password;
        }
    }
    state.connection_store.save(&profile).map_err(|e| {
        tracing::error!(error = %e, "Failed to save connection profile");
        e.to_string()
    })?;
    tracing::info!(profile_id = %profile.id, "Connection profile saved");
    Ok(profile.id.clone())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn list_connection_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionProfileSummary>, String> {
    let profiles = state.connection_store.list().map_err(|e| {
        tracing::error!(error = %e, "Failed to list connection profiles");
        e.to_string()
    })?;
    tracing::info!(count = profiles.len(), "Listed connection profiles");
    Ok(profiles)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn delete_connection_profile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), String> {
    state.connection_store.delete(&profile_id).map_err(|e| {
        tracing::error!(error = %e, profile_id = %profile_id, "Failed to delete connection profile");
        e.to_string()
    })?;
    tracing::info!("Connection profile deleted");
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(state, profile), fields(profile_name = %profile.name, host = %profile.host, port = %profile.port))]
pub async fn test_connection(
    state: State<'_, AppState>,
    mut profile: ConnectionProfile,
) -> Result<TestConnectionResult, String> {
    // If the frontend omitted the password (edit mode), look it up from the store
    if profile.password.is_empty() {
        if let Ok(stored) = state.connection_store.get(&profile.id) {
            profile.password = stored.password;
        }
    }
    let result = ConnectionManager::test_connection(&profile)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Test connection failed");
            e.to_string()
        })?;
    tracing::info!(
        success = result.success,
        latency_ms = result.latency_ms,
        "Test connection completed"
    );
    Ok(result)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn connect(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<ConnectionInfo, String> {
    let profile = state.connection_store.get(&profile_id).map_err(|e| {
        tracing::error!(error = %e, "Failed to get profile for connect");
        e.to_string()
    })?;
    let info = state
        .connection_manager
        .connect(&profile)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Connect failed");
            e.to_string()
        })?;
    tracing::info!(connection_id = %info.id, server_version = %info.server_version, "Connected");
    Ok(info)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn disconnect(state: State<'_, AppState>, connection_id: String) -> Result<(), String> {
    state
        .connection_manager
        .disconnect(&connection_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Disconnect failed");
            e.to_string()
        })?;
    tracing::info!("Disconnected");
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn list_connections(state: State<'_, AppState>) -> Result<Vec<ConnectionInfo>, String> {
    let connections = state.connection_manager.list_connections();
    tracing::info!(count = connections.len(), "Listed connections");
    Ok(connections)
}

// Query commands
#[tauri::command]
#[tracing::instrument(skip(state), fields(connection_id = %connection_id, sql_preview = %sql.chars().take(100).collect::<String>()))]
pub async fn execute_query(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
    database: Option<String>,
    limit: Option<u64>,
) -> Result<Vec<QueryResult>, String> {
    let results = state
        .query_executor
        .execute_owned(connection_id, sql, database, limit)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Query execution failed");
            e.to_string()
        })?;
    let total_rows: u64 = results.iter().map(|r| r.rows_affected).sum();
    tracing::info!(
        statement_count = results.len(),
        total_rows = total_rows,
        "Query executed"
    );
    Ok(results)
}

// Schema commands
#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn get_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DatabaseInfo>, String> {
    let dbs = state
        .schema_inspector
        .get_databases(&connection_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get databases");
            e.to_string()
        })?;
    tracing::info!(count = dbs.len(), "Listed databases");
    Ok(dbs)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn get_tables(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<TableInfo>, String> {
    let tables = state
        .schema_inspector
        .get_tables(&connection_id, &database)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get tables");
            e.to_string()
        })?;
    tracing::info!(count = tables.len(), "Listed tables");
    Ok(tables)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn get_columns(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<ColumnInfo>, String> {
    let columns = state
        .schema_inspector
        .get_columns(&connection_id, &database, &table)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get columns");
            e.to_string()
        })?;
    tracing::info!(count = columns.len(), "Listed columns");
    Ok(columns)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn get_indexes(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<Vec<IndexInfo>, String> {
    let indexes = state
        .schema_inspector
        .get_indexes(&connection_id, &database, &table)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get indexes");
            e.to_string()
        })?;
    tracing::info!(count = indexes.len(), "Listed indexes");
    Ok(indexes)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn get_table_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<String, String> {
    let ddl = state
        .schema_inspector
        .get_table_ddl(&connection_id, &database, &table)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get table DDL");
            e.to_string()
        })?;
    tracing::info!(ddl_length = ddl.len(), "Retrieved table DDL");
    Ok(ddl)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn get_views(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<ViewInfo>, String> {
    let views = state
        .schema_inspector
        .get_views(&connection_id, &database)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get views");
            e.to_string()
        })?;
    tracing::info!(count = views.len(), "Listed views");
    Ok(views)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn get_routines(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<RoutineInfo>, String> {
    let routines = state
        .schema_inspector
        .get_routines(&connection_id, &database)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get routines");
            e.to_string()
        })?;
    tracing::info!(count = routines.len(), "Listed routines");
    Ok(routines)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn get_triggers(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<TriggerInfo>, String> {
    let triggers = state
        .schema_inspector
        .get_triggers(&connection_id, &database)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get triggers");
            e.to_string()
        })?;
    tracing::info!(count = triggers.len(), "Listed triggers");
    Ok(triggers)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn get_view_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    view_name: String,
) -> Result<String, String> {
    let ddl = state
        .schema_inspector
        .get_view_ddl(&connection_id, &database, &view_name)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get view DDL");
            e.to_string()
        })?;
    tracing::info!(ddl_length = ddl.len(), "Retrieved view DDL");
    Ok(ddl)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn get_routine_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    routine_name: String,
    routine_type: String,
) -> Result<String, String> {
    let ddl = state
        .schema_inspector
        .get_routine_ddl(&connection_id, &database, &routine_name, &routine_type)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get routine DDL");
            e.to_string()
        })?;
    tracing::info!(ddl_length = ddl.len(), "Retrieved routine DDL");
    Ok(ddl)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn get_trigger_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    trigger_name: String,
) -> Result<String, String> {
    let ddl = state
        .schema_inspector
        .get_trigger_ddl(&connection_id, &database, &trigger_name)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get trigger DDL");
            e.to_string()
        })?;
    tracing::info!(ddl_length = ddl.len(), "Retrieved trigger DDL");
    Ok(ddl)
}

// Export commands
#[tauri::command]
#[tracing::instrument(skip(result), fields(format = %format, rows = result.rows.len(), cols = result.columns.len()))]
pub async fn export_results(
    result: QueryResult,
    format: String,
    table_name: Option<String>,
) -> Result<String, String> {
    let output = match format.as_str() {
        "csv" => Ok(mas_export::export_csv(&result)),
        "json" => Ok(mas_export::export_json(&result)),
        "sql" => Ok(mas_export::export_sql_insert(
            &result,
            &table_name.unwrap_or("table".to_string()),
        )),
        "markdown" => Ok(mas_export::export_markdown(&result)),
        _ => {
            tracing::error!(format = %format, "Unknown export format");
            Err(format!("Unknown format: {}", format))
        }
    }?;
    tracing::info!(output_bytes = output.len(), "Export completed");
    Ok(output)
}

// Admin commands
#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn get_process_list(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<mas_admin::ProcessInfo>, String> {
    let processes = state
        .admin_service
        .get_process_list(&connection_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get process list");
            e.to_string()
        })?;
    tracing::info!(count = processes.len(), "Listed processes");
    Ok(processes)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn get_server_variables(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<mas_admin::ServerVariable>, String> {
    let vars = state
        .admin_service
        .get_server_variables(&connection_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get server variables");
            e.to_string()
        })?;
    tracing::info!(count = vars.len(), "Listed server variables");
    Ok(vars)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn kill_process(
    state: State<'_, AppState>,
    connection_id: String,
    process_id: i64,
) -> Result<(), String> {
    state
        .admin_service
        .kill_process(&connection_id, process_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to kill process");
            e.to_string()
        })?;
    tracing::info!("Process killed");
    Ok(())
}

// Platform detection
//
// `tauri-plugin-updater` shells out to `rpm -U` on Linux, which is a no-op
// (or worse, writes into a shadowed /var/lib/rpm) on atomic distros that use
// `rpm-ostree` (Bazzite, Fedora Silverblue, Bluefin, Aurora, Universal Blue,
// Fedora Atomic). The frontend uses this signal to suppress the auto-update
// chip and surface a copyable `rpm-ostree install <url>` command instead.
// On non-Linux targets, the answer is always false so the frontend short-
// circuits without a runtime branch.
#[tauri::command]
#[tracing::instrument]
pub async fn is_rpm_ostree() -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        Ok(Path::new("/usr/bin/rpm-ostree").exists())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(false)
    }
}

// File import commands
#[tauri::command]
#[tracing::instrument]
pub async fn read_file_contents(path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;
    if !path_buf.is_file() {
        return Err(format!("Not a regular file: {}", path));
    }
    let contents = tokio::fs::read_to_string(&path_buf).await.map_err(|e| {
        tracing::error!(error = %e, path = %path, "Failed to read file");
        format!("Failed to read file: {}", e)
    })?;
    tracing::info!(path = %path, bytes = contents.len(), "File read successfully");
    Ok(contents)
}

#[tauri::command]
#[tracing::instrument]
pub async fn pick_file(
    title: String,
    filters: Vec<(String, Vec<String>)>,
) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title(&title);
    for (name, extensions) in &filters {
        let ext_refs: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
        dialog = dialog.add_filter(name, &ext_refs);
    }
    let result = dialog.pick_file().await;
    match result {
        Some(handle) => {
            let path = handle.path().to_string_lossy().to_string();
            tracing::info!(path = %path, "File picked");
            Ok(Some(path))
        }
        None => {
            tracing::info!("File pick cancelled");
            Ok(None)
        }
    }
}

#[tauri::command]
#[tracing::instrument(skip(contents), fields(path = %path, content_len = contents.len()))]
pub async fn write_file_contents(path: String, contents: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    // Canonicalize the parent directory so relative paths resolve, but
    // preserve the filename for new files (save-as) that don't exist yet.
    let resolved = if let Some(parent) = path_buf.parent() {
        let canonical_parent = parent
            .canonicalize()
            .map_err(|e| format!("Invalid path: {e}"))?;
        canonical_parent.join(
            path_buf
                .file_name()
                .ok_or_else(|| "Invalid path: missing file name".to_string())?,
        )
    } else {
        path_buf
            .canonicalize()
            .map_err(|e| format!("Invalid path: {e}"))?
    };
    tokio::fs::write(&resolved, &contents).await.map_err(|e| {
        tracing::error!(error = %e, path = %path, "Failed to write file");
        format!("Failed to write file: {}", e)
    })?;
    tracing::info!(path = %path, bytes = contents.len(), "File written successfully");
    Ok(())
}

#[tauri::command]
#[tracing::instrument]
pub async fn pick_save_file(
    title: String,
    default_name: String,
    filters: Vec<(String, Vec<String>)>,
) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title(&title)
        .set_file_name(&default_name);
    for (name, extensions) in &filters {
        let ext_refs: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
        dialog = dialog.add_filter(name, &ext_refs);
    }
    let result = dialog.save_file().await;
    match result {
        Some(handle) => {
            let path = handle.path().to_string_lossy().to_string();
            tracing::info!(path = %path, "Save file path picked");
            Ok(Some(path))
        }
        None => {
            tracing::info!("Save file pick cancelled");
            Ok(None)
        }
    }
}

#[cfg(test)]
mod platform_tests {
    use super::is_rpm_ostree;

    #[tokio::test]
    async fn is_rpm_ostree_returns_false_on_non_linux() {
        #[cfg(not(target_os = "linux"))]
        assert!(!is_rpm_ostree().await.unwrap());
    }

    #[tokio::test]
    async fn is_rpm_ostree_reflects_binary_presence() {
        // On Linux this returns true iff /usr/bin/rpm-ostree exists. We don't
        // assert a specific value (CI runner may or may not be atomic) — just
        // that the command succeeds and the boolean matches the filesystem.
        #[cfg(target_os = "linux")]
        {
            let result = is_rpm_ostree().await.unwrap();
            let expected = std::path::Path::new("/usr/bin/rpm-ostree").exists();
            assert_eq!(result, expected);
        }
    }
}
