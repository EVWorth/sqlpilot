use crate::connection::SqliteConnectionManager;
use crate::error::SqliteError;
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct SqliteColumnMeta {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SqliteQueryResult {
    pub query_id: String,
    pub statement_index: usize,
    pub columns: Vec<SqliteColumnMeta>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub rows_affected: u64,
    pub execution_time_ms: u64,
    pub warnings: Vec<String>,
    pub rows_truncated: bool,
}

pub struct SqliteQueryExecutor {
    manager: Arc<SqliteConnectionManager>,
}

impl SqliteQueryExecutor {
    pub fn new(manager: Arc<SqliteConnectionManager>) -> Self {
        Self { manager }
    }

    pub async fn execute(
        &self,
        connection_id: &str,
        sql: &str,
    ) -> Result<Vec<SqliteQueryResult>, SqliteError> {
        let conn = self.manager.get(connection_id)?;
        let sql = sql.to_string();
        tokio::task::spawn_blocking(move || execute_sync(&conn, &sql))
            .await
            .map_err(|e| SqliteError::Query(e.to_string()))?
    }
}

fn execute_sync(
    conn: &crate::connection::SqliteConnection,
    sql: &str,
) -> Result<Vec<SqliteQueryResult>, SqliteError> {
    let start = std::time::Instant::now();
    let db = conn
        .db
        .lock()
        .map_err(|e| SqliteError::Query(e.to_string()))?;

    let is_select = {
        let trimmed = sql.trim().to_uppercase();
        trimmed.starts_with("SELECT")
            || trimmed.starts_with("PRAGMA")
            || trimmed.starts_with("EXPLAIN")
    };

    if is_select {
        let mut stmt = db.prepare(sql)?;
        let col_count = stmt.column_count();
        let columns: Vec<SqliteColumnMeta> = (0..col_count)
            .map(|i| SqliteColumnMeta {
                name: stmt.column_name(i).unwrap_or("?").to_string(),
                data_type: "TEXT".to_string(),
                nullable: true,
                is_primary_key: false,
            })
            .collect();

        let mut rows = Vec::new();
        let row_iter = stmt.query_map([], |row| {
            let values: Vec<serde_json::Value> = (0..col_count)
                .map(|i| match row.get_ref(i) {
                    Ok(v) => to_json_value(&v),
                    Err(_) => serde_json::Value::Null,
                })
                .collect();
            Ok(values)
        })?;

        for row_result in row_iter {
            rows.push(row_result?);
        }

        Ok(vec![SqliteQueryResult {
            query_id: uuid::Uuid::new_v4().to_string(),
            statement_index: 0,
            columns,
            rows,
            rows_affected: 0,
            execution_time_ms: start.elapsed().as_millis() as u64,
            warnings: vec![],
            rows_truncated: false,
        }])
    } else {
        let affected = db.execute(sql, [])?;
        Ok(vec![SqliteQueryResult {
            query_id: uuid::Uuid::new_v4().to_string(),
            statement_index: 0,
            columns: vec![],
            rows: vec![],
            rows_affected: affected as u64,
            execution_time_ms: start.elapsed().as_millis() as u64,
            warnings: vec![],
            rows_truncated: false,
        }])
    }
}

fn to_json_value(v: &rusqlite::types::ValueRef) -> serde_json::Value {
    match v {
        rusqlite::types::ValueRef::Null => serde_json::Value::Null,
        rusqlite::types::ValueRef::Integer(i) => serde_json::json!(i),
        rusqlite::types::ValueRef::Real(f) => serde_json::json!(f),
        rusqlite::types::ValueRef::Text(s) => {
            serde_json::Value::String(String::from_utf8_lossy(s).to_string())
        }
        rusqlite::types::ValueRef::Blob(b) => {
            serde_json::Value::String(format!("<blob {} bytes>", b.len()))
        }
    }
}
