//! How much memory one result costs the backend, measured (#967).
//!
//! Not a pass/fail test: each case prints the process's resident memory at
//! the points where a copy of the result exists, so a change to how results
//! travel has a number to beat. Run one case per process, since peak memory
//! is per process:
//!
//! ```text
//! cargo test -p mas-core --release --test memory_baseline -- --ignored --exact narrow_100k --nocapture
//! ```
//!
//! Each workload has a second case, `*_store`, that runs it into the result
//! store instead (`run_owned`) and prints the same lines, so the two can be
//! read side by side. There the "IPC JSON" is what one screen of the grid
//! costs: the handles plus a window of 200 rows.
use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::{ConnectionProfile, SqlValue};
use mas_core::query::QueryExecutor;
use mas_core::results::{ResultStore, WindowRequest};
use std::sync::Arc;
use std::time::Instant;

fn test_profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Memory baseline".to_string(),
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

/// Resident and peak resident memory of this process, in MB.
fn memory_mb() -> (f64, f64) {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let field = |name: &str| {
        status
            .lines()
            .find(|l| l.starts_with(name))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|kb| kb.parse::<f64>().ok())
            .map_or(0.0, |kb| kb / 1024.0)
    };
    (field("VmRSS:"), field("VmHWM:"))
}

/// The bytes of cell data in a result: what the rows would cost if each
/// value were stored once with no overhead.
fn payload_bytes(rows: &[Vec<SqlValue>]) -> usize {
    rows.iter()
        .flatten()
        .map(|v| match v {
            SqlValue::Null => 0,
            SqlValue::Bool(_) => 1,
            SqlValue::Int(_) | SqlValue::UInt(_) | SqlValue::Float(_) => 8,
            SqlValue::String(s) => s.len(),
            SqlValue::Bytes(b) => b.len(),
        })
        .sum()
}

async fn measure(label: &str, setup: &[&str], query: &str) {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();
    let db = || Some("test_db".to_string());
    for statement in setup {
        executor
            .execute(&info.id, statement, db(), None, None)
            .await
            .unwrap_or_else(|e| panic!("setup failed: {statement}: {e}"));
    }

    let (idle, _) = memory_mb();
    let results = executor
        .execute(&info.id, query, db(), None, None)
        .await
        .unwrap();
    let (fetched, fetched_peak) = memory_mb();
    let rows = &results[0].rows;
    let payload = payload_bytes(rows) as f64 / 1048576.0;

    // What Tauri does with a command's return value: the whole result as one
    // JSON string, built while the rows are still alive.
    let json = serde_json::to_string(&results).unwrap();
    let (serialized, serialized_peak) = memory_mb();

    // The same bytes the webview receives, for measuring its side.
    if let Ok(dir) = std::env::var("MEM_BASELINE_DUMP") {
        let name = label.split(',').next().unwrap_or(label).replace(' ', "_");
        std::fs::write(format!("{dir}/{name}.json"), &json).unwrap();
    }

    println!("== {label}");
    println!("rows                    {}", rows.len());
    println!("truncated               {:?}", results[0].truncation_reason);
    println!("cell data               {payload:8.1} MB");
    println!("idle RSS                {idle:8.1} MB");
    println!(
        "rows held               {:8.1} MB over idle (peak {:.1})",
        fetched - idle,
        fetched_peak - idle
    );
    println!(
        "IPC JSON                {:8.1} MB",
        json.len() as f64 / 1048576.0
    );
    println!(
        "rows + JSON held        {:8.1} MB over idle (peak {:.1})",
        serialized - idle,
        serialized_peak - idle
    );
    println!(
        "peak / cell data        {:8.1}x",
        (serialized_peak - idle) / payload
    );
}

/// Rows in the window the store-path cases serialise: a screen of the grid
/// and its margin.
const WINDOW_ROWS: u32 = 200;

/// The cell limit `result_window` applies.
const WINDOW_CELL_BYTES: u32 = 64 * 1024;

