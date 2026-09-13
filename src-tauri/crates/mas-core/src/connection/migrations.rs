use rusqlite::Connection as SqliteConn;

/// One versioned schema migration. `up` is the SQL to apply when
/// `PRAGMA user_version` is below `v`. The migration is run inside
/// a transaction. If any statement fails the whole migration rolls
/// back.
#[derive(Debug, Clone)]
pub struct Migration {
    pub v: i64,
    pub name: &'static str,
    pub up: &'static str,
}

/// All migrations in order. Append new entries; do not renumber existing
/// ones. `PRAGMA user_version` is the cursor.
///
/// Initial schema (v1) is the original `connection_profiles` shape.
/// Migrations v2..v5 add columns that were introduced post-launch; v6 adds
/// the agent grants table; v7 gives it per-connection redaction patterns.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        v: 1,
        name: "create_connection_profiles",
        up: "CREATE TABLE IF NOT EXISTS connection_profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            grp TEXT,
            color TEXT,
            host TEXT NOT NULL,
            port INTEGER NOT NULL DEFAULT 3306,
            username TEXT NOT NULL,
            password TEXT NOT NULL DEFAULT '',
            default_database TEXT,
            ssh_config TEXT,
            ssl_config TEXT,
            pool_min INTEGER NOT NULL DEFAULT 1,
            pool_max INTEGER NOT NULL DEFAULT 5,
            read_only INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
    },
    Migration {
        v: 2,
        name: "add_env_column",
        up: "ALTER TABLE connection_profiles ADD COLUMN env TEXT",
    },
    Migration {
        v: 3,
        name: "add_connect_timeout_secs",
        up: "ALTER TABLE connection_profiles ADD COLUMN connect_timeout_secs INTEGER",
    },
    Migration {
        v: 4,
        name: "add_query_timeout_secs",
        up: "ALTER TABLE connection_profiles ADD COLUMN query_timeout_secs INTEGER",
    },
    Migration {
        v: 5,
        name: "add_charset_column",
        up: "ALTER TABLE connection_profiles ADD COLUMN charset TEXT",
    },
    Migration {
        v: 6,
        name: "create_agent_grants",
        // Which connections the user has shared with an agent harness, and on
        // what terms. Separate from the profile because a grant is a statement
        // about agents, not about the connection, and deleting a profile
        // should take its grant with it — hence the cascade.
        up: "CREATE TABLE IF NOT EXISTS agent_grants (
            connection_id TEXT PRIMARY KEY
                REFERENCES connection_profiles(id) ON DELETE CASCADE,
            posture TEXT NOT NULL,
            databases TEXT
        )",
    },
    Migration {
        v: 7,
        name: "add_agent_grant_redact",
        // Column-name patterns this connection hides from agents, on top of
        // the built-in credential list. JSON, like `databases` above, because
        // it is a list and this table is read as a whole.
        up: "ALTER TABLE agent_grants ADD COLUMN redact TEXT",
    },
];

/// The latest schema version. Bump this when adding a new entry to
/// `MIGRATIONS` (the constant itself enforces ordering, but having
/// a single named source of truth is helpful for docs and tests).
pub const SCHEMA_VERSION: i64 = 7;

/// Whether a failure means the change is already in place.
///
/// Matched on the message because that is what rusqlite gives: SQLite reports
/// both of these as a generic error, with the detail only in the text. Narrow
/// on purpose — anything else is a real failure and must stay one.
fn already_applied(error: &rusqlite::Error) -> bool {
    let message = error.to_string();
    message.starts_with("duplicate column name:")
        || message.starts_with("index ") && message.ends_with(" already exists")
        || message.starts_with("table ") && message.ends_with(" already exists")
}

