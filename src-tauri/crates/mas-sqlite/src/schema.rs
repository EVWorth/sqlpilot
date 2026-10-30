use crate::connection::SqliteConnectionManager;
use crate::error::SqliteError;
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SqliteTableInfo {
    pub name: String,
    pub table_type: String,
    // JSON already serialises this as a number and JS truncates past 2^53;
    // declaring it as f64 documents the existing behaviour rather than
    // changing it. Row counts, byte sizes, timings and ids never approach it.
    #[specta(type = Option<specta_typescript::Number>)]
    pub row_count: Option<i64>,
    pub sql: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SqliteColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SqliteIndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
}

/// A foreign key, in the shape `mas-core`'s `ForeignKeyInfo` has, so the
/// app can hand both backends' keys to the same views.
///
/// `PRAGMA foreign_key_list` has no constraint names: SQLite parses
/// `CONSTRAINT <name>` and then drops it. `name` is therefore made up as
/// `fk_<table>_<id>`, from the pragma's per-table key id, which is stable for
/// a given schema and unique within the table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct SqliteForeignKeyInfo {
    pub name: String,
    /// In key order (the pragma's `seq`).
    pub columns: Vec<String>,
    pub referenced_table: String,
    /// Paired with `columns`. A key declared as `REFERENCES parent` with no
    /// column list points at the parent's primary key, which is read here.
    pub referenced_columns: Vec<String>,
    /// `NO ACTION`, `RESTRICT`, `SET NULL`, `SET DEFAULT` or `CASCADE`: the
    /// same words MySQL's `REFERENTIAL_CONSTRAINTS` uses.
    pub on_update: String,
    pub on_delete: String,
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
                    // A table name cannot be a bound parameter, so it is
                    // quoted instead, every `"` in it doubled (#929). The
                    // listing comes from `main`, so the count does too, not
                    // from a temp table that shadows the name.
                    db.query_row(
                        &format!("SELECT COUNT(*) FROM \"main\".{}", quote_identifier(&name)),
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
            // The table-valued pragma takes the name as a bound parameter,
            // so no name, however it is spelt, needs quoting (#929).
            let mut stmt = db.prepare(
                "SELECT name, type, \"notnull\", dflt_value, pk \
                 FROM pragma_table_info(?1) ORDER BY cid",
            )?;
            let columns = stmt
                .query_map([&table], |row| {
                    Ok(SqliteColumnInfo {
                        name: row.get(0)?,
                        data_type: row.get::<_, String>(1).unwrap_or_default(),
                        nullable: row.get::<_, i32>(2).unwrap_or(0) == 0,
                        default_value: row.get(3)?,
                        is_primary_key: row.get::<_, i32>(4).unwrap_or(0) > 0,
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
            let db = conn
                .db
                .lock()
                .map_err(|e| SqliteError::Schema(e.to_string()))?;
            read_indexes(&db, &table)
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

    /// The foreign keys `table` declares, from `PRAGMA foreign_key_list`.
    /// A table with none, a view or an unknown name gives an empty list.
    #[tracing::instrument(skip(self))]
    pub async fn get_foreign_keys(
        &self,
        connection_id: &str,
        table: &str,
    ) -> Result<Vec<SqliteForeignKeyInfo>, SqliteError> {
        let conn = self.manager.get(connection_id)?;
        let table = table.to_string();
        tokio::task::spawn_blocking(move || {
            let db = conn
                .db
                .lock()
                .map_err(|e| SqliteError::Schema(e.to_string()))?;
            read_foreign_keys(&db, &table)
        })
        .await
        .map_err(|e| SqliteError::Schema(e.to_string()))?
    }
}

/// One row of `PRAGMA foreign_key_list`: a column pair of one key.
struct ForeignKeyRow {
    id: i64,
    parent: String,
    from: String,
    /// `NULL` when the key names no parent columns.
    to: Option<String>,
    on_update: String,
    on_delete: String,
}

/// The table-valued form of the pragma takes the table name as a bound
/// parameter, so no name, however it is spelt, needs quoting.
fn read_foreign_keys(
    db: &rusqlite::Connection,
    table: &str,
) -> Result<Vec<SqliteForeignKeyInfo>, SqliteError> {
    let mut stmt = db.prepare(
        "SELECT id, \"table\", \"from\", \"to\", on_update, on_delete \
         FROM pragma_foreign_key_list(?1) ORDER BY id, seq",
    )?;
    let rows = stmt
        .query_map([table], |row| {
            Ok(ForeignKeyRow {
                id: row.get(0)?,
                parent: row.get(1)?,
                from: row.get(2)?,
                to: row.get(3)?,
                on_update: row.get(4)?,
                on_delete: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut keys: Vec<(i64, SqliteForeignKeyInfo, bool)> = Vec::new();
    for row in rows {
        let implicit = row.to.is_none();
        match keys.last_mut() {
            Some((id, key, implicit_key)) if *id == row.id => {
                key.columns.push(row.from);
                key.referenced_columns.extend(row.to);
                *implicit_key |= implicit;
            }
            _ => keys.push((
                row.id,
                SqliteForeignKeyInfo {
                    name: format!("fk_{table}_{}", row.id),
                    columns: vec![row.from],
                    referenced_table: row.parent,
                    referenced_columns: row.to.into_iter().collect(),
                    on_update: row.on_update,
                    on_delete: row.on_delete,
                },
                implicit,
            )),
        }
    }

    keys.into_iter()
        .map(|(_, mut key, implicit)| {
            if implicit {
                key.referenced_columns = primary_key_columns(db, &key.referenced_table)?;
            }
            Ok(key)
        })
        .collect()
}

/// The parent's primary key columns, in key order. Empty if the parent does
/// not exist (SQLite allows a key to point at a table not created yet).
fn primary_key_columns(db: &rusqlite::Connection, table: &str) -> Result<Vec<String>, SqliteError> {
    let mut stmt = db.prepare("SELECT name FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk")?;
    let columns = stmt
        .query_map([table], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns)
}

/// The indexes created on `table` with `CREATE INDEX`, in name order.
///
/// Read from `pragma_index_list` and `pragma_index_xinfo` rather than parsed
/// out of the `CREATE INDEX` text (#929), which split expression indexes and
/// `COLLATE`/`DESC` columns wrongly. The automatic indexes behind PRIMARY KEY
/// and UNIQUE constraints (origin `pk` and `u`) are left out, as they were.
fn read_indexes(
    db: &rusqlite::Connection,
    table: &str,
) -> Result<Vec<SqliteIndexInfo>, SqliteError> {
    let mut stmt = db.prepare(
        "SELECT name, \"unique\" FROM pragma_index_list(?1) WHERE origin = 'c' ORDER BY name",
    )?;
    let listed = stmt
        .query_map([table], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    listed
        .into_iter()
        .map(|(name, is_unique)| {
            Ok(SqliteIndexInfo {
                columns: index_key_columns(db, &name)?,
                name,
                is_unique,
            })
        })
        .collect()
}

/// What an expression column of an index is reported as. SQLite records no
/// name for it, and the expression text exists only in the `CREATE INDEX`.
pub const EXPRESSION_COLUMN: &str = "<expression>";

/// The key columns of an index, in key order. The row id SQLite appends to
/// every index is not a key column and is left out; an expression column
/// reads as [`EXPRESSION_COLUMN`].
fn index_key_columns(db: &rusqlite::Connection, index: &str) -> Result<Vec<String>, SqliteError> {
    let mut stmt = db
        .prepare("SELECT cid, name FROM pragma_index_xinfo(?1) WHERE \"key\" = 1 ORDER BY seqno")?;
    let columns = stmt
        .query_map([index], |row| {
            let cid: i64 = row.get(0)?;
            let name: Option<String> = row.get(1)?;
            Ok(match (name, cid) {
                (Some(name), _) => name,
                // -1 is the row id, named explicitly as a key column.
                (None, -1) => "rowid".to_string(),
                (None, _) => EXPRESSION_COLUMN.to_string(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns)
}

/// `name` as a quoted SQL identifier: wrapped in `"`, every `"` inside it
/// doubled. For the places a name cannot be a bound parameter.
pub fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_identifier_doubles_embedded_quotes() {
        assert_eq!(quote_identifier("plain"), "\"plain\"");
        assert_eq!(quote_identifier("a\"b"), "\"a\"\"b\"");
        assert_eq!(
            quote_identifier("x\"; DROP TABLE t; --"),
            "\"x\"\"; DROP TABLE t; --\""
        );
    }
}
