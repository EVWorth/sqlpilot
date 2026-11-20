//! A run that writes its rows to the result store (#967) against a real
//! server: what comes back through `window` is what `execute` returns for
//! the same SQL, and no way of ending a run leaves a table behind.
//!
//! ```text
//! cargo test -p mas-core --test result_store_runs -- --ignored --test-threads=1
//! ```
use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::error::Completed;
use mas_core::models::{ConnectionProfile, QueryResult, ResultHandle, SqlValue, TruncationReason};
use mas_core::query::{CancelScope, QueryExecutor, TransactionState};
use mas_core::results::{ResultStore, WindowRequest};
use mas_core::{CoreError, QueryError};
use std::sync::Arc;
use std::time::Duration;

const MIB: u64 = 1024 * 1024;

fn test_profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Result store runs".to_string(),
        group: None,
        color: None,
        host: "127.0.0.1".to_string(),
        port: std::env::var("MAS_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(13306),
        username: "test_user".to_string(),
        password: "test_password".to_string(),
        default_database: Some("test_db".to_string()),
        ssh_config: None,
        ssl_config: None,
        pool_min: 1,
        pool_max: 5,
        read_only: false,
        connect_timeout_secs: None,
        query_timeout_secs: None,
        charset: None,
        environment: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

struct Bench {
    _dir: tempfile::TempDir,
    manager: Arc<ConnectionManager>,
    executor: Arc<QueryExecutor>,
    store: Arc<ResultStore>,
    id: String,
}

fn db() -> Option<String> {
    Some("test_db".to_string())
}

async fn bench_with(profile: ConnectionProfile, budget: u64) -> Bench {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = Arc::new(ResultStore::open(dir.path(), budget).expect("store opens"));
    let manager = Arc::new(ConnectionManager::new());
    let executor = Arc::new(QueryExecutor::new(manager.clone()));
    let info = manager.connect(&profile).await.expect("connects");
    Bench {
        _dir: dir,
        manager,
        executor,
        store,
        id: info.id,
    }
}

async fn bench() -> Bench {
    bench_with(test_profile(), 256 * MIB).await
}

impl Bench {
    async fn setup(&self, statements: &[&str]) {
        for statement in statements {
            self.executor
                .execute(&self.id, statement, db(), None, None)
                .await
                .unwrap_or_else(|e| panic!("setup failed: {statement}: {e}"));
        }
    }

    async fn old(
        &self,
        sql: &str,
        limit: Option<u64>,
        offset: Option<u64>,
    ) -> Result<Vec<QueryResult>, CoreError> {
        self.executor
            .execute(&self.id, sql, db(), limit, offset)
            .await
    }

    async fn run(
        &self,
        sql: &str,
        limit: Option<u64>,
        offset: Option<u64>,
    ) -> Result<Vec<ResultHandle>, CoreError> {
        self.executor
            .run_owned(
                self.id.clone(),
                sql.to_string(),
                db(),
                limit,
                offset,
                &self.store,
            )
            .await
    }

    async fn run_on(&self, session: &str, sql: &str) -> Result<Vec<ResultHandle>, CoreError> {
        self.executor
            .run_in_session(
                session,
                self.id.clone(),
                sql.to_string(),
                db(),
                None,
                None,
                &self.store,
            )
            .await
    }

    /// Every row of a stored result, whole.
    fn rows(&self, handle: &ResultHandle) -> Vec<Vec<SqlValue>> {
        if handle.row_count == 0 {
            return Vec::new();
        }
        let window = self
            .store
            .window(
                &handle.result_id,
                &WindowRequest {
                    count: u32::MAX,
                    max_cell_bytes: u32::MAX,
                    ..WindowRequest::default()
                },
            )
            .expect("window");
        assert_eq!(window.matching_rows, handle.row_count);
        let ids: Vec<u64> = (1..=handle.row_count).collect();
        assert_eq!(window.row_ids, ids, "row ids are arrival positions");
        window
            .rows
            .into_iter()
            .map(|cells| {
                cells
                    .into_iter()
                    .map(|cell| {
                        assert_eq!(cell.full_len, None);
                        cell.value
                    })
                    .collect()
            })
            .collect()
    }

    fn tables(&self) -> u64 {
        self.store.table_count().expect("table count")
    }

    fn release(&self, handles: &[ResultHandle]) {
        let ids: Vec<String> = handles.iter().map(|h| h.result_id.clone()).collect();
        self.store.release(&ids);
    }

    /// Run `sql` both ways and require the same answer, statement by
    /// statement. Returns the handles, already released.
    async fn assert_same(
        &self,
        sql: &str,
        limit: Option<u64>,
        offset: Option<u64>,
    ) -> Vec<ResultHandle> {
        let context = format!("{sql} (limit {limit:?}, offset {offset:?})");
        let results = self.old(sql, limit, offset).await.expect("old path runs");
        let handles = self.run(sql, limit, offset).await.expect("store path runs");
        assert_eq!(handles.len(), results.len(), "statement count: {context}");

        for (handle, result) in handles.iter().zip(&results) {
            assert_eq!(handle.statement_index, result.statement_index, "{context}");
            assert_eq!(handle.sql, result.sql, "{context}");
            assert_eq!(handle.rows_affected, result.rows_affected, "{context}");
            assert_eq!(handle.row_count, result.rows.len() as u64, "{context}");
            assert_eq!(
                handle.truncation_reason, result.truncation_reason,
                "{context}"
            );
            assert_eq!(handle.warnings, result.warnings, "{context}");
            assert_eq!(handle.transaction, result.transaction, "{context}");
            let shape = |columns: &[mas_core::models::ColumnMeta]| -> Vec<(String, String)> {
                columns
                    .iter()
                    .map(|c| (c.name.clone(), c.data_type.clone()))
                    .collect()
            };
            assert_eq!(shape(&handle.columns), shape(&result.columns), "{context}");

            let stored = self.rows(handle);
            assert_eq!(stored.len(), result.rows.len(), "{context}");
            for (index, (stored, returned)) in stored.iter().zip(&result.rows).enumerate() {
                assert_eq!(stored, returned, "row {index}: {context}");
                // The same variant too: `1` is not `true`.
                for (a, b) in stored.iter().zip(returned) {
                    assert_eq!(
                        std::mem::discriminant(a),
                        std::mem::discriminant(b),
                        "row {index}: {a:?} vs {b:?}: {context}"
                    );
                }
            }
        }

        let with_rows = handles.iter().filter(|h| h.row_count > 0).count() as u64;
        assert_eq!(self.tables(), with_rows, "a table per result with rows");
        self.release(&handles);
        assert_eq!(self.tables(), 0, "release frees them: {context}");
        handles
    }
}

/// Ten thousand numbered rows, from a cross join of digits.
const SEQ_SETUP: &[&str] = &[
    "DROP TABLE IF EXISTS rs_digits",
    "CREATE TABLE rs_digits (d INT PRIMARY KEY)",
    "INSERT INTO rs_digits VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)",
    "DROP TABLE IF EXISTS rs_seq",
    "CREATE TABLE rs_seq (n INT PRIMARY KEY, label VARCHAR(40))",
    "INSERT INTO rs_seq
     SELECT 1 + a.d + b.d * 10 + c.d * 100 + e.d * 1000, CONCAT('row ', 1 + a.d + b.d * 10 + c.d * 100 + e.d * 1000)
     FROM rs_digits a CROSS JOIN rs_digits b CROSS JOIN rs_digits c CROSS JOIN rs_digits e",
];

/// A statement that streams a hundred million wide rows: long enough that
/// it is still sending when a test cancels it or its timeout arrives.
const ENDLESS: &str = "SELECT a.n, REPEAT('x', 200) AS filler FROM rs_seq a CROSS JOIN rs_seq b";

const TYPES_SETUP: &[&str] = &[
    "DROP TABLE IF EXISTS rs_types",
    "CREATE TABLE rs_types (
        id INT PRIMARY KEY,
        tiny TINYINT,
        flag TINYINT(1),
        small_u SMALLINT UNSIGNED,
        big BIGINT,
        big_u BIGINT UNSIGNED,
        bits BIT(8),
        price DECIMAL(20,6),
        ratio DOUBLE,
        approx FLOAT,
        yr YEAR,
        day DATE,
        at DATETIME,
        stamp TIMESTAMP NULL,
        name VARCHAR(60),
        body TEXT,
        doc JSON,
        raw MEDIUMBLOB,
        fixed BINARY(4)
    )",
    "INSERT INTO rs_types VALUES
     (1, -128, 1, 65535, -9223372036854775808, 18446744073709551615, b'10100101',
      12345678901234.123456, 3.141592653589793, 1.5, 2024, '2024-02-29',
      '2024-02-29 23:59:58', '2024-02-29 23:59:59', 'Zoë', 'some text',
      '{\"a\": [1, 2, {\"b\": null}], \"n\": 1.5}', x'00FF10', x'DEADBEEF'),
     (2, 127, 0, 0, 9223372036854775807, 9223372036854775808, b'0',
      -0.000001, -0.0, 0, 1901, '1000-01-01',
      '1000-01-01 00:00:00', '1970-01-02 00:00:01', '', '',
      '[]', x'', x'00000000'),
     (3, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL,
      NULL, NULL, NULL),
     (4, 0, 1, 1, 0, 0, b'11111111',
      0, 1e300, 3.25, 2155, '9999-12-31',
      '9999-12-31 23:59:59', '2038-01-19 03:14:07', '日本語 and emoji 🎉', REPEAT('long ', 4000),
      '\"just a string\"', REPEAT(x'AB', 70000), x'41424344')",
];

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn every_type_comes_back_through_a_window_as_execute_returns_it() {
    let bench = bench().await;
    bench.setup(TYPES_SETUP).await;

    let handles = bench
        .assert_same("SELECT * FROM rs_types ORDER BY id", None, None)
        .await;
    assert_eq!(handles[0].row_count, 4);
    assert_eq!(handles[0].columns.len(), 19);

    // The values this is about, read back by cell and checked against what
    // was inserted rather than against the other path.
    let handles = bench
        .run(
            "SELECT big_u, price, at, doc, raw, big FROM rs_types ORDER BY id",
            None,
            None,
        )
        .await
        .expect("runs");
    let id = &handles[0].result_id;
    let cell = |row: u64, column: usize| bench.store.cell(id, row, column).expect("cell");
    let text = |value: &str| SqlValue::String(value.to_string());
    assert_eq!(cell(1, 0), text("18446744073709551615"), "above i64::MAX");
    assert_eq!(cell(2, 0), text("9223372036854775808"));
    assert_eq!(cell(1, 1), text("12345678901234.123456"), "exact DECIMAL");
    assert_eq!(cell(2, 1), text("-0.000001"));
    assert_eq!(cell(1, 2), text("2024-02-29 23:59:58"));
    assert!(
        matches!(cell(1, 3), SqlValue::String(doc) if doc.contains("\"b\"")),
        "JSON is text"
    );
    assert_eq!(cell(1, 4), SqlValue::Bytes(vec![0x00, 0xFF, 0x10]));
    assert_eq!(cell(2, 4), SqlValue::Bytes(Vec::new()), "empty, not NULL");
    assert_eq!(cell(4, 4), SqlValue::Bytes(vec![0xAB; 70000]));
    assert_eq!(cell(1, 5), text("-9223372036854775808"));
    for column in 0..6 {
        assert_eq!(cell(3, column), SqlValue::Null, "column {column}");
    }

    // A window cuts the long BLOB and says how long it really is.
    let window = bench
        .store
        .window(
            id,
            &WindowRequest {
                offset: 3,
                count: 1,
                max_cell_bytes: 64 * 1024,
                ..WindowRequest::default()
            },
        )
        .expect("window");
    assert_eq!(window.rows[0][4].full_len, Some(70000));
    assert_eq!(
        window.rows[0][4].value,
        SqlValue::Bytes(vec![0xAB; 64 * 1024])
    );
    let json = serde_json::to_value(&window.rows[0][4]).expect("serialises");
    assert!(
        json["value"]["bytes"].is_string(),
        "binary is base64 on the wire: {json}"
    );

    bench.release(&handles);
    bench.setup(&["DROP TABLE rs_types"]).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn limit_and_offset_behave_as_they_do_when_results_are_returned() {
    let bench = bench().await;
    bench.setup(SEQ_SETUP).await;
    let sql = "SELECT n, label FROM rs_seq WHERE n <= 2500 ORDER BY n";

    for (limit, offset) in [
        (None, None),
        (Some(100), None),
        // Exactly the size of the result: nothing withheld, not truncated.
        (Some(2500), None),
        (Some(2499), None),
        // Across the sink's batch boundary.
        (Some(1000), None),
        (Some(1001), None),
        (Some(100), Some(50)),
        (Some(1000), Some(2000)),
        // The last page comes back short.
        (Some(1000), Some(2400)),
        // A page past the end keeps its columns (#391).
        (Some(100), Some(2500)),
        (Some(100), Some(9999)),
        (None, Some(2499)),
        (Some(0), None),
    ] {
        bench.assert_same(sql, limit, offset).await;
    }

    // Statements a LIMIT clause could not be appended to, and each
    // statement of a script paged from its own start.
    bench
        .assert_same("SHOW COLUMNS FROM rs_seq", Some(1), Some(1))
        .await;
    let handles = bench
        .assert_same(
            "SELECT n FROM rs_seq ORDER BY n; SELECT n FROM rs_seq ORDER BY n DESC",
            Some(3),
            Some(2),
        )
        .await;
    assert_eq!(handles[0].row_count, 3);
    assert_eq!(
        handles[1].truncation_reason,
        Some(TruncationReason::RowLimit)
    );
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_script_yields_a_handle_per_statement_and_a_table_per_result_with_rows() {
    let bench = bench().await;
    bench.setup(SEQ_SETUP).await;

    let script = "DROP TABLE IF EXISTS rs_script;
        CREATE TABLE rs_script (id INT PRIMARY KEY, v VARCHAR(10));
        INSERT INTO rs_script VALUES (1, 'a'), (2, 'b'), (3, 'c');
        SELECT * FROM rs_script ORDER BY id;
        UPDATE rs_script SET v = 'z' WHERE id > 1;
        SELECT * FROM rs_script WHERE id > 100;
        SELECT v, COUNT(*) AS c FROM rs_script GROUP BY v ORDER BY v;
        DROP TABLE rs_script";
    let handles = bench.assert_same(script, None, None).await;

    let summary: Vec<(usize, u64, u64, usize)> = handles
        .iter()
        .map(|h| {
            (
                h.statement_index,
                h.row_count,
                h.rows_affected,
                h.columns.len(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            (0, 0, 0, 0),
            (1, 0, 0, 0),
            (2, 0, 3, 0),
            (3, 3, 3, 2),
            (4, 0, 2, 0),
            // A result set with no rows: nothing stored, and (as on the
            // other path) no columns, which are read from the first row.
            (5, 0, 0, 0),
            (6, 2, 2, 2),
            (7, 0, 0, 0),
        ]
    );
    let mut ids: Vec<&str> = handles.iter().map(|h| h.result_id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), handles.len(), "every handle has its own id");

    // A procedure returning two result sets, then a statement after it.
    bench
        .setup(&[
            "DROP PROCEDURE IF EXISTS rs_two_sets",
            "CREATE PROCEDURE rs_two_sets() BEGIN SELECT n FROM rs_seq WHERE n <= 3 ORDER BY n; SELECT label FROM rs_seq WHERE n <= 2 ORDER BY n; END",
        ])
        .await;
    let handles = bench
        .assert_same("CALL rs_two_sets(); SELECT 'after' AS marker", None, None)
        .await;
    assert_eq!(handles.len(), 3);
    assert_eq!(
        handles.iter().map(|h| h.row_count).collect::<Vec<_>>(),
        vec![3, 2, 1]
    );
    bench.setup(&["DROP PROCEDURE rs_two_sets"]).await;
}

/// The handles a failed run carries, and the error as the frontend gets it.
fn completed_handles(err: &CoreError) -> (Vec<ResultHandle>, QueryError) {
    let reported = QueryError::from_core(err);
    let handles = match err {
        CoreError::AtStatement {
            completed: Completed::Handles(handles),
            ..
        } => handles.clone(),
        other => panic!("not a statement failure with handles: {other:?}"),
    };
    assert!(
        reported.completed_results.is_none(),
        "a store run never carries whole results"
    );
    (handles, reported)
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_failing_third_statement_returns_two_handles_and_leaves_no_third_table() {
    let bench = bench().await;
    bench.setup(SEQ_SETUP).await;

    // The third statement fails before it returns anything.
    let err = bench
        .run(
            "SELECT n FROM rs_seq WHERE n <= 5 ORDER BY n; SELECT 'second' AS label; SELECT * FROM rs_no_such_table; SELECT 'never'",
            None,
            None,
        )
        .await
        .expect_err("the third statement fails");
    let (handles, reported) = completed_handles(&err);
    assert_eq!(reported.statement_index, Some(2));
    assert_eq!(reported.code, Some(1146), "the driver's error survives");
    assert_eq!(
        reported.completed_handles.as_ref().map(Vec::len),
        Some(2),
        "the frontend gets both"
    );
    assert_eq!(handles.len(), 2);
    assert_eq!(handles[0].row_count, 5);
    assert_eq!(
        bench.rows(&handles[1]),
        vec![vec![SqlValue::String("second".into())]]
    );
    assert_eq!(bench.tables(), 2, "the two that completed, and no third");
    bench.release(&handles);
    assert_eq!(bench.tables(), 0);

    // The third statement fails after thousands of its rows have arrived
    // and been written: a scalar subquery that returns two rows, hit late
    // in the scan.
    let late = "SELECT n FROM rs_seq WHERE n <= 5 ORDER BY n; SELECT 'second' AS label; \
                SELECT n, REPEAT('x', 200), IF(n = 9000, (SELECT d FROM rs_digits WHERE d < 2), 0) FROM rs_seq ORDER BY n";
    let err = bench
        .run(late, None, None)
        .await
        .expect_err("fails mid-result");
    let (handles, reported) = completed_handles(&err);
    assert_eq!(reported.statement_index, Some(2));
    assert_eq!(handles.len(), 2);
    assert_eq!(bench.tables(), 2, "the partly written third is gone");

    // The same failure on the path that returns results says the same.
    let old = bench.old(late, None, None).await.expect_err("fails");
    let old = QueryError::from_core(&old);
    assert_eq!(old.statement_index, reported.statement_index);
    assert_eq!(old.code, reported.code);
    assert_eq!(old.completed_results.map(|r| r.len()), Some(2));
    assert!(old.completed_handles.is_none());

    bench.release(&handles);
    assert_eq!(bench.tables(), 0);

    // A failure at the first statement carries nothing either way.
    let err = bench
        .run("SELECT * FROM rs_no_such_table", None, None)
        .await
        .expect_err("fails");
    assert!(QueryError::from_core(&err).completed_handles.is_none());
    assert_eq!(bench.tables(), 0);
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_tiny_budget_truncates_with_store_full() {
    let bench = bench_with(test_profile(), MIB).await;
    bench.setup(SEQ_SETUP).await;

    // About 2.4 MB of rows into a 1 MB store, then a statement after it.
    let handles = bench
        .run(
            "SELECT n, REPEAT('x', 200) AS filler FROM rs_seq ORDER BY n; SELECT 'after' AS marker",
            None,
            None,
        )
        .await
        .expect("a full store truncates; it does not fail the run");
    assert_eq!(handles.len(), 2, "the script runs on past the full result");

    let big = &handles[0];
    assert_eq!(big.truncation_reason, Some(TruncationReason::StoreFull));
    assert!(
        big.row_count > 0 && big.row_count < 10_000,
        "kept {}",
        big.row_count
    );
    assert_eq!(big.rows_affected, big.row_count);
    // What was kept is the start of the result, in order, and readable.
    let rows = bench.rows(big);
    assert_eq!(rows.len() as u64, big.row_count);
    assert_eq!(rows[0][0], SqlValue::Int(1));
    assert_eq!(
        rows.last().expect("rows")[0],
        SqlValue::Int(big.row_count as i64)
    );

    // The row limit, when it also applied, is not what gets reported.
    let limited = bench
        .run(
            "SELECT n, REPEAT('x', 200) AS filler FROM rs_seq ORDER BY n",
            Some(9000),
            None,
        )
        .await
        .expect("runs");
    assert_eq!(
        limited[0].truncation_reason,
        Some(TruncationReason::StoreFull)
    );
    bench.release(&limited);

    // Releasing makes room: the same query, small enough, is whole again.
    bench.release(&handles);
    let small = bench
        .run("SELECT n FROM rs_seq ORDER BY n", Some(500), None)
        .await
        .expect("runs");
    assert_eq!(small[0].truncation_reason, Some(TruncationReason::RowLimit));
    assert_eq!(small[0].row_count, 500);
    bench.release(&small);
    assert_eq!(bench.tables(), 0);
}

/// Wait until a run has started writing a result, so that stopping it
/// stops it mid-fetch.
async fn until_writing(bench: &Bench, tables: u64) {
    for _ in 0..200 {
        if bench.tables() >= tables {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the run never started writing");
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn cancel_mid_fetch_leaves_no_table() {
    let bench = Arc::new(bench().await);
    bench.setup(SEQ_SETUP).await;

    let running = {
        let bench = Arc::clone(&bench);
        tokio::spawn(async move {
            bench
                .run(&format!("SELECT 'first' AS label; {ENDLESS}"), None, None)
                .await
        })
    };
    // One table for the first statement, a second once rows are arriving.
    until_writing(&bench, 2).await;
    bench
        .executor
        .cancel(&bench.id, CancelScope::Interactive)
        .await
        .expect("cancel is issued");
    let err = tokio::time::timeout(Duration::from_secs(20), running)
        .await
        .expect("the run stopped when cancelled")
        .expect("no panic")
        .expect_err("a cancelled run is an error");

    let (handles, reported) = completed_handles(&err);
    assert_eq!(reported.statement_index, Some(1));
    assert_eq!(handles.len(), 1, "the statement before it completed");
    assert_eq!(bench.tables(), 1, "the cancelled result left nothing");
    bench.release(&handles);
    assert_eq!(bench.tables(), 0);

    // The connection is still good, and so is the store.
    bench.assert_same("SELECT 1 AS one", None, None).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn cancel_mid_fetch_on_a_session_leaves_no_table() {
    let bench = Arc::new(bench().await);
    bench.setup(SEQ_SETUP).await;

    // What the session holds before the run is still there after it.
    bench
        .run_on("tab-1", "SET @kept = 41")
        .await
        .expect("session opens");
    let running = {
        let bench = Arc::clone(&bench);
        tokio::spawn(async move { bench.run_on("tab-1", ENDLESS).await })
    };
    until_writing(&bench, 1).await;
    bench
        .executor
        .cancel(&bench.id, CancelScope::Session("tab-1".to_string()))
        .await
        .expect("cancel is issued");
    let err = tokio::time::timeout(Duration::from_secs(20), running)
        .await
        .expect("the run stopped when cancelled")
        .expect("no panic")
        .expect_err("a cancelled run is an error");
    assert!(QueryError::from_core(&err).completed_handles.is_none());
    assert_eq!(bench.tables(), 0, "the cancelled result left nothing");

    let handles = bench
        .run_on("tab-1", "SELECT @kept + 1 AS answer")
        .await
        .expect("the session survives the cancel");
    assert_eq!(bench.rows(&handles[0]).len(), 1);
    assert!(
        format!("{:?}", bench.rows(&handles[0])[0][0]).contains("42"),
        "{:?}",
        bench.rows(&handles[0])
    );
    bench.release(&handles);
    bench.manager.close_session(&bench.id, "tab-1").await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_timeout_mid_fetch_leaves_no_table_and_keeps_what_completed() {
    let mut profile = test_profile();
    profile.query_timeout_secs = Some(2);
    let bench = bench_with(profile, 4096 * MIB).await;
    bench.setup(SEQ_SETUP).await;

    let started = std::time::Instant::now();
    let err = bench
        .run(&format!("SELECT 'first' AS label; {ENDLESS}"), None, None)
        .await
        .expect_err("the second statement runs past the timeout");
    // The deadline holds even though a row is always ready to read: it is
    // two seconds, plus at most the grace given to a killed statement.
    assert!(
        started.elapsed() < Duration::from_secs(12),
        "stopped after {:?}",
        started.elapsed()
    );
    assert!(matches!(err.root(), CoreError::Timeout(_)), "got {err:?}");
    let (handles, reported) = completed_handles(&err);
    assert_eq!(reported.statement_index, Some(1));
    assert_eq!(handles.len(), 1);
    assert_eq!(bench.tables(), 1, "the timed-out result left nothing");
    assert_eq!(
        bench.rows(&handles[0]),
        vec![vec![SqlValue::String("first".into())]]
    );
    bench.release(&handles);

    // The connection came back to the pool (#658).
    bench.assert_same("SELECT 1 AS one", None, None).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_run_on_a_session_behaves_as_execute_in_session_does() {
    let bench = bench().await;
    bench.setup(SEQ_SETUP).await;
    bench
        .setup(&[
            "DROP TABLE IF EXISTS rs_session",
            "CREATE TABLE rs_session (id INT PRIMARY KEY) ENGINE=InnoDB",
        ])
        .await;

    // What one run sets up is there for the next, and the transaction
    // state rides on the last handle only.
    let handles = bench
        .run_on(
            "tab-1",
            "SET @base = 40; BEGIN; INSERT INTO rs_session VALUES (1); SELECT @base + 2 AS answer",
        )
        .await
        .expect("runs");
    assert_eq!(handles.len(), 4);
    assert!(handles[..3].iter().all(|h| h.transaction.is_none()));
    assert_eq!(handles[3].transaction, Some(TransactionState::Open));
    assert_eq!(handles[2].rows_affected, 1);
    assert_eq!(bench.tables(), 1);
    bench.release(&handles);

    let handles = bench
        .run_on("tab-1", "SELECT COUNT(*) AS c FROM rs_session; ROLLBACK")
        .await
        .expect("runs");
    assert!(format!("{:?}", bench.rows(&handles[0])).contains('1'));
    assert_eq!(handles[1].transaction, Some(TransactionState::None));
    bench.release(&handles);

    // Another tab does not see the first tab's variable.
    let handles = bench
        .run_on("tab-2", "SELECT @base IS NULL AS unset")
        .await
        .expect("runs");
    assert!(format!("{:?}", bench.rows(&handles[0])).contains('1'));
    bench.release(&handles);

    // A failing script on a session: the handles before it, the open
    // transaction, and no table for the statement that failed.
    let err = bench
        .run_on(
            "tab-1",
            "BEGIN; SELECT n FROM rs_seq WHERE n <= 4 ORDER BY n; SELECT * FROM rs_no_such_table",
        )
        .await
        .expect_err("the third statement fails");
    let (handles, reported) = completed_handles(&err);
    assert_eq!(reported.statement_index, Some(2));
    assert_eq!(reported.transaction, Some(TransactionState::Open));
    assert_eq!(handles.len(), 2);
    assert_eq!(handles[1].row_count, 4);
    assert_eq!(bench.tables(), 1);
    bench.release(&handles);
    assert_eq!(bench.tables(), 0);

    // Off a session there is no transaction state to report.
    let handles = bench.run("SELECT 1", None, None).await.expect("runs");
    assert_eq!(handles[0].transaction, None);
    bench.release(&handles);

    bench.manager.close_session(&bench.id, "tab-1").await;
    bench.manager.close_session(&bench.id, "tab-2").await;
    bench.setup(&["DROP TABLE rs_session"]).await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: just test-integration"]
async fn a_read_only_connection_refuses_a_write_before_anything_is_stored() {
    let mut profile = test_profile();
    profile.read_only = true;
    let bench = bench_with(profile, 64 * MIB).await;

    let err = bench
        .run("SELECT 1; DELETE FROM rs_seq", None, None)
        .await
        .expect_err("refused whole");
    assert!(matches!(err, CoreError::ReadOnly(_)), "got {err:?}");
    assert_eq!(bench.tables(), 0);
    assert!(bench.run("", None, None).await.expect("empty").is_empty());
}
