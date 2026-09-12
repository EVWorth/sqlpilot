use chrono::Utc;
use mas_core::backup::{run_backup, BackupOptions};
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// The streaming dump, against a live server.
///
/// The dump used to be built in the renderer as one JavaScript string and
/// handed across IPC at the end, reading rows with `LIMIT/OFFSET` against the
/// pool (#358). Nothing tested the output at all, which is how it came to
/// format every DATETIME through the grid's value type and quietly drop the
/// fractional seconds from every backup.
fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "backup-dump".to_string(),
        group: None,
        color: None,
        host: "127.0.0.1".to_string(),
        // MySQL by default; `MAS_TEST_PORT=13308` runs the same tests against
        // MariaDB, where `information_schema` and `SHOW CREATE` diverge most.
        port: std::env::var("MAS_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(13306),
        username: "root".to_string(),
        password: "test_root_password".to_string(),
        default_database: Some("test_db".to_string()),
        ssh_config: None,
        ssl_config: None,
        pool_min: 1,
        pool_max: 4,
        read_only: false,
        connect_timeout_secs: None,
        query_timeout_secs: None,
        charset: None,
        environment: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

const DB: &str = "backup_dump_probe";

async fn run(pool: &sqlx::MySqlPool, statements: &[String]) {
    for statement in statements {
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement.clone()))
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("{statement}: {e}"));
    }
}

/// A database with one of everything that has ever been got wrong.
async fn seed(pool: &sqlx::MySqlPool) {
    run(
        pool,
        &[
            format!("DROP DATABASE IF EXISTS `{DB}`"),
            format!("CREATE DATABASE `{DB}`"),
            format!(
                "CREATE TABLE `{DB}`.`awkward` (
                   id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                   quoted VARCHAR(255),
                   exact DECIMAL(30,10),
                   big BIGINT,
                   moment DATETIME(6),
                   raw VARBINARY(16),
                   nothing VARCHAR(16),
                   PRIMARY KEY (id)
                 ) ENGINE=InnoDB"
            ),
            format!(
                "INSERT INTO `{DB}`.`awkward` (quoted, exact, big, moment, raw, nothing) VALUES
                   ('x'', 1); DROP TABLE victim; -- ', 1.0000000001, 9223372036854775807,
                    '2026-09-03 11:22:33.123456', 0x00FF10, NULL),
                   ('plain', -0.0000000001, -9223372036854775808,
                    '2000-01-01 00:00:00.000001', 0x27, 'here')"
            ),
            format!("CREATE VIEW `{DB}`.`a_view` AS SELECT id, quoted FROM `{DB}`.`awkward`"),
            format!("CREATE PROCEDURE `{DB}`.`recalc`() BEGIN SET @a = 1; SET @b = 2; END"),
            format!(
                "CREATE TRIGGER `{DB}`.`stamp` BEFORE INSERT ON `{DB}`.`awkward`
                 FOR EACH ROW SET NEW.nothing = COALESCE(NEW.nothing, 'auto')"
            ),
        ],
    )
    .await;
}

