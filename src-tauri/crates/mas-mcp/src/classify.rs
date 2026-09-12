//! What a piece of SQL is, before anyone runs it.
//!
//! The old assistant decided this with `sql.trim().to_uppercase().starts_with("SELECT")`
//! and then handed the string to an executor that splits on `;`. So
//! `SELECT 1; DROP TABLE users` passed the read-only tool and dropped the
//! table (#308).
//!
//! Two rules fix that class of bug, and they belong here rather than inside
//! any one tool:
//!
//! 1. **One statement.** A tool argument that contains two is refused, not
//!    truncated and not run. There is no tool for which "and also this" is a
//!    reasonable thing to accept.
//! 2. **The effective verb, not the first word.** `WITH doomed AS (…) DELETE`
//!    is a delete. `mas-core` already works this out, correctly, for the
//!    editor's own safety checks; this reuses it rather than writing a second
//!    parser to disagree with.

use crate::policy::VerbClass;
use mas_core::query::statement::{effective_verb, is_blank_or_comment_only};

/// Why a piece of SQL cannot be used as a tool argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejected {
    /// Nothing but whitespace and comments.
    Empty,
    /// More than one statement. Carries how many were found, because "I sent
    /// one statement" is the model's most likely next thought.
    MultipleStatements(usize),
}

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Rejected::Empty => write!(f, "There is no statement here to run."),
            Rejected::MultipleStatements(n) => write!(
                f,
                "This is {n} statements, and these tools take one at a time. Send them \
                 separately, so each is checked and — where it changes something — approved on \
                 its own."
            ),
        }
    }
}

/// One statement, classified, or a reason it is not usable.
///
/// `sql` comes back trimmed of a trailing terminator so the caller can hand it
/// straight on: a stray `;` is harmless to MySQL but makes a second splitter
/// think there is an empty statement after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    pub sql: String,
    pub class: VerbClass,
}

/// Statements that only read. Anything unrecognised is *not* assumed to be
/// one — an unknown verb falls through to `Write`, which asks the user, rather
/// than to `Read`, which would not.
const READ_VERBS: [&str; 7] = [
    "SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "TABLE", "VALUES",
];

