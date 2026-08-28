//! Planning a statement, safely.
//!
//! `EXPLAIN` is inert — the server plans the statement and reports back.
//! `EXPLAIN ANALYZE` is not: it *runs* the statement to collect real timings,
//! so `EXPLAIN ANALYZE DELETE FROM users` deletes the users (#412). The UI
//! offers both from one split button, which makes the distinction far too easy
//! to miss.
//!
//! Everything that decides whether a statement is safe to ANALYZE lives here,
//! behind the `explain_query` command, rather than in the renderer where a
//! second call site could skip it.

use crate::connection::ConnectionManager;
use crate::error::CoreError;
use crate::models::QueryResult;
use crate::query::executor::{split_statements, QueryExecutor};
use crate::query::statement::{effective_verb, is_blank_or_comment_only};

/// Why a requested ANALYZE was not performed.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AnalyzeRefusal {
    /// The statement writes. Running it to time it would apply the write.
    WouldMutate,
    /// The connection's profile is marked read-only.
    ReadOnlyConnection,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct ExplainResponse {
    pub result: QueryResult,
    /// True when the output is ANALYZE-shaped (actual timings), false for a plan.
    pub analyzed: bool,
    /// Set when ANALYZE was asked for and deliberately not run. The caller shows
    /// this to the user; `result` holds the plain EXPLAIN performed instead.
    pub refusal: Option<AnalyzeRefusal>,
    /// True when the plan came back in MariaDB's tabular ANALYZE shape rather
    /// than MySQL's single-column TREE text (#422).
    pub tabular: bool,
}

/// Statements whose execution has no side effects, and so are safe to ANALYZE.
///
/// An allowlist rather than a list of dangerous verbs: an unrecognised verb
/// downgrades to a plain EXPLAIN, which is the harmless outcome. A blocklist
/// fails the other way — anything it forgets gets executed.
/// `WITH` is deliberately absent: `effective_verb` resolves a CTE to the
/// statement it prefixes, so a WITH reaching the check means the clause could
/// not be parsed through and what it wraps is unknown.
const ANALYZABLE_VERBS: [&str; 3] = ["SELECT", "TABLE", "VALUES"];

/// Whether running `sql` to time it would be free of side effects.
///
/// Reads the verb that decides what the statement does, not its first word:
/// `WITH doomed AS (...) DELETE FROM t` is a DELETE, and treating the leading
/// WITH as safe is how EXPLAIN ANALYZE ended up executing writes.
pub fn is_analyzable(sql: &str) -> bool {
    ANALYZABLE_VERBS.contains(&effective_verb(sql).as_str())
}

/// Reduce editor content to the single statement EXPLAIN can accept.
///
/// The splitter drops the trailing `;` as a side effect of splitting, which is
/// what stops `EXPLAIN ANALYZE SELECT 1;;` reaching the server (#418).
pub fn normalize_explain_target(sql: &str) -> Result<String, CoreError> {
    // A trailing `-- note` splits off as its own entry. Counting it would tell
    // someone with one commented statement to go and split their script.
    let statements: Vec<String> = split_statements(sql)
        .into_iter()
        .filter(|s| !is_blank_or_comment_only(s))
        .collect();
    match statements.len() {
        0 => Err(CoreError::Query("Nothing to explain".to_string())),
        1 => Ok(statements.into_iter().next().unwrap()),
        n => Err(CoreError::Query(format!(
            "EXPLAIN supports a single statement — {} were given. Select one statement and re-run.",
            n
        ))),
    }
}

