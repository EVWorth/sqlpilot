use chrono::Utc;
use mas_core::connection::ConnectionManager;
use mas_core::models::ConnectionProfile;
use mas_core::restore::{run_restore, RestoreOptions};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// Running a dump back in, against a live server.
///
/// The restore used to read the whole file into the renderer, split it there
/// and send back one statement per call — each on whichever pooled connection
/// it landed on, so `USE` and any session setting applied to a session the
/// next statement might not get (#359). A truncated stored program made the
/// splitter wait for a terminator that never came (#360).
fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: "restore-file".to_string(),
        group: None,
        color: None,
        host: "127.0.0.1".to_string(),
        // MySQL by default; `MAS_TEST_PORT=13308` runs the same tests against
        // MariaDB.
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
        // More than one, so a restore that depends on landing on the same
        // session fails here rather than in front of a user.
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

const DB: &str = "restore_file_probe";

async fn fresh(pool: &sqlx::MySqlPool) {
    for statement in [
        format!("DROP DATABASE IF EXISTS `{DB}`"),
        format!("CREATE DATABASE `{DB}`"),
    ] {
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement.clone()))
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("{statement}: {e}"));
    }
}

struct Harness {
    manager: Arc<ConnectionManager>,
    connection_id: String,
    pool: sqlx::MySqlPool,
    dir: tempfile::TempDir,
}

async fn harness() -> Harness {
    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&profile()).await.unwrap();
    let pool = manager.get_pool(&info.id).unwrap();
    fresh(&pool).await;
    Harness {
        manager,
        connection_id: info.id,
        pool,
        dir: tempfile::tempdir().unwrap(),
    }
}

