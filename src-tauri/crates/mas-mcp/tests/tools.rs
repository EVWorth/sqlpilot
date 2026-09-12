//! What the tools do, against a workspace that is not a database.
//!
//! These are the tests that matter most in this crate. The policy has its own
//! unit tests, but a policy is only worth what its callers do with it, and the
//! failure mode being guarded against — a tool that fetches first and checks
//! afterwards, or forgets to check at all — is invisible to a test of the
//! policy alone.
//!
//! A fake workspace makes the awkward cases cheap: a production connection
//! that is also read-only, a grant limited to one database, a posture that
//! forbids values. Against a live server each of those is a fixture; here it
//! is a field.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use mas_core::error::CoreError;
use mas_core::history::HistoryEntry;
use mas_core::models::query::{ColumnMeta, QueryResult, SqlValue};
use mas_core::query::{AnalyzeRefusal, ExplainFormat, ExplainResponse, FormatFallback};
use mas_core::schema::inspector::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ReferencingKey, RoutineInfo, SchemaMatch,
    TableInfo, TriggerInfo, ViewInfo,
};
use mas_mcp::grants::{ConnectionFacts, Grant, Grants};
use mas_mcp::policy::DataPosture;
use mas_mcp::server::{
    ColumnArg, ConnectionArg, DatabaseArg, ExplainArg, HistoryArg, Limits, ObjectsArg,
    OpenDraftArg, PlanFormat, ProposeEditArg, RelatedArg, SearchArg, SelectArg, SqlPilot, TableArg,
    WriteArg,
};
use mas_mcp::surface::{
    ApprovalRequest, EditOutcome, EditorContext, RawResult, Surface, SurfaceError,
};
use mas_mcp::workspace::{HistoryFilter, LiveConnection, ObjectKind, StagedWrite, Workspace};
use rmcp::handler::server::wrapper::Parameters;

#[derive(Default)]
struct Fake {
    grants: Grants,
    facts: Vec<ConnectionFacts>,
    /// Every statement that reached the database, so a test can assert that
    /// one did *not*.
    ran: std::sync::Mutex<Vec<String>>,
    /// The row limit the last run was given.
    last_limit: std::sync::Mutex<Option<u32>>,
    rows: usize,
    /// Foreign keys as edges: (table, table it references).
    edges: Vec<(&'static str, &'static str)>,
    /// The row `profile_column`'s aggregate query should return, when a test
    /// is about profiling rather than about reading.
    profile: Option<Vec<SqlValue>>,
    /// The rows its top-values query should return.
    top: Vec<(String, i64)>,
    /// The columns and single row a plain read returns, for the tests that
    /// are about what happens to particular column *names*.
    columns: Vec<(String, SqlValue)>,
    /// What the history store holds.
    history: Vec<HistoryEntry>,
    /// How many rows a staged write reports.
    affected: u64,
    /// Statements that were staged, and what was decided about each.
    staged: std::sync::Mutex<Vec<String>>,
    decisions: std::sync::Mutex<Vec<String>>,
    /// Set to make staging fail, for the case where the statement itself is
    /// broken.
    stage_fails: Option<String>,
    last_history: std::sync::Mutex<Option<HistoryFilter>>,
    calls: AtomicUsize,
}

impl Fake {
    fn shared(posture: DataPosture, environment: &str, read_only: bool) -> Self {
        let mut grants = Grants::default();
        grants.set(Grant::new("c1").with_posture(posture));
        Self {
            grants,
            facts: vec![ConnectionFacts {
                id: "c1".into(),
                name: "shop".into(),
                environment: Some(environment.into()),
                read_only,
            }],
            rows: 3,
            ..Default::default()
        }
    }

    fn ran(&self) -> Vec<String> {
        self.ran.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Workspace for Fake {
    fn grants(&self) -> Grants {
        self.grants.clone()
    }

    fn live_connections(&self) -> Vec<LiveConnection> {
        self.facts
            .iter()
            .map(|f| LiveConnection {
                id: f.id.clone(),
                name: f.name.clone(),
                server_version: "8.0.46".into(),
                environment: f.environment.clone().unwrap_or_else(|| "unknown".into()),
                read_only: f.read_only,
                default_database: Some("shop".into()),
            })
            .collect()
    }

    fn facts(&self, connection_id: &str) -> Option<ConnectionFacts> {
        self.facts.iter().find(|f| f.id == connection_id).cloned()
    }

    async fn databases(&self, _: &str) -> Result<Vec<DatabaseInfo>, CoreError> {
        Ok(["shop", "payroll", "mysql"]
            .into_iter()
            .map(|name| DatabaseInfo {
                name: name.into(),
                default_charset: "utf8mb4".into(),
                default_collation: "utf8mb4_0900_ai_ci".into(),
                is_system: name == "mysql",
            })
            .collect())
    }

    async fn tables(&self, _: &str, _: &str) -> Result<Vec<TableInfo>, CoreError> {
        Ok(vec![TableInfo {
            name: "orders".into(),
            table_type: "BASE TABLE".into(),
            engine: Some("InnoDB".into()),
            row_count: Some(42),
            data_size: Some(16384),
            comment: String::new(),
        }])
    }

    async fn columns(&self, _: &str, _: &str, _: &str) -> Result<Vec<ColumnInfo>, CoreError> {
        Ok(vec![
            ColumnInfo {
                name: "id".into(),
                data_type: "int".into(),
                column_type: "int unsigned".into(),
                nullable: false,
                default_value: None,
                is_primary_key: true,
                extra: "auto_increment".into(),
                comment: String::new(),
                charset: None,
                collation: None,
            },
            ColumnInfo {
                name: "total".into(),
                data_type: "decimal".into(),
                column_type: "decimal(10,2)".into(),
                nullable: true,
                default_value: None,
                is_primary_key: false,
                extra: String::new(),
                comment: "in cents".into(),
                charset: None,
                collation: None,
            },
        ])
    }

    async fn indexes(&self, _: &str, _: &str, _: &str) -> Result<Vec<IndexInfo>, CoreError> {
        Ok(vec![IndexInfo {
            name: "PRIMARY".into(),
            columns: vec!["id".into()],
            is_unique: true,
            index_type: "BTREE".into(),
        }])
    }

    async fn foreign_keys(
        &self,
        _: &str,
        _: &str,
        table: &str,
    ) -> Result<Vec<ForeignKeyInfo>, CoreError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self
            .edges
            .iter()
            .filter(|(from, _)| *from == table)
            .map(|(_, to)| ForeignKeyInfo {
                name: format!("fk_{table}_{to}"),
                columns: vec![format!("{to}_id")],
                referenced_table: (*to).into(),
                referenced_columns: vec!["id".into()],
                on_update: "RESTRICT".into(),
                on_delete: "CASCADE".into(),
            })
            .collect())
    }