#[tracing::instrument(skip(connection_manager, executor, sql), fields(connection_id = %connection_id, analyze))]
pub async fn explain(
    connection_manager: &ConnectionManager,
    executor: &QueryExecutor,
    connection_id: String,
    sql: String,
    database: Option<String>,
    analyze: bool,
) -> Result<ExplainResponse, CoreError> {
    let target = normalize_explain_target(&sql)?;

    // Decide ANALYZE vs plain EXPLAIN before touching the server.
    let refusal = if !analyze {
        None
    } else if connection_manager.is_read_only(&connection_id) {
        Some(AnalyzeRefusal::ReadOnlyConnection)
    } else if !is_analyzable(&target) {
        Some(AnalyzeRefusal::WouldMutate)
    } else {
        None
    };
    let will_analyze = analyze && refusal.is_none();

    if let Some(ref r) = refusal {
        tracing::warn!(refusal = ?r, "Refusing EXPLAIN ANALYZE, downgrading to EXPLAIN");
    }

    // MariaDB spells it `ANALYZE <stmt>` and answers in the same tabular shape
    // as EXPLAIN; MySQL spells it `EXPLAIN ANALYZE` and answers with
    // single-column TREE text.
    let is_mariadb = connection_manager
        .get_server_version(&connection_id)
        .map(|v| v.to_lowercase().contains("mariadb"))
        .unwrap_or(false);

    let statement = match (will_analyze, is_mariadb) {
        (true, true) => format!("ANALYZE {}", target),
        (true, false) => format!("EXPLAIN ANALYZE {}", target),
        (false, _) => format!("EXPLAIN {}", target),
    };

    // No row limit: appending LIMIT to an EXPLAIN would rewrite the very
    // statement being planned.
    let mut results = executor
        .execute_owned(connection_id, statement, database, None)
        .await?;

    if results.is_empty() {
        return Err(CoreError::Query(
            "EXPLAIN returned no result set".to_string(),
        ));
    }
    let result = results.remove(0);

    // MySQL's TREE output is one column; anything wider is tabular and should
    // render in the table/tree views rather than as raw text.
    let tabular = result.columns.len() > 1;

    Ok(ExplainResponse {
        result,
        analyzed: will_analyze,
        refusal,
        tabular,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_trailing_semicolon() {
        assert_eq!(normalize_explain_target("SELECT 1;").unwrap(), "SELECT 1");
        assert_eq!(
            normalize_explain_target("  SELECT 1 ;  ").unwrap(),
            "SELECT 1"
        );
    }

    #[test]
    fn rejects_multi_statement_input() {
        let err = normalize_explain_target("SELECT 1; SELECT 2;").unwrap_err();
        assert!(err.to_string().contains("single statement"), "{err}");
    }

    #[test]
    fn a_semicolon_inside_a_literal_is_not_a_separator() {
        assert_eq!(
            normalize_explain_target("SELECT 'a;b'").unwrap(),
            "SELECT 'a;b'"
        );
    }

    #[test]
    fn rejects_empty_input() {
        assert!(normalize_explain_target("   ").is_err());
        assert!(normalize_explain_target(";").is_err());
    }

    #[test]
    fn reads_select_as_analyzable() {
        assert!(is_analyzable("SELECT * FROM users"));
        assert!(is_analyzable("  select 1"));
        assert!(is_analyzable("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(is_analyzable("(SELECT 1)"));
        assert!(is_analyzable("-- a comment\nSELECT 1"));
        assert!(is_analyzable("/* hi */ SELECT 1"));
    }

    #[test]
    fn reads_writes_as_not_analyzable() {
        for sql in [
            "DELETE FROM users WHERE 1=1",
            "UPDATE users SET a = 1",
            "INSERT INTO users VALUES (1)",
            "REPLACE INTO users VALUES (1)",
            "TRUNCATE users",
            "DROP TABLE users",
            "ALTER TABLE users ADD c INT",
            "CALL do_something()",
            "GRANT ALL ON *.* TO u",
        ] {
            assert!(!is_analyzable(sql), "should refuse to ANALYZE: {sql}");
        }
    }

    #[test]
    fn refuses_to_analyze_a_write_hidden_behind_a_cte() {
        // MySQL 8 runs `WITH ... DELETE` as a DELETE. Reading only the leading
        // keyword called it a WITH and let EXPLAIN ANALYZE execute it.
        assert!(!is_analyzable(
            "WITH doomed AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM doomed)"
        ));
        assert!(!is_analyzable("WITH x AS (SELECT 1) UPDATE t SET a = 1"));
        assert!(!is_analyzable(
            "WITH a AS (SELECT 1), b AS (SELECT 2) DELETE FROM t"
        ));
        // A read behind a CTE is still fine to analyze.
        assert!(is_analyzable("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(is_analyzable(
            "WITH RECURSIVE t (n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n < 5) SELECT * FROM t"
        ));
    }

    #[test]
    fn keeps_a_statement_that_merely_carries_a_comment() {
        // The splitter emits a trailing comment as its own entry; counting it
        // rejected perfectly ordinary SQL as a multi-statement script.
        assert_eq!(
            normalize_explain_target("SELECT 1; -- why").unwrap(),
            "SELECT 1"
        );
        assert_eq!(
            normalize_explain_target("SELECT 1;\n-- trailing note").unwrap(),
            "SELECT 1"
        );
        assert_eq!(
            normalize_explain_target("SELECT 1; /* block */").unwrap(),
            "SELECT 1"
        );
        // A leading comment stays attached to the statement.
        assert!(normalize_explain_target("-- lead\nSELECT 1;").is_ok());
        // Genuinely two statements are still refused.
        assert!(normalize_explain_target("SELECT 1; -- c\nSELECT 2;").is_err());
    }

    #[test]
    fn treats_an_unknown_verb_as_unsafe() {
        assert!(!is_analyzable("FLUSH PRIVILEGES"));
        assert!(!is_analyzable(""));
    }

    #[test]
    fn is_not_fooled_by_a_write_wearing_a_select_prefix() {
        // The verb, not a substring match anywhere in the statement.
        assert!(!is_analyzable(
            "DELETE FROM t WHERE id IN (SELECT id FROM u)"
        ));
        assert!(is_analyzable("SELECT * FROM t WHERE note = 'DELETE'"));
    }
}
