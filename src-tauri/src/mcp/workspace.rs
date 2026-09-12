//! The live app, behind the workspace trait.
//!
//! Everything here is a forward: the schema questions go to the inspector the
//! UI uses, and `run` goes to the executor the editor uses. That is deliberate
//! — an agent running a different query path from the one a person runs would
//! mean two sets of timeouts, two row caps and two sets of bugs, and the
//! agent's set would be the one nobody noticed was wrong.
//!
//! No policy decisions happen in this file. By the time a method here is
//! called, `mas-mcp` has already decided the call is permitted; a check
//! repeated here would be a second rule to keep in step with the first.

use std::sync::Arc;

use mas_core::connection::ConnectionManager;
use mas_core::error::CoreError;
use mas_core::models::query::QueryResult;
use mas_core::query::QueryExecutor;
use mas_core::schema::inspector::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ReferencingKey, RoutineInfo, SchemaMatch,
    TableInfo, TriggerInfo, ViewInfo,
};
use mas_core::schema::SchemaInspector;
use mas_mcp::grants::{ConnectionFacts, Grants};
use mas_mcp::workspace::{LiveConnection, ObjectKind, Workspace};

use crate::mcp::state::McpState;

pub struct AppWorkspace {
    connections: Arc<ConnectionManager>,
    inspector: Arc<SchemaInspector>,
    executor: Arc<QueryExecutor>,
    state: McpState,
}

impl AppWorkspace {
    pub fn new(
        connections: Arc<ConnectionManager>,
        inspector: Arc<SchemaInspector>,
        executor: Arc<QueryExecutor>,
        state: McpState,
    ) -> Self {
        Self {
            connections,
            inspector,
            executor,
            state,
        }
    }
}

#[async_trait::async_trait]
impl Workspace for AppWorkspace {
    fn grants(&self) -> Grants {
        self.state.grants()
    }

    fn live_connections(&self) -> Vec<LiveConnection> {
        self.connections
            .list_connections()
            .into_iter()
            .map(|info| LiveConnection {
                read_only: self.connections.is_read_only(&info.id),
                // Never silently "development": a profile with no environment
                // is an unlabelled one, and the policy treats it as such.
                environment: info
                    .environment
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                id: info.id,
                name: info.name,
                server_version: info.server_version,
                default_database: info.database,
            })
            .collect()
    }

    fn facts(&self, connection_id: &str) -> Option<ConnectionFacts> {
        self.connections
            .list_connections()
            .into_iter()
            .find(|info| info.id == connection_id)
            .map(|info| ConnectionFacts {
                read_only: self.connections.is_read_only(&info.id),
                environment: info.environment.map(|e| e.to_string()),
                id: info.id,
                name: info.name,
            })
    }

    async fn databases(&self, connection_id: &str) -> Result<Vec<DatabaseInfo>, CoreError> {
        self.inspector.get_databases(connection_id).await
    }

    async fn tables(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<TableInfo>, CoreError> {
        self.inspector.get_tables(connection_id, database).await
    }

    async fn columns(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<ColumnInfo>, CoreError> {
        self.inspector
            .get_columns(connection_id, database, table)
            .await
    }

    async fn indexes(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<IndexInfo>, CoreError> {
        self.inspector
            .get_indexes(connection_id, database, table)
            .await
    }

    async fn foreign_keys(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<ForeignKeyInfo>, CoreError> {
        self.inspector
            .get_foreign_keys(connection_id, database, table)
            .await
    }

    async fn referencing_keys(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<ReferencingKey>, CoreError> {
        self.inspector
            .get_referencing_keys(connection_id, database, table)
            .await
    }

    async fn views(&self, connection_id: &str, database: &str) -> Result<Vec<ViewInfo>, CoreError> {
        self.inspector.get_views(connection_id, database).await
    }

    async fn routines(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<RoutineInfo>, CoreError> {
        self.inspector.get_routines(connection_id, database).await
    }

    async fn triggers(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<TriggerInfo>, CoreError> {
        self.inspector.get_triggers(connection_id, database).await
    }

    async fn ddl(
        &self,
        connection_id: &str,
        database: &str,
        object: &str,
        kind: ObjectKind,
    ) -> Result<String, CoreError> {
        match kind {
            ObjectKind::Table => {
                self.inspector
                    .get_table_ddl(connection_id, database, object)
                    .await
            }
            ObjectKind::View => {
                self.inspector
                    .get_view_ddl(connection_id, database, object)
                    .await
            }
            ObjectKind::Procedure => {
                self.inspector
                    .get_routine_ddl(connection_id, database, object, "PROCEDURE")
                    .await
            }
            ObjectKind::Function => {
                self.inspector
                    .get_routine_ddl(connection_id, database, object, "FUNCTION")
                    .await
            }
            ObjectKind::Trigger => {
                self.inspector
                    .get_trigger_ddl(connection_id, database, object)
                    .await
            }
        }
    }

    async fn search_schema(
        &self,
        connection_id: &str,
        database: &str,
        fragment: &str,
        limit: u32,
    ) -> Result<Vec<SchemaMatch>, CoreError> {
        self.inspector
            .search_schema(connection_id, database, fragment, limit)
            .await
    }

    async fn run(
        &self,
        connection_id: &str,
        database: Option<&str>,
        sql: &str,
        limit: Option<u32>,
    ) -> Result<QueryResult, CoreError> {
        let results = self
            .executor
            .execute(
                connection_id,
                sql,
                database.map(str::to_string),
                limit.map(u64::from),
                None,
            )
            .await?;

        // One statement in, so one result out. An empty vector would mean the
        // splitter and the classifier disagreed about what a statement is,
        // which is worth an error rather than an empty table that reads as
        // "no rows".
        results
            .into_iter()
            .next()
            .ok_or_else(|| CoreError::Query("The statement produced no result at all.".to_string()))
    }
}
