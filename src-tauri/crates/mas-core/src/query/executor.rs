use crate::connection::ConnectionManager;
use crate::error::CoreError;
use crate::models::{ColumnMeta, QueryResult, SqlValue};
use futures::StreamExt;
use sqlx::{Column, Either, Row, TypeInfo};
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
        database: Option<String>,
        limit: Option<u64>,
    ) -> Result<Vec<QueryResult>, CoreError> {
        self.execute_owned(connection_id.to_string(), sql.to_string(), database, limit)
            .await
    }

    #[tracing::instrument(skip(self), fields(connection_id = %connection_id, statement_count))]
    pub async fn execute_owned(
        &self,
        connection_id: String,
        sql: String,
        database: Option<String>,
        limit: Option<u64>,
    ) -> Result<Vec<QueryResult>, CoreError> {
        const HARD_MAX_ROWS: u64 = 50_000;
        let effective_limit = limit.unwrap_or(HARD_MAX_ROWS);
        let capped_limit = effective_limit.min(HARD_MAX_ROWS);

        let pool = self.connection_manager.get_pool(&connection_id)?;
        let statements = split_statements(&sql);

        // Always apply row limit to SELECT/SHOW/DESCRIBE statements (hard cap prevents OOM)
        let statements: Vec<String> = statements
            .into_iter()
            .map(|stmt| {
                let upper = stmt.trim().to_uppercase();
                if upper.starts_with("SELECT")
                    || upper.starts_with("SHOW")
                    || upper.starts_with("DESCRIBE")
                    || upper.starts_with("EXPLAIN")
                {
                    let cleaned = strip_limit(&stmt);
                    format!("{} LIMIT {}", cleaned, capped_limit)
                } else {
                    stmt
                }
            })
            .collect();

        tracing::Span::current().record("statement_count", statements.len());
        tracing::trace!(sql = %sql, "Full SQL input");

        if statements.is_empty() {
            return Ok(vec![]);
        }

        // Combine all statements into one raw_sql call with &pool.
        //
        // Using &pool (not conn.as_mut()) avoids the HRTB lifetime error that
        // Tauri's `respond_async_serialized` imposes. The pool internally acquires
        // ONE connection for the entire multi-statement execution, so USE db
        // session state is preserved for subsequent statements.
        //
        // raw_sql uses the text protocol (COM_QUERY) which supports USE, SHOW CREATE,
        // CALL, etc. — commands that MySQL rejects over the prepared-statement protocol.
        let combined_sql = if let Some(db) = &database {
            let escaped_db = db.replace('`', "``");
            tracing::debug!(database = %db, "Switching database context");
            format!("USE `{}`;\n{}", escaped_db, statements.join("; "))
        } else {
            statements.join("; ")
        };

        // If USE db was prepended, skip its result (the first Either::Left).
        let mut stmt_idx: isize = if database.is_some() { -1 } else { 0 };

        let mut stream = sqlx::raw_sql(&combined_sql).fetch_many(&pool);
        let mut results = Vec::new();
        let mut current_rows: Vec<sqlx::mysql::MySqlRow> = Vec::new();
        let mut start = Instant::now();

        while let Some(item) = stream.next().await {
            let item = item.map_err(|e| CoreError::Query(e.to_string()))?;
            match item {
                Either::Right(row) => {
                    // SELECT/SHOW/DESCRIBE/EXPLAIN row — accumulate until trailing Left.
                    if stmt_idx >= 0 {
                        current_rows.push(row);
                    }
                }
                Either::Left(qr) => {
                    // Statement complete. For SELECT this arrives after all rows;
                    // for DML/DDL it is the only item for that statement.
                    if stmt_idx >= 0 {
                        let idx = stmt_idx as usize;
                        let stmt = &statements[idx];
                        let query_id = uuid::Uuid::new_v4().to_string();
                        let execution_time = start.elapsed().as_millis() as u64;
                        let preview: String = stmt.chars().take(200).collect();
                        tracing::debug!(
                            query_id = %query_id,
                            statement_index = idx,
                            sql_preview = %preview,
                            "Executing statement"
                        );
                        tracing::trace!(query_id = %query_id, sql = %stmt, "Full statement SQL");

                        let upper = stmt.to_uppercase();
                        let is_select = upper.starts_with("SELECT")
                            || upper.starts_with("SHOW")
                            || upper.starts_with("DESCRIBE")
                            || upper.starts_with("EXPLAIN");

                        if is_select {
                            let columns: Vec<ColumnMeta> =
                                if let Some(first_row) = current_rows.first() {
                                    first_row
                                        .columns()
                                        .iter()
                                        .map(|col| ColumnMeta {
                                            name: col.name().to_string(),
                                            data_type: col.type_info().name().to_string(),
                                            nullable: true,
                                            is_primary_key: false,
                                        })
                                        .collect()
                                } else {
                                    Vec::new()
                                };

                            let result_rows: Vec<Vec<SqlValue>> = current_rows
                                .iter()
                                .map(|row| {
                                    row.columns()
                                        .iter()
                                        .enumerate()
                                        .map(|(i, col)| {
                                            extract_value(row, i, col.type_info().name())
                                        })
                                        .collect()
                                })
                                .collect();

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

                            // Detect if rows may be truncated by our injected LIMIT
                            let rows_truncated = row_count >= capped_limit;

                            results.push(QueryResult {
                                query_id,
                                statement_index: idx,
                                columns,
                                rows: result_rows,
                                rows_affected: row_count,
                                execution_time_ms: execution_time,
                                warnings: vec![],
                                rows_truncated,
                                total_rows_available: if rows_truncated {
                                    Some(row_count)
                                } else {
                                    None
                                },
                            });
                        } else {
                            let rows_affected = qr.rows_affected();

                            if execution_time > 1000 {
                                tracing::warn!(
                                    query_id = %query_id,
                                    rows_affected,
                                    time_ms = execution_time,
                                    "Slow statement detected"
                                );
                            }
                            tracing::info!(
                                query_id = %query_id,
                                rows_affected,
                                time_ms = execution_time,
                                "Statement executed"
                            );

                            results.push(QueryResult {
                                query_id,
                                statement_index: idx,
                                columns: vec![],
                                rows: vec![],
                                rows_affected,
                                execution_time_ms: execution_time,
                                warnings: vec![],
                                rows_truncated: false,
                                total_rows_available: None,
                            });
                        }

                        current_rows.clear();
                        start = Instant::now();
                    }
                    stmt_idx += 1;
                }
            }
        }

        Ok(results)
    }
}

