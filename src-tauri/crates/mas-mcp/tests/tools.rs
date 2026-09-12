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
use mas_core::models::query::{ColumnMeta, QueryResult, SqlValue};
use mas_core::schema::inspector::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ReferencingKey, RoutineInfo, SchemaMatch,
    TableInfo, TriggerInfo, ViewInfo,
};
use mas_mcp::grants::{ConnectionFacts, Grant, Grants};
use mas_mcp::policy::DataPosture;
use mas_mcp::server::{
    ConnectionArg, DatabaseArg, Limits, ObjectsArg, RelatedArg, SearchArg, SelectArg, SqlPilot,
    TableArg,
};
use mas_mcp::workspace::{LiveConnection, ObjectKind, Workspace};
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

    async fn run(
        &self,
        _: &str,
        _: Option<&str>,
        sql: &str,
        limit: Option<u32>,
    ) -> Result<QueryResult, CoreError> {
        self.ran.lock().unwrap().push(sql.to_string());
        *self.last_limit.lock().unwrap() = limit;
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