const DDL_VERBS: [&str; 6] = ["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "COMMENT"];

const ADMIN_VERBS: [&str; 8] = [
    "GRANT",
    "REVOKE",
    "KILL",
    "FLUSH",
    "SHUTDOWN",
    "RESET",
    "INSTALL",
    "UNINSTALL",
];

/// Classify one statement's SQL, having already established it is one.
pub fn classify(sql: &str) -> VerbClass {
    let verb = effective_verb(sql);

    if ADMIN_VERBS.contains(&verb.as_str()) {
        return VerbClass::Admin;
    }
    // `SET GLOBAL` reconfigures the server; `SET @x` is session-local and
    // ordinary. mas-core draws the same line for the read-only check.
    if verb == "SET" {
        let rest = sql.trim().to_uppercase();
        let global = rest.contains("GLOBAL") || rest.contains("PERSIST") || rest.contains("@@");
        return if global {
            VerbClass::Admin
        } else {
            VerbClass::Write
        };
    }
    if DDL_VERBS.contains(&verb.as_str()) {
        return VerbClass::Ddl;
    }
    if READ_VERBS.contains(&verb.as_str()) {
        // `EXPLAIN ANALYZE` runs the statement it is given, and MariaDB
        // spells that `ANALYZE <stmt>`. mas-core already knows; asking it is
        // cheaper than repeating the rule wrongly.
        if mas_core::query::statement::is_write_statement(sql) {
            return VerbClass::Write;
        }
        return VerbClass::Read;
    }

    // ANALYZE, OPTIMIZE, REPAIR, CHECK: maintenance that rewrites statistics
    // or locks a table. Not reads, and not schema changes either.
    VerbClass::Write
}

/// Take exactly one statement from a tool argument, or say why not.
pub fn single_statement(sql: &str) -> Result<Statement, Rejected> {
    let statements: Vec<String> = mas_core::query::split_statements(sql)
        .into_iter()
        .filter(|s| !is_blank_or_comment_only(s))
        .collect();

    match statements.len() {
        0 => Err(Rejected::Empty),
        1 => {
            let sql = statements.into_iter().next().unwrap();
            let class = classify(&sql);
            Ok(Statement { sql, class })
        }
        n => Err(Rejected::MultipleStatements(n)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn class_of(sql: &str) -> VerbClass {
        single_statement(sql).expect("one statement").class
    }

    #[test]
    fn the_bug_that_started_this() {
        // #308: this passed a "read-only" tool and dropped the table.
        let rejected = single_statement("SELECT 1; DROP TABLE users").unwrap_err();
        assert_eq!(rejected, Rejected::MultipleStatements(2));
        // And the message tells the model what to do instead of retrying.
        assert!(rejected.to_string().contains("separately"), "{rejected}");
    }

    #[test]
    fn a_cte_prefixed_delete_is_a_write() {
        // The first word is WITH. What it does is delete.
        assert_eq!(
            class_of("WITH doomed AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM doomed)"),
            VerbClass::Write
        );
    }

    #[test]
    fn a_cte_prefixed_select_is_still_a_read() {
        assert_eq!(
            class_of("WITH recent AS (SELECT * FROM orders) SELECT * FROM recent"),
            VerbClass::Read
        );
    }

    #[test]
    fn plain_reads_are_reads() {
        for sql in [
            "SELECT * FROM users",
            "  select 1  ",
            "SHOW TABLES",
            "DESCRIBE users",
            "DESC users",
            "EXPLAIN SELECT 1",
            "TABLE users",
            "VALUES ROW(1)",
        ] {
            assert_eq!(class_of(sql), VerbClass::Read, "{sql}");
        }
    }

    #[test]
    fn explain_analyze_is_a_write_because_it_runs_what_it_measures() {
        // The distinction that #412 was about, reused rather than re-derived.
        assert_eq!(class_of("EXPLAIN ANALYZE DELETE FROM t"), VerbClass::Write);
        assert_eq!(class_of("ANALYZE DELETE FROM t"), VerbClass::Write);
        assert_eq!(class_of("EXPLAIN SELECT 1"), VerbClass::Read);
    }

    #[test]
    fn writes_are_writes() {
        for sql in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET a = 1 WHERE id = 2",
            "DELETE FROM t WHERE id = 2",
            "REPLACE INTO t VALUES (1)",
            "CALL recalc()",
        ] {
            assert_eq!(class_of(sql), VerbClass::Write, "{sql}");
        }
    }

    #[test]
    fn schema_changes_are_ddl() {
        for sql in [
            "CREATE TABLE t (a INT)",
            "ALTER TABLE t ADD b INT",
            "DROP TABLE t",
            "TRUNCATE TABLE t",
            "RENAME TABLE a TO b",
        ] {
            assert_eq!(class_of(sql), VerbClass::Ddl, "{sql}");
        }
    }

    #[test]
    fn server_administration_is_its_own_class() {
        for sql in [
            "GRANT ALL ON *.* TO 'x'@'%'",
            "REVOKE ALL ON *.* FROM 'x'@'%'",
            "KILL 42",
            "FLUSH PRIVILEGES",
            "SET GLOBAL max_connections = 1",
            "SET @@GLOBAL.max_connections = 1",
        ] {
            assert_eq!(class_of(sql), VerbClass::Admin, "{sql}");
        }
    }

    #[test]
    fn a_session_variable_is_not_administration() {
        // `SET @x = 1` is how a routine's parameters are passed; refusing it
        // as "admin" would break the ordinary case to catch the rare one.
        assert_eq!(class_of("SET @x = 1"), VerbClass::Write);
    }

    #[test]
    fn an_unknown_verb_is_treated_as_a_write_not_a_read() {
        // The safe direction: an unrecognised statement asks the user rather
        // than running unannounced. A blocklist fails the other way.
        assert_eq!(class_of("OPTIMIZE TABLE t"), VerbClass::Write);
        assert_eq!(class_of("REPAIR TABLE t"), VerbClass::Write);
        assert_eq!(class_of("SOMETHING NEW"), VerbClass::Write);
    }

    #[test]
    fn a_semicolon_inside_a_string_is_not_two_statements() {
        // The splitter is quote-aware, which is why it is the splitter and
        // not a `split(';')`.
        let statement = single_statement("SELECT 'a;b' FROM t").expect("one statement");
        assert_eq!(statement.class, VerbClass::Read);
        assert!(statement.sql.contains("a;b"));
    }

    #[test]
    fn a_trailing_semicolon_is_one_statement() {
        // Models write them. It would be absurd to refuse.
        assert_eq!(class_of("SELECT 1;"), VerbClass::Read);
        assert_eq!(class_of("SELECT 1;   "), VerbClass::Read);
    }

    #[test]
    fn a_trailing_comment_is_not_a_second_statement() {
        // The splitter emits it separately; #418 was this exact shape.
        assert_eq!(class_of("SELECT 1; -- why"), VerbClass::Read);
    }

    #[test]
    fn nothing_at_all_is_refused_as_such() {
        for sql in ["", "   ", "-- just a comment", "/* nothing */"] {
            assert_eq!(
                single_statement(sql).unwrap_err(),
                Rejected::Empty,
                "{sql:?}"
            );
        }
    }

    #[test]
    fn the_returned_sql_has_no_trailing_terminator() {
        // So the caller can hand it on without a second splitter deciding
        // there is an empty statement after it.
        let statement = single_statement("SELECT 1;").unwrap();
        assert!(
            !statement.sql.trim_end().ends_with(';'),
            "{}",
            statement.sql
        );
    }
}
