use crate::connection::SqliteConnectionManager;
use crate::error::SqliteError;
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct SqliteTableInfo {
    pub name: String,
    pub table_type: String,
    pub row_count: Option<i64>,
    pub sql: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SqliteColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SqliteIndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
}

pub struct SqliteSchemaInspector {
    manager: Arc<SqliteConnectionManager>,
}

impl SqliteSchemaInspector {
    pub fn new(manager: Arc<SqliteConnectionManager>) -> Self {
        Self { manager }
    }

    pub async fn get_tables(
        &self,
        connection_id: &str,
    ) -> Result<Vec<SqliteTableInfo>, SqliteError> {
        let conn = self.manager.get(connection_id)?;
        tokio::task::spawn_blocking(move || {
            let db = conn.db.lock().map_err(|e| SqliteError::Schema(e.to_string()))?;
            let mut stmt = db.prepare(
                "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )?;
            let table_rows: Vec<(String, String, Option<String>)> = stmt
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);

            let mut tables = Vec::new();
            for (name, ttype, sql) in table_rows {
                let row_count = if ttype == "table" {
                    db.query_row(
                        &format!("SELECT COUNT(*) FROM \"{}\"", name),
                        [],
                        |r| r.get(0),
                    )
                    .ok()
                } else {
                    None
                };
                tables.push(SqliteTableInfo {
                    name,
                    table_type: ttype,
                    row_count,
                    sql,
                });
            }
            Ok(tables)
        })
        .await
        .map_err(|e| SqliteError::Schema(e.to_string()))?
    }

    pub async fn get_columns(
        &self,
        connection_id: &str,
        table: &str,
    ) -> Result<Vec<SqliteColumnInfo>, SqliteError> {
        let conn = self.manager.get(connection_id)?;
        let table = table.to_string();
        tokio::task::spawn_blocking(move || {
            let db = conn
                .db
                .lock()
                .map_err(|e| SqliteError::Schema(e.to_string()))?;
            let mut stmt = db.prepare(&format!("PRAGMA table_info(\"{}\")", table))?;
            let columns = stmt
                .query_map([], |row| {
                    Ok(SqliteColumnInfo {
                        name: row.get(1)?,
                        data_type: row.get::<_, String>(2).unwrap_or_default(),
                        nullable: row.get::<_, i32>(3).unwrap_or(0) == 0,
                        default_value: row.get(4)?,
                        is_primary_key: row.get::<_, i32>(5).unwrap_or(0) > 0,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(columns)
        })
        .await
        .map_err(|e| SqliteError::Schema(e.to_string()))?
    }

    pub async fn get_indexes(
        &self,
        connection_id: &str,
        table: &str,
    ) -> Result<Vec<SqliteIndexInfo>, SqliteError> {
        let conn = self.manager.get(connection_id)?;
        let table = table.to_string();
        tokio::task::spawn_blocking(move || {
            let db = conn.db.lock().map_err(|e| SqliteError::Schema(e.to_string()))?;
            let mut stmt = db.prepare(
                "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=?1 AND name NOT LIKE 'sqlite_%'"
            )?;
            let indexes = stmt
                .query_map([&table], |row| {
                    let name: String = row.get(0)?;
                    Ok(SqliteIndexInfo {
                        name,
                        columns: row
                            .get::<_, Option<String>>(1)
                            .ok()
                            .flatten()
                            .and_then(|sql| {
                                let start = sql.find('(')?;
                                let end = sql.rfind(')')?;
                                Some(
                                    sql[start + 1..end]
                                        .split(',')
                                        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
                                        .collect(),
                                )
                            })
                            .unwrap_or_default(),
                        is_unique: row
                            .get::<_, Option<String>>(1)
                            .ok()
                            .flatten()
                            .map(|s| s.to_uppercase().contains("UNIQUE"))
                            .unwrap_or(false),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(indexes)
        })
        .await
        .map_err(|e| SqliteError::Schema(e.to_string()))?
    }

    pub async fn get_table_ddl(
        &self,
        connection_id: &str,
        table: &str,
    ) -> Result<String, SqliteError> {
        let conn = self.manager.get(connection_id)?;
        let table = table.to_string();
        tokio::task::spawn_blocking(move || {
            let db = conn
                .db
                .lock()
                .map_err(|e| SqliteError::Schema(e.to_string()))?;
            db.query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [&table],
                |row| row.get(0),
            )
            .map_err(|e| SqliteError::Schema(e.to_string()))
        })
        .await
        .map_err(|e| SqliteError::Schema(e.to_string()))?
    }
}
