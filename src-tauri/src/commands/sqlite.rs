use tauri::State;

use super::AppState;

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn sqlite_open(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    state
        .sqlite_manager
        .open(&id, &path)
        .map_err(|e| e.to_string())?;
    tracing::info!(path = %path, id = %id, "SQLite connection opened");
    Ok(id)
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn sqlite_close(state: State<'_, AppState>, connection_id: String) -> Result<(), String> {
    state
        .sqlite_manager
        .close(&connection_id)
        .map_err(|e| e.to_string())?;
    tracing::info!(id = %connection_id, "SQLite connection closed");
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn sqlite_list(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.sqlite_manager.list())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn sqlite_execute(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> Result<Vec<mas_sqlite::query::SqliteQueryResult>, String> {
    state
        .sqlite_executor
        .execute(&connection_id, &sql)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn sqlite_get_tables(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<mas_sqlite::schema::SqliteTableInfo>, String> {
    state
        .sqlite_inspector
        .get_tables(&connection_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn sqlite_get_columns(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> Result<Vec<mas_sqlite::schema::SqliteColumnInfo>, String> {
    state
        .sqlite_inspector
        .get_columns(&connection_id, &table)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn sqlite_get_indexes(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> Result<Vec<mas_sqlite::schema::SqliteIndexInfo>, String> {
    state
        .sqlite_inspector
        .get_indexes(&connection_id, &table)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn sqlite_get_table_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> Result<String, String> {
    state
        .sqlite_inspector
        .get_table_ddl(&connection_id, &table)
        .await
        .map_err(|e| e.to_string())
}
