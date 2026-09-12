//! The live app, behind the workspace trait.
//!
//! Everything here is a forward: the schema questions go to the inspector the
//! UI uses, and `run` goes to the executor the editor uses. That is deliberate
//! — an agent running a different query path from the one a person runs would
//! mean two sets of timeouts, two row caps and two sets of bugs, and the
//! agent's set would be the one nobody noticed was wrong.
//!
//! One thing is translated rather than forwarded: the connection id. An agent
//! addresses a connection by its **profile** id, which is stable across
//! restarts, because a harness config that names a connection has to keep
//! meaning the same connection tomorrow. The manager and the executor work in
//! per-session connection ids, so every method here resolves one to the other,
//! and a profile that is not connected right now fails with a sentence saying
//! exactly that rather than with "not found".
//!
//! No policy decisions happen in this file. By the time a method here is
//! called, `mas-mcp` has already decided the call is permitted; a check
//! repeated here would be a second rule to keep in step with the first.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use mas_core::connection::{ConnectionManager, ConnectionStore};
use mas_core::error::CoreError;
use mas_core::history::{HistoryEntry, HistoryQuery, HistoryStore};
use mas_core::models::query::QueryResult;
use mas_core::query::staged::{StageError, StagedWrite as CoreStagedWrite, DEFAULT_DEADLINE};
use mas_core::query::{ExplainFormat, ExplainResponse, QueryExecutor};
use mas_core::schema::inspector::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ReferencingKey, RoutineInfo, SchemaMatch,
    TableInfo, TriggerInfo, ViewInfo,
};
use mas_core::schema::SchemaInspector;
use mas_mcp::grants::{ConnectionFacts, Grants};
use mas_mcp::workspace::{HistoryFilter, LiveConnection, ObjectKind, Workspace};

use crate::mcp::state::McpState;

/// How long a staged write waits for an answer.
///
/// The dialog's own deadline is longer, so the wait that ends first is the one
/// holding database locks rather than the one holding a window open.
const STAGE_DEADLINE: std::time::Duration = DEFAULT_DEADLINE;

pub struct AppWorkspace {
    connections: Arc<ConnectionManager>,
    /// Writes that have run and are waiting for the user to answer.
    ///
    /// Held here rather than in the tool call, because the call that stages a
    /// write and the call that commits it are two different awaits and the
    /// transaction has to outlive the first.
    staged: Arc<Mutex<HashMap<String, CoreStagedWrite>>>,
    history: Arc<HistoryStore>,
    /// The saved profiles, so a shared connection has a policy whether or not
    /// it is connected right now.
    store: Arc<ConnectionStore>,
    inspector: Arc<SchemaInspector>,
    executor: Arc<QueryExecutor>,
    state: McpState,
}

impl AppWorkspace {
    /// The live connection for a profile, or why there is not one.
    ///
    /// "Shared but not connected" is an ordinary state — the user shares a
    /// connection once and connects to it when they need it — so it gets its
    /// own message rather than being reported as a missing connection, which
    /// would send an agent looking for a typo that is not there.
    fn live(&self, profile_id: &str) -> Result<String, CoreError> {
        self.connections
            .list_connections()
            .into_iter()
            .find(|info| info.profile_id == profile_id)
            .map(|info| info.id)
            .ok_or_else(|| {
                CoreError::NotFound(format!(
                    "The connection \"{profile_id}\" is shared with agents but is not connected \
                     right now. Ask the user to connect it in SQLPilot."
                ))
            })
    }

    /// Take a staged write out of the register, or say it is gone.
    ///
    /// Gone means answered already, or expired: either way there is nothing to
    /// commit, and saying which is more useful than a missing-key error.
    fn take_staged(&self, id: &str) -> Result<CoreStagedWrite, CoreError> {
        self.staged
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
            .ok_or_else(|| {
                CoreError::Query(
                    "That change is no longer waiting — it was already answered, or it timed out \
                     and was rolled back. Nothing was applied. Try it again if you still want it."
                        .to_string(),
                )
            })
    }