    async fn referencing_keys(
        &self,
        _: &str,
        _: &str,
        table: &str,
    ) -> Result<Vec<ReferencingKey>, CoreError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self
            .edges
            .iter()
            .filter(|(_, to)| *to == table)
            .map(|(from, _)| ReferencingKey {
                table: (*from).into(),
                name: format!("fk_{from}_{table}"),
                columns: vec![format!("{table}_id")],
                referenced_columns: vec!["id".into()],
                on_update: "RESTRICT".into(),
                on_delete: "CASCADE".into(),
            })
            .collect())
    }

    async fn views(&self, _: &str, _: &str) -> Result<Vec<ViewInfo>, CoreError> {
        Ok(vec![ViewInfo {
            name: "open_orders".into(),
            is_updatable: false,
        }])
    }

    async fn routines(&self, _: &str, _: &str) -> Result<Vec<RoutineInfo>, CoreError> {
        Ok(vec![
            RoutineInfo {
                name: "recalc".into(),
                routine_type: "PROCEDURE".into(),
                data_type: String::new(),
            },
            RoutineInfo {
                name: "vat".into(),
                routine_type: "FUNCTION".into(),
                data_type: "decimal".into(),
            },
        ])
    }

    async fn triggers(&self, _: &str, _: &str) -> Result<Vec<TriggerInfo>, CoreError> {
        Ok(vec![TriggerInfo {
            name: "orders_audit".into(),
            event: "INSERT".into(),
            timing: "AFTER".into(),
            table: "orders".into(),
        }])
    }

    async fn ddl(
        &self,
        _: &str,
        _: &str,
        object: &str,
        _: ObjectKind,
    ) -> Result<String, CoreError> {
        Ok(format!("CREATE TABLE `{object}` (id INT)"))
    }

    async fn search_schema(
        &self,
        _: &str,
        _: &str,
        fragment: &str,
        limit: u32,
    ) -> Result<Vec<SchemaMatch>, CoreError> {
        Ok(vec![SchemaMatch {
            table: "orders".into(),
            column: format!("{fragment}_id"),
            column_type: "int".into(),
            comment: format!("limit was {limit}"),
        }])
    }

    async fn stage_write(
        &self,
        _: &str,
        _: Option<&str>,
        sql: &str,
    ) -> Result<StagedWrite, CoreError> {
        if let Some(failure) = &self.stage_fails {
            return Err(CoreError::Query(failure.clone()));
        }
        self.staged.lock().unwrap().push(sql.to_string());
        Ok(StagedWrite {
            id: "staged-1".into(),
            rows_affected: self.affected,
        })
    }

    async fn commit_write(&self, staged: &str) -> Result<u64, CoreError> {
        self.decisions
            .lock()
            .unwrap()
            .push(format!("commit {staged}"));
        Ok(self.affected)
    }

    async fn rollback_write(&self, staged: &str) -> Result<(), CoreError> {
        self.decisions
            .lock()
            .unwrap()
            .push(format!("rollback {staged}"));
        Ok(())
    }

    async fn run_ddl(&self, _: &str, _: Option<&str>, sql: &str) -> Result<(), CoreError> {
        self.ran.lock().unwrap().push(sql.to_string());
        Ok(())
    }

    async fn history(&self, filter: HistoryFilter) -> Result<Vec<HistoryEntry>, CoreError> {
        *self.last_history.lock().unwrap() = Some(filter.clone());
        Ok(self
            .history
            .iter()
            .filter(|entry| filter.connection_names.contains(&entry.connection_name))
            .filter(|entry| !filter.failed_only || entry.status == "error")
            .take(filter.limit as usize)
            .cloned()
            .collect())
    }

    async fn explain(
        &self,
        _: &str,
        _: Option<&str>,
        sql: &str,
        analyze: bool,
        format: ExplainFormat,
    ) -> Result<ExplainResponse, CoreError> {
        // Mirrors the real path's decisions rather than its SQL: ANALYZE is
        // refused on a read-only connection, and this server has no tree
        // format. Both are cases the tool has to report rather than hide.
        let read_only = self.facts.first().is_some_and(|f| f.read_only);
        let refusal = (analyze && read_only).then_some(AnalyzeRefusal::ReadOnlyConnection);
        let tree = matches!(format, ExplainFormat::Tree);
        Ok(ExplainResponse {
            result: QueryResult {
                query_id: "q".into(),
                statement_index: 0,
                sql: sql.to_string(),
                columns: vec![ColumnMeta {
                    name: "type".into(),
                    data_type: "varchar".into(),
                    nullable: true,
                    is_primary_key: false,
                }],
                rows: vec![vec![SqlValue::String("ALL".into())]],
                rows_affected: 0,
                execution_time_ms: 1,
                warnings: vec![],
                rows_truncated: false,
                truncation_reason: None,
                total_rows_available: None,
            },
            analyzed: analyze && refusal.is_none(),
            refusal,
            tabular: true,
            format: if tree { ExplainFormat::Classic } else { format },
            format_fallback: tree.then_some(FormatFallback::TreeNotSupported),
        })
    }

    async fn run(
        &self,
        _: &str,
        _: Option<&str>,
        sql: &str,
        limit: Option<u32>,
    ) -> Result<QueryResult, CoreError> {
        self.ran.lock().unwrap().push(sql.to_string());
        *self.last_limit.lock().unwrap() = limit;

        // The generated analysis queries are answered with the fixture rather
        // than with the generic row, so a profiling test can say what the
        // database found.
        if let Some(profile) = &self.profile {
            if sql.contains("rows_total") {
                return Ok(one_row(sql, profile.clone()));
            }
        }
        if sql.contains("occurrences") {
            return Ok(rows(
                sql,
                self.top
                    .iter()
                    .map(|(value, count)| {
                        vec![SqlValue::String(value.clone()), SqlValue::Int(*count)]
                    })
                    .collect(),
            ));
        }

        if !self.columns.is_empty() {
            return Ok(QueryResult {
                query_id: "q".into(),
                statement_index: 0,
                sql: sql.to_string(),
                columns: self
                    .columns
                    .iter()
                    .map(|(name, _)| ColumnMeta {
                        name: name.clone(),
                        data_type: "varchar".into(),
                        nullable: true,
                        is_primary_key: false,
                    })
                    .collect(),
                rows: vec![self
                    .columns
                    .iter()
                    .map(|(_, value)| value.clone())
                    .collect()],
                rows_affected: 0,
                execution_time_ms: 1,
                warnings: vec![],
                rows_truncated: false,
                truncation_reason: None,
                total_rows_available: None,
            });
        }

        let wanted = limit.unwrap_or(u32::MAX) as usize;
        let returned = self.rows.min(wanted);
        Ok(QueryResult {
            query_id: "q".into(),
            statement_index: 0,
            sql: sql.to_string(),
            columns: vec![ColumnMeta {
                name: "id".into(),
                data_type: "int".into(),
                nullable: false,
                is_primary_key: true,
            }],
            rows: (0..returned)
                .map(|i| vec![SqlValue::Int(i as i64)])
                .collect(),
            rows_affected: 0,
            execution_time_ms: 1,
            warnings: vec![],
            rows_truncated: returned < self.rows,
            truncation_reason: (returned < self.rows)
                .then_some(mas_core::models::query::TruncationReason::RowLimit),
            total_rows_available: None,
        })
    }
}

/// A result with the given rows and a column per cell.
fn rows(sql: &str, rows: Vec<Vec<SqlValue>>) -> QueryResult {
    let width = rows.first().map(Vec::len).unwrap_or(1);
    QueryResult {
        query_id: "q".into(),
        statement_index: 0,
        sql: sql.to_string(),
        columns: (0..width)
            .map(|i| ColumnMeta {
                name: format!("c{i}"),
                data_type: "varchar".into(),
                nullable: true,
                is_primary_key: false,
            })
            .collect(),
        rows,
        rows_affected: 0,
        execution_time_ms: 1,
        warnings: vec![],
        rows_truncated: false,
        truncation_reason: None,
        total_rows_available: None,
    }
}

fn one_row(sql: &str, row: Vec<SqlValue>) -> QueryResult {
    rows(sql, vec![row])
}

fn server(fake: Fake) -> (SqlPilot, Arc<Fake>) {
    let fake = Arc::new(fake);
    (SqlPilot::new(fake.clone()), fake)
}

fn conn() -> Parameters<ConnectionArg> {
    Parameters(ConnectionArg {
        connection: "c1".into(),
    })
}

fn db(database: &str) -> Parameters<DatabaseArg> {
    Parameters(DatabaseArg {
        connection: "c1".into(),
        database: database.into(),
    })
}

/// The refusal a tool gave, or a failure saying it did not refuse.
///
/// `unwrap_err` would do, if a successful tool result implemented Debug. It
/// does not, and giving it one to serve the tests would be the tail wagging
/// the dog.
fn refused<T>(result: Result<rmcp::handler::server::wrapper::Json<T>, String>) -> String {
    match result {
        Err(refusal) => refusal,
        Ok(_) => panic!("expected a refusal, got a result"),
    }
}

fn select(sql: &str, limit: Option<u32>) -> Parameters<SelectArg> {
    Parameters(SelectArg {
        connection: "c1".into(),
        database: Some("shop".into()),
        sql: sql.into(),
        limit,
    })
}

// ------------------------------------------------------------------- sharing

#[tokio::test]
async fn an_ungranted_connection_is_not_listed() {
    let mut fake = Fake::shared(DataPosture::Samples, "development", false);
    fake.grants = Grants::default();
    let (server, _) = server(fake);

    assert!(
        server.list_connections().await.0.is_empty(),
        "a live connection the user has not shared is not an agent's business"
    );
}

#[tokio::test]
async fn a_shared_connection_says_what_it_will_return() {
    // The posture travels with the connection, so a model can see before it
    // asks that this one will not give it values.
    let (server, _) = server(Fake::shared(DataPosture::SchemaOnly, "production", false));

    let listed = server.list_connections().await.0;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].posture, "schemaonly");
    assert_eq!(listed[0].connection.environment, "production");
}

#[tokio::test]
async fn an_ungranted_connection_cannot_be_used_by_id() {
    // Not being listed is not the control; this is.
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.grants = Grants::default();
    let (server, fake) = server(fake);

    let refusal = refused(server.run_select(select("SELECT 1", None)).await);
    assert!(refusal.contains("not shared"), "{refusal}");
    assert!(
        fake.ran().is_empty(),
        "nothing should have reached the database"
    );
}

#[tokio::test]
async fn a_grant_limited_to_one_database_hides_the_others() {
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.grants
        .set(Grant::new("c1").limited_to(vec!["shop".into()]));
    let (server, _) = server(fake);

    let names: Vec<String> = server
        .list_databases(conn())
        .await
        .unwrap()
        .0
        .into_iter()
        .map(|d| d.name)
        .collect();

    // Hidden rather than refused later: an agent should never plan against a
    // database it will not be allowed to touch.
    assert_eq!(names, vec!["shop"]);
}