/// The same workload as [`measure`], written to the result store.
async fn measure_store(label: &str, setup: &[&str], query: &str) {
    let manager = Arc::new(ConnectionManager::new());
    let executor = QueryExecutor::new(manager.clone());
    let info = manager.connect(&test_profile()).await.unwrap();
    let db = || Some("test_db".to_string());
    for statement in setup {
        executor
            .execute(&info.id, statement, db(), None, None)
            .await
            .unwrap_or_else(|e| panic!("setup failed: {statement}: {e}"));
    }
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(ResultStore::open(dir.path(), 8 << 30).unwrap());

    let (idle, _) = memory_mb();
    let started = Instant::now();
    let handles = executor
        .run_owned(info.id.clone(), query.to_string(), db(), None, None, &store)
        .await
        .unwrap();
    let stored_in = started.elapsed();
    let (fetched, fetched_peak) = memory_mb();
    let handle = &handles[0];

    // What crosses IPC for one screen: the command's return value, then a
    // window. Both are built while the store is open, as in the app.
    let started = Instant::now();
    let window = store
        .window(
            &handle.result_id,
            &WindowRequest {
                count: WINDOW_ROWS,
                max_cell_bytes: WINDOW_CELL_BYTES,
                ..WindowRequest::default()
            },
        )
        .unwrap();
    let handles_json = serde_json::to_string(&handles).unwrap();
    let window_json = serde_json::to_string(&window).unwrap();
    let window_in = started.elapsed();
    let (serialized, serialized_peak) = memory_mb();
    let file_mb = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .map(|meta| meta.len())
        .sum::<u64>() as f64
        / 1048576.0;

    if let Ok(dump) = std::env::var("MEM_BASELINE_DUMP") {
        let name = label.split(',').next().unwrap_or(label).replace(' ', "_");
        std::fs::write(format!("{dump}/{name}.window.json"), &window_json).unwrap();
    }

    // Counted last, a thousand rows at a time, so that reading the result
    // back to measure it is not part of what is measured.
    let mut payload = 0usize;
    let mut offset = 0u64;
    while offset < handle.row_count {
        let page = store
            .window(
                &handle.result_id,
                &WindowRequest {
                    offset,
                    count: 1000,
                    max_cell_bytes: u32::MAX,
                    ..WindowRequest::default()
                },
            )
            .unwrap();
        let rows: Vec<Vec<SqlValue>> = page
            .rows
            .into_iter()
            .map(|cells| cells.into_iter().map(|cell| cell.value).collect())
            .collect();
        payload += payload_bytes(&rows);
        offset += 1000;
    }
    let payload = payload as f64 / 1048576.0;

    println!("== {label}, into the result store");
    println!("rows                    {}", handle.row_count);
    println!("truncated               {:?}", handle.truncation_reason);
    println!("cell data               {payload:8.1} MB");
    println!("idle RSS                {idle:8.1} MB");
    println!(
        "rows held               {:8.1} MB over idle (peak {:.1})",
        fetched - idle,
        fetched_peak - idle
    );
    println!(
        "IPC JSON                {:8.3} MB (handles {} bytes + a {}-row window {} bytes)",
        (handles_json.len() + window_json.len()) as f64 / 1048576.0,
        handles_json.len(),
        window.rows.len(),
        window_json.len()
    );
    println!(
        "rows + JSON held        {:8.1} MB over idle (peak {:.1})",
        serialized - idle,
        serialized_peak - idle
    );
    println!(
        "peak / cell data        {:8.1}x",
        (serialized_peak - idle) / payload
    );
    println!("store file              {file_mb:8.1} MB");
    println!(
        "stored in               {:8.0} ms",
        stored_in.as_secs_f64() * 1000.0
    );
    println!(
        "window read + JSON in   {:8.1} ms",
        window_in.as_secs_f64() * 1000.0
    );
}

const NARROW_SETUP: &[&str] = &[
    "DROP TABLE IF EXISTS mem_narrow",
    "CREATE TABLE mem_narrow (
        id INT PRIMARY KEY,
        name VARCHAR(40),
        email VARCHAR(60),
        created_at DATETIME,
        amount DECIMAL(10,2),
        active TINYINT(1),
        note VARCHAR(120)
    )",
    "INSERT INTO mem_narrow
     SELECT n, CONCAT('Customer ', n), CONCAT('customer', n, '@example.com'),
            NOW() - INTERVAL n MINUTE, n * 1.37, n % 2,
            CONCAT('Order note for customer ', n, ' with some ordinary text in it')
     FROM (SELECT 1 + a.d + b.d * 10 + c.d * 100 + e.d * 1000 + f.d * 10000 AS n
           FROM (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a
           CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b
           CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c
           CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) e
           CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) f) seq",
];

const BLOB_SETUP: &[&str] = &[
    "DROP TABLE IF EXISTS mem_blob",
    "CREATE TABLE mem_blob (id INT PRIMARY KEY, name VARCHAR(40), body LONGBLOB)",
    // 64 KB of random bytes repeated to 1 MB: binary, so it stays a BLOB
    // value rather than being read as text.
    "INSERT INTO mem_blob
     SELECT n, CONCAT('file-', n), REPEAT(RANDOM_BYTES(1024), 1024)
     FROM (SELECT 1 + a.d + b.d * 10 AS n
           FROM (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a
           CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b) seq",
];

#[tokio::test]
#[ignore = "a measurement, and it needs a live MySQL server"]
async fn narrow_100k() {
    measure(
        "100,000 narrow rows, 7 columns",
        NARROW_SETUP,
        "SELECT * FROM mem_narrow",
    )
    .await;
}

#[tokio::test]
#[ignore = "a measurement, and it needs a live MySQL server"]
async fn blob_100mb() {
    measure(
        "100 rows with a 1 MB BLOB each",
        BLOB_SETUP,
        "SELECT * FROM mem_blob",
    )
    .await;
}

#[tokio::test]
#[ignore = "a measurement, and it needs a live MySQL server"]
async fn narrow_100k_store() {
    measure_store(
        "100,000 narrow rows, 7 columns",
        NARROW_SETUP,
        "SELECT * FROM mem_narrow",
    )
    .await;
}

#[tokio::test]
#[ignore = "a measurement, and it needs a live MySQL server"]
async fn blob_100mb_store() {
    measure_store(
        "100 rows with a 1 MB BLOB each",
        BLOB_SETUP,
        "SELECT * FROM mem_blob",
    )
    .await;
}
