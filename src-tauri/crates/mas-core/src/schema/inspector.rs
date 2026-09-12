use crate::connection::ConnectionManager;
use crate::error::CoreError;
use crate::schema::ident::qualified;
use serde::Serialize;
use sqlx::{AssertSqlSafe, Row};
use std::sync::Arc;

pub struct SchemaInspector {
    connection_manager: Arc<ConnectionManager>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct DatabaseInfo {
    pub name: String,
    pub default_charset: String,
    pub default_collation: String,
    /// True for the server's own schemas.
    ///
    /// Reported rather than filtered out here, so FR-4.1.6's toggle is a
    /// decision the tree makes rather than a second round trip. They were
    /// excluded in the query, which made them unreachable at any price (#291).
    pub is_system: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TableInfo {
    pub name: String,
    pub table_type: String, // "BASE TABLE" or "VIEW"
    pub engine: Option<String>,
    // JSON already serialises this as a number and JS truncates past 2^53;
    // declaring it as f64 documents the existing behaviour rather than
    // changing it. Row counts, byte sizes, timings and ids never approach it.
    #[specta(type = Option<specta_typescript::Number>)]
    pub row_count: Option<i64>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub data_size: Option<i64>,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub column_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
    pub extra: String,
    pub comment: String,
    /// Only set for string columns, and only when the column carries its own
    /// character set rather than inheriting the table's. COLUMN_TYPE does not
    /// include either, so without these a round-trip through the designer
    /// would rewrite the column with the table default (#377).
    pub charset: Option<String>,
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub index_type: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ForeignKeyInfo {
    pub name: String,
    /// In key order. A composite foreign key spans several rows of
    /// KEY_COLUMN_USAGE, which ORDINAL_POSITION puts back in order.
    pub columns: Vec<String>,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

/// A foreign key pointing at a table, named from the far end.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ReferencingKey {
    /// The table that declares the constraint.
    pub table: String,
    pub name: String,
    pub columns: Vec<String>,
    /// The columns of the referenced table that are pointed at.
    pub referenced_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

/// A column whose name, or whose table's name, matched a search.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SchemaMatch {
    pub table: String,
    pub column: String,
    pub column_type: String,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ViewInfo {
    pub name: String,
    pub is_updatable: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct RoutineInfo {
    pub name: String,
    pub routine_type: String,
    pub data_type: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TriggerInfo {
    pub name: String,
    pub event: String,
    pub table: String,
    pub timing: String,
}

/// A scheduled event, which FR-4.1.1 lists alongside the other object types
/// and which the tree had no folder for (#291).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct EventInfo {
    pub name: String,
    /// `ONE TIME` or `RECURRING`.
    pub event_type: String,
    /// `ENABLED`, `DISABLED`, or `SLAVESIDE_DISABLED`.
    pub status: String,
    pub definer: String,
    /// How often a recurring event runs, e.g. "1 DAY". Empty for one-shot.
    pub interval: String,
    pub comment: String,
}

/// One partition of a partitioned table, or nothing for a table without any.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct PartitionInfo {
    pub name: String,
    /// `RANGE`, `LIST`, `HASH`, `KEY`, and the `COLUMNS` variants.
    pub method: String,
    /// The expression partitioned on.
    pub expression: String,
    /// The bound, for RANGE and LIST.
    pub description: String,
    #[specta(type = specta_typescript::Number)]
    pub row_count: i64,
    #[specta(type = specta_typescript::Number)]
    pub data_size: i64,
}

/// The schemas the server keeps for itself.
///
/// The same four on MySQL 8 and MariaDB 11 — MariaDB gained `sys` in 10.6.
/// Compared case-insensitively because the server's own case-sensitivity for
/// schema names depends on the filesystem it is running on.
pub fn is_system_schema(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "information_schema" | "performance_schema" | "mysql" | "sys"
    )
}

impl SchemaInspector {
    pub fn new(connection_manager: Arc<ConnectionManager>) -> Self {
        Self { connection_manager }
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_databases(&self, connection_id: &str) -> Result<Vec<DatabaseInfo>, CoreError> {
        tracing::debug!("Fetching databases");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query(
            "SELECT CAST(SCHEMA_NAME AS CHAR) AS SCHEMA_NAME,
                    CAST(DEFAULT_CHARACTER_SET_NAME AS CHAR) AS DEFAULT_CHARACTER_SET_NAME,
                    CAST(DEFAULT_COLLATION_NAME AS CHAR) AS DEFAULT_COLLATION_NAME
             FROM INFORMATION_SCHEMA.SCHEMATA
             ORDER BY SCHEMA_NAME",
        )
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let databases: Vec<DatabaseInfo> = rows
            .iter()
            .map(|row| {
                let name: String = row.get("SCHEMA_NAME");
                DatabaseInfo {
                    is_system: is_system_schema(&name),
                    name,
                    default_charset: row.get("DEFAULT_CHARACTER_SET_NAME"),
                    default_collation: row.get("DEFAULT_COLLATION_NAME"),
                }
            })
            .collect();
        tracing::debug!(count = databases.len(), "Found databases");
        Ok(databases)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_tables(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<TableInfo>, CoreError> {
        tracing::debug!(database = %database, "Fetching tables");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query(
            "SELECT CAST(TABLE_NAME AS CHAR) AS TABLE_NAME,
                    CAST(TABLE_TYPE AS CHAR) AS TABLE_TYPE,
                    CAST(ENGINE AS CHAR) AS ENGINE,
                    TABLE_ROWS,
                    DATA_LENGTH,
                    CAST(TABLE_COMMENT AS CHAR) AS TABLE_COMMENT
             FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_SCHEMA = ?
             ORDER BY TABLE_NAME",
        )
        .bind(database)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let tables: Vec<TableInfo> = rows
            .iter()
            .map(|row| TableInfo {
                name: row.get("TABLE_NAME"),
                table_type: row.get("TABLE_TYPE"),
                engine: row.try_get("ENGINE").ok(),
                row_count: row.try_get("TABLE_ROWS").ok(),
                data_size: row.try_get("DATA_LENGTH").ok(),
                comment: row.try_get("TABLE_COMMENT").unwrap_or_default(),
            })
            .collect();
        tracing::debug!(count = tables.len(), database = %database, "Found tables");
        Ok(tables)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_columns(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<ColumnInfo>, CoreError> {
        tracing::debug!(database = %database, table = %table, "Fetching columns");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query(
            "SELECT CAST(COLUMN_NAME AS CHAR) AS COLUMN_NAME,
                    CAST(DATA_TYPE AS CHAR) AS DATA_TYPE,
                    CAST(COLUMN_TYPE AS CHAR) AS COLUMN_TYPE,
                    CAST(IS_NULLABLE AS CHAR) AS IS_NULLABLE,
                    CAST(COLUMN_DEFAULT AS CHAR) AS COLUMN_DEFAULT,
                    CAST(COLUMN_KEY AS CHAR) AS COLUMN_KEY,
                    CAST(EXTRA AS CHAR) AS EXTRA,
                    CAST(COLUMN_COMMENT AS CHAR) AS COLUMN_COMMENT,
                    CAST(CHARACTER_SET_NAME AS CHAR) AS CHARACTER_SET_NAME,
                    CAST(COLLATION_NAME AS CHAR) AS COLLATION_NAME
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let columns: Vec<ColumnInfo> = rows
            .iter()
            .map(|row| {
                let nullable_str: String = row.get("IS_NULLABLE");
                let key: String = row.get("COLUMN_KEY");
                ColumnInfo {
                    name: row.get("COLUMN_NAME"),
                    data_type: row.get("DATA_TYPE"),
                    column_type: row.get("COLUMN_TYPE"),
                    nullable: nullable_str == "YES",
                    default_value: row.try_get("COLUMN_DEFAULT").ok(),
                    is_primary_key: key == "PRI",
                    extra: row.get("EXTRA"),
                    comment: row.try_get("COLUMN_COMMENT").unwrap_or_default(),
                    charset: row.try_get("CHARACTER_SET_NAME").ok(),
                    collation: row.try_get("COLLATION_NAME").ok(),
                }
            })
            .collect();
        tracing::debug!(count = columns.len(), database = %database, table = %table, "Found columns");
        Ok(columns)
    }

    #[tracing::instrument(skip(self))]
    /// The table's foreign keys, with the referential actions that go with
    /// them.
    ///
    /// This had a type and no method: the designer showed an empty Foreign
    /// Keys tab for every table, so an existing constraint could not be seen,
    /// edited or removed (#386).
    ///
    /// The columns come from KEY_COLUMN_USAGE, one row per column, and the ON
    /// UPDATE / ON DELETE rules from REFERENTIAL_CONSTRAINTS, one row per
    /// constraint — hence the join and the grouping.
    pub async fn get_foreign_keys(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<ForeignKeyInfo>, CoreError> {
        tracing::debug!(database = %database, table = %table, "Fetching foreign keys");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query(
            "SELECT CAST(k.CONSTRAINT_NAME AS CHAR) AS CONSTRAINT_NAME,
                    CAST(k.COLUMN_NAME AS CHAR) AS COLUMN_NAME,
                    CAST(k.REFERENCED_TABLE_NAME AS CHAR) AS REFERENCED_TABLE_NAME,
                    CAST(k.REFERENCED_COLUMN_NAME AS CHAR) AS REFERENCED_COLUMN_NAME,
                    CAST(r.UPDATE_RULE AS CHAR) AS UPDATE_RULE,
                    CAST(r.DELETE_RULE AS CHAR) AS DELETE_RULE
             FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
             JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
               ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
              AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
              AND r.TABLE_NAME = k.TABLE_NAME
             WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?
               AND k.REFERENCED_TABLE_NAME IS NOT NULL
             ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        // Grouped in first-seen order, which ORDER BY has already settled, so
        // a composite key's columns stay in key order.
        let mut keys: Vec<ForeignKeyInfo> = Vec::new();
        for row in &rows {
            let name: String = row.get("CONSTRAINT_NAME");
            let column: String = row.get("COLUMN_NAME");
            let ref_column: String = row.get("REFERENCED_COLUMN_NAME");

            match keys.last_mut() {
                Some(existing) if existing.name == name => {
                    existing.columns.push(column);
                    existing.referenced_columns.push(ref_column);
                }
                _ => keys.push(ForeignKeyInfo {
                    name,
                    columns: vec![column],
                    referenced_table: row.get("REFERENCED_TABLE_NAME"),
                    referenced_columns: vec![ref_column],
                    on_update: row.get("UPDATE_RULE"),
                    on_delete: row.get("DELETE_RULE"),
                }),
            }
        }

        tracing::debug!(count = keys.len(), "Foreign keys fetched");
        Ok(keys)
    }

    /// Foreign keys that point *at* this table, from wherever they are declared.
    ///
    /// The direction a schema dump does not have. `get_foreign_keys` answers
    /// "what does this table depend on"; this answers "what depends on it",
    /// which is the question behind "is this row safe to delete" and "can this
    /// column change type".
    ///
    /// Scoped to one schema: a cross-schema foreign key is legal but rare, and
    /// searching every schema on the server turns a cheap lookup into a scan
    /// of the whole instance.
    pub async fn get_referencing_keys(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<ReferencingKey>, CoreError> {
        tracing::debug!(database = %database, table = %table, "Fetching referencing keys");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query(
            "SELECT CAST(k.TABLE_NAME AS CHAR) AS TABLE_NAME,
                    CAST(k.CONSTRAINT_NAME AS CHAR) AS CONSTRAINT_NAME,
                    CAST(k.COLUMN_NAME AS CHAR) AS COLUMN_NAME,
                    CAST(k.REFERENCED_COLUMN_NAME AS CHAR) AS REFERENCED_COLUMN_NAME,
                    CAST(r.UPDATE_RULE AS CHAR) AS UPDATE_RULE,
                    CAST(r.DELETE_RULE AS CHAR) AS DELETE_RULE
             FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
             JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
               ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
              AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
              AND r.TABLE_NAME = k.TABLE_NAME
             WHERE k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?
             ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        // Grouped in first-seen order, as in get_foreign_keys, so a composite
        // key's columns stay in key order.
        let mut keys: Vec<ReferencingKey> = Vec::new();
        for row in &rows {
            let table_name: String = row.get("TABLE_NAME");
            let name: String = row.get("CONSTRAINT_NAME");
            let column: String = row.get("COLUMN_NAME");
            let ref_column: String = row.get("REFERENCED_COLUMN_NAME");

            match keys.last_mut() {
                Some(existing) if existing.name == name && existing.table == table_name => {
                    existing.columns.push(column);
                    existing.referenced_columns.push(ref_column);
                }
                _ => keys.push(ReferencingKey {
                    table: table_name,
                    name,
                    columns: vec![column],
                    referenced_columns: vec![ref_column],
                    on_update: row.get("UPDATE_RULE"),
                    on_delete: row.get("DELETE_RULE"),
                }),
            }
        }

        tracing::debug!(count = keys.len(), "Referencing keys fetched");
        Ok(keys)
    }

    /// Tables and columns whose name contains a fragment.
    ///
    /// One query against INFORMATION_SCHEMA rather than a walk of every
    /// table, because the databases where this matters are the ones with five
    /// hundred tables in them — the same ones where listing everything is
    /// useless.
    ///
    /// `limit` is applied in the database. A caller that gets exactly `limit`
    /// matches should assume there are more.
    pub async fn search_schema(
        &self,
        connection_id: &str,
        database: &str,
        fragment: &str,
        limit: u32,
    ) -> Result<Vec<SchemaMatch>, CoreError> {
        tracing::debug!(database = %database, "Searching schema");
        let pool = self.connection_manager.get_pool(connection_id)?;
        // Escaped so a fragment containing % or _ searches for those
        // characters rather than becoming a wildcard: someone looking for
        // "created_at" means that column, not "createdXat".
        let pattern = format!(
            "%{}%",
            fragment
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let rows = sqlx::query(
            "SELECT CAST(TABLE_NAME AS CHAR) AS TABLE_NAME,
                    CAST(COLUMN_NAME AS CHAR) AS COLUMN_NAME,
                    CAST(COLUMN_TYPE AS CHAR) AS COLUMN_TYPE,
                    CAST(COLUMN_COMMENT AS CHAR) AS COLUMN_COMMENT
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = ?
               AND (TABLE_NAME LIKE ? OR COLUMN_NAME LIKE ?)
             ORDER BY TABLE_NAME, ORDINAL_POSITION
             LIMIT ?",
        )
        .bind(database)
        .bind(&pattern)
        .bind(&pattern)
        .bind(limit)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        Ok(rows
            .iter()
            .map(|row| SchemaMatch {
                table: row.get("TABLE_NAME"),
                column: row.get("COLUMN_NAME"),
                column_type: row.get("COLUMN_TYPE"),
                comment: row.get("COLUMN_COMMENT"),
            })
            .collect())
    }

    pub async fn get_indexes(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<IndexInfo>, CoreError> {
        tracing::debug!(database = %database, table = %table, "Fetching indexes");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query(
            "SELECT CAST(INDEX_NAME AS CHAR) AS INDEX_NAME,
                    CAST(COLUMN_NAME AS CHAR) AS COLUMN_NAME,
                    NON_UNIQUE,
                    CAST(INDEX_TYPE AS CHAR) AS INDEX_TYPE
             FROM INFORMATION_SCHEMA.STATISTICS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
             ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let mut index_map: std::collections::BTreeMap<String, IndexInfo> =
            std::collections::BTreeMap::new();
        for row in &rows {
            let name: String = row.get("INDEX_NAME");
            // NULL for a functional index — MySQL 8 puts the expression in
            // EXPRESSION and leaves COLUMN_NAME empty. Decoding it as String
            // panicked, so any table carrying one made the whole schema read
            // fail. EXPRESSION cannot simply be selected instead: MariaDB has
            // no such column, and errors on the query. The index is still
            // listed, with no columns, which is the honest answer for
            // something that indexes an expression rather than a column.
            let col: Option<String> = row.get("COLUMN_NAME");
            let non_unique: i32 = row.get("NON_UNIQUE");
            let idx_type: String = row.get("INDEX_TYPE");

            index_map
                .entry(name.clone())
                .and_modify(|idx| {
                    if let Some(col) = &col {
                        idx.columns.push(col.clone());
                    }
                })
                .or_insert_with(|| IndexInfo {
                    name,
                    columns: col.into_iter().collect(),
                    is_unique: non_unique == 0,
                    index_type: idx_type,
                });
        }

        let indexes: Vec<IndexInfo> = index_map.into_values().collect();
        tracing::debug!(count = indexes.len(), database = %database, table = %table, "Found indexes");
        Ok(indexes)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_table_ddl(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<String, CoreError> {
        tracing::debug!(database = %database, table = %table, "Fetching table DDL");
        let pool = self.connection_manager.get_pool(connection_id)?;
        // Qualified, so no `USE` is needed and no session state is relied on
        // (#290).
        let row = sqlx::raw_sql(AssertSqlSafe(format!(
            "SHOW CREATE TABLE {}",
            qualified(database, table)
        )))
        .fetch_one(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let ddl: String = row.try_get(1).unwrap_or_default();
        tracing::debug!(ddl_length = ddl.len(), "Retrieved DDL");
        Ok(ddl)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_views(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<ViewInfo>, CoreError> {
        tracing::debug!(database = %database, "Fetching views");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query(
            "SELECT CAST(TABLE_NAME AS CHAR) AS TABLE_NAME,
                    CAST(IS_UPDATABLE AS CHAR) AS IS_UPDATABLE
             FROM INFORMATION_SCHEMA.VIEWS
             WHERE TABLE_SCHEMA = ?
             ORDER BY TABLE_NAME",
        )
        .bind(database)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let views: Vec<ViewInfo> = rows
            .iter()
            .map(|row| {
                let updatable: String = row.get("IS_UPDATABLE");
                ViewInfo {
                    name: row.get("TABLE_NAME"),
                    is_updatable: updatable == "YES",
                }
            })
            .collect();
        tracing::debug!(count = views.len(), database = %database, "Found views");
        Ok(views)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_routines(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<RoutineInfo>, CoreError> {
        tracing::debug!(database = %database, "Fetching routines");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query(
            "SELECT CAST(ROUTINE_NAME AS CHAR) AS ROUTINE_NAME,
                    CAST(ROUTINE_TYPE AS CHAR) AS ROUTINE_TYPE,
                    CAST(DATA_TYPE AS CHAR) AS DATA_TYPE
             FROM INFORMATION_SCHEMA.ROUTINES
             WHERE ROUTINE_SCHEMA = ?
             ORDER BY ROUTINE_TYPE, ROUTINE_NAME",
        )
        .bind(database)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let routines: Vec<RoutineInfo> = rows
            .iter()
            .map(|row| RoutineInfo {
                name: row.get("ROUTINE_NAME"),
                routine_type: row.get("ROUTINE_TYPE"),
                data_type: row.try_get("DATA_TYPE").unwrap_or_default(),
            })
            .collect();
        tracing::debug!(count = routines.len(), database = %database, "Found routines");
        Ok(routines)
    }

    /// Scheduled events for a database (FR-4.1.1, #291).
    ///
    /// `information_schema.EVENTS` reports the same columns on MySQL 8 and
    /// MariaDB 11, so one query serves both — verified against each.
    #[tracing::instrument(skip(self))]
    pub async fn get_events(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<EventInfo>, CoreError> {
        tracing::debug!(database = %database, "Fetching events");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query(
            "SELECT CAST(EVENT_NAME AS CHAR) AS EVENT_NAME,
                    CAST(EVENT_TYPE AS CHAR) AS EVENT_TYPE,
                    CAST(STATUS AS CHAR) AS STATUS,
                    CAST(DEFINER AS CHAR) AS DEFINER,
                    INTERVAL_VALUE,
                    CAST(INTERVAL_FIELD AS CHAR) AS INTERVAL_FIELD,
                    CAST(EVENT_COMMENT AS CHAR) AS EVENT_COMMENT
             FROM INFORMATION_SCHEMA.EVENTS
             WHERE EVENT_SCHEMA = ?
             ORDER BY EVENT_NAME",
        )
        .bind(database)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let events: Vec<EventInfo> = rows
            .iter()
            .map(|row| {
                // Both are NULL for a one-shot event, which has a time rather
                // than an interval.
                let value: Option<String> = row.try_get("INTERVAL_VALUE").unwrap_or(None);
                let field: Option<String> = row.try_get("INTERVAL_FIELD").unwrap_or(None);
                let interval = match (value, field) {
                    (Some(v), Some(f)) => format!("{v} {f}"),
                    _ => String::new(),
                };
                EventInfo {
                    name: row.get("EVENT_NAME"),
                    event_type: row.get("EVENT_TYPE"),
                    status: row.get("STATUS"),
                    definer: row.get("DEFINER"),
                    interval,
                    comment: row.try_get("EVENT_COMMENT").unwrap_or_default(),
                }
            })
            .collect();
        tracing::debug!(count = events.len(), database = %database, "Found events");
        Ok(events)
    }

    /// The partitions of a table, or an empty list for one that has none.
    ///
    /// `information_schema.PARTITIONS` has a row per table either way; the
    /// unpartitioned case is a single row with a NULL partition name, which is
    /// filtered out rather than reported as a partition called "null".
    #[tracing::instrument(skip(self))]
    pub async fn get_partitions(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<PartitionInfo>, CoreError> {
        tracing::debug!(database = %database, table = %table, "Fetching partitions");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query(
            "SELECT CAST(PARTITION_NAME AS CHAR) AS PARTITION_NAME,
                    CAST(PARTITION_METHOD AS CHAR) AS PARTITION_METHOD,
                    CAST(PARTITION_EXPRESSION AS CHAR) AS PARTITION_EXPRESSION,
                    CAST(PARTITION_DESCRIPTION AS CHAR) AS PARTITION_DESCRIPTION,
                    TABLE_ROWS,
                    DATA_LENGTH
             FROM INFORMATION_SCHEMA.PARTITIONS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
               AND PARTITION_NAME IS NOT NULL
             ORDER BY PARTITION_ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let partitions: Vec<PartitionInfo> = rows
            .iter()
            .map(|row| PartitionInfo {
                name: row.get("PARTITION_NAME"),
                method: row.try_get("PARTITION_METHOD").unwrap_or_default(),
                expression: row
                    .try_get::<Option<String>, _>("PARTITION_EXPRESSION")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                description: row
                    .try_get::<Option<String>, _>("PARTITION_DESCRIPTION")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                row_count: row.try_get("TABLE_ROWS").unwrap_or(0),
                data_size: row.try_get("DATA_LENGTH").unwrap_or(0),
            })
            .collect();
        tracing::debug!(count = partitions.len(), "Found partitions");
        Ok(partitions)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_triggers(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<TriggerInfo>, CoreError> {
        tracing::debug!(database = %database, "Fetching triggers");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query(
            "SELECT CAST(TRIGGER_NAME AS CHAR) AS TRIGGER_NAME,
                    CAST(EVENT_MANIPULATION AS CHAR) AS EVENT_MANIPULATION,
                    CAST(EVENT_OBJECT_TABLE AS CHAR) AS EVENT_OBJECT_TABLE,
                    CAST(ACTION_TIMING AS CHAR) AS ACTION_TIMING
             FROM INFORMATION_SCHEMA.TRIGGERS
             WHERE TRIGGER_SCHEMA = ?
             ORDER BY TRIGGER_NAME",
        )
        .bind(database)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let triggers: Vec<TriggerInfo> = rows
            .iter()
            .map(|row| TriggerInfo {
                name: row.get("TRIGGER_NAME"),
                event: row.get("EVENT_MANIPULATION"),
                table: row.get("EVENT_OBJECT_TABLE"),
                timing: row.get("ACTION_TIMING"),
            })
            .collect();
        tracing::debug!(count = triggers.len(), database = %database, "Found triggers");
        Ok(triggers)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_view_ddl(
        &self,
        connection_id: &str,
        database: &str,
        view: &str,
    ) -> Result<String, CoreError> {
        tracing::debug!(database = %database, view = %view, "Fetching view DDL");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let row = sqlx::raw_sql(AssertSqlSafe(format!(
            "SHOW CREATE VIEW {}",
            qualified(database, view)
        )))
        .fetch_one(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let ddl: String = row.try_get(1).unwrap_or_default();
        tracing::debug!(ddl_length = ddl.len(), "Retrieved view DDL");
        Ok(ddl)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_routine_ddl(
        &self,
        connection_id: &str,
        database: &str,
        routine: &str,
        routine_type: &str,
    ) -> Result<String, CoreError> {
        tracing::debug!(database = %database, routine = %routine, routine_type = %routine_type, "Fetching routine DDL");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let name = qualified(database, routine);
        let show_cmd = match routine_type.to_uppercase().as_str() {
            "FUNCTION" => format!("SHOW CREATE FUNCTION {}", name),
            _ => format!("SHOW CREATE PROCEDURE {}", name),
        };

        let row = sqlx::raw_sql(AssertSqlSafe(show_cmd))
            .fetch_one(&pool)
            .await
            .map_err(|e| CoreError::Schema(e.to_string()))?;

        let ddl: String = row.try_get(2).unwrap_or_default();
        tracing::debug!(ddl_length = ddl.len(), "Retrieved routine DDL");
        Ok(ddl)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_trigger_ddl(
        &self,
        connection_id: &str,
        database: &str,
        trigger: &str,
    ) -> Result<String, CoreError> {
        tracing::debug!(database = %database, trigger = %trigger, "Fetching trigger DDL");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let row = sqlx::raw_sql(AssertSqlSafe(format!(
            "SHOW CREATE TRIGGER {}",
            qualified(database, trigger)
        )))
        .fetch_one(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let ddl: String = row.try_get(2).unwrap_or_default();
        tracing::debug!(ddl_length = ddl.len(), "Retrieved trigger DDL");
        Ok(ddl)
    }
}