#[tokio::test]
async fn a_database_outside_the_grant_is_refused() {
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.grants
        .set(Grant::new("c1").limited_to(vec!["shop".into()]));
    let (server, _) = server(fake);

    let refusal = refused(server.list_tables(db("payroll")).await);
    assert!(refusal.contains("payroll"), "{refusal}");
    assert!(
        refusal.contains("list_databases"),
        "a refusal should name the way forward: {refusal}"
    );
}

// --------------------------------------------------------------------- shape

#[tokio::test]
async fn describe_table_answers_both_directions_of_the_foreign_keys() {
    let mut fake = Fake::shared(DataPosture::SchemaOnly, "production", false);
    fake.edges = vec![("orders", "customers"), ("shipments", "orders")];
    let (server, _) = server(fake);

    let described = server
        .describe_table(Parameters(TableArg {
            connection: "c1".into(),
            database: "shop".into(),
            table: "orders".into(),
        }))
        .await
        .unwrap()
        .0;

    assert_eq!(described.primary_key, vec!["id"]);
    assert_eq!(described.foreign_keys[0].references_table, "customers");
    assert_eq!(
        described.referenced_by[0].table, "shipments",
        "what points at this table is the half a schema dump leaves out"
    );
    assert_eq!(
        described.referenced_by[0].on_delete, "CASCADE",
        "CASCADE here is the difference between deleting one row and a thousand"
    );
}

#[tokio::test]
async fn the_shape_of_a_table_is_available_at_every_posture() {
    // Schema-only means no values. It does not mean no answers.
    let (server, _) = server(Fake::shared(DataPosture::SchemaOnly, "production", true));

    let described = server
        .describe_table(Parameters(TableArg {
            connection: "c1".into(),
            database: "shop".into(),
            table: "orders".into(),
        }))
        .await
        .unwrap()
        .0;
    assert_eq!(described.columns.len(), 2);
    assert_eq!(described.columns[1].column_type, "decimal(10,2)");
}

#[tokio::test]
async fn objects_are_split_by_what_they_are() {
    let (server, _) = server(Fake::shared(DataPosture::Samples, "development", false));

    let objects = server
        .list_objects(Parameters(ObjectsArg {
            connection: "c1".into(),
            database: "shop".into(),
        }))
        .await
        .unwrap()
        .0;

    assert_eq!(objects.views, vec!["open_orders"]);
    assert_eq!(objects.procedures, vec!["recalc"]);
    assert_eq!(objects.functions, vec!["vat"]);
    assert_eq!(objects.triggers, vec!["orders_audit"]);
}

#[tokio::test]
async fn search_applies_the_servers_own_cap() {
    let (server, _) = server(Fake::shared(DataPosture::Samples, "development", false));

    let matches = server
        .search_schema(Parameters(SearchArg {
            connection: "c1".into(),
            database: "shop".into(),
            fragment: "customer".into(),
        }))
        .await
        .unwrap()
        .0;

    // The cap is the tool's, not the model's: an agent cannot ask for the
    // whole schema by asking for a big enough limit.
    assert_eq!(matches[0].comment, "limit was 200");
}

#[tokio::test]
async fn related_tables_walks_both_directions() {
    let mut fake = Fake::shared(DataPosture::Samples, "development", false);
    fake.edges = vec![("orders", "customers"), ("shipments", "orders")];
    let (server, _) = server(fake);

    let relations = server
        .related_tables(Parameters(RelatedArg {
            connection: "c1".into(),
            database: "shop".into(),
            table: "orders".into(),
            depth: None,
        }))
        .await
        .unwrap()
        .0;

    let pairs: Vec<(String, String)> = relations
        .iter()
        .map(|r| (r.from_table.clone(), r.to_table.clone()))
        .collect();
    assert!(pairs.contains(&("orders".into(), "customers".into())));
    assert!(pairs.contains(&("shipments".into(), "orders".into())));
}

#[tokio::test]
async fn the_walk_does_not_revisit_a_table() {
    // A cycle — orders → customers → orders — must not loop, and the obvious
    // implementation does.
    let mut fake = Fake::shared(DataPosture::Samples, "development", false);
    fake.edges = vec![("orders", "customers"), ("customers", "orders")];
    let (server, fake) = server(fake);

    let relations = server
        .related_tables(Parameters(RelatedArg {
            connection: "c1".into(),
            database: "shop".into(),
            table: "orders".into(),
            depth: Some(3),
        }))
        .await
        .unwrap()
        .0;

    assert!(!relations.is_empty());
    // Two lookups per table visited, and there are only two tables.
    assert!(
        fake.calls.load(Ordering::SeqCst) <= 4,
        "the walk revisited a table it had already seen"
    );
}

#[tokio::test]
async fn the_walk_is_bounded_however_deep_it_is_asked_to_go() {
    let mut fake = Fake::shared(DataPosture::Samples, "development", false);
    fake.edges = vec![
        ("a", "b"),
        ("b", "c"),
        ("c", "d"),
        ("d", "e"),
        ("e", "f"),
        ("f", "g"),
    ];
    let (server, _) = server(fake);

    let relations = server
        .related_tables(Parameters(RelatedArg {
            connection: "c1".into(),
            database: "shop".into(),
            table: "a".into(),
            depth: Some(99),
        }))
        .await
        .unwrap()
        .0;

    // Depth is clamped: "everything reachable" on a real schema is the whole
    // schema, which is what related_tables exists to avoid.
    assert!(relations.iter().all(|r| r.hops <= 3), "{relations:?}");
}

// ------------------------------------------------------------------- reading

#[tokio::test]
async fn two_statements_are_refused_and_neither_runs() {
    let (server, fake) = server(Fake::shared(DataPosture::Full, "development", false));

    let refusal = refused(
        server
            .run_select(select("SELECT 1; DROP TABLE users", None))
            .await,
    );

    assert!(refusal.contains("one at a time"), "{refusal}");
    assert!(
        fake.ran().is_empty(),
        "the first statement must not run either — that was the old bug"
    );
}

#[tokio::test]
async fn a_write_dressed_as_a_select_is_refused() {
    let (server, fake) = server(Fake::shared(DataPosture::Full, "development", false));

    let refusal = refused(
        server
            .run_select(select(
                "WITH doomed AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM \
                 doomed)",
                None,
            ))
            .await,
    );

    assert!(
        refusal.contains("run_write"),
        "name the right tool: {refusal}"
    );
    assert!(fake.ran().is_empty());
}

#[tokio::test]
async fn a_read_runs_and_comes_back_as_json() {
    let (server, _) = server(Fake::shared(DataPosture::Full, "development", false));

    let result = server
        .run_select(select("SELECT id FROM orders", None))
        .await
        .unwrap()
        .0;

    assert_eq!(result.columns[0].name, "id");
    assert_eq!(result.row_count, 3);
    assert_eq!(result.rows[0][0], serde_json::json!(0));
    assert!(result.note.is_none(), "nothing was withheld");
}

#[tokio::test]
async fn schema_only_returns_the_shape_and_no_values() {
    let (server, fake) = server(Fake::shared(DataPosture::SchemaOnly, "production", false));

    let result = server
        .run_select(select("SELECT id FROM orders", None))
        .await
        .unwrap()
        .0;

    // The query still runs — the columns are real, and so is the timing.
    assert_eq!(fake.ran(), vec!["SELECT id FROM orders"]);
    assert_eq!(result.columns[0].name, "id");
    assert!(result.rows.is_empty());
    assert_eq!(result.row_count, 0);

    let note = result.note.expect("a posture that withholds rows says so");
    assert!(note.contains("schema only"), "{note}");
    assert!(
        note.contains("profile_column"),
        "a refusal should name what still works: {note}"
    );
}

#[tokio::test]
async fn samples_posture_caps_the_rows_in_the_database_not_afterwards() {
    let mut fake = Fake::shared(DataPosture::Samples, "staging", false);
    fake.rows = 1000;
    let (server, fake) = server(fake);

    let result = server
        .run_select(select("SELECT * FROM orders", Some(1000)))
        .await
        .unwrap()
        .0;

    // Fetching a thousand rows and throwing away 980 would cost the database
    // the work and the user the memory.
    assert_eq!(*fake.last_limit.lock().unwrap(), Some(20));
    assert_eq!(result.row_count, 20);
    assert!(result.note.unwrap().contains("samples"));
}

#[tokio::test]
async fn the_tools_cap_survives_a_model_asking_for_more() {
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.rows = 100_000;
    let (server, fake) = server(fake);

    server
        .run_select(select("SELECT * FROM orders", Some(100_000)))
        .await
        .unwrap();

    assert_eq!(
        *fake.last_limit.lock().unwrap(),
        Some(500),
        "a model asking for 100k rows is wrong about what fits, not about what it wants"
    );
}

