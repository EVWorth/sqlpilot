use crate::connection::ConnectionManager;
use crate::error::CoreError;
use crate::models::{ColumnMeta, QueryResult, SqlValue};
use sqlx::{Acquire, Column, Row, TypeInfo};
use std::sync::Arc;
use std::time::Instant;

pub struct QueryExecutor {
    connection_manager: Arc<ConnectionManager>,
}

impl QueryExecutor {
    pub fn new(connection_manager: Arc<ConnectionManager>) -> Self {
        Self { connection_manager }
    }

    #[tracing::instrument(skip(self), fields(connection_id = %connection_id, statement_count))]
    pub async fn execute(
        &self,
        connection_id: &str,
        sql: &str,
        database: Option<&str>,
    ) -> Result<Vec<QueryResult>, CoreError> {
        let pool = self.connection_manager.get_pool(connection_id)?;
        let statements = split_statements(sql);

        tracing::Span::current().record("statement_count", statements.len());
        tracing::trace!(sql = %sql, "Full SQL input");

        // Acquire a dedicated connection so USE + query share the same session
        let mut conn = pool.acquire().await.map_err(|e| CoreError::Query(e.to_string()))?;

        if let Some(db) = database {
            let use_sql = format!("USE `{}`", db);
            tracing::debug!(database = %db, "Switching database context");
            sqlx::query(&use_sql)
                .execute(conn.as_mut())
                .await
                .map_err(|e| CoreError::Query(e.to_string()))?;
        }

        let mut results = Vec::new();

        for (idx, stmt) in statements.iter().enumerate() {
            let trimmed = stmt.trim();
            if trimmed.is_empty() {
                continue;
            }

            let query_id = uuid::Uuid::new_v4().to_string();
            let preview: String = trimmed.chars().take(200).collect();
            tracing::debug!(query_id = %query_id, statement_index = idx, sql_preview = %preview, "Executing statement");
            tracing::trace!(query_id = %query_id, sql = %trimmed, "Full statement SQL");

            let start = Instant::now();

            let is_select = trimmed.to_uppercase().starts_with("SELECT")
                || trimmed.to_uppercase().starts_with("SHOW")
                || trimmed.to_uppercase().starts_with("DESCRIBE")
                || trimmed.to_uppercase().starts_with("EXPLAIN");

            if is_select {
                let rows = sqlx::query(trimmed)
                    .fetch_all(conn.as_mut())
                    .await
                    .map_err(|e| CoreError::Query(e.to_string()))?;

                let execution_time = start.elapsed().as_millis() as u64;

                let columns: Vec<ColumnMeta> = if let Some(first_row) = rows.first() {
                    first_row.columns().iter().map(|col| {
                        ColumnMeta {
                            name: col.name().to_string(),
                            data_type: col.type_info().name().to_string(),
                            nullable: true,
                            is_primary_key: false,
                        }
                    }).collect()
                } else {
                    Vec::new()
                };

                let result_rows: Vec<Vec<SqlValue>> = rows.iter().map(|row| {
                    row.columns().iter().enumerate().map(|(i, col)| {
                        extract_value(row, i, col.type_info().name())
                    }).collect()
                }).collect();

                let row_count = result_rows.len() as u64;

                if execution_time > 1000 {
                    tracing::warn!(
                        query_id = %query_id,
                        rows = row_count,
                        time_ms = execution_time,
                        "Slow query detected"
                    );
                }

                tracing::info!(
                    query_id = %query_id,
                    rows = row_count,
                    time_ms = execution_time,
                    "Query executed"
                );

                results.push(QueryResult {
                    query_id,
                    statement_index: idx,
                    columns,
                    rows: result_rows,
                    rows_affected: row_count,
                    execution_time_ms: execution_time,
                    warnings: vec![],
                });
            } else {
                let result = sqlx::query(trimmed)
                    .execute(conn.as_mut())
                    .await
                    .map_err(|e| CoreError::Query(e.to_string()))?;

                let execution_time = start.elapsed().as_millis() as u64;

                if execution_time > 1000 {
                    tracing::warn!(
                        query_id = %query_id,
                        rows_affected = result.rows_affected(),
                        time_ms = execution_time,
                        "Slow statement detected"
                    );
                }

                tracing::info!(
                    query_id = %query_id,
                    rows_affected = result.rows_affected(),
                    time_ms = execution_time,
                    "Statement executed"
                );

                results.push(QueryResult {
                    query_id,
                    statement_index: idx,
                    columns: vec![],
                    rows: vec![],
                    rows_affected: result.rows_affected(),
                    execution_time_ms: execution_time,
                    warnings: vec![],
                });
            }
        }

        Ok(results)
    }
}

