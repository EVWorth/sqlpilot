//! Whether ordinary use gives its pooled connections back.
//!
//! Written to chase a report of a five-connection pool filling up during
//! normal use. It did not reproduce that — the paths here all return what they
//! take — but it is worth keeping, because a leak of one connection per action
//! is invisible until the pool is empty and then looks like a server problem.
//!
//! The settle is the point. `num_idle` does not update the instant a query
//! ends, so measuring immediately after an `await` shows a connection still
//! out and reads exactly like a leak. It cost me an hour and a wrong diagnosis;
//! anything asserting on pool counts has to wait first.
//!
//! `just db-up` first; ignored by default like the other live tests.

use std::sync::Arc;

use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use mas_core::query::QueryExecutor;
use mas_core::schema::SchemaInspector;

fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "pool-repro".to_string(),
        host: "127.0.0.1".to_string(),
        port: std::env::var("MAS_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(13308),
        username: "root".to_string(),
        password: "test_root_password".to_string(),
        default_database: Some("test_db".to_string()),
        pool_min: 1,
        // The default, and the number in the report.
        pool_max: 5,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        ..Default::default()
    }
}

/// `(held, idle)` after giving the pool a moment to take its connections back.
///
/// Without the wait this reports connections as held that are merely on their
/// way home, which is a false leak every time.
async fn census(pool: &sqlx::MySqlPool) -> (u32, usize) {
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    (pool.size(), pool.num_idle())
}

#[tokio::test]
#[ignore = "needs a live MariaDB: just db-up"]
async fn ordinary_use_gives_its_connections_back() {
    keyring_core::set_default_store(keyring_core::mock::Store::new().unwrap());

    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile()).await.expect("connects");
    let pool = manager.get_pool(&info.id).unwrap();

    let inspector = SchemaInspector::new(manager.clone());
    let executor = QueryExecutor::new(manager.clone());

    let (held, idle) = census(&pool).await;
    println!("after connect:            held={held} idle={idle}");

    // The things the app does when someone is simply using it, several times
    // over, because a leak of one per action only shows up after a few.
    for round in 1..=6 {
        let _ = inspector.get_databases(&info.id).await;
        let _ = inspector.get_tables(&info.id, "test_db").await;
        let _ = executor
            .execute(
                &info.id,
                "SELECT 1",
                Some("test_db".to_string()),
                None,
                None,
            )
            .await;

        let (held, idle) = census(&pool).await;
        println!("after round {round}:            held={held} idle={idle}");
        assert_eq!(
            idle as u32,
            held,
            "round {round}: {} of {held} connections are still out after the work finished",
            held - idle as u32
        );
    }

    let (held, idle) = census(&pool).await;
    println!("final:                    held={held} idle={idle}");
    assert!(
        idle as u32 == held,
        "{} of {held} connections are still held after everything finished",
        held - idle as u32
    );
}

/// Is the connection genuinely held, or merely in flight when we looked?
///
/// The control is a pool built by sqlx directly with the same sizing. If the
/// app's pool differs from it, the difference is the app's doing.
#[tokio::test]
#[ignore = "needs a live MariaDB: just db-up"]
async fn connect_does_not_keep_a_connection_checked_out() {
    keyring_core::set_default_store(keyring_core::mock::Store::new().unwrap());

    let control = sqlx::mysql::MySqlPoolOptions::new()
        .min_connections(1)
        .max_connections(5)
        .connect(&format!(
            "mysql://root:test_root_password@127.0.0.1:{}/test_db",
            std::env::var("MAS_TEST_PORT").unwrap_or_else(|_| "13308".into())
        ))
        .await
        .expect("control pool connects");
    sqlx::query("SELECT 1").fetch_one(&control).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    println!(
        "control  (plain sqlx):    held={} idle={}",
        control.size(),
        control.num_idle()
    );

    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile()).await.expect("connects");
    let pool = manager.get_pool(&info.id).unwrap();

    // Long enough that anything merely in flight has finished.
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let (held, idle) = census(&pool).await;
    println!("app pool, 3s after connect: held={held} idle={idle}");

    assert_eq!(
        idle as u32,
        held,
        "{} connection(s) still checked out {} seconds after connect finished",
        held - idle as u32,
        3
    );
}

/// The same question for a staged write, which detaches its connection.
#[tokio::test]
#[ignore = "needs a live MariaDB: just db-up"]
async fn a_staged_write_does_not_cost_the_pool_a_connection() {
    use mas_core::query::staged::StagedWrite;

    keyring_core::set_default_store(keyring_core::mock::Store::new().unwrap());

    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile()).await.expect("connects");
    let pool = manager.get_pool(&info.id).unwrap();

    sqlx::raw_sql(sqlx::AssertSqlSafe(
        "CREATE TABLE IF NOT EXISTS test_db.pool_repro (id INT PRIMARY KEY)".to_string(),
    ))
    .execute(&pool)
    .await
    .unwrap();

    for round in 1..=6 {
        let staged = StagedWrite::begin(
            &pool,
            Some("test_db"),
            "UPDATE pool_repro SET id = id WHERE id = -1",
            std::time::Duration::from_secs(120),
        )
        .await;
        match staged {
            Ok(write) => write.rollback().await.expect("rolls back"),
            Err(e) => panic!("round {round}: could not stage: {e:?}"),
        }
        let (held, idle) = census(&pool).await;
        println!("after staged round {round}:     held={held} idle={idle}");
    }

    let (held, idle) = census(&pool).await;
    assert_eq!(
        idle as u32,
        held,
        "after six staged writes, {} of {held} connections are still out — a staged write \
         detaches its connection, so the pool should have replaced it",
        held - idle as u32
    );
}