impl Harness {
    async fn restore(
        &self,
        sql: &str,
        options: RestoreOptions,
    ) -> mas_core::restore::RestoreSummary {
        let path = self
            .dir
            .path()
            .join(format!("{}.sql", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, sql).await.unwrap();
        run_restore(
            self.manager.clone(),
            &self.connection_id,
            DB,
            &path,
            &options,
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .await
        .expect("the restore itself should not fail")
    }

    async fn tables(&self) -> Vec<String> {
        sqlx::query_scalar("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME")
            .bind(DB)
            .fetch_all(&self.pool)
            .await
            .unwrap()
    }

    async fn done(self) {
        let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS `{DB}`"
        )))
        .execute(&self.pool)
        .await;
        self.manager.disconnect(&self.connection_id).await.unwrap();
    }
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_dump_restores_onto_one_session() {
    // Every statement used to get its own pooled connection, so the `USE`
    // that opened the database was not guaranteed to apply to the next one.
    let h = harness().await;
    let summary = h
        .restore(
            "CREATE TABLE parts (id INT PRIMARY KEY, name VARCHAR(20));\n\
             INSERT INTO parts VALUES (1, 'bolt'), (2, 'nut');\n\
             CREATE TABLE spare (id INT);\n",
            RestoreOptions::default(),
        )
        .await;

    assert_eq!(summary.statements_failed, 0, "{:?}", summary.errors);
    assert_eq!(summary.statements_run, 3);
    assert_eq!(h.tables().await, vec!["parts", "spare"]);

    let names: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT name FROM `{DB}`.parts ORDER BY id"
    )))
    .fetch_all(&h.pool)
    .await
    .unwrap();
    assert_eq!(names, vec!["bolt", "nut"]);
    h.done().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_stored_program_restores_whole() {
    let h = harness().await;
    let summary = h
        .restore(
            "DELIMITER ;;\n\
             CREATE PROCEDURE recalc() BEGIN SET @a = 1; SET @b = 2; END ;;\n\
             DELIMITER ;\n",
            RestoreOptions::default(),
        )
        .await;

    assert_eq!(summary.statements_failed, 0, "{:?}", summary.errors);
    let routines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?",
    )
    .bind(DB)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(routines, 1, "the procedure was split at its internal ;");
    h.done().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_truncated_stored_program_reports_rather_than_hanging() {
    // The case that used to wait forever for a terminator (#360).
    let h = harness().await;
    let summary = h
        .restore(
            "CREATE TABLE t (id INT);\n\
             DELIMITER ;;\n\
             CREATE PROCEDURE half() BEGIN SET @a = 1;",
            RestoreOptions::default(),
        )
        .await;

    assert_eq!(summary.statements_failed, 1);
    assert!(
        summary.errors[0].contains("truncated"),
        "the error should say the file is cut short: {:?}",
        summary.errors
    );
    // And it says the earlier statements did apply, which is what the user
    // has to know before running it again.
    assert!(summary.partially_applied);
    h.done().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn stopping_at_the_first_error_says_what_had_already_applied() {
    let h = harness().await;
    let summary = h
        .restore(
            "CREATE TABLE good (id INT);\n\
             INSERT INTO good VALUES (1);\n\
             INSERT INTO good VALUES (1, 2, 3);\n\
             CREATE TABLE never (id INT);\n",
            RestoreOptions::default(),
        )
        .await;

    assert_eq!(summary.statements_failed, 1);
    assert_eq!(summary.statements_run, 2, "it should have stopped");
    // The table survives the rollback because DDL commits as it runs. Saying
    // "rolled back" without saying that would be a lie.
    assert!(summary.partially_applied);
    assert!(h.tables().await.contains(&"good".to_string()));
    assert!(!h.tables().await.contains(&"never".to_string()));
    h.done().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_data_only_restore_rolls_back_completely() {
    // Where a transaction does buy something: no DDL, so nothing has
    // committed before the failure.
    let h = harness().await;
    h.restore(
        "CREATE TABLE rows_only (id INT PRIMARY KEY);",
        RestoreOptions::default(),
    )
    .await;

    let summary = h
        .restore(
            "INSERT INTO rows_only VALUES (1);\n\
             INSERT INTO rows_only VALUES (2);\n\
             INSERT INTO rows_only VALUES (1);\n",
            RestoreOptions::default(),
        )
        .await;

    assert_eq!(summary.statements_failed, 1);
    assert!(summary.rolled_back);
    assert!(
        !summary.partially_applied,
        "a data-only file that failed should leave nothing behind"
    );
    let count: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM `{DB}`.rows_only"
    )))
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(count, 0, "the rows before the failure were not rolled back");
    h.done().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn carrying_on_past_errors_runs_the_rest_of_the_file() {
    let h = harness().await;
    let summary = h
        .restore(
            "CREATE TABLE a (id INT);\n\
             INSERT INTO a VALUES (1, 2);\n\
             CREATE TABLE b (id INT);\n",
            RestoreOptions {
                stop_on_error: false,
                ..Default::default()
            },
        )
        .await;

    assert_eq!(summary.statements_failed, 1);
    assert_eq!(summary.statements_run, 2);
    assert_eq!(h.tables().await, vec!["a", "b"]);
    h.done().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn rows_land_in_a_child_table_before_its_parent_exists() {
    // What turning the foreign-key checks off is for: a file whose tables are
    // in the wrong order restores anyway, which is how mysqldump's own output
    // is meant to be loaded.
    let h = harness().await;
    let summary = h
        .restore(
            "CREATE TABLE child (id INT PRIMARY KEY, parent_id INT,
               CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES parent (id));\n\
             CREATE TABLE parent (id INT PRIMARY KEY);\n\
             INSERT INTO child VALUES (1, 10);\n\
             INSERT INTO parent VALUES (10);\n",
            RestoreOptions::default(),
        )
        .await;

    assert_eq!(summary.statements_failed, 0, "{:?}", summary.errors);
    h.done().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn the_checks_are_back_on_when_the_restore_ends() {
    // A session left with foreign_key_checks off would silently accept
    // orphans for every later query on that connection.
    let h = harness().await;
    h.restore("CREATE TABLE t (id INT);", RestoreOptions::default())
        .await;

    // The pool hands the same connection back; ask every one of them.
    for _ in 0..4 {
        let on: i64 = sqlx::query_scalar("SELECT @@SESSION.foreign_key_checks")
            .fetch_one(&h.pool)
            .await
            .unwrap();
        assert_eq!(on, 1, "a connection was left with the checks off");
    }
    h.done().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn progress_reports_bytes_against_the_size_of_the_file() {
    let h = harness().await;
    let sql: String = (0..200)
        .map(|i| format!("CREATE TABLE t{i} (id INT);\n"))
        .collect();
    let path = h.dir.path().join("many.sql");
    tokio::fs::write(&path, &sql).await.unwrap();

    let mut seen = Vec::new();
    let summary = run_restore(
        h.manager.clone(),
        &h.connection_id,
        DB,
        &path,
        &RestoreOptions::default(),
        Arc::new(AtomicBool::new(false)),
        |p| seen.push(p),
    )
    .await
    .unwrap();

    assert_eq!(summary.statements_run, 200);
    assert!(!seen.is_empty());
    let last = seen.last().unwrap();
    assert_eq!(last.total_bytes, sql.len() as u64);
    assert_eq!(last.bytes_read, sql.len() as u64);
    h.done().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_read_only_connection_refuses_a_restore() {
    let mut p = profile();
    p.read_only = true;
    let manager = Arc::new(ConnectionManager::new());
    let info = manager.connect(&p).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("x.sql");
    tokio::fs::write(&path, "CREATE TABLE nope (id INT);")
        .await
        .unwrap();

    let err = run_restore(
        manager.clone(),
        &info.id,
        "test_db",
        &path,
        &RestoreOptions::default(),
        Arc::new(AtomicBool::new(false)),
        |_| {},
    )
    .await
    .expect_err("a read-only connection cannot be restored onto");
    assert!(err.to_string().to_lowercase().contains("read-only"));
    manager.disconnect(&info.id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_database_survives_a_round_trip_through_a_dump() {
    // The test the audit asked for and nothing did: dump a database, restore
    // it somewhere else, and compare. Every other test here checks one part
    // of that; this is the one that would catch the parts nobody thought of.
    use mas_core::backup::{run_backup, BackupOptions};

    let h = harness().await;
    let source = format!("{DB}_source");
    let target = format!("{DB}_target");

    for statement in [
        format!("DROP DATABASE IF EXISTS `{source}`"),
        format!("DROP DATABASE IF EXISTS `{target}`"),
        format!("CREATE DATABASE `{source}`"),
        format!("CREATE DATABASE `{target}`"),
        format!(
            "CREATE TABLE `{source}`.`things` (
               id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
               label VARCHAR(64),
               exact DECIMAL(20,8),
               moment DATETIME(6),
               blob_col VARBINARY(8),
               PRIMARY KEY (id)
             )"
        ),
        format!(
            "INSERT INTO `{source}`.`things` (label, exact, moment, blob_col) VALUES
               ('it''s here', 12345.67890123, '2026-09-03 11:22:33.123456', 0x00FF),
               (NULL, -0.00000001, '1999-12-31 23:59:59.999999', 0x27),
               ('café 日本', 0, '2000-01-01 00:00:00.000000', NULL)"
        ),
    ] {
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement.clone()))
            .execute(&h.pool)
            .await
            .unwrap_or_else(|e| panic!("{statement}: {e}"));
    }

    let path = h.dir.path().join("roundtrip.sql");
    run_backup(
        h.manager.clone(),
        &h.connection_id,
        &source,
        &["things".to_string()],
        &BackupOptions::default(),
        &path,
        Arc::new(AtomicBool::new(false)),
        |_| {},
    )
    .await
    .unwrap();

    let summary = run_restore(
        h.manager.clone(),
        &h.connection_id,
        &target,
        &path,
        &RestoreOptions::default(),
        Arc::new(AtomicBool::new(false)),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(summary.statements_failed, 0, "{:?}", summary.errors);

    // Not a row count: a checksum over every column of every row, so a value
    // that came back subtly different — a rounded DECIMAL, a DATETIME missing
    // its microseconds — fails here rather than looking identical.
    let digest = |db: &str| {
        let sql = format!(
            "SELECT MD5(GROUP_CONCAT(
                 COALESCE(id,'~'), '|', COALESCE(label,'~'), '|',
                 COALESCE(exact,'~'), '|', COALESCE(moment,'~'), '|',
                 COALESCE(HEX(blob_col),'~')
                 ORDER BY id SEPARATOR '#'))
             FROM `{db}`.`things`"
        );
        sqlx::query_scalar::<_, Option<String>>(sqlx::AssertSqlSafe(sql)).fetch_one(&h.pool)
    };
    let before: Option<String> = digest(&source).await.unwrap();
    let after: Option<String> = digest(&target).await.unwrap();
    assert!(before.is_some());
    assert_eq!(before, after, "the data changed on the way through");

    // And the structure, which is what a restored backup is for.
    let columns = |db: &str| {
        sqlx::query_scalar::<_, String>(
            "SELECT GROUP_CONCAT(CONCAT_WS(':', COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA)
                     ORDER BY ORDINAL_POSITION)
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'things'",
        )
        .bind(db.to_string())
        .fetch_one(&h.pool)
    };
    assert_eq!(
        columns(&source).await.unwrap(),
        columns(&target).await.unwrap()
    );

    for db in [&source, &target] {
        let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS `{db}`"
        )))
        .execute(&h.pool)
        .await;
    }
    h.done().await;
}

