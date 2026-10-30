use tauri::State;

use super::AppState;

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
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
#[specta::specta]
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
#[specta::specta]
pub async fn sqlite_list(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.sqlite_manager.list())
}

#[tauri::command]
// The SQL text is not recorded whole: it can carry data the log should not
// keep. A redacted preview is enough to tell runs apart (#875).
#[tracing::instrument(
    skip(state, sql),
    fields(sql_preview = %mas_core::query::redacted_preview(&sql, mas_core::query::LOG_PREVIEW_CHARS))
)]
#[specta::specta]
pub async fn sqlite_execute(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> Result<Vec<mas_sqlite::query::SqliteQueryResult>, mas_core::QueryError> {
    // Same shape as the MySQL path: the shared pane reads one error type
    // whichever backend answered (#324).
    state
        .sqlite_executor
        .execute(&connection_id, &sql)
        .await
        .map_err(|e| sqlite_query_error(&e))
}

/// A SQLite failure in the shape the shared pane reads.
///
/// A statement-tagged failure (#928) carries its index and, from the second
/// statement on, what the statements before it returned, as the MySQL path
/// reports them.
fn sqlite_query_error(err: &mas_sqlite::error::SqliteError) -> mas_core::QueryError {
    use mas_sqlite::error::SqliteError;
    match err {
        SqliteError::AtStatement {
            index,
            source,
            completed,
        } => {
            let mut reported = sqlite_query_error(source).at_statement(*index);
            if *index > 0 && !completed.is_empty() {
                reported.completed_results =
                    Some(completed.iter().cloned().map(core_result).collect());
            }
            reported
        }
        SqliteError::Rusqlite(inner) => {
            mas_core::QueryError::from_rusqlite(inner, &err.to_string())
        }
        _ => mas_core::QueryError {
            message: err.to_string(),
            code: None,
            sql_state: None,
            statement_index: None,
            completed_results: None,
            transaction: None,
        },
    }
}

/// A SQLite result as the shared result type, for `completed_results`, which
/// the frontend reads as MySQL-shaped results whichever backend failed.
fn core_result(r: mas_sqlite::query::SqliteQueryResult) -> mas_core::models::query::QueryResult {
    use mas_core::models::query::{ColumnMeta, QueryResult};
    QueryResult {
        query_id: r.query_id,
        statement_index: r.statement_index,
        sql: r.sql,
        columns: r
            .columns
            .into_iter()
            .map(|c| ColumnMeta {
                name: c.name,
                data_type: c.data_type,
                nullable: c.nullable,
                is_primary_key: c.is_primary_key,
            })
            .collect(),
        rows: r
            .rows
            .into_iter()
            .map(|row| row.into_iter().map(core_value).collect())
            .collect(),
        rows_affected: r.rows_affected,
        execution_time_ms: r.execution_time_ms,
        warnings: r.warnings,
        rows_truncated: r.rows_truncated,
        truncation_reason: None,
        total_rows_available: None,
        transaction: None,
    }
}

/// The SQLite executor only produces null, integers, reals and text.
fn core_value(v: serde_json::Value) -> mas_core::models::query::SqlValue {
    use mas_core::models::query::SqlValue;
    match v {
        serde_json::Value::Null => SqlValue::Null,
        serde_json::Value::Bool(b) => SqlValue::Bool(b),
        serde_json::Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => SqlValue::Int(i),
            (None, Some(u)) => SqlValue::UInt(u),
            _ => n.as_f64().map_or(SqlValue::Null, SqlValue::Float),
        },
        serde_json::Value::String(s) => SqlValue::String(s),
        other => SqlValue::String(other.to_string()),
    }
}

#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
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
#[specta::specta]
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
#[specta::specta]
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
#[specta::specta]
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

/// A SQLite table's foreign keys, in the shape `get_foreign_keys` returns for
/// MySQL, so the structure and designer views read both the same way. SQLite
/// keeps no constraint names; see `SqliteForeignKeyInfo` for the made-up ones.
#[tauri::command]
#[tracing::instrument(skip(state))]
#[specta::specta]
pub async fn sqlite_get_foreign_keys(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> Result<Vec<mas_core::schema::inspector::ForeignKeyInfo>, String> {
    let keys = state
        .sqlite_inspector
        .get_foreign_keys(&connection_id, &table)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get SQLite foreign keys");
            e.to_string()
        })?;
    tracing::info!(count = keys.len(), "Listed SQLite foreign keys");
    Ok(keys
        .into_iter()
        .map(|k| mas_core::schema::inspector::ForeignKeyInfo {
            name: k.name,
            columns: k.columns,
            referenced_table: k.referenced_table,
            referenced_columns: k.referenced_columns,
            on_update: k.on_update,
            on_delete: k.on_delete,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mas_core::models::query::SqlValue;
    use mas_sqlite::connection::SqliteConnectionManager;
    use mas_sqlite::error::SqliteError;
    use mas_sqlite::query::SqliteQueryExecutor;
    use std::sync::Arc;

    async fn run(sql: &str) -> mas_core::QueryError {
        let manager = Arc::new(SqliteConnectionManager::new());
        manager.open("c", ":memory:").expect("opens");
        let err = SqliteQueryExecutor::new(manager)
            .execute("c", sql)
            .await
            .expect_err("the script fails");
        sqlite_query_error(&err)
    }

    #[tokio::test]
    async fn a_second_statement_failure_reports_index_and_earlier_results() {
        let reported = run("SELECT 1, 1.5, 'a', NULL; SELECT * FROM missing; SELECT 3").await;
        assert_eq!(reported.message, "no such table: missing");
        assert_eq!(reported.code, Some(1));
        assert_eq!(reported.statement_index, Some(1));
        let completed = reported
            .completed_results
            .clone()
            .expect("earlier results kept");
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].sql, "SELECT 1, 1.5, 'a', NULL");
        assert_eq!(
            completed[0].rows[0],
            vec![
                SqlValue::Int(1),
                SqlValue::Float(1.5),
                SqlValue::String("a".into()),
                SqlValue::Null,
            ]
        );
        let json = serde_json::to_value(&reported).expect("serialises");
        assert_eq!(json["statementIndex"], 1);
        assert_eq!(json["completedResults"][0]["statement_index"], 0);
    }

    #[tokio::test]
    async fn a_first_statement_failure_has_index_zero_and_no_results() {
        let reported = run("SELECT * FROM missing; SELECT 1").await;
        assert_eq!(reported.statement_index, Some(0));
        assert!(reported.completed_results.is_none());
    }

    #[test]
    fn an_untagged_failure_has_no_index() {
        let reported = sqlite_query_error(&SqliteError::NotFound("gone".into()));
        assert_eq!(reported.message, "Not found: gone");
        assert_eq!(reported.statement_index, None);
    }
}