async fn dump(options: BackupOptions) -> (String, mas_core::backup::BackupSummary) {
    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    seed(&pool).await;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dump.sql");
    let summary = run_backup(
        manager.clone(),
        &info.id,
        DB,
        &["awkward".to_string()],
        &options,
        &path,
        Arc::new(AtomicBool::new(false)),
        |_| {},
    )
    .await
    .expect("the dump should succeed");

    let sql = tokio::fs::read_to_string(&path).await.unwrap();
    manager.disconnect(&info.id).await.unwrap();
    (sql, summary)
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn values_are_written_exactly_as_the_server_printed_them() {
    let (sql, summary) = dump(BackupOptions::default()).await;

    // The whole reason the dump formats from raw bytes rather than from a
    // decoded value.
    assert!(
        sql.contains("2026-09-03 11:22:33.123456"),
        "a DATETIME(6) lost its fractional seconds:\n{sql}"
    );
    assert!(
        sql.contains("9223372036854775807"),
        "a BIGINT was rounded:\n{sql}"
    );
    assert!(
        sql.contains("1.0000000001"),
        "a DECIMAL went through a float:\n{sql}"
    );
    assert!(
        sql.contains("X'00ff10'"),
        "binary was not written as hex:\n{sql}"
    );
    assert!(sql.contains("NULL"), "a NULL was not written as NULL");
    assert_eq!(summary.rows_exported, 2);
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_hostile_value_is_data_in_the_file_and_stays_data_on_restore() {
    // Without the routines and triggers, because DELIMITER is a client
    // directive that the server itself does not parse — the restore dialog
    // handles those, and this test is about the data.
    let (sql, _) = dump(BackupOptions {
        include_routines: false,
        include_triggers: false,
        ..Default::default()
    })
    .await;

    // The value that dropped a table through the old `\'` escaping (#285).
    assert!(
        sql.contains("'x'', 1); DROP TABLE victim; -- '"),
        "the quote was not doubled:\n{sql}"
    );
    assert!(!sql.contains("\\', 1); DROP TABLE"));

    // And the proof: restore it into a fresh database on a server in the mode
    // where the backslash form breaks out, with a table for it to drop.
    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    let target = format!("{DB}_restored");
    run(
        &pool,
        &[
            format!("DROP DATABASE IF EXISTS `{target}`"),
            format!("CREATE DATABASE `{target}`"),
            format!("CREATE TABLE `{target}`.`victim` (id INT)"),
            format!("SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES'"),
        ],
    )
    .await;

    let mut conn = pool.acquire().await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES'; USE `{target}`; {sql}"
    )))
    .execute(&mut *conn)
    .await
    .expect("the dump should restore under NO_BACKSLASH_ESCAPES");
    drop(conn);

    let victims: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'victim'",
    )
    .bind(&target)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(victims, 1, "restoring the dump dropped a table");

    let round_tripped: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT quoted FROM `{target}`.`awkward` WHERE quoted LIKE 'x%'"
    )))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(round_tripped, "x', 1); DROP TABLE victim; -- ");

    run(&pool, &[format!("DROP DATABASE IF EXISTS `{target}`")]).await;
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn the_dump_carries_views_routines_and_triggers() {
    let (sql, _) = dump(BackupOptions::default()).await;

    // A backup that silently leaves out the routines is not a backup.
    assert!(
        sql.contains("CREATE") && sql.contains("`a_view`"),
        "no view:\n{sql}"
    );
    assert!(
        sql.contains("PROCEDURE `recalc`") || sql.contains("recalc"),
        "no routine"
    );
    assert!(sql.contains("stamp"), "no trigger");
    // A routine body full of semicolons needs its own delimiter around it.
    assert!(sql.contains("DELIMITER ;;"));
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn structure_only_writes_no_rows_and_data_only_writes_no_ddl() {
    let (structure, _) = dump(BackupOptions {
        include_data: false,
        ..Default::default()
    })
    .await;
    assert!(structure.contains("CREATE TABLE"));
    assert!(!structure.contains("INSERT INTO"));

    let (data, _) = dump(BackupOptions {
        include_structure: false,
        include_views: false,
        include_routines: false,
        include_triggers: false,
        ..Default::default()
    })
    .await;
    assert!(data.contains("INSERT INTO"));
    assert!(!data.contains("CREATE TABLE"));
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn dropping_the_auto_increment_keeps_the_column_that_generates_it() {
    let (sql, _) = dump(BackupOptions {
        include_auto_increment: false,
        ..Default::default()
    })
    .await;
    assert!(
        !sql.contains("AUTO_INCREMENT="),
        "the table-level counter survived:\n{sql}"
    );
    assert!(
        sql.contains("AUTO_INCREMENT"),
        "the column keyword was stripped too, so the restored table has no key:\n{sql}"
    );
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn one_insert_per_row_when_that_is_what_was_asked_for() {
    let (batched, _) = dump(BackupOptions::default()).await;
    assert_eq!(
        batched.matches("INSERT INTO").count(),
        1,
        "two rows, one statement"
    );

    let (single, _) = dump(BackupOptions {
        multi_row_inserts: false,
        ..Default::default()
    })
    .await;
    assert_eq!(single.matches("INSERT INTO").count(), 2);
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_cancelled_backup_leaves_no_file_behind() {
    // A partial dump that looks like a dump is how someone restores half a
    // database a month later.
    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    seed(&pool).await;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cancelled.sql");
    let cancel = Arc::new(AtomicBool::new(true));

    let summary = run_backup(
        manager.clone(),
        &info.id,
        DB,
        &["awkward".to_string()],
        &BackupOptions::default(),
        &path,
        cancel,
        |_| {},
    )
    .await
    .unwrap();

    assert!(summary.cancelled);
    assert!(!path.exists(), "the partial file is still there");
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn progress_is_reported_while_a_table_is_being_read() {
    // Progress used to be emitted once per table, so a single large table
    // showed nothing from the first row to the last (#361).
    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    seed(&pool).await;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("progress.sql");
    let mut seen = Vec::new();
    run_backup(
        manager.clone(),
        &info.id,
        DB,
        &["awkward".to_string()],
        &BackupOptions::default(),
        &path,
        Arc::new(AtomicBool::new(false)),
        |p| seen.push(p),
    )
    .await
    .unwrap();

    assert!(!seen.is_empty(), "no progress at all");
    assert!(
        seen.iter().any(|p| p.rows_exported > 0),
        "every report said zero rows"
    );
    assert!(
        seen.iter().any(|p| p.estimated_rows.is_some()),
        "no row estimate, so the dialog cannot say how much is left"
    );
    assert!(
        seen.iter().any(|p| p.table_name == "awkward"),
        "no report named the table being read"
    );
    // The later phases report too, so the dialog does not look stuck while
    // the views and routines are read.
    assert!(seen.iter().any(|p| p.phase.contains("triggers")));
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn the_file_ends_with_the_marker_that_says_it_finished() {
    let (sql, summary) = dump(BackupOptions::default()).await;
    // A file without this was interrupted, whatever its size.
    assert!(sql
        .trim_end()
        .ends_with(|c: char| c.is_ascii_digit() || c == 'Z' || c == ':'));
    assert!(sql.contains("-- Backup completed:"));
    assert!(summary.bytes_written as usize >= sql.len());
    assert!(summary.warnings.is_empty(), "{:?}", summary.warnings);
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn the_snapshot_transaction_does_not_outlive_the_dump() {
    // The dump reads inside START TRANSACTION WITH CONSISTENT SNAPSHOT. Left
    // open, the connection goes back to the pool still reading the database
    // as it was, and the next caller to get it sees a stale schema — which
    // surfaces much later, somewhere else, as "Table definition has changed,
    // please retry transaction".
    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    seed(&pool).await;

    let dir = tempfile::tempdir().unwrap();
    run_backup(
        manager.clone(),
        &info.id,
        DB,
        &["awkward".to_string()],
        &BackupOptions::default(),
        &dir.path().join("dump.sql"),
        Arc::new(AtomicBool::new(false)),
        |_| {},
    )
    .await
    .unwrap();

    // Change the schema, then read it back on every pooled connection. A
    // session still inside the snapshot answers with the old definition or
    // refuses outright.
    run(
        &pool,
        &[format!(
            "ALTER TABLE `{DB}`.`awkward` ADD COLUMN added_later INT"
        )],
    )
    .await;

    for _ in 0..4 {
        let columns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'awkward'",
        )
        .bind(DB)
        .fetch_one(&pool)
        .await
        .expect("a connection was left inside the dump's transaction");
        assert_eq!(
            columns, 8,
            "a pooled connection is still on the old snapshot"
        );
    }

    manager.disconnect(&info.id).await.unwrap();
}