#[tokio::test]
async fn a_smaller_request_is_honoured() {
    // The cap is a ceiling, not a target.
    let (server, fake) = server(Fake::shared(DataPosture::Full, "development", false));

    server
        .run_select(select("SELECT 1", Some(2)))
        .await
        .unwrap();

    assert_eq!(*fake.last_limit.lock().unwrap(), Some(2));
}

#[tokio::test]
async fn truncation_says_what_actually_stopped_it() {
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.rows = 10_000;
    let (server, _) = server(fake);

    let note = server
        .run_select(select("SELECT * FROM orders", Some(10)))
        .await
        .unwrap()
        .0
        .note
        .expect("truncated results explain themselves");

    assert!(note.contains("row limit"), "{note}");
}

#[tokio::test]
async fn a_configured_sample_size_is_the_one_that_applies() {
    let mut fake = Fake::shared(DataPosture::Samples, "production", false);
    fake.rows = 1000;
    let fake = Arc::new(fake);
    let server = SqlPilot::with_limits(
        fake.clone(),
        Limits {
            sample_rows: 5,
            ..Limits::default()
        },
    );

    server.run_select(select("SELECT 1", None)).await.unwrap();

    assert_eq!(*fake.last_limit.lock().unwrap(), Some(5));
}

#[tokio::test]
async fn a_read_only_connection_still_reads() {
    // Read-only restricts writing, not asking. Getting this backwards would
    // make the safest connections the least useful ones.
    let (server, _) = server(Fake::shared(DataPosture::Full, "production", true));

    let result = server.run_select(select("SELECT 1", None)).await.unwrap().0;
    assert_eq!(result.row_count, 3);
}

#[tokio::test]
async fn an_empty_statement_is_refused_before_the_database_sees_it() {
    let (server, fake) = server(Fake::shared(DataPosture::Full, "development", false));

    let refusal = refused(server.run_select(select("  -- nothing here", None)).await);
    assert!(refusal.contains("no statement"), "{refusal}");
    assert!(fake.ran().is_empty());
}

#[tokio::test]
async fn a_trailing_semicolon_is_not_two_statements() {
    // Models write them, constantly.
    let (server, fake) = server(Fake::shared(DataPosture::Full, "development", false));

    server.run_select(select("SELECT 1;", None)).await.unwrap();
    assert_eq!(fake.ran(), vec!["SELECT 1"]);
}

// ------------------------------------------------------------------ analysis

#[tokio::test]
async fn a_plan_is_available_at_every_posture() {
    // A plan is about the shape of the work, not the data, so schema-only
    // withholding it would be withholding the wrong thing.
    let (server, _) = server(Fake::shared(DataPosture::SchemaOnly, "production", false));

    let plan = server
        .explain(Parameters(ExplainArg {
            connection: "c1".into(),
            database: Some("shop".into()),
            sql: "SELECT * FROM orders".into(),
            format: None,
            analyze: false,
        }))
        .await
        .unwrap()
        .0;

    assert_eq!(plan.columns[0].name, "type");
    assert!(!plan.analyzed);
    assert!(plan.note.is_none());
}

#[tokio::test]
async fn a_plan_that_is_not_a_measurement_says_so() {
    // Otherwise a model reports an estimate as a timing, which is the whole
    // reason anyone asked for ANALYZE.
    let (server, _) = server(Fake::shared(DataPosture::Full, "production", true));

    let plan = server
        .explain(Parameters(ExplainArg {
            connection: "c1".into(),
            database: Some("shop".into()),
            sql: "SELECT 1".into(),
            format: None,
            analyze: true,
        }))
        .await
        .unwrap()
        .0;

    assert!(!plan.analyzed);
    let note = plan.note.expect("a refused ANALYZE is reported");
    assert!(note.contains("read-only"), "{note}");
}

#[tokio::test]
async fn a_format_the_server_cannot_serve_is_reported_not_hidden() {
    let (server, _) = server(Fake::shared(DataPosture::Full, "development", false));

    let plan = server
        .explain(Parameters(ExplainArg {
            connection: "c1".into(),
            database: Some("shop".into()),
            sql: "SELECT 1".into(),
            format: Some(PlanFormat::Tree),
            analyze: false,
        }))
        .await
        .unwrap()
        .0;

    assert_eq!(plan.format, "classic");
    assert!(plan.note.unwrap().contains("no tree format"));
}

#[tokio::test]
async fn explaining_two_statements_is_refused() {
    let (server, _) = server(Fake::shared(DataPosture::Full, "development", false));

    let refusal = refused(
        server
            .explain(Parameters(ExplainArg {
                connection: "c1".into(),
                database: Some("shop".into()),
                sql: "SELECT 1; SELECT 2".into(),
                format: None,
                analyze: false,
            }))
            .await,
    );
    assert!(refusal.contains("one at a time"), "{refusal}");
}

#[tokio::test]
async fn table_stats_reads_the_catalogue() {
    let (server, fake) = server(Fake::shared(DataPosture::SchemaOnly, "production", false));

    server
        .table_stats(Parameters(TableArg {
            connection: "c1".into(),
            database: "shop".into(),
            table: "orders".into(),
        }))
        .await
        .unwrap();

    // Not COUNT(*): on a large table that is a full scan, and a tool called
    // "stats" should not be the most expensive call an agent can make.
    let ran = fake.ran();
    assert!(ran[0].contains("INFORMATION_SCHEMA.TABLES"), "{ran:?}");
}

#[tokio::test]
async fn a_table_name_that_could_not_exist_is_refused_before_the_database_sees_it() {
    let (server, fake) = server(Fake::shared(DataPosture::Full, "development", false));

    let refusal = refused(
        server
            .table_stats(Parameters(TableArg {
                connection: "c1".into(),
                database: "shop".into(),
                table: "x".repeat(200),
            }))
            .await,
    );
    assert!(refusal.contains("64"), "{refusal}");
    assert!(fake.ran().is_empty());
}

#[tokio::test]
async fn profiling_a_column_counts_what_is_missing() {
    let mut fake = Fake::shared(DataPosture::SchemaOnly, "production", false);
    // rows_total, rows_present, distinct, min, max — in that order.
    fake.profile = Some(vec![
        SqlValue::Int(100),
        SqlValue::Int(80),
        SqlValue::Int(12),
        SqlValue::String("2020-01-01".into()),
        SqlValue::String("2024-12-31".into()),
    ]);
    let (server, _) = server(fake);

    let profile = server
        .profile_column(Parameters(ColumnArg {
            connection: "c1".into(),
            database: "shop".into(),
            table: "orders".into(),
            column: "created_at".into(),
        }))
        .await
        .unwrap()
        .0;

    assert_eq!(profile.rows_total, 100);
    assert_eq!(profile.rows_present, 80);
    assert_eq!(profile.nulls, 20, "the number nobody computes by hand");
    assert_eq!(profile.distinct_values, 12);
    assert_eq!(profile.min.as_deref(), Some("2020-01-01"));
}

#[tokio::test]
async fn a_schema_only_profile_has_no_values_in_it() {
    // The counts are numbers about data. The top ten of a column called
    // `email` is data, whatever the tool is called.
    let mut fake = Fake::shared(DataPosture::SchemaOnly, "production", false);
    fake.profile = Some(vec![
        SqlValue::Int(10),
        SqlValue::Int(10),
        SqlValue::Int(3),
        SqlValue::Null,
        SqlValue::Null,
    ]);
    let (server, fake) = server(fake);

    let profile = server
        .profile_column(Parameters(ColumnArg {
            connection: "c1".into(),
            database: "shop".into(),
            table: "customers".into(),
            column: "email".into(),
        }))
        .await
        .unwrap()
        .0;

    assert!(profile.most_common.is_empty());
    assert!(profile.note.unwrap().contains("schema only"));
    assert_eq!(
        fake.ran().len(),
        1,
        "the top-values query should not have run at all"
    );
}

#[tokio::test]
async fn a_profile_with_values_allowed_includes_the_common_ones() {
    let mut fake = Fake::shared(DataPosture::Samples, "development", false);
    fake.profile = Some(vec![
        SqlValue::Int(10),
        SqlValue::Int(10),
        SqlValue::Int(2),
        SqlValue::String("a".into()),
        SqlValue::String("b".into()),
    ]);
    fake.top = vec![("shipped".to_string(), 7), ("pending".to_string(), 3)];
    let (server, _) = server(fake);

    let profile = server
        .profile_column(Parameters(ColumnArg {
            connection: "c1".into(),
            database: "shop".into(),
            table: "orders".into(),
            column: "status".into(),
        }))
        .await
        .unwrap()
        .0;

    assert_eq!(profile.most_common[0].value, "shipped");
    assert_eq!(profile.most_common[0].occurrences, 7);
    assert!(profile.note.is_none());
}

