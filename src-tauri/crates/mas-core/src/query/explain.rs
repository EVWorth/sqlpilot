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

/// Which shape of plan to ask the server for.
///
/// MySQL and MariaDB do not offer the same set, and neither offers every
/// combination with ANALYZE — see `plan_statement`, which is where the
/// differences are resolved rather than in the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExplainFormat {
    /// The tabular plan: one row per table, with the access type and the row
    /// estimate. What every version of both servers answers by default.
    Classic,
    /// The optimiser's own cost model, as nested JSON. `query_cost`,
    /// `rows_examined_per_scan`, `filtered` and the rest — the numbers the
    /// tabular form rounds off.
    Json,
    /// The iterator tree, which is the shape `EXPLAIN ANALYZE` reports in.
    /// MySQL 8.0.16 and later; MariaDB does not have it.
    Tree,
}

/// A format that could not be served, and what was done instead.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum FormatFallback {
    /// MariaDB has no `FORMAT=TREE`; asking for one is error 1791. The
    /// tabular plan was produced instead.
    TreeNotSupported,
    /// MySQL cannot combine ANALYZE with JSON before 8.3 — error 1235. The
    /// plan was produced in JSON without the actual timings.
    AnalyzeJsonNotSupported,
    /// MariaDB spells the JSON form of ANALYZE `ANALYZE FORMAT=JSON`, which
    /// is what ran; nothing was lost.
    None,
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
    /// The format the result is actually in, which is not always the one that
    /// was asked for.
    pub format: ExplainFormat,
    /// Set when the requested format could not be served (#424).
    pub format_fallback: Option<FormatFallback>,
}