/// `PRAGMA user_version` reads 0 on a fresh DB (sqlite's default).
/// Migrations start firing at version 1.
///
/// Apply all migrations in `MIGRATIONS` whose version is greater than
/// the current `PRAGMA user_version`. Each migration runs inside a
/// transaction. On success, `user_version` is bumped to the new
/// version. Idempotent — re-running on an up-to-date DB is a no-op, and a
/// database that already has a migration's changes without the version to say
/// so is recorded rather than refused.
///
/// `up` is split on `;` and each non-empty statement is executed
/// individually. Sqlite doesn't support multiple statements in
/// `execute()` for DDL, so we split rather than `execute_batch` the
/// whole string (which works for SELECTs but is brittle for ALTER
/// statements).
pub fn run(conn: &SqliteConn) -> Result<i64, rusqlite::Error> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

    for m in MIGRATIONS {
        if m.v <= current {
            continue;
        }
        conn.execute_batch("BEGIN")?;
        for stmt in m.up.split(';') {
            let trimmed = stmt.trim();
            if trimmed.is_empty() {
                continue;
            }
            match conn.execute(trimmed, []) {
                Ok(_) => {}
                // A column this migration adds is already there. That is what
                // a database written before this framework existed looks like:
                // the old code ran the same `ALTER TABLE` at startup and never
                // recorded a version, so `user_version` sits at 1 with the
                // columns of version 5 already in place. Treating it as an
                // error stranded those users on an empty in-memory store with
                // their real connections still on disk, unreadable.
                Err(e) if already_applied(&e) => {
                    tracing::info!(
                        version = m.v,
                        name = m.name,
                        "Migration was already applied by an older version; recording it",
                    );
                }
                Err(e) => {
                    // Best-effort rollback. Even if the rollback fails,
                    // the next run will skip this migration if the
                    // partial state left the schema valid; the cursor
                    // will only advance on success.
                    let _ = conn.execute_batch("ROLLBACK");
                    tracing::error!(
                        version = m.v,
                        name = m.name,
                        error = %e,
                        "Migration failed",
                    );
                    return Err(e);
                }
            }
        }
        // Move the cursor. Done inside the same transaction so an
        // error during the SQL doesn't leave the cursor past a
        // half-applied migration.
        conn.execute(&format!("PRAGMA user_version = {}", m.v), [])?;
        conn.execute_batch("COMMIT")?;
        tracing::info!(version = m.v, name = m.name, "Applied migration");
    }

    Ok(SCHEMA_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection as SqliteConn;

    fn empty_db() -> SqliteConn {
        SqliteConn::open_in_memory().expect("open in-memory")
    }

    #[test]
    fn fresh_db_runs_all_migrations() {
        let conn = empty_db();
        let v = run(&conn).expect("run");
        assert_eq!(v, SCHEMA_VERSION);
        let cur: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cur, SCHEMA_VERSION);
    }

    #[test]
    fn existing_v3_db_applies_only_pending_migrations() {
        // Simulate a user at schema version 3: the table was created
        // with the v1 base schema, then env (v2) and connect_timeout
        // (v3) columns were added. They are upgrading to a build that
        // has v4 + v5 (query_timeout, charset). Those two new
        // migrations should apply cleanly; v1..v3 should not re-apply.
        let conn = empty_db();
        // v1
        conn.execute_batch(
            "CREATE TABLE connection_profiles (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, grp TEXT, color TEXT,
                host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 3306,
                username TEXT NOT NULL, password TEXT NOT NULL DEFAULT '',
                default_database TEXT, ssh_config TEXT, ssl_config TEXT,
                pool_min INTEGER NOT NULL DEFAULT 1,
                pool_max INTEGER NOT NULL DEFAULT 5,
                read_only INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            )",
        )
        .unwrap();
        // v2
        conn.execute("ALTER TABLE connection_profiles ADD COLUMN env TEXT", [])
            .unwrap();
        // v3
        conn.execute(
            "ALTER TABLE connection_profiles ADD COLUMN connect_timeout_secs INTEGER",
            [],
        )
        .unwrap();
        conn.execute("PRAGMA user_version = 3", []).unwrap();

        let v = run(&conn).expect("run");
        assert_eq!(v, SCHEMA_VERSION);
        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('connection_profiles') ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for expected in &[
            "env",
            "connect_timeout_secs",
            "query_timeout_secs",
            "charset",
        ] {
            assert!(
                cols.iter().any(|n| n == expected),
                "expected column {} missing from {cols:?}",
                expected,
            );
        }
    }

    #[test]
    fn already_at_head_is_noop() {
        let conn = empty_db();
        conn.execute(&format!("PRAGMA user_version = {}", SCHEMA_VERSION), [])
            .unwrap();
        let v = run(&conn).expect("run");
        assert_eq!(v, SCHEMA_VERSION);
    }

    #[test]
    fn a_database_from_before_this_framework_is_adopted_rather_than_refused() {
        // The shape found on a real machine upgrading to 1.0.0: every column
        // through v5 present, because an older build added them at startup,
        // and `user_version` still 1 because that build never recorded any.
        // Refusing it sent the app to an empty in-memory store while the
        // user's actual connections sat on disk, unreadable.
        let conn = empty_db();
        conn.execute_batch(
            "CREATE TABLE connection_profiles (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, grp TEXT, color TEXT,
                host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 3306,
                username TEXT NOT NULL, password TEXT NOT NULL DEFAULT '',
                default_database TEXT, ssh_config TEXT, ssl_config TEXT,
                pool_min INTEGER NOT NULL DEFAULT 1,
                pool_max INTEGER NOT NULL DEFAULT 5,
                read_only INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            )",
        )
        .unwrap();
        for column in [
            "env TEXT",
            "connect_timeout_secs INTEGER",
            "query_timeout_secs INTEGER",
            "charset TEXT",
        ] {
            conn.execute(
                &format!("ALTER TABLE connection_profiles ADD COLUMN {column}"),
                [],
            )
            .unwrap();
        }
        conn.execute_batch("PRAGMA user_version = 1").unwrap();
        conn.execute(
            "INSERT INTO connection_profiles
             (id, name, host, port, username, password, pool_min, pool_max, read_only,
              created_at, updated_at)
             VALUES ('p1', 'Unraid', '10.0.1.11', 3306, 'root', '', 1, 5, 0, 'now', 'now')",
            [],
        )
        .unwrap();

        let applied = run(&conn).expect("an older database is still openable");

        assert_eq!(applied, SCHEMA_VERSION);
        // The profile is still there — the point of the whole exercise.
        let name: String = conn
            .query_row("SELECT name FROM connection_profiles", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Unraid");
        // And the migrations that had nothing to do with columns still ran.
        let grants: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'agent_grants'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(grants, 1);
    }

    #[test]
    fn a_real_failure_is_still_a_failure() {
        // The tolerance is narrow on purpose: only "this is already here".
        // A migration against a table that does not exist is a broken
        // database, and pretending otherwise would hide it.
        let conn = empty_db();
        let error = run(&conn).err();
        assert!(error.is_none(), "a fresh database migrates cleanly");

        conn.execute_batch("DROP TABLE connection_profiles")
            .unwrap();
        conn.execute_batch("PRAGMA user_version = 1").unwrap();
        assert!(
            run(&conn).is_err(),
            "a missing table is a real problem and must be reported"
        );
    }

    #[test]
    fn only_already_here_errors_are_tolerated() {
        use rusqlite::Error;
        let conn = empty_db();
        run(&conn).unwrap();
        let duplicate = conn
            .execute("ALTER TABLE connection_profiles ADD COLUMN env TEXT", [])
            .unwrap_err();
        assert!(already_applied(&duplicate), "{duplicate}");

        let missing: Error = conn
            .execute("ALTER TABLE nope ADD COLUMN x TEXT", [])
            .unwrap_err();
        assert!(!already_applied(&missing), "{missing}");
    }

    #[test]
    fn runs_each_migration_exactly_once() {
        // Verify idempotency by running twice.
        let conn = empty_db();
        let _ = run(&conn).unwrap();
        // A second call must not throw (no schema mismatch) and must
        // leave user_version unchanged.
        let v = run(&conn).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
    }
}