#[tokio::test]
#[ignore = "needs a live MySQL/MariaDB server: make test-integration"]
async fn a_commit_that_cannot_happen_is_reported_as_a_failure() {
    // The transaction's own outcome used to be ignored, so a restore could
    // report "complete — 400 statements" with nothing committed. Provoked
    // here by killing the session between the last statement and the commit.
    let h = harness().await;
    h.restore("CREATE TABLE t (id INT);", RestoreOptions::default())
        .await;

    // A restore whose connection is cut mid-run: the statements are gone and
    // the summary has to say so rather than counting them as applied.
    let path = h.dir.path().join("big.sql");
    let statements: String = (0..200)
        .map(|i| format!("INSERT INTO t VALUES ({i});\n"))
        .collect();
    tokio::fs::write(&path, &statements).await.unwrap();

    let killer = {
        let pool = h.pool.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            // Every session but this one's own.
            let ids: Vec<i64> = sqlx::query_scalar(
                "SELECT ID FROM information_schema.PROCESSLIST
                 WHERE USER = 'root' AND ID <> CONNECTION_ID() AND INFO LIKE 'INSERT%'",
            )
            .fetch_all(&pool)
            .await
            .unwrap_or_default();
            for id in ids {
                let _ = sqlx::query(sqlx::AssertSqlSafe(format!("KILL {id}")))
                    .execute(&pool)
                    .await;
            }
        })
    };

    let summary = run_restore(
        h.manager.clone(),
        &h.connection_id,
        DB,
        &path,
        &RestoreOptions {
            stop_on_error: false,
            ..Default::default()
        },
        Arc::new(AtomicBool::new(false)),
        |_| {},
    )
    .await;
    let _ = killer.await;

    // Either the run itself failed, or it finished and reported the failure —
    // what must not happen is a clean summary over a database that did not
    // receive the rows.
    match summary {
        Err(_) => {}
        Ok(s) => {
            let rows: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "SELECT COUNT(*) FROM `{DB}`.t"
            )))
            .fetch_one(&h.pool)
            .await
            .unwrap_or(0);
            if rows == 0 {
                assert!(
                    s.statements_failed > 0,
                    "nothing was written and nothing was reported: {s:?}"
                );
            }
        }
    }

    h.done().await;
}