/// What to send, and what the caller ends up with.
///
/// The combinations neither server supports are resolved here rather than by
/// letting the server reject the statement: an error saying "This version of
/// MySQL doesn't yet support 'EXPLAIN ANALYZE with JSON format'" in place of a
/// plan is a worse answer than the plan without the timings.
fn plan_statement(
    target: &str,
    analyze: bool,
    format: ExplainFormat,
    is_mariadb: bool,
) -> (String, ExplainFormat, bool, Option<FormatFallback>) {
    match (format, analyze, is_mariadb) {
        // Classic — what both servers answer by default. MariaDB spells the
        // timed form `ANALYZE <stmt>` and answers tabular; MySQL spells it
        // `EXPLAIN ANALYZE` and answers with TREE text.
        (ExplainFormat::Classic, true, true) => (
            format!("ANALYZE {target}"),
            ExplainFormat::Classic,
            true,
            None,
        ),
        (ExplainFormat::Classic, true, false) => (
            format!("EXPLAIN ANALYZE {target}"),
            ExplainFormat::Tree,
            true,
            None,
        ),
        (ExplainFormat::Classic, false, _) => (
            format!("EXPLAIN {target}"),
            ExplainFormat::Classic,
            false,
            None,
        ),

        // JSON — both servers have it for a plan. For a timed run, MariaDB
        // has `ANALYZE FORMAT=JSON`; MySQL does not before 8.3 (error 1235),
        // so the plan comes back in JSON without the timings.
        (ExplainFormat::Json, true, true) => (
            format!("ANALYZE FORMAT=JSON {target}"),
            ExplainFormat::Json,
            true,
            Some(FormatFallback::None),
        ),
        (ExplainFormat::Json, true, false) => (
            format!("EXPLAIN FORMAT=JSON {target}"),
            ExplainFormat::Json,
            false,
            Some(FormatFallback::AnalyzeJsonNotSupported),
        ),
        (ExplainFormat::Json, false, _) => (
            format!("EXPLAIN FORMAT=JSON {target}"),
            ExplainFormat::Json,
            false,
            None,
        ),

        // TREE — MySQL only. `EXPLAIN ANALYZE` is already tree-shaped, so the
        // timed form needs no FORMAT clause.
        (ExplainFormat::Tree, true, false) => (
            format!("EXPLAIN ANALYZE {target}"),
            ExplainFormat::Tree,
            true,
            None,
        ),
        (ExplainFormat::Tree, false, false) => (
            format!("EXPLAIN FORMAT=TREE {target}"),
            ExplainFormat::Tree,
            false,
            None,
        ),
        (ExplainFormat::Tree, analyze, true) => {
            // Error 1791: "Unknown EXPLAIN/ANALYZE format name: 'TREE'".
            let statement = if analyze {
                format!("ANALYZE {target}")
            } else {
                format!("EXPLAIN {target}")
            };
            (
                statement,
                ExplainFormat::Classic,
                analyze,
                Some(FormatFallback::TreeNotSupported),
            )
        }
    }
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
    format: ExplainFormat,
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

    let (statement, produced_format, _timed, format_fallback) =
        plan_statement(&target, will_analyze, format, is_mariadb);

    // No row limit: appending LIMIT to an EXPLAIN would rewrite the very
    // statement being planned.
    let mut results = executor
        .execute_owned(connection_id, statement, database, None, None)
        .await?;

    if results.is_empty() {
        return Err(CoreError::Query(
            "EXPLAIN returned no result set".to_string(),
        ));
    }
    let result = results.remove(0);

    // MySQL's TREE and JSON output is one column; anything wider is tabular
    // and should render in the table/tree views rather than as raw text.
    let tabular = result.columns.len() > 1;

    Ok(ExplainResponse {
        result,
        analyzed: will_analyze,
        refusal,
        tabular,
        format: produced_format,
        format_fallback,
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

    /// The statement each combination sends, checked against what the servers
    /// actually accept. Every case here was run against MySQL 8.0.46 and
    /// MariaDB 11.8 before being written down.
    mod formats {
        use super::*;

        fn plan(
            analyze: bool,
            format: ExplainFormat,
            mariadb: bool,
        ) -> (String, ExplainFormat, Option<FormatFallback>) {
            let (sql, produced, _, fallback) = plan_statement("SELECT 1", analyze, format, mariadb);
            (sql, produced, fallback)
        }

        #[test]
        fn the_default_is_what_both_servers_answered_before() {
            assert_eq!(
                plan(false, ExplainFormat::Classic, false).0,
                "EXPLAIN SELECT 1"
            );
            assert_eq!(
                plan(false, ExplainFormat::Classic, true).0,
                "EXPLAIN SELECT 1"
            );
        }

        #[test]
        fn each_server_is_asked_to_analyze_the_way_it_spells_it() {
            // MySQL: `EXPLAIN ANALYZE`, answering with TREE text.
            let (sql, produced, _) = plan(true, ExplainFormat::Classic, false);
            assert_eq!(sql, "EXPLAIN ANALYZE SELECT 1");
            assert_eq!(produced, ExplainFormat::Tree);

            // MariaDB: `ANALYZE`, answering in the same tabular shape as
            // EXPLAIN (#422).
            let (sql, produced, _) = plan(true, ExplainFormat::Classic, true);
            assert_eq!(sql, "ANALYZE SELECT 1");
            assert_eq!(produced, ExplainFormat::Classic);
        }

        #[test]
        fn json_is_asked_for_the_same_way_on_both() {
            assert_eq!(
                plan(false, ExplainFormat::Json, false).0,
                "EXPLAIN FORMAT=JSON SELECT 1"
            );
            assert_eq!(
                plan(false, ExplainFormat::Json, true).0,
                "EXPLAIN FORMAT=JSON SELECT 1"
            );
        }

        #[test]
        fn mariadb_can_time_a_json_plan_and_mysql_cannot() {
            // MariaDB has `ANALYZE FORMAT=JSON`, which carries r_total_time_ms.
            let (sql, produced, fallback) = plan(true, ExplainFormat::Json, true);
            assert_eq!(sql, "ANALYZE FORMAT=JSON SELECT 1");
            assert_eq!(produced, ExplainFormat::Json);
            assert_eq!(fallback, Some(FormatFallback::None));

            // MySQL before 8.3 answers `EXPLAIN ANALYZE FORMAT=JSON` with
            // error 1235. A plan without timings beats an error instead of a
            // plan, so that is what is sent — and said.
            let (sql, produced, fallback) = plan(true, ExplainFormat::Json, false);
            assert_eq!(sql, "EXPLAIN FORMAT=JSON SELECT 1");
            assert_eq!(produced, ExplainFormat::Json);
            assert_eq!(fallback, Some(FormatFallback::AnalyzeJsonNotSupported));
        }

        #[test]
        fn tree_is_mysql_only_and_mariadb_falls_back_rather_than_erroring() {
            let (sql, produced, fallback) = plan(false, ExplainFormat::Tree, false);
            assert_eq!(sql, "EXPLAIN FORMAT=TREE SELECT 1");
            assert_eq!(produced, ExplainFormat::Tree);
            assert_eq!(fallback, None);

            // MariaDB: error 1791, "Unknown EXPLAIN/ANALYZE format name".
            let (sql, produced, fallback) = plan(false, ExplainFormat::Tree, true);
            assert_eq!(sql, "EXPLAIN SELECT 1");
            assert_eq!(produced, ExplainFormat::Classic);
            assert_eq!(fallback, Some(FormatFallback::TreeNotSupported));
        }

        #[test]
        fn a_timed_tree_needs_no_format_clause() {
            // `EXPLAIN ANALYZE` is already tree-shaped on MySQL; adding
            // FORMAT=TREE to it is a syntax error.
            let (sql, _, _) = plan(true, ExplainFormat::Tree, false);
            assert_eq!(sql, "EXPLAIN ANALYZE SELECT 1");
            assert!(!sql.contains("FORMAT"));
        }

        #[test]
        fn a_timed_tree_on_mariadb_becomes_a_timed_tabular_plan() {
            let (sql, produced, fallback) = plan(true, ExplainFormat::Tree, true);
            assert_eq!(sql, "ANALYZE SELECT 1");
            assert_eq!(produced, ExplainFormat::Classic);
            assert_eq!(fallback, Some(FormatFallback::TreeNotSupported));
        }

        #[test]
        fn no_combination_sends_something_neither_server_accepts() {
            // The whole point of resolving this here: every branch has to
            // produce a statement one of them will run.
            for &format in &[
                ExplainFormat::Classic,
                ExplainFormat::Json,
                ExplainFormat::Tree,
            ] {
                for &analyze in &[true, false] {
                    for &mariadb in &[true, false] {
                        let (sql, _, _, _) = plan_statement("SELECT 1", analyze, format, mariadb);
                        assert!(sql.ends_with("SELECT 1"), "{sql}");
                        assert!(
                            sql.starts_with("EXPLAIN ") || sql.starts_with("ANALYZE "),
                            "{sql}"
                        );
                        // MariaDB never sees TREE, MySQL never sees a timed
                        // JSON request.
                        if mariadb {
                            assert!(!sql.contains("TREE"), "{sql}");
                        } else {
                            assert!(!(sql.contains("ANALYZE") && sql.contains("JSON")), "{sql}");
                        }
                    }
                }
            }
        }
    }
}