#[tokio::test]
async fn an_empty_table_profiles_without_inventing_extremes() {
    // MIN and MAX of nothing are NULL, and reporting them as "" would be a
    // value that is not in the table.
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.profile = Some(vec![
        SqlValue::Int(0),
        SqlValue::Int(0),
        SqlValue::Int(0),
        SqlValue::Null,
        SqlValue::Null,
    ]);
    let (server, _) = server(fake);

    let profile = server
        .profile_column(Parameters(ColumnArg {
            connection: "c1".into(),
            database: "shop".into(),
            table: "orders".into(),
            column: "total".into(),
        }))
        .await
        .unwrap()
        .0;

    assert_eq!(profile.rows_total, 0);
    assert_eq!(profile.nulls, 0);
    assert!(profile.min.is_none());
    assert!(profile.max.is_none());
}

// ------------------------------------------------------------ what is onscreen

/// A window that answers whatever the test set, and records what it was asked.
#[derive(Default)]
struct FakeWindow {
    editor: Option<EditorContext>,
    result: Option<RawResult>,
    outcome: Option<EditOutcome>,
    proposals: std::sync::Mutex<Vec<(Option<String>, String, String)>>,
    drafts: std::sync::Mutex<Vec<String>>,
    /// Set to fail every question, for the no-window case.
    gone: bool,
    /// What the user says to an approval. None stands for a window that never
    /// answered.
    approval: Option<bool>,
    approvals: std::sync::Mutex<Vec<ApprovalRequest>>,
}

#[async_trait::async_trait]
impl Surface for FakeWindow {
    async fn editor_context(&self) -> Result<EditorContext, SurfaceError> {
        if self.gone {
            return Err(SurfaceError::NoWindow);
        }
        self.editor.clone().ok_or(SurfaceError::NoWindow)
    }

    async fn result_context(&self) -> Result<Option<RawResult>, SurfaceError> {
        if self.gone {
            return Err(SurfaceError::NoWindow);
        }
        Ok(self.result.clone())
    }

    async fn approve(&self, request: ApprovalRequest) -> Result<bool, SurfaceError> {
        self.approvals.lock().unwrap().push(request);
        match self.approval {
            Some(answer) => Ok(answer),
            // No answer configured stands for a window that went away, which
            // is the case the caller must not read as consent.
            None => Err(SurfaceError::Abandoned),
        }
    }

    async fn propose_edit(
        &self,
        tab: Option<String>,
        sql: String,
        rationale: String,
    ) -> Result<EditOutcome, SurfaceError> {
        self.proposals.lock().unwrap().push((tab, sql, rationale));
        self.outcome.clone().ok_or(SurfaceError::Abandoned)
    }

    async fn open_draft(
        &self,
        sql: String,
        _: Option<String>,
        _: Option<String>,
        _: Option<String>,
    ) -> Result<String, SurfaceError> {
        self.drafts.lock().unwrap().push(sql);
        Ok("tab-9".to_string())
    }
}

fn editor(connection: Option<&str>) -> EditorContext {
    EditorContext {
        tab: "t1".into(),
        title: "Untitled Query".into(),
        connection: connection.map(str::to_string),
        database: Some("shop".into()),
        sql: "SELECT * FROM orders".into(),
        selection: Some("FROM orders".into()),
    }
}

fn with_window(fake: Fake, window: FakeWindow) -> (SqlPilot, Arc<FakeWindow>) {
    let window = Arc::new(window);
    let server = SqlPilot::new(Arc::new(fake)).with_surface(window.clone());
    (server, window)
}

#[tokio::test]
async fn without_a_window_the_database_tools_still_work() {
    // A server started before the UI is up, or after the last window closed.
    let (server, _) = server(Fake::shared(DataPosture::Full, "development", false));

    let refusal = refused(server.get_editor_context().await);
    assert!(refusal.contains("no window"), "{refusal}");
    assert!(
        refusal.contains("database tools"),
        "an agent should not conclude the whole server is down: {refusal}"
    );
    assert!(server.run_select(select("SELECT 1", None)).await.is_ok());
}

#[tokio::test]
async fn the_editor_context_carries_the_selection() {
    // "Fix this query" almost always means the selection, because running a
    // selection is how people run one statement out of a file.
    let (server, _) = with_window(
        Fake::shared(DataPosture::Samples, "development", false),
        FakeWindow {
            editor: Some(editor(Some("c1"))),
            ..Default::default()
        },
    );

    let context = server.get_editor_context().await.unwrap().0;
    assert_eq!(context.selection.as_deref(), Some("FROM orders"));
    assert_eq!(context.tab, "t1");
}

#[tokio::test]
async fn a_tab_on_an_unshared_connection_is_not_readable_either() {
    // Sharing is one decision, not one per surface. Otherwise "not shared"
    // would mean "not through the database tools".
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.grants = Grants::default();
    let (server, _) = with_window(
        fake,
        FakeWindow {
            editor: Some(editor(Some("c1"))),
            ..Default::default()
        },
    );

    let refusal = refused(server.get_editor_context().await);
    assert!(refusal.contains("not shared"), "{refusal}");
}

#[tokio::test]
async fn a_tab_with_no_connection_yet_is_still_readable() {
    // Someone drafting SQL before picking a server. There is nothing to leak.
    let (server, _) = with_window(
        Fake::shared(DataPosture::Full, "development", false),
        FakeWindow {
            editor: Some(editor(None)),
            ..Default::default()
        },
    );

    assert!(server
        .get_editor_context()
        .await
        .unwrap()
        .0
        .connection
        .is_none());
}

fn on_screen(connection: Option<&str>) -> RawResult {
    RawResult {
        sql: "SELECT id FROM orders".into(),
        columns: vec!["id".into()],
        rows: vec![vec![serde_json::json!(1)], vec![serde_json::json!(2)]],
        row_count: 2,
        execution_time_ms: 4,
        truncated: false,
        connection: connection.map(str::to_string),
    }
}

#[tokio::test]
async fn the_result_on_screen_comes_back_with_its_rows_when_the_posture_allows() {
    let (server, _) = with_window(
        Fake::shared(DataPosture::Full, "development", false),
        FakeWindow {
            result: Some(on_screen(Some("c1"))),
            ..Default::default()
        },
    );

    let result = server.get_result_context().await.unwrap().0.unwrap();
    assert_eq!(result.rows.len(), 2);
    assert!(result.note.is_none());
}

#[tokio::test]
async fn the_user_seeing_rows_is_not_the_same_as_an_agent_receiving_them() {
    // The whole point of a schema-only posture. The agent is told the shape
    // and what it cannot have.
    let (server, _) = with_window(
        Fake::shared(DataPosture::SchemaOnly, "production", false),
        FakeWindow {
            result: Some(on_screen(Some("c1"))),
            ..Default::default()
        },
    );

    let result = server.get_result_context().await.unwrap().0.unwrap();
    assert!(result.rows.is_empty());
    assert_eq!(result.columns, vec!["id"], "the shape is not the data");
    assert_eq!(result.row_count, 2, "how many is a number, not a value");
    assert!(result.note.unwrap().contains("schema only"));
}

#[tokio::test]
async fn a_result_from_an_unshared_connection_is_refused_rather_than_stripped() {
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.grants = Grants::default();
    let (server, _) = with_window(
        fake,
        FakeWindow {
            result: Some(on_screen(Some("c1"))),
            ..Default::default()
        },
    );

    assert!(refused(server.get_result_context().await).contains("not shared"));
}

#[tokio::test]
async fn nothing_run_yet_is_an_answer() {
    let (server, _) = with_window(
        Fake::shared(DataPosture::Full, "development", false),
        FakeWindow::default(),
    );
    assert!(server.get_result_context().await.unwrap().0.is_none());
}

#[tokio::test]
async fn a_proposal_reaches_the_window_with_its_rationale() {
    let (server, window) = with_window(
        Fake::shared(DataPosture::Full, "development", false),
        FakeWindow {
            outcome: Some(EditOutcome {
                accepted: true,
                edited: false,
                sql: Some("SELECT id FROM orders".into()),
            }),
            ..Default::default()
        },
    );

    let outcome = server
        .propose_edit(Parameters(ProposeEditArg {
            tab: Some("t1".into()),
            sql: "SELECT id FROM orders".into(),
            rationale: "SELECT * reads every column".into(),
        }))
        .await
        .unwrap()
        .0;

    assert!(outcome.accepted);
    let proposals = window.proposals.lock().unwrap();
    assert_eq!(proposals[0].0.as_deref(), Some("t1"));
    assert_eq!(proposals[0].2, "SELECT * reads every column");
}