    pub fn new(
        connections: Arc<ConnectionManager>,
        store: Arc<ConnectionStore>,
        history: Arc<HistoryStore>,
        inspector: Arc<SchemaInspector>,
        executor: Arc<QueryExecutor>,
        state: McpState,
    ) -> Self {
        Self {
            connections,
            staged: Arc::new(Mutex::new(HashMap::new())),
            history,
            store,
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
                // The profile id, not the session id: a harness config naming
                // this connection has to still mean it after a restart.
                id: info.profile_id,
                // Never silently "development": a profile with no environment
                // is an unlabelled one, and the policy treats it as such.
                environment: info
                    .environment
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                name: info.name,
                server_version: info.server_version,
                default_database: info.database,
            })
            .collect()
    }

    fn facts(&self, connection_id: &str) -> Option<ConnectionFacts> {
        // Answered from the saved profiles rather than from the live
        // connections, so that a shared-but-not-connected profile still has a
        // policy. The refusal for "not connected" then comes from the call
        // that needs the server, and says so.
        let profile = self.store.get_existing(connection_id).ok().flatten()?;
        Some(ConnectionFacts {
            id: profile.id,
            name: profile.name,
            environment: profile.environment.map(|e| e.to_string()),
            read_only: profile.read_only,
        })
    }

    async fn databases(&self, connection_id: &str) -> Result<Vec<DatabaseInfo>, CoreError> {
        let connection_id = &self.live(connection_id)?;
        self.inspector.get_databases(connection_id).await
    }

    async fn tables(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<TableInfo>, CoreError> {
        let connection_id = &self.live(connection_id)?;
        self.inspector.get_tables(connection_id, database).await
    }

    async fn columns(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<ColumnInfo>, CoreError> {
        let connection_id = &self.live(connection_id)?;
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
        let connection_id = &self.live(connection_id)?;
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
        let connection_id = &self.live(connection_id)?;
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
        let connection_id = &self.live(connection_id)?;
        self.inspector
            .get_referencing_keys(connection_id, database, table)
            .await
    }

    async fn views(&self, connection_id: &str, database: &str) -> Result<Vec<ViewInfo>, CoreError> {
        let connection_id = &self.live(connection_id)?;
        self.inspector.get_views(connection_id, database).await
    }

    async fn routines(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<RoutineInfo>, CoreError> {
        let connection_id = &self.live(connection_id)?;
        self.inspector.get_routines(connection_id, database).await
    }

    async fn triggers(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<TriggerInfo>, CoreError> {
        let connection_id = &self.live(connection_id)?;
        self.inspector.get_triggers(connection_id, database).await
    }

    async fn ddl(
        &self,
        connection_id: &str,
        database: &str,
        object: &str,
        kind: ObjectKind,
    ) -> Result<String, CoreError> {
        let connection_id = &self.live(connection_id)?;
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
        let connection_id = &self.live(connection_id)?;
        self.inspector
            .search_schema(connection_id, database, fragment, limit)
            .await
    }

    async fn explain(
        &self,
        connection_id: &str,
        database: Option<&str>,
        sql: &str,
        analyze: bool,
        format: ExplainFormat,
    ) -> Result<ExplainResponse, CoreError> {
        let connection_id = self.live(connection_id)?;
        mas_core::query::explain(
            &self.connections,
            &self.executor,
            connection_id,
            sql.to_string(),
            database.map(str::to_string),
            analyze,
            format,
        )
        .await
    }

    async fn history(&self, filter: HistoryFilter) -> Result<Vec<HistoryEntry>, CoreError> {
        self.history.list(&HistoryQuery {
            search: filter.search,
            connection_names: Some(filter.connection_names),
            status: filter.failed_only.then(|| "error".to_string()),
            limit: Some(filter.limit),
            ..Default::default()
        })
    }

    async fn stage_write(
        &self,
        connection_id: &str,
        database: Option<&str>,
        sql: &str,
    ) -> Result<mas_mcp::workspace::StagedWrite, CoreError> {
        let connection_id = self.live(connection_id)?;
        let pool = self.connections.get_pool(&connection_id)?;
        let staged = CoreStagedWrite::begin(&pool, database, sql, STAGE_DEADLINE)
            .await
            .map_err(|e| match e {
                StageError::Failed(e) => e,
                other => CoreError::Query(other.to_string()),
            })?;

        let id = uuid::Uuid::new_v4().to_string();
        let rows_affected = staged.rows_affected;
        self.staged
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), staged);

        // A staged write holds row locks. If nobody answers, it rolls itself
        // back rather than blocking other sessions until the app closes.
        let staged_writes = self.staged.clone();
        let expiring = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(STAGE_DEADLINE).await;
            let forgotten = staged_writes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&expiring);
            if let Some(write) = forgotten {
                tracing::warn!("rolling back a staged write nobody answered");
                let _ = write.rollback().await;
            }
        });

        Ok(mas_mcp::workspace::StagedWrite { id, rows_affected })
    }

    async fn commit_write(&self, staged: &str) -> Result<u64, CoreError> {
        let write = self.take_staged(staged)?;
        write.commit().await
    }

    async fn rollback_write(&self, staged: &str) -> Result<(), CoreError> {
        let write = self.take_staged(staged)?;
        write.rollback().await
    }

    async fn run_ddl(
        &self,
        connection_id: &str,
        database: Option<&str>,
        sql: &str,
    ) -> Result<(), CoreError> {
        // Through the same executor as everything else: one set of timeouts,
        // one cancel path, and the statement lands in history where the user
        // can see what their agent did.
        let connection_id = self.live(connection_id)?;
        self.executor
            .execute(
                &connection_id,
                sql,
                database.map(str::to_string),
                None,
                None,
            )
            .await?;
        Ok(())
    }

    async fn run(
        &self,
        connection_id: &str,
        database: Option<&str>,
        sql: &str,
        limit: Option<u32>,
    ) -> Result<QueryResult, CoreError> {
        let connection_id = &self.live(connection_id)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use mas_core::models::ConnectionProfile;

    fn workspace() -> (AppWorkspace, Arc<ConnectionStore>) {
        keyring_core::set_default_store(keyring_core::mock::Store::new().unwrap());
        let store = Arc::new(ConnectionStore::in_memory().unwrap());
        let manager = Arc::new(ConnectionManager::new());
        let workspace = AppWorkspace::new(
            manager.clone(),
            store.clone(),
            Arc::new(HistoryStore::in_memory().unwrap()),
            Arc::new(SchemaInspector::new(manager.clone())),
            Arc::new(QueryExecutor::new(manager)),
            McpState::default(),
        );
        (workspace, store)
    }

    fn profile(id: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            name: "shop".to_string(),
            read_only: true,
            ..Default::default()
        }
    }

    #[test]
    fn a_saved_connection_has_a_policy_before_it_is_connected() {
        // The grant is the user's standing decision. Making it evaporate until
        // they happen to connect would mean the settings screen and the agent
        // disagreed about what is shared.
        let (workspace, store) = workspace();
        store.save(&profile("p1")).unwrap();

        let facts = workspace.facts("p1").expect("a saved profile has facts");
        assert_eq!(facts.id, "p1", "addressed by profile id, not session id");
        assert!(facts.read_only, "and its read-only flag comes with it");
    }

    #[test]
    fn a_connection_that_was_never_saved_has_none() {
        let (workspace, _) = workspace();
        assert!(workspace.facts("nope").is_none());
    }

    #[tokio::test]
    async fn asking_about_a_disconnected_connection_says_so() {
        // Not "no such connection": the agent has the id because the user
        // shared it, and "not found" would send it hunting for a typo.
        let (workspace, store) = workspace();
        store.save(&profile("p1")).unwrap();

        let error = workspace.databases("p1").await.unwrap_err().to_string();
        assert!(error.contains("not connected"), "{error}");
        assert!(
            error.contains("SQLPilot"),
            "and says who can fix it: {error}"
        );
    }

    #[test]
    fn nothing_is_listed_when_nothing_is_connected() {
        let (workspace, store) = workspace();
        store.save(&profile("p1")).unwrap();
        assert!(workspace.live_connections().is_empty());
    }
}
