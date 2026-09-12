//! Numbers about data, rather than the data.
//!
//! This is the group of tools that makes an agent attached to SQLPilot more
//! useful than one holding a connection string, and it is also the group that
//! makes a schema-only connection worth having. A model cannot read the rows,
//! but it can ask how many there are, how often a column is null, what the
//! range of a date column is, and what the planner intends to do — all of it
//! computed in the database, with only the aggregate coming back.
//!
//! The SQL here is generated rather than taken from the caller, so the only
//! values that reach it are identifiers the caller named. They are quoted with
//! the app's own `quote_ident`, and a name that cannot be an identifier is
//! refused rather than escaped into something else.

use mas_core::schema::ident::{qualified, quote_ident};

/// A column name that could not be used as one.
///
/// Identifier quoting doubles backticks, which makes almost anything safe, but
/// "almost" is not the standard for a string that becomes SQL. A name with a
/// NUL or a newline in it is not a column anybody has; refusing is both safer
/// and more honest than quoting it and getting a confusing error from the
/// server.
pub fn check_identifier(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("An empty name is not a column or a table.".to_string());
    }
    if name.len() > 64 {
        return Err(format!(
            "\"{name}\" is longer than the 64 characters MySQL allows in an identifier, so no \
             such object exists."
        ));
    }
    if name.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(format!(
            "\"{name}\" contains a character that cannot appear in an identifier."
        ));
    }
    Ok(())
}

/// The statement behind `table_stats`.
///
/// INFORMATION_SCHEMA rather than `COUNT(*)`: on a large table the count is a
/// full scan, and a tool called "stats" should not be the most expensive thing
/// an agent can do by accident. The row count is an estimate, and the shape of
/// the answer says so.
pub fn table_stats_sql(database: &str, table: &str) -> String {
    // Bound as literals rather than parameters because this goes through the
    // same execute path as a user's own statement, which takes no parameters.
    // Both values are identifiers the caller named and `check_identifier` has
    // already vetted; they are quoted as string literals here, not spliced as
    // SQL.
    format!(
        "SELECT TABLE_ROWS AS approximate_rows,
                DATA_LENGTH AS data_bytes,
                INDEX_LENGTH AS index_bytes,
                DATA_FREE AS free_bytes,
                AUTO_INCREMENT AS auto_increment,
                ENGINE AS engine,
                TABLE_COLLATION AS collation,
                CREATE_TIME AS created,
                UPDATE_TIME AS updated
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
        literal(database),
        literal(table)
    )
}

/// The statement behind `profile_column`, without top values.
///
/// One pass, several aggregates. Min and max are cast to CHAR so that a date,
/// a number and a string all come back the same shape — the alternative is a
/// result whose column types depend on the column being profiled, which every
/// caller then has to special-case.
pub fn profile_column_sql(database: &str, table: &str, column: &str) -> String {
    let target = qualified(database, table);
    let column = quote_ident(column);
    format!(
        "SELECT COUNT(*) AS rows_total,
                COUNT({column}) AS rows_present,
                COUNT(DISTINCT {column}) AS distinct_values,
                CAST(MIN({column}) AS CHAR) AS min_value,
                CAST(MAX({column}) AS CHAR) AS max_value
         FROM {target}"
    )
}

/// The statement behind the top-values half of `profile_column`.
///
/// Only ever run where the posture allows values: a top-ten list of a column
/// called `email` is row data, whatever the tool is called. `LIMIT` is the
/// caller's, already bounded.
pub fn top_values_sql(database: &str, table: &str, column: &str, limit: u32) -> String {
    let target = qualified(database, table);
    let quoted = quote_ident(column);
    format!(
        "SELECT CAST({quoted} AS CHAR) AS value, COUNT(*) AS occurrences
         FROM {target}
         WHERE {quoted} IS NOT NULL
         GROUP BY {quoted}
         ORDER BY occurrences DESC
         LIMIT {limit}"
    )
}