#[tokio::test]
async fn a_proposal_with_no_rationale_is_refused_before_the_user_sees_it() {
    // The rationale is what the user reads next to the diff. Without it they
    // have to work out what changed and why for themselves.
    let (server, window) = with_window(
        Fake::shared(DataPosture::Full, "development", false),
        FakeWindow::default(),
    );

    let refusal = refused(
        server
            .propose_edit(Parameters(ProposeEditArg {
                tab: None,
                sql: "SELECT 1".into(),
                rationale: "  ".into(),
            }))
            .await,
    );
    assert!(refusal.contains("why"), "{refusal}");
    assert!(window.proposals.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_empty_proposal_is_refused() {
    // A diff that deletes the user's query and says nothing.
    let (server, window) = with_window(
        Fake::shared(DataPosture::Full, "development", false),
        FakeWindow::default(),
    );

    refused(
        server
            .propose_edit(Parameters(ProposeEditArg {
                tab: None,
                sql: "   ".into(),
                rationale: "tidier".into(),
            }))
            .await,
    );
    assert!(window.proposals.lock().unwrap().is_empty());
}

#[tokio::test]
async fn several_statements_may_be_proposed_because_a_migration_is_several() {
    // Deliberately not the single-statement rule: this writes into an editor,
    // it does not run anything.
    let (server, window) = with_window(
        Fake::shared(DataPosture::Full, "development", false),
        FakeWindow {
            outcome: Some(EditOutcome {
                accepted: false,
                edited: false,
                sql: None,
            }),
            ..Default::default()
        },
    );

    server
        .propose_edit(Parameters(ProposeEditArg {
            tab: None,
            sql: "ALTER TABLE a ADD b INT; UPDATE a SET b = 1;".into(),
            rationale: "the migration".into(),
        }))
        .await
        .unwrap();

    assert_eq!(window.proposals.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_user_who_closes_the_diff_is_reported_as_not_having_answered() {
    let (server, _) = with_window(
        Fake::shared(DataPosture::Full, "development", false),
        FakeWindow::default(),
    );

    let refusal = refused(
        server
            .propose_edit(Parameters(ProposeEditArg {
                tab: None,
                sql: "SELECT 1".into(),
                rationale: "why".into(),
            }))
            .await,
    );
    // Read as a no, so the agent asks rather than proposing the same thing
    // again — which is how a dialog becomes a loop.
    assert!(refusal.contains("no"), "{refusal}");
}

#[tokio::test]
async fn a_draft_opens_a_new_tab_and_names_it() {
    let (server, window) = with_window(
        Fake::shared(DataPosture::Full, "development", false),
        FakeWindow::default(),
    );

    let tab = server
        .open_draft(Parameters(OpenDraftArg {
            sql: "ALTER TABLE orders ADD INDEX (customer_id)".into(),
            title: Some("Add the index".into()),
            connection: Some("c1".into()),
            database: Some("shop".into()),
        }))
        .await
        .unwrap()
        .0;

    assert_eq!(tab, "tab-9");
    assert_eq!(window.drafts.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_draft_on_an_unshared_connection_is_refused() {
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.grants = Grants::default();
    let (server, window) = with_window(fake, FakeWindow::default());

    refused(
        server
            .open_draft(Parameters(OpenDraftArg {
                sql: "SELECT 1".into(),
                title: None,
                connection: Some("c1".into()),
                database: None,
            }))
            .await,
    );
    assert!(window.drafts.lock().unwrap().is_empty());
}

// -------------------------------------------------------------------- history

fn entry(connection: &str, sql: &str, status: &str) -> HistoryEntry {
    HistoryEntry {
        id: uuid::Uuid::new_v4().to_string(),
        sql: sql.into(),
        connection_name: connection.into(),
        database: Some("shop".into()),
        executed_at: "2026-09-12T10:00:00Z".into(),
        execution_time_ms: 12,
        row_count: 3,
        status: status.into(),
        error: (status == "error").then(|| "Table 'shop.nope' doesn't exist".to_string()),
        error_code: (status == "error").then_some(1146),
        error_sql_state: (status == "error").then(|| "42S02".to_string()),
        redacted: false,
        truncated: false,
        origin: "editor".into(),
    }
}

#[tokio::test]
async fn history_is_limited_to_the_connections_the_user_shared() {
    // A statement is as revealing as the schema it names, and history spans
    // every connection the user has ever used.
    let mut fake = Fake::shared(DataPosture::Samples, "development", false);
    fake.history = vec![
        entry("shop", "SELECT 1", "success"),
        entry("payroll", "SELECT salary FROM staff", "success"),
    ];
    let (server, fake) = server(fake);

    let items = server
        .query_history(Parameters(HistoryArg {
            search: None,
            connection: None,
            failed_only: false,
            limit: None,
        }))
        .await
        .unwrap()
        .0;

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].connection, "shop");
    assert_eq!(
        fake.last_history
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .connection_names,
        vec!["shop"]
    );
}

#[tokio::test]
async fn with_nothing_shared_history_is_empty_rather_than_everything() {
    // The failure mode worth guarding: an empty filter list read as "no
    // filter" would hand over every statement the user has ever run.
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.grants = Grants::default();
    fake.history = vec![entry("payroll", "SELECT salary FROM staff", "success")];
    let (server, fake) = server(fake);

    assert!(server
        .query_history(Parameters(HistoryArg {
            search: None,
            connection: None,
            failed_only: false,
            limit: None,
        }))
        .await
        .unwrap()
        .0
        .is_empty());
    assert!(
        fake.last_history.lock().unwrap().is_none(),
        "the store should not even be asked"
    );
}

#[tokio::test]
async fn the_history_limit_is_the_tools_not_the_models() {
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.history = (0..500)
        .map(|_| entry("shop", "SELECT 1", "success"))
        .collect();
    let (server, fake) = server(fake);

    server
        .query_history(Parameters(HistoryArg {
            search: None,
            connection: None,
            failed_only: false,
            limit: Some(10_000),
        }))
        .await
        .unwrap();

    assert_eq!(
        fake.last_history.lock().unwrap().as_ref().unwrap().limit,
        50
    );
}

#[tokio::test]
async fn the_last_error_is_the_last_failure_with_its_error_number() {
    let mut fake = Fake::shared(DataPosture::SchemaOnly, "production", false);
    fake.history = vec![entry("shop", "SELECT * FROM nope", "error")];
    let (server, fake) = server(fake);

    let last = server
        .get_last_error()
        .await
        .unwrap()
        .0
        .expect("one failure");
    assert!(last.error.unwrap().contains("doesn't exist"));
    assert_eq!(last.sql, "SELECT * FROM nope");

    let filter = fake.last_history.lock().unwrap().clone().unwrap();
    assert!(filter.failed_only, "successes are not errors");
    assert_eq!(filter.limit, 1, "the *last* one");
}

#[tokio::test]
async fn nothing_has_failed_is_an_answer_too() {
    let (server, _) = server(Fake::shared(DataPosture::Full, "development", false));
    assert!(server.get_last_error().await.unwrap().0.is_none());
}

// --------------------------------------------------------------------- writes

fn write(sql: &str) -> Parameters<WriteArg> {
    Parameters(WriteArg {
        connection: "c1".into(),
        database: Some("shop".into()),
        sql: sql.into(),
        reason: "the orders were imported with the wrong status".into(),
    })
}

/// A workspace and a window that answers approvals the given way.
fn with_approval(
    posture: DataPosture,
    environment: &str,
    approval: Option<bool>,
) -> (SqlPilot, Arc<Fake>, Arc<FakeWindow>) {
    let mut fake = Fake::shared(posture, environment, false);
    fake.affected = 4;
    let fake = Arc::new(fake);
    let window = Arc::new(FakeWindow {
        approval,
        ..Default::default()
    });
    let server = SqlPilot::new(fake.clone()).with_surface(window.clone());
    (server, fake, window)
}

#[tokio::test]
async fn a_write_is_run_before_the_user_is_asked_so_the_number_is_real() {
    // "Are you sure?" is unanswerable without knowing how much this changes,
    // and that is not in the statement.
    let (server, fake, window) = with_approval(DataPosture::Full, "staging", Some(true));

    let outcome = server
        .run_write(write(
            "UPDATE orders SET status = 'new' WHERE status = 'nwe'",
        ))
        .await
        .unwrap()
        .0;

    assert_eq!(window.approvals.lock().unwrap()[0].rows_affected, Some(4));
    assert!(outcome.applied);
    assert_eq!(outcome.rows_affected, 4);
    assert_eq!(fake.decisions.lock().unwrap()[0], "commit staged-1");
}

#[tokio::test]
async fn saying_no_rolls_it_back_and_says_nothing_changed() {
    let (server, fake, _) = with_approval(DataPosture::Full, "production", Some(false));

    let outcome = server
        .run_write(write("DELETE FROM orders"))
        .await
        .unwrap()
        .0;

    assert!(!outcome.applied);
    assert_eq!(fake.decisions.lock().unwrap()[0], "rollback staged-1");
    // The agent is told to ask rather than to try again another way.
    assert!(
        outcome.note.contains("nothing was changed"),
        "{}",
        outcome.note
    );
    assert!(outcome.note.contains("another way in"), "{}", outcome.note);
}

#[tokio::test]
async fn a_window_that_never_answers_is_not_consent() {
    // The failure that would make the whole model decorative.
    let (server, fake, _) = with_approval(DataPosture::Full, "production", None);

    let refusal = refused(server.run_write(write("DELETE FROM orders")).await);

    assert_eq!(fake.decisions.lock().unwrap()[0], "rollback staged-1");
    assert!(refusal.contains("no"), "{refusal}");
}

#[tokio::test]
async fn the_approval_says_which_database_and_which_environment() {
    // The same statement is a different decision on production.
    let (server, _, window) = with_approval(DataPosture::SchemaOnly, "production", Some(false));

    server.run_write(write("DELETE FROM orders")).await.unwrap();

    let request = &window.approvals.lock().unwrap()[0];
    assert_eq!(request.connection, "shop");
    assert_eq!(request.environment, "production");
    assert_eq!(request.database.as_deref(), Some("shop"));
    assert_eq!(request.kind, "write");
    assert!(request.reason.as_ref().unwrap().contains("wrong status"));
}

#[tokio::test]
async fn a_write_is_allowed_even_where_the_posture_hides_the_rows() {
    // Posture is about what an agent may *see*. It has nothing to say about
    // what the user may approve.
    let (server, _, _) = with_approval(DataPosture::SchemaOnly, "production", Some(true));
    assert!(
        server
            .run_write(write("DELETE FROM orders"))
            .await
            .unwrap()
            .0
            .applied
    );
}

#[tokio::test]
async fn a_read_only_connection_refuses_before_anything_is_staged() {
    let mut fake = Fake::shared(DataPosture::Full, "production", true);
    fake.affected = 4;
    let fake = Arc::new(fake);
    let window = Arc::new(FakeWindow {
        approval: Some(true),
        ..Default::default()
    });
    let server = SqlPilot::new(fake.clone()).with_surface(window.clone());

    let refusal = refused(server.run_write(write("DELETE FROM orders")).await);

    assert!(refusal.contains("read-only"), "{refusal}");
    assert!(fake.staged.lock().unwrap().is_empty(), "nothing ran");
    assert!(
        window.approvals.lock().unwrap().is_empty(),
        "nobody was asked"
    );
}

#[tokio::test]
async fn a_write_with_no_reason_is_refused_before_it_runs() {
    let (server, fake, _) = with_approval(DataPosture::Full, "development", Some(true));

    let refusal = refused(
        server
            .run_write(Parameters(WriteArg {
                connection: "c1".into(),
                database: Some("shop".into()),
                sql: "DELETE FROM orders".into(),
                reason: "   ".into(),
            }))
            .await,
    );

    assert!(refusal.contains("why"), "{refusal}");
    assert!(fake.staged.lock().unwrap().is_empty());
}

#[tokio::test]
async fn two_statements_are_refused_here_too() {
    let (server, fake, _) = with_approval(DataPosture::Full, "development", Some(true));
    refused(
        server
            .run_write(write("DELETE FROM a; DELETE FROM b"))
            .await,
    );
    assert!(fake.staged.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_schema_change_sent_to_run_write_is_redirected_rather_than_staged() {
    // Staging it would promise an undo the server does not offer.
    let (server, fake, _) = with_approval(DataPosture::Full, "development", Some(true));

    let refusal = refused(
        server
            .run_write(write("ALTER TABLE orders ADD note TEXT"))
            .await,
    );

    assert!(refusal.contains("run_ddl"), "{refusal}");
    assert!(refusal.contains("cannot be undone"), "{refusal}");
    assert!(fake.staged.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_select_sent_to_run_write_is_redirected() {
    let (server, _, _) = with_approval(DataPosture::Full, "development", Some(true));
    let refusal = refused(server.run_write(write("SELECT * FROM orders")).await);
    assert!(refusal.contains("run_select"), "{refusal}");
}

#[tokio::test]
async fn a_statement_that_fails_never_reaches_the_user() {
    // Nothing to approve: it did not run.
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.stage_fails = Some("Unknown column 'nope'".into());
    let fake = Arc::new(fake);
    let window = Arc::new(FakeWindow {
        approval: Some(true),
        ..Default::default()
    });
    let server = SqlPilot::new(fake.clone()).with_surface(window.clone());

    let refusal = refused(server.run_write(write("UPDATE orders SET nope = 1")).await);

    assert!(refusal.contains("Unknown column"), "{refusal}");
    assert!(window.approvals.lock().unwrap().is_empty());
}

// ----------------------------------------------------------------- schema

fn ddl(sql: &str) -> Parameters<WriteArg> {
    Parameters(WriteArg {
        connection: "c1".into(),
        database: Some("shop".into()),
        sql: sql.into(),
        reason: "the query scans the whole table without it".into(),
    })
}

#[tokio::test]
async fn a_schema_change_is_approved_before_it_runs_with_no_row_count() {
    // There is no honest number to show, and an estimate would be a guess
    // presented as a measurement.
    let (server, fake, window) = with_approval(DataPosture::Full, "development", Some(true));

    let outcome = server
        .run_ddl(ddl("ALTER TABLE orders ADD INDEX (customer_id)"))
        .await
        .unwrap()
        .0;

    let request = &window.approvals.lock().unwrap()[0];
    assert_eq!(request.kind, "schema");
    assert_eq!(request.rows_affected, None);
    assert!(outcome.applied);
    assert_eq!(fake.ran()[0], "ALTER TABLE orders ADD INDEX (customer_id)");
}

#[tokio::test]
async fn a_schema_change_the_user_refuses_does_not_run() {
    let (server, fake, _) = with_approval(DataPosture::Full, "staging", Some(false));

    let outcome = server.run_ddl(ddl("DROP TABLE orders")).await.unwrap().0;

    assert!(!outcome.applied);
    assert!(fake.ran().is_empty(), "the table is still there");
}

#[tokio::test]
async fn production_schema_changes_are_refused_before_anyone_is_asked() {
    // Not "ask harder": refused, until the user unlocks that connection in
    // SQLPilot itself.
    let (server, fake, window) = with_approval(DataPosture::Full, "production", Some(true));

    let refusal = refused(server.run_ddl(ddl("DROP TABLE orders")).await);

    assert!(refusal.contains("production"), "{refusal}");
    assert!(
        refusal.contains("draft"),
        "and points at the way that works: {refusal}"
    );
    assert!(window.approvals.lock().unwrap().is_empty());
    assert!(fake.ran().is_empty());
}

#[tokio::test]
async fn an_unlocked_production_connection_asks_rather_than_refusing() {
    let mut fake = Fake::shared(DataPosture::Full, "production", false);
    fake.grants.unlock_ddl("c1", true);
    let fake = Arc::new(fake);
    let window = Arc::new(FakeWindow {
        approval: Some(true),
        ..Default::default()
    });
    let server = SqlPilot::new(fake.clone()).with_surface(window.clone());

    assert!(
        server
            .run_ddl(ddl("ALTER TABLE orders ADD note TEXT"))
            .await
            .unwrap()
            .0
            .applied
    );
    assert_eq!(window.approvals.lock().unwrap().len(), 1, "still asked");
}

#[tokio::test]
async fn a_write_sent_to_run_ddl_is_redirected() {
    let (server, fake, _) = with_approval(DataPosture::Full, "development", Some(true));
    let refusal = refused(server.run_ddl(ddl("DELETE FROM orders")).await);
    assert!(refusal.contains("run_write"), "{refusal}");
    assert!(fake.ran().is_empty());
}

#[tokio::test]
async fn without_a_window_a_write_cannot_be_approved_and_is_not_applied() {
    // A headless server — the app closed, the endpoint still up — must not
    // fall through to applying it.
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.affected = 4;
    let fake = Arc::new(fake);
    let server = SqlPilot::new(fake.clone());

    let refusal = refused(server.run_write(write("DELETE FROM orders")).await);

    assert!(refusal.contains("no window"), "{refusal}");
    // And it was never staged: a write that has run with nobody to ask would
    // hold locks in an open transaction until its deadline, for a question
    // that was never going to be seen.
    assert!(fake.staged.lock().unwrap().is_empty());
    assert!(fake.decisions.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_estimate_runs_it_and_puts_it_back_without_asking_anyone() {
    // For deciding whether a change is the right size before proposing it.
    let (server, fake, window) = with_approval(DataPosture::Full, "production", Some(true));

    let impact = server
        .estimate_impact(select(
            "DELETE FROM orders WHERE created_at < '2020-01-01'",
            None,
        ))
        .await
        .unwrap()
        .0;

    assert_eq!(impact.rows_affected, 4);
    assert_eq!(fake.decisions.lock().unwrap()[0], "rollback staged-1");
    assert!(
        window.approvals.lock().unwrap().is_empty(),
        "nobody was asked"
    );
    assert!(impact.note.contains("rolled back"), "{}", impact.note);
    assert!(impact.note.contains("run_write"), "{}", impact.note);
}

#[tokio::test]
async fn estimating_a_schema_change_says_why_it_cannot_be_done() {
    let (server, fake, _) = with_approval(DataPosture::Full, "development", Some(true));

    let refusal = refused(
        server
            .estimate_impact(select("DROP TABLE orders", None))
            .await,
    );

    assert!(refusal.contains("commits before"), "{refusal}");
    assert!(fake.staged.lock().unwrap().is_empty(), "and it did not run");
}

#[tokio::test]
async fn estimating_a_read_points_at_the_tool_that_runs_reads() {
    let (server, _, _) = with_approval(DataPosture::Full, "development", Some(true));
    let refusal = refused(
        server
            .estimate_impact(select("SELECT * FROM orders", None))
            .await,
    );
    assert!(refusal.contains("run_select"), "{refusal}");
}

#[tokio::test]
async fn a_read_only_connection_will_not_even_measure() {
    // Measuring means running, and running is the thing a read-only
    // connection does not do.
    let mut fake = Fake::shared(DataPosture::Full, "production", true);
    fake.affected = 4;
    let fake = Arc::new(fake);
    let server = SqlPilot::new(fake.clone());

    let refusal = refused(
        server
            .estimate_impact(select("DELETE FROM orders", None))
            .await,
    );

    assert!(refusal.contains("read-only"), "{refusal}");
    assert!(fake.staged.lock().unwrap().is_empty());
}

// ------------------------------------------------------------------ redaction

#[tokio::test]
async fn a_credential_column_is_not_returned_even_at_full_posture() {
    // Sharing a database as `full` says "you can read this data". It does not
    // say "you can read the password hashes".
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.columns = vec![
        ("id".to_string(), SqlValue::Int(1)),
        (
            "password_hash".to_string(),
            SqlValue::String("$2b$12$abcdef".into()),
        ),
    ];
    let (server, _) = server(fake);

    let result = server
        .run_select(select("SELECT id, password_hash FROM users", None))
        .await
        .unwrap()
        .0;

    assert_eq!(result.rows[0][0], serde_json::json!(1));
    assert_eq!(
        result.rows[0][1].as_str().unwrap(),
        mas_mcp::redact::REDACTED
    );
    let note = result
        .note
        .expect("something was hidden, so something is said");
    assert!(note.contains("password_hash"), "{note}");
}

#[tokio::test]
async fn ordinary_columns_are_untouched_by_it() {
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.columns = vec![
        ("id".to_string(), SqlValue::Int(1)),
        ("email".to_string(), SqlValue::String("a@b.c".into())),
    ];
    let (server, _) = server(fake);

    let result = server
        .run_select(select("SELECT id, email FROM users", None))
        .await
        .unwrap()
        .0;

    assert_eq!(result.rows[0][1], serde_json::json!("a@b.c"));
    assert!(result.note.is_none());
}

#[tokio::test]
async fn a_credential_column_gets_counts_but_no_top_values() {
    // The counts are numbers about the column. A top-ten list *is* the column.
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.profile = Some(vec![
        SqlValue::Int(10),
        SqlValue::Int(10),
        SqlValue::Int(10),
        SqlValue::String("$2b$12$aaa".into()),
        SqlValue::String("$2b$12$zzz".into()),
    ]);
    fake.top = vec![("$2b$12$aaa".to_string(), 1)];
    let (server, fake) = server(fake);

    let profile = server
        .profile_column(Parameters(ColumnArg {
            connection: "c1".into(),
            database: "shop".into(),
            table: "users".into(),
            column: "password_hash".into(),
        }))
        .await
        .unwrap()
        .0;

    assert_eq!(profile.rows_total, 10);
    assert_eq!(profile.distinct_values, 10, "distinctness is a number");
    assert!(profile.most_common.is_empty());
    // The extremes are values too, and a min/max of a hash is two hashes.
    assert!(profile.min.is_none());
    assert!(profile.max.is_none());
    assert!(profile.note.unwrap().contains("credential"));
    assert_eq!(
        fake.ran().len(),
        1,
        "the top-values query should not have run"
    );
}

#[tokio::test]
async fn the_result_on_screen_is_redacted_too() {
    // The user can see it. That is not the same as it being allowed to leave.
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.affected = 0;
    let (server, _) = with_window(
        fake,
        FakeWindow {
            result: Some(RawResult {
                sql: "SELECT id, api_key FROM apps".into(),
                columns: vec!["id".into(), "api_key".into()],
                rows: vec![vec![serde_json::json!(1), serde_json::json!("sk-live-123")]],
                row_count: 1,
                execution_time_ms: 2,
                truncated: false,
                connection: Some("c1".into()),
            }),
            ..Default::default()
        },
    );

    let result = server.get_result_context().await.unwrap().0.unwrap();

    assert_eq!(result.rows[0][0], serde_json::json!(1));
    assert_eq!(
        result.rows[0][1].as_str().unwrap(),
        mas_mcp::redact::REDACTED
    );
    assert!(result.note.unwrap().contains("api_key"));
}

// ------------------------------------------------- staying inside the grant

/// A workspace shared for one database out of the several the server has.
fn limited() -> Fake {
    let mut fake = Fake::shared(DataPosture::Full, "development", false);
    fake.grants
        .set(Grant::new("c1").limited_to(vec!["shop".into()]));
    fake.affected = 1;
    fake
}

#[tokio::test]
async fn a_statement_cannot_reach_a_database_the_grant_excludes() {
    // Hiding `payroll` from list_databases is not a limit: the connection is
    // the user's own, and the server would answer this happily.
    let (server, fake) = server(limited());

    let refusal = refused(
        server
            .run_select(select("SELECT * FROM payroll.staff", None))
            .await,
    );

    assert!(refusal.contains("payroll"), "{refusal}");
    assert!(refusal.contains("list_databases"), "{refusal}");
    assert!(fake.ran().is_empty(), "and it did not run");
}

#[tokio::test]
async fn a_statement_inside_the_grant_runs() {
    let (server, fake) = server(limited());

    server
        .run_select(select("SELECT * FROM shop.orders", None))
        .await
        .unwrap();

    assert_eq!(fake.ran().len(), 1);
}

#[tokio::test]
async fn an_unlimited_grant_pays_nothing_for_the_check() {
    // The databases are only listed where a grant is actually limited.
    let (server, fake) = server(Fake::shared(DataPosture::Full, "development", false));

    server
        .run_select(select("SELECT * FROM payroll.staff", None))
        .await
        .unwrap();

    assert_eq!(fake.ran().len(), 1);
}

#[tokio::test]
async fn a_write_cannot_reach_outside_the_grant_either() {
    let mut fake = limited();
    fake.affected = 4;
    let fake = Arc::new(fake);
    let window = Arc::new(FakeWindow {
        approval: Some(true),
        ..Default::default()
    });
    let server = SqlPilot::new(fake.clone()).with_surface(window.clone());

    let refusal = refused(
        server
            .run_write(Parameters(WriteArg {
                connection: "c1".into(),
                database: Some("shop".into()),
                sql: "DELETE FROM payroll.staff".into(),
                reason: "tidying".into(),
            }))
            .await,
    );

    assert!(refusal.contains("payroll"), "{refusal}");
    assert!(fake.staged.lock().unwrap().is_empty(), "nothing was staged");
    assert!(
        window.approvals.lock().unwrap().is_empty(),
        "nobody was asked"
    );
}

#[tokio::test]
async fn a_plan_cannot_map_a_database_outside_the_grant() {
    // EXPLAIN runs nothing, but a plan names columns and row estimates, which
    // is most of what mapping a schema needs.
    let (server, _) = server(limited());

    let refusal = refused(
        server
            .explain(Parameters(ExplainArg {
                connection: "c1".into(),
                database: Some("shop".into()),
                sql: "SELECT * FROM payroll.staff".into(),
                format: None,
                analyze: false,
            }))
            .await,
    );
    assert!(refusal.contains("payroll"), "{refusal}");
}

#[tokio::test]
async fn a_database_name_inside_a_string_is_not_a_reference_to_it() {
    // Otherwise the check refuses statements that only mention the word.
    let (server, fake) = server(limited());

    server
        .run_select(select(
            "SELECT 'payroll.staff' AS note FROM shop.orders",
            None,
        ))
        .await
        .unwrap();

    assert_eq!(fake.ran().len(), 1);
}
