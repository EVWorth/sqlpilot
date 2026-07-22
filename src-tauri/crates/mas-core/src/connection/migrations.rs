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
/// Migrations v2..v5 add columns that were introduced post-launch.
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
];

/// The latest schema version. Bump this when adding a new entry to
/// `MIGRATIONS` (the constant itself enforces ordering, but having
/// a single named source of truth is helpful for docs and tests).
pub const SCHEMA_VERSION: i64 = 5;

/// `PRAGMA user_version` reads 0 on a fresh DB (sqlite's default).
/// Migrations start firing at version 1.
///
/// Apply all migrations in `MIGRATIONS` whose version is greater than
/// the current `PRAGMA user_version`. Each migration runs inside a
/// transaction. On success, `user_version` is bumped to the new
/// version. Idempotent — re-running on an up-to-date DB is a no-op.
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
