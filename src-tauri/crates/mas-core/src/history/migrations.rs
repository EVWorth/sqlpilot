use rusqlite::Connection as SqliteConn;

/// One versioned schema migration for the history database.
///
/// Same shape and same rules as `connection::migrations`: `PRAGMA user_version`
/// is the cursor, each migration runs in a transaction, append rather than
/// renumber.
#[derive(Debug, Clone)]
pub struct Migration {
    pub v: i64,
    pub name: &'static str,
    pub up: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[Migration {
    v: 1,
    name: "create_query_history",
    // `executed_at` is ISO 8601 in UTC, stored as text. SQLite has no date
    // type, and the string form sorts chronologically, so a range filter is a
    // plain BETWEEN rather than a conversion per row.
    up: "CREATE TABLE IF NOT EXISTS query_history (
            id TEXT PRIMARY KEY,
            sql TEXT NOT NULL,
            connection_name TEXT NOT NULL,
            database TEXT,
            executed_at TEXT NOT NULL,
            execution_time_ms INTEGER NOT NULL DEFAULT 0,
            row_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            error TEXT,
            error_code INTEGER,
            error_sql_state TEXT,
            redacted INTEGER NOT NULL DEFAULT 0,
            truncated INTEGER NOT NULL DEFAULT 0
        );
        -- Every read is newest-first, and the count cap deletes by the same
        -- order, so this index carries both.
        CREATE INDEX IF NOT EXISTS idx_query_history_executed_at
            ON query_history (executed_at DESC);",
}];

/// Apply anything the database has not seen. Returns the migrations applied.
pub fn run(db: &SqliteConn) -> Result<Vec<&'static str>, rusqlite::Error> {
    let current: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let mut applied = Vec::new();

    for m in MIGRATIONS {
        if m.v <= current {
            continue;
        }
        db.execute_batch(&format!(
            "BEGIN; {} ; PRAGMA user_version = {}; COMMIT;",
            m.up, m.v
        ))?;
        applied.push(m.name);
    }

    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_numbered_from_one_without_gaps() {
        for (i, m) in MIGRATIONS.iter().enumerate() {
            assert_eq!(m.v, i as i64 + 1, "migration {} is out of order", m.name);
        }
    }

    #[test]
    fn running_twice_applies_nothing_the_second_time() {
        let db = SqliteConn::open_in_memory().unwrap();

        let first = run(&db).unwrap();
        assert_eq!(first.len(), MIGRATIONS.len());

        let second = run(&db).unwrap();
        assert!(second.is_empty(), "migrations must be idempotent");
    }
}