fn extract_value(row: &sqlx::mysql::MySqlRow, index: usize, type_name: &str) -> SqlValue {
    // Try to get value, return Null if column is null
    match type_name {
        "BOOLEAN" | "TINYINT(1)" | "BOOL" => {
            row.try_get::<Option<bool>, _>(index)
                .ok()
                .flatten()
                .map(SqlValue::Bool)
                .unwrap_or(SqlValue::Null)
        }
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => {
            row.try_get::<Option<i64>, _>(index)
                .ok()
                .flatten()
                .map(SqlValue::Int)
                .unwrap_or(SqlValue::Null)
        }
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED"
        | "INT UNSIGNED" | "BIGINT UNSIGNED" => {
            row.try_get::<Option<u64>, _>(index)
                .ok()
                .flatten()
                .map(SqlValue::UInt)
                .unwrap_or(SqlValue::Null)
        }
        "FLOAT" | "DOUBLE" | "DECIMAL" => {
            row.try_get::<Option<f64>, _>(index)
                .ok()
                .flatten()
                .map(SqlValue::Float)
                .unwrap_or(SqlValue::Null)
        }
        "JSON" => {
            // JSON columns must be decoded as serde_json::Value, then serialized to string
            row.try_get::<Option<serde_json::Value>, _>(index)
                .ok()
                .flatten()
                .map(|v| SqlValue::String(v.to_string()))
                .unwrap_or(SqlValue::Null)
        }
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" => {
            row.try_get::<Option<Vec<u8>>, _>(index)
                .ok()
                .flatten()
                .map(SqlValue::Bytes)
                .unwrap_or(SqlValue::Null)
        }
        "BIT" => {
            // BIT columns: try reading as bytes and convert to integer
            row.try_get::<Option<u64>, _>(index)
                .ok()
                .flatten()
                .map(SqlValue::UInt)
                .unwrap_or(SqlValue::Null)
        }
        _ => {
            // Default: try as string (covers VARCHAR, TEXT, DATE, DATETIME, TIMESTAMP, ENUM, SET, etc.)
            row.try_get::<Option<String>, _>(index)
                .ok()
                .flatten()
                .map(SqlValue::String)
                .unwrap_or(SqlValue::Null)
        }
    }
}

fn split_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    let mut string_char = ' ';
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let chars: Vec<char> = sql.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let c = chars[i];
        let next = if i + 1 < len { Some(chars[i + 1]) } else { None };

        if in_line_comment {
            if c == '\n' {
                in_line_comment = false;
            }
            current.push(c);
            i += 1;
            continue;
        }

        if in_block_comment {
            current.push(c);
            if c == '*' && next == Some('/') {
                current.push('/');
                in_block_comment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if in_string {
            current.push(c);
            if c == '\\' {
                if let Some(next_ch) = next {
                    current.push(next_ch);
                    i += 2;
                    continue;
                }
            }
            if c == string_char {
                in_string = false;
            }
            i += 1;
            continue;
        }

        // Check for comments
        if c == '-' && next == Some('-') {
            in_line_comment = true;
            current.push(c);
            i += 1;
            continue;
        }
        if c == '/' && next == Some('*') {
            in_block_comment = true;
            current.push(c);
            current.push('*');
            i += 2;
            continue;
        }

        // Check for string start
        if c == '\'' || c == '"' || c == '`' {
            in_string = true;
            string_char = c;
            current.push(c);
            i += 1;
            continue;
        }

        // Statement separator
        if c == ';' {
            if !current.trim().is_empty() {
                statements.push(current.trim().to_string());
            }
            current = String::new();
            i += 1;
            continue;
        }

        current.push(c);
        i += 1;
    }

    if !current.trim().is_empty() {
        statements.push(current.trim().to_string());
    }

    statements
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_simple_statements() {
        let sql = "SELECT 1; SELECT 2; SELECT 3";
        let stmts = split_statements(sql);
        assert_eq!(stmts.len(), 3);
        assert_eq!(stmts[0], "SELECT 1");
        assert_eq!(stmts[1], "SELECT 2");
        assert_eq!(stmts[2], "SELECT 3");
    }

    #[test]
    fn test_split_with_strings() {
        let sql = "SELECT 'hello;world'; SELECT 1";
        let stmts = split_statements(sql);
        assert_eq!(stmts.len(), 2);
        assert_eq!(stmts[0], "SELECT 'hello;world'");
    }

    #[test]
    fn test_split_with_comments() {
        let sql = "SELECT 1; -- this is a comment;\nSELECT 2";
        let stmts = split_statements(sql);
        assert_eq!(stmts.len(), 2);
    }

    #[test]
    fn test_split_empty() {
        let stmts = split_statements("");
        assert_eq!(stmts.len(), 0);
    }

    #[test]
    fn test_split_single_statement_no_semicolon() {
        let stmts = split_statements("SELECT 1");
        assert_eq!(stmts.len(), 1);
        assert_eq!(stmts[0], "SELECT 1");
    }
}
