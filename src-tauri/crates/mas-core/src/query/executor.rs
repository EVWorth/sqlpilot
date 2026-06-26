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
        let pool = self.connection_manager.get_pool(&connection_id)?;
        let statements = split_statements(&sql);

        // Apply user-specified row limit to SELECT/SHOW/DESCRIBE statements (if provided)
        let statements: Vec<String> = if let Some(max_rows) = limit {
            statements
                .into_iter()
                .map(|stmt| {
                    let upper = stmt.trim().to_uppercase();
                    if upper.starts_with("SELECT")
                        || upper.starts_with("SHOW")
                        || upper.starts_with("DESCRIBE")
                        || upper.starts_with("EXPLAIN")
                    {
                        // Respect in-statement LIMIT: only apply global limit if user didn't specify one
                        if has_limit_clause(&upper) {
                            stmt
                        } else {
                            format!("{} LIMIT {}", stmt.trim_end_matches(';'), max_rows)
                        }
                    } else {
                        stmt
                    }
                })
                .collect()
        } else {
            statements
        };

        // Memory guard: detect OOM before the OS kills us
        let mut mem_guard = MemoryGuard::new();

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
                        // Check memory every 1000 rows to prevent OOM
                        if !current_rows.is_empty()
                            && current_rows.len().is_multiple_of(1000)
                            && mem_guard.check().is_err()
                        {
                            tracing::warn!(
                                rows_accumulated = current_rows.len(),
                                "Memory limit reached, stopping query fetch"
                            );
                            break;
                        }
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
                            let row_count = current_rows.len() as u64;
                            let rows_truncated = limit.is_some() && row_count >= limit.unwrap()
                                || mem_guard.triggered();

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

                            results.push(build_select_result(
                                query_id,
                                idx,
                                &current_rows,
                                execution_time,
                                rows_truncated,
                            ));
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

        // If memory guard triggered mid-stream, process accumulated rows for current statement
        if mem_guard.triggered() && stmt_idx >= 0 && !current_rows.is_empty() {
            let idx = stmt_idx as usize;
            let stmt = &statements[idx];
            let execution_time = start.elapsed().as_millis() as u64;

            let upper = stmt.to_uppercase();
            let is_select = upper.starts_with("SELECT")
                || upper.starts_with("SHOW")
                || upper.starts_with("DESCRIBE")
                || upper.starts_with("EXPLAIN");

            if is_select {
                results.push(build_select_result(
                    uuid::Uuid::new_v4().to_string(),
                    idx,
                    &current_rows,
                    execution_time,
                    true,
                ));
            }
        }

        Ok(results)
    }
}

fn extract_value(row: &sqlx::mysql::MySqlRow, index: usize, type_name: &str) -> SqlValue {
    let t = type_name.to_uppercase();
    let t = t.trim();

    match t {
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
        "FLOAT" | "DOUBLE" | "DECIMAL" | "REAL" => row
            .try_get::<Option<f64>, _>(index)
            .ok()
            .flatten()
            .map(SqlValue::Float)
            .unwrap_or(SqlValue::Null),
        "JSON" => row
            .try_get::<Option<serde_json::Value>, _>(index)
            .ok()
            .flatten()
            .map(|v| SqlValue::String(v.to_string()))
            .unwrap_or(SqlValue::Null),
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" => row
            .try_get::<Option<Vec<u8>>, _>(index)
            .ok()
            .flatten()
            .map(SqlValue::Bytes)
            .unwrap_or(SqlValue::Null),
        "BIT" => row
            .try_get::<Option<u64>, _>(index)
            .ok()
            .flatten()
            .map(SqlValue::UInt)
            .unwrap_or(SqlValue::Null),
        "DATE" | "DATETIME" | "TIMESTAMP" | "TIME" | "YEAR" => {
            // Try chrono types first
            let val = row.try_get::<Option<sqlx::types::chrono::NaiveDateTime>, _>(index);
            if let Ok(Some(dt)) = val {
                return SqlValue::String(dt.to_string());
            }
            let val = row.try_get::<Option<sqlx::types::chrono::NaiveDate>, _>(index);
            if let Ok(Some(d)) = val {
                return SqlValue::String(d.to_string());
            }
            let val = row.try_get::<Option<sqlx::types::chrono::NaiveTime>, _>(index);
            if let Ok(Some(t)) = val {
                return SqlValue::String(t.to_string());
            }
            // Fallback: try as plain string
            row.try_get::<Option<String>, _>(index)
                .ok()
                .flatten()
                .map(SqlValue::String)
                .unwrap_or(SqlValue::Null)
        }
        _ => row
            .try_get::<Option<String>, _>(index)
            .ok()
            .flatten()
            .map(SqlValue::String)
            .unwrap_or(SqlValue::Null),
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

/// Check if a SQL statement already has a LIMIT clause.
fn has_limit_clause(upper: &str) -> bool {
    find_limit_keyword(upper).is_some()
}

#[allow(dead_code)]
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

fn build_select_result(
    query_id: String,
    statement_index: usize,
    rows: &[sqlx::mysql::MySqlRow],
    execution_time_ms: u64,
    rows_truncated: bool,
) -> QueryResult {
    let columns: Vec<ColumnMeta> = rows
        .first()
        .map(|r| {
            r.columns()
                .iter()
                .map(|col| ColumnMeta {
                    name: col.name().to_string(),
                    data_type: col.type_info().name().to_string(),
                    nullable: true,
                    is_primary_key: false,
                })
                .collect()
        })
        .unwrap_or_default();

    let result_rows: Vec<Vec<SqlValue>> = rows
        .iter()
        .map(|row| {
            row.columns()
                .iter()
                .enumerate()
                .map(|(i, col)| extract_value(row, i, col.type_info().name()))
                .collect()
        })
        .collect();

    let row_count = result_rows.len() as u64;

    QueryResult {
        query_id,
        statement_index,
        columns,
        rows: result_rows,
        rows_affected: row_count,
        execution_time_ms,
        warnings: vec![],
        rows_truncated,
        total_rows_available: if rows_truncated {
            Some(row_count)
        } else {
            None
        },
    }
}

/// Monitors system-wide available memory to prevent OOM crashes.
/// Checks every 1000 rows during query execution and triggers when
/// available system memory drops below 512 MB.
struct MemoryGuard {
    sys: sysinfo::System,
    triggered: bool,
}

impl MemoryGuard {
    /// Create a new guard. Reads initial memory state for diagnostics.
    fn new() -> Self {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();

        let available_mb = sys.available_memory() / 1024 / 1024;
        let total_mb = sys.total_memory() / 1024 / 1024;

        tracing::debug!(
            available_mb,
            total_mb,
            "Memory guard initialized, will stop query if available memory drops below 512 MB"
        );

        Self {
            sys,
            triggered: false,
        }
    }

    /// Refresh system memory and return Err if available memory is below 512 MB.
    /// Sets the triggered flag on the first failure so subsequent calls fast-fail.
    fn check(&mut self) -> Result<(), CoreError> {
        if self.triggered {
            return Err(CoreError::OutOfMemory(
                "Query stopped: available memory critically low".to_string(),
            ));
        }

        self.sys.refresh_memory();
        let available_mb = self.sys.available_memory() / 1024 / 1024;

        if available_mb < 512 {
            self.triggered = true;
            tracing::warn!(available_mb, "System memory critically low, stopping query");
            return Err(CoreError::OutOfMemory(format!(
                "System memory critically low ({available_mb} MB available). \
                 Add a LIMIT clause to reduce result size."
            )));
        }

        Ok(())
    }

    fn triggered(&self) -> bool {
        self.triggered
    }
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
