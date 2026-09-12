//! What the tools need from the running app.
//!
//! The tool surface is defined here; the ability to answer it lives in the
//! Tauri layer, which owns the connection manager, the schema inspector and
//! the window an approval appears in. This trait is the seam between them, and
//! it exists for two reasons beyond tidiness.
//!
//! The first is that every tool in this crate can then be tested against a
//! workspace that returns whatever the test needs — a production connection
//! that is read-only, a table with a million rows — without a database, a
//! window, or a harness. The policy decisions are the part that must not
//! regress, and they are exactly the part that live-server tests are worst at
//! covering.
//!
//! The second is that it keeps the answer to "what may an agent see" in one
//! place. An implementation cannot accidentally expose a connection the user
//! did not grant, because the tools ask for a connection by id and get a
//! policy or a refusal, and the refusal is produced here rather than by each
//! tool remembering to check.

use mas_core::error::CoreError;
use mas_core::history::HistoryEntry;
use mas_core::models::query::QueryResult;
use mas_core::query::{ExplainFormat, ExplainResponse};
use mas_core::schema::inspector::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ReferencingKey, RoutineInfo, SchemaMatch,
    TableInfo, TriggerInfo, ViewInfo,
};

use crate::grants::{ConnectionFacts, Grants};

/// A live connection, as an agent sees it.
#[derive(Debug, Clone, serde::Serialize, schemars::JsonSchema)]
pub struct LiveConnection {
    pub id: String,
    pub name: String,
    pub server_version: String,
    /// The profile's label, or "unknown" — never silently "development".
    pub environment: String,
    pub read_only: bool,
    pub default_database: Option<String>,
}

/// What kind of object a DDL request is about.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "lowercase")]
#[schemars(rename_all = "lowercase")]
pub enum ObjectKind {
    Table,
    View,
    Procedure,
    Function,
    Trigger,
}

/// The app, as the tool surface needs it.
///
/// Every method takes a connection id and may fail with [`CoreError::NotFound`]
/// if that connection is not live. Whether the agent is *allowed* to ask is
/// decided before any of these are called; an implementation is a plain
/// accessor and does not repeat the policy.
#[async_trait::async_trait]
pub trait Workspace: Send + Sync + 'static {
    /// Connections the user has shared, and on what terms.
    fn grants(&self) -> Grants;

    /// Every live connection, granted or not. Filtering is the caller's job,
    /// so that "not granted" and "not connected" stay distinguishable.
    fn live_connections(&self) -> Vec<LiveConnection>;

    /// The facts the policy needs about one connection.
    fn facts(&self, connection_id: &str) -> Option<ConnectionFacts>;

    async fn databases(&self, connection_id: &str) -> Result<Vec<DatabaseInfo>, CoreError>;

    async fn tables(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<TableInfo>, CoreError>;

    async fn columns(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<ColumnInfo>, CoreError>;

    async fn indexes(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<IndexInfo>, CoreError>;

    /// Foreign keys declared *by* this table.
    async fn foreign_keys(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<ForeignKeyInfo>, CoreError>;

    /// Foreign keys declared by other tables that point *at* this one.
    ///
    /// The direction that is missing from every schema dump, and the one that
    /// answers "what breaks if I delete this row".
    async fn referencing_keys(
        &self,
        connection_id: &str,
        database: &str,
        table: &str,
    ) -> Result<Vec<ReferencingKey>, CoreError>;

    async fn views(&self, connection_id: &str, database: &str) -> Result<Vec<ViewInfo>, CoreError>;

    async fn routines(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<RoutineInfo>, CoreError>;

    async fn triggers(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<TriggerInfo>, CoreError>;

    async fn ddl(
        &self,
        connection_id: &str,
        database: &str,
        object: &str,
        kind: ObjectKind,
    ) -> Result<String, CoreError>;

    /// Tables and columns whose name contains a fragment.
    ///
    /// The retrieval primitive: an agent greps the schema rather than being
    /// handed five hundred tables it cannot fit.
    async fn search_schema(
        &self,
        connection_id: &str,
        database: &str,
        fragment: &str,
        limit: u32,
    ) -> Result<Vec<SchemaMatch>, CoreError>;

    /// The plan for a statement, through the app's own explain path.
    ///
    /// Not assembled here by prefixing "EXPLAIN": that path already knows to
    /// refuse ANALYZE on a read-only connection, to refuse it for a statement
    /// that would mutate, and to fall back when MariaDB will not serve the
    /// format that was asked for. Re-deriving any of that would be a second
    /// implementation to keep in step.
    async fn explain(
        &self,
        connection_id: &str,
        database: Option<&str>,
        sql: &str,
        analyze: bool,
        format: ExplainFormat,
    ) -> Result<ExplainResponse, CoreError>;

    /// Statements run here before, filtered to the connections named.
    ///
    /// Reads the app's own history store, so a statement an agent sees is one
    /// the user could have seen too — including its redaction, which happens
    /// on the way into storage rather than on the way out.
    async fn history(&self, filter: HistoryFilter) -> Result<Vec<HistoryEntry>, CoreError>;

    /// Run a write inside a transaction and hold it open.
    ///
    /// The rows it changed come back with a handle; nothing is visible to
    /// anyone else until [`Workspace::commit_write`]. This is what makes the
    /// approval a real question rather than a guess: the user is told what the
    /// statement did, not what it might do.
    async fn stage_write(
        &self,
        connection_id: &str,
        database: Option<&str>,
        sql: &str,
    ) -> Result<StagedWrite, CoreError>;

    /// Keep a staged write. Returns the rows it changed.
    async fn commit_write(&self, staged: &str) -> Result<u64, CoreError>;

    /// Throw a staged write away, as though it never ran.
    async fn rollback_write(&self, staged: &str) -> Result<(), CoreError>;

    /// Run a schema change, which cannot be staged: both servers commit the
    /// open transaction before it, so approval has to come first.
    async fn run_ddl(
        &self,
        connection_id: &str,
        database: Option<&str>,
        sql: &str,
    ) -> Result<(), CoreError>;

    /// Run one statement that has already been classified and permitted.
    ///
    /// `limit` is the row cap the posture arrived at, not the model's request;
    /// the caller has already reconciled the two.
    async fn run(
        &self,
        connection_id: &str,
        database: Option<&str>,
        sql: &str,
        limit: Option<u32>,
    ) -> Result<QueryResult, CoreError>;
}

/// A write that has run and is waiting to be kept or undone.
#[derive(Debug, Clone)]
pub struct StagedWrite {
    /// The handle to commit or roll back with.
    pub id: String,
    pub rows_affected: u64,
}

/// What to look for in the history.
///
/// Narrower than the app's own `HistoryQuery`, which has a dozen fields for a
/// panel with a dozen controls. An agent needs the recent statements, the ones
/// matching a fragment, and the ones that failed.
#[derive(Debug, Clone)]
pub struct HistoryFilter {
    pub search: Option<String>,
    /// Connection *names*, as history records them. Empty means nothing comes
    /// back — never "everything", because this list is what limits an agent to
    /// the connections the user shared.
    pub connection_names: Vec<String>,
    pub failed_only: bool,
    pub limit: u32,
}
