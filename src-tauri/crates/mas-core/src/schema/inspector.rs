use crate::connection::ConnectionManager;
use crate::error::CoreError;
use serde::Serialize;
use sqlx::Row;
use std::sync::Arc;

pub struct SchemaInspector {
    connection_manager: Arc<ConnectionManager>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DatabaseInfo {
    pub name: String,
    pub default_charset: String,
    pub default_collation: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableInfo {
    pub name: String,
    pub table_type: String, // "BASE TABLE" or "VIEW"
    pub engine: Option<String>,
    pub row_count: Option<i64>,
    pub data_size: Option<i64>,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub column_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
    pub extra: String,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub index_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForeignKeyInfo {
    pub name: String,
    pub column: String,
    pub referenced_table: String,
    pub referenced_column: String,
    pub on_update: String,
    pub on_delete: String,
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
             WHERE SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
             ORDER BY SCHEMA_NAME"
        )
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let databases: Vec<DatabaseInfo> = rows.iter().map(|row| DatabaseInfo {
            name: row.get("SCHEMA_NAME"),
            default_charset: row.get("DEFAULT_CHARACTER_SET_NAME"),
            default_collation: row.get("DEFAULT_COLLATION_NAME"),
        }).collect();
        tracing::debug!(count = databases.len(), "Found databases");
        Ok(databases)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_tables(&self, connection_id: &str, database: &str) -> Result<Vec<TableInfo>, CoreError> {
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
             ORDER BY TABLE_NAME"
        )
        .bind(database)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let tables: Vec<TableInfo> = rows.iter().map(|row| TableInfo {
            name: row.get("TABLE_NAME"),
            table_type: row.get("TABLE_TYPE"),
            engine: row.try_get("ENGINE").ok(),
            row_count: row.try_get("TABLE_ROWS").ok(),
            data_size: row.try_get("DATA_LENGTH").ok(),
            comment: row.try_get("TABLE_COMMENT").unwrap_or_default(),
        }).collect();
        tracing::debug!(count = tables.len(), database = %database, "Found tables");
        Ok(tables)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_columns(&self, connection_id: &str, database: &str, table: &str) -> Result<Vec<ColumnInfo>, CoreError> {
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
                    CAST(COLUMN_COMMENT AS CHAR) AS COLUMN_COMMENT
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION"
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let columns: Vec<ColumnInfo> = rows.iter().map(|row| {
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
            }
        }).collect();
        tracing::debug!(count = columns.len(), database = %database, table = %table, "Found columns");
        Ok(columns)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_indexes(&self, connection_id: &str, database: &str, table: &str) -> Result<Vec<IndexInfo>, CoreError> {
        tracing::debug!(database = %database, table = %table, "Fetching indexes");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let rows = sqlx::query(
            "SELECT CAST(INDEX_NAME AS CHAR) AS INDEX_NAME,
                    CAST(COLUMN_NAME AS CHAR) AS COLUMN_NAME,
                    NON_UNIQUE,
                    CAST(INDEX_TYPE AS CHAR) AS INDEX_TYPE
             FROM INFORMATION_SCHEMA.STATISTICS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
             ORDER BY INDEX_NAME, SEQ_IN_INDEX"
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(|e| CoreError::Schema(e.to_string()))?;

        let mut index_map: std::collections::BTreeMap<String, IndexInfo> = std::collections::BTreeMap::new();
        for row in &rows {
            let name: String = row.get("INDEX_NAME");
            let col: String = row.get("COLUMN_NAME");
            let non_unique: i32 = row.get("NON_UNIQUE");
            let idx_type: String = row.get("INDEX_TYPE");

            index_map.entry(name.clone())
                .and_modify(|idx| idx.columns.push(col.clone()))
                .or_insert_with(|| IndexInfo {
                    name,
                    columns: vec![col],
                    is_unique: non_unique == 0,
                    index_type: idx_type,
                });
        }

        let indexes: Vec<IndexInfo> = index_map.into_values().collect();
        tracing::debug!(count = indexes.len(), database = %database, table = %table, "Found indexes");
        Ok(indexes)
    }

    #[tracing::instrument(skip(self))]
    pub async fn get_table_ddl(&self, connection_id: &str, database: &str, table: &str) -> Result<String, CoreError> {
        tracing::debug!(database = %database, table = %table, "Fetching table DDL");
        let pool = self.connection_manager.get_pool(connection_id)?;
        let use_db = format!("USE `{}`", database);
        let _ = sqlx::query(&use_db).execute(&pool).await;

        let row = sqlx::query(&format!("SHOW CREATE TABLE `{}`", table))
            .fetch_one(&pool)
            .await
            .map_err(|e| CoreError::Schema(e.to_string()))?;

        let ddl: String = row.try_get(1).unwrap_or_default();
        tracing::debug!(ddl_length = ddl.len(), "Retrieved DDL");
        Ok(ddl)
    }
}