fn extract_value(row: &sqlx::mysql::MySqlRow, index: usize, type_name: &str) -> SqlValue {
    // Try to get value, return Null if column is null
    match type_name {
        "BOOLEAN" | "TINYINT(1)" | "BOOL" => row
            .try_get::<Option<bool>, _>(index)
            .ok()
            .flatten()
            .map(SqlValue::Bool)
            .unwrap_or(SqlValue::Null),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => row
            .try_get::<Option<i64>, _>(index)
            .ok()
            .flatten()
            .map(SqlValue::Int)
            .unwrap_or(SqlValue::Null),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "BIGINT UNSIGNED" => row
            .try_get::<Option<u64>, _>(index)
            .ok()
            .flatten()
            .map(SqlValue::UInt)
            .unwrap_or(SqlValue::Null),
        "FLOAT" | "DOUBLE" | "DECIMAL" => row
            .try_get::<Option<f64>, _>(index)
            .ok()
            .flatten()
            .map(SqlValue::Float)
            .unwrap_or(SqlValue::Null),
        "JSON" => {
            // JSON columns must be decoded as serde_json::Value, then serialized to string
            row.try_get::<Option<serde_json::Value>, _>(index)
                .ok()
                .flatten()
                .map(|v| SqlValue::String(v.to_string()))
                .unwrap_or(SqlValue::Null)
        }
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" => row
            .try_get::<Option<Vec<u8>>, _>(index)
            .ok()
            .flatten()
            .map(SqlValue::Bytes)
            .unwrap_or(SqlValue::Null),
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
        let next = if i + 1 < len {
            Some(chars[i + 1])
        } else {
            None
        };

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

/// Strip trailing LIMIT/OFFSET from a SQL statement so we can inject our own global limit.
/// Handles common patterns: LIMIT N, LIMIT M,N, LIMIT N OFFSET M
fn strip_limit(stmt: &str) -> String {
    let trimmed = stmt.trim();
    let upper = trimmed.to_uppercase();

    // Work backwards to find LIMIT keyword
    // First check if statement ends with LIMIT pattern
    if let Some(pos) = find_limit_keyword(&upper) {
        let before_limit = trimmed[..pos].trim_end();
        return before_limit.to_string();
    }

    trimmed.to_string()
}

/// Find the position of the LIMIT keyword at the end of a statement (case-insensitive).
/// Returns None if no trailing LIMIT/OFFSET found.
fn find_limit_keyword(upper: &str) -> Option<usize> {
    let chars: Vec<char> = upper.chars().collect();
    let len = chars.len();

    // Skip trailing whitespace
    let end = len
        - chars[len - 1..]
            .iter()
            .take_while(|&&c| c.is_whitespace())
            .count();
    if end == 0 {
        return None;
    }

    // Skip trailing OFFSET clause: ... OFFSET <number>
    let mut end = end;
    if upper[..end].ends_with("OFFSET") {
        // Find "OFFSET" keyword
        if let Some(pos) = find_keyword_offset(upper, "OFFSET") {
            end = pos;
        }
    }

    // Now look for LIMIT keyword
    find_keyword_offset(&upper[..end], "LIMIT")
}

/// Find position where a keyword starts at the end of the string (with number after it)
fn find_keyword_offset(s: &str, keyword: &str) -> Option<usize> {
    let upper = s.to_uppercase();
    // Search for "LIMIT" followed by a digit, anywhere in the string
    // We want the last occurrence that's followed by digits (not part of another word)
    let mut last_pos = None;
    let bytes = upper.as_bytes();
    let keyword_bytes = keyword.as_bytes();

    for i in 0..=bytes.len().saturating_sub(keyword_bytes.len()) {
        if &bytes[i..i + keyword_bytes.len()] == keyword_bytes {
            // Check it's not part of a larger word
            let before_ok = i == 0 || bytes[i - 1] == b' ' || bytes[i - 1] == b'\t';
            let after_pos = i + keyword_bytes.len();
            let after_ok =
                after_pos < bytes.len() && (bytes[after_pos] == b' ' || bytes[after_pos] == b'\t');

            if before_ok && after_ok {
                // Check there's a digit following
                let rest = &upper[after_pos..].trim_start();
                if rest.starts_with(|c: char| c.is_ascii_digit()) {
                    last_pos = Some(i);
                }
            }
        }
    }

    last_pos
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