/// A string literal, with quotes and backslashes escaped.
///
/// Used only for identifiers being *compared* rather than spliced — the
/// INFORMATION_SCHEMA lookups above. Escaping both characters covers the
/// server whether or not NO_BACKSLASH_ESCAPES is set.
fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_identifier_with_a_backtick_is_quoted_rather_than_refused() {
        // A backtick in a column name is legal and rare. Doubling it is what
        // MySQL's own quoting does.
        assert!(check_identifier("we`ird").is_ok());
        assert!(profile_column_sql("db", "t", "we`ird").contains("`we``ird`"));
    }

    #[test]
    fn an_identifier_that_could_not_exist_is_refused() {
        for name in ["", &"x".repeat(65)] {
            assert!(check_identifier(name).is_err(), "{name:?}");
        }
        assert!(check_identifier("a\nb").is_err());
        assert!(check_identifier("a\0b").is_err());
    }

    #[test]
    fn a_refusal_says_why_rather_than_just_no() {
        let message = check_identifier(&"x".repeat(65)).unwrap_err();
        assert!(message.contains("64"), "{message}");
    }

    #[test]
    fn table_stats_asks_the_catalogue_and_not_the_table() {
        // COUNT(*) on a large table is a scan, and a tool called "stats"
        // should not be the most expensive call an agent can make by accident.
        let sql = table_stats_sql("shop", "orders");
        assert!(sql.contains("INFORMATION_SCHEMA.TABLES"));
        assert!(!sql.to_uppercase().contains("COUNT(*)"));
        assert!(sql.contains("'shop'"));
        assert!(sql.contains("'orders'"));
    }

    #[test]
    fn a_quote_in_a_name_cannot_end_the_literal() {
        // The name reaches table_stats as a value to compare, not as SQL.
        let sql = table_stats_sql("shop", "o'brien");
        assert!(sql.contains("'o''brien'"), "{sql}");
        assert!(!sql.contains("o'brien'"), "{sql}");
    }

    #[test]
    fn a_backslash_in_a_name_cannot_escape_the_closing_quote() {
        let sql = table_stats_sql("shop", "back\\");
        assert!(sql.contains("'back\\\\'"), "{sql}");
    }

    #[test]
    fn profiling_counts_what_is_there_and_what_is_missing() {
        let sql = profile_column_sql("shop", "orders", "total");
        // COUNT(*) and COUNT(col) differ by exactly the nulls, which is the
        // number anyone profiling a column actually wants.
        assert!(sql.contains("COUNT(*)"));
        assert!(sql.contains("COUNT(`total`)"));
        assert!(sql.contains("COUNT(DISTINCT `total`)"));
        assert!(sql.contains("`shop`.`orders`"));
    }

    #[test]
    fn the_extremes_come_back_as_text_whatever_the_column_is() {
        // Otherwise the result's column types depend on the column being
        // profiled, and every caller has to special-case dates.
        let sql = profile_column_sql("shop", "orders", "created_at");
        assert!(sql.contains("CAST(MIN(`created_at`) AS CHAR)"));
        assert!(sql.contains("CAST(MAX(`created_at`) AS CHAR)"));
    }

    #[test]
    fn top_values_skips_nulls_and_orders_by_frequency() {
        let sql = top_values_sql("shop", "orders", "status", 10);
        assert!(sql.contains("`status` IS NOT NULL"));
        assert!(sql.contains("ORDER BY occurrences DESC"));
        assert!(sql.ends_with("LIMIT 10"));
    }

    #[test]
    fn everything_generated_here_is_a_single_read() {
        // These strings go through the same classifier as anything else, so a
        // stray semicolon would be refused rather than run — but generating
        // one at all would be a bug worth catching here.
        for sql in [
            table_stats_sql("db", "t"),
            profile_column_sql("db", "t", "c"),
            top_values_sql("db", "t", "c", 5),
        ] {
            assert!(!sql.contains(';'), "{sql}");
            assert_eq!(
                crate::classify::single_statement(&sql).unwrap().class,
                crate::policy::VerbClass::Read,
                "{sql}"
            );
        }
    }
}
