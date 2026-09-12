//! Which databases a statement names.
//!
//! A grant can be limited to some of a connection's databases, and hiding the
//! others from `list_databases` is not enough: `SELECT * FROM payroll.staff`
//! reaches a database the tools never mentioned. The connection is the user's
//! own, with the user's own privileges, so the server will happily answer.
//!
//! So the statement is read for schema qualifiers — the `x` in `x.y` — and any
//! that names a real database outside the grant is refused.
//!
//! The ambiguity is the hard part. In `SELECT o.id FROM orders o`, `o` is an
//! alias, not a database; in `SELECT * FROM payroll.staff`, `payroll` is a
//! database. Nothing in the text distinguishes them. What does distinguish
//! them is the server: the caller checks the qualifiers found here against the
//! databases that actually exist, and only refuses on a name that is one. An
//! alias that happens to be called `payroll` is refused too — rare, and the
//! refusal says exactly what to change.

use std::collections::BTreeSet;

/// Every identifier used as a qualifier: the `x` in `x.y`.
///
/// Lower-cased, because database names are compared case-insensitively on the
/// platforms where the server does.
pub fn qualifiers(sql: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    // The identifier that ended most recently, and where it ended.
    let mut last: Option<String> = None;

    while i < chars.len() {
        let c = chars[i];

        // Comments and string literals hold no identifiers.
        if c == '-' && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            last = None;
            continue;
        }
        if c == '#' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            last = None;
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            last = None;
            continue;
        }
        if c == '\'' || c == '"' {
            let quote = c;
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' {
                    i += 2;
                    continue;
                }
                if chars[i] == quote {
                    // A doubled quote is an escaped one, not the end.
                    if chars.get(i + 1) == Some(&quote) {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i += 1;
            last = None;
            continue;
        }

        // A backtick-quoted identifier.
        if c == '`' {
            let mut name = String::new();
            i += 1;
            while i < chars.len() {
                if chars[i] == '`' {
                    if chars.get(i + 1) == Some(&'`') {
                        name.push('`');
                        i += 2;
                        continue;
                    }
                    break;
                }
                name.push(chars[i]);
                i += 1;
            }
            i += 1;
            last = Some(name);
            continue;
        }

        if c.is_alphanumeric() || c == '_' || c == '$' {
            let mut name = String::new();
            while i < chars.len()
                && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '$')
            {
                name.push(chars[i]);
                i += 1;
            }
            last = Some(name);
            continue;
        }

        if c == '.' {
            // `1.5` is a number, and its parts are not identifiers — but the
            // scanner above would have read "1" as one, so a qualifier that is
            // all digits is dropped rather than reported.
            if let Some(name) = last.take() {
                if !name.chars().all(|c| c.is_ascii_digit()) {
                    found.insert(name.to_lowercase());
                }
            }
            i += 1;
            continue;
        }

        // Whitespace between an identifier and its dot is legal — `db . t` —
        // so the identifier is kept across it.
        if !c.is_whitespace() {
            last = None;
        }
        i += 1;
    }

    found
}

/// The databases a statement names that the grant does not cover.
///
/// `existing` is the list of databases on the server. A qualifier that is not
/// one of them is an alias or a table, and is ignored.
pub fn out_of_bounds<'a>(
    sql: &str,
    existing: impl IntoIterator<Item = &'a str>,
    covers: impl Fn(&str) -> bool,
) -> Vec<String> {
    let named = qualifiers(sql);
    existing
        .into_iter()
        .filter(|database| named.contains(&database.to_lowercase()) && !covers(database))
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(sql: &str) -> Vec<String> {
        qualifiers(sql).into_iter().collect()
    }

    #[test]
    fn a_qualified_table_names_its_database() {
        assert_eq!(found("SELECT * FROM payroll.staff"), vec!["payroll"]);
    }

    #[test]
    fn backticks_are_not_part_of_the_name() {
        assert_eq!(found("SELECT * FROM `pay roll`.`staff`"), vec!["pay roll"]);
    }

    #[test]
    fn case_does_not_matter() {
        assert_eq!(found("SELECT * FROM PayRoll.staff"), vec!["payroll"]);
    }

    #[test]
    fn every_qualifier_in_a_join_is_found() {
        let sql = "SELECT * FROM shop.orders o JOIN payroll.staff s ON s.id = o.staff_id";
        // Aliases are qualifiers too — the caller decides which are databases.
        assert_eq!(found(sql), vec!["o", "payroll", "s", "shop"]);
    }

    #[test]
    fn a_name_inside_a_string_is_not_a_qualifier() {
        // The case that would make a check like this trivially bypassable in
        // the other direction: text that looks like SQL but is data.
        assert!(found("SELECT 'payroll.staff' AS note").is_empty());
        assert!(found("SELECT \"payroll.staff\"").is_empty());
    }

    #[test]
    fn an_escaped_quote_does_not_end_the_string_early() {
        assert!(found("SELECT 'it''s payroll.staff'").is_empty());
        assert!(found("SELECT 'it\\'s payroll.staff'").is_empty());
    }

    #[test]
    fn comments_are_not_read() {
        assert!(found("SELECT 1 -- payroll.staff").is_empty());
        assert!(found("SELECT 1 # payroll.staff").is_empty());
        assert!(found("SELECT /* payroll.staff */ 1").is_empty());
    }

    #[test]
    fn a_decimal_number_is_not_a_qualifier() {
        assert!(found("SELECT 1.5 + 2.25").is_empty());
    }

    #[test]
    fn whitespace_around_the_dot_does_not_hide_it() {
        // `db . table` is legal SQL, and a check that missed it would be one
        // space away from useless.
        assert_eq!(found("SELECT * FROM payroll . staff"), vec!["payroll"]);
        assert_eq!(found("SELECT * FROM payroll\n.staff"), vec!["payroll"]);
    }

    #[test]
    fn a_three_part_name_reports_its_first_part_too() {
        // `db.table.column` is not MySQL, but the qualifier that matters is
        // still the first one.
        let names = found("SELECT payroll.staff.salary FROM payroll.staff");
        assert!(names.contains(&"payroll".to_string()));
    }

    #[test]
    fn nothing_qualified_means_nothing_found() {
        assert!(found("SELECT id, total FROM orders WHERE id = 1").is_empty());
    }

    #[test]
    fn only_real_databases_outside_the_grant_are_reported() {
        // `o` is an alias; `shop` is granted; `payroll` is neither.
        let sql = "SELECT o.id FROM shop.orders o JOIN payroll.staff s ON s.id = o.staff_id";
        let outside = out_of_bounds(sql, ["shop", "payroll", "mysql"], |db| db == "shop");
        assert_eq!(outside, vec!["payroll"]);
    }

    #[test]
    fn a_statement_that_stays_inside_the_grant_is_clean() {
        let sql = "SELECT o.id FROM shop.orders o WHERE o.total > 10";
        assert!(out_of_bounds(sql, ["shop", "payroll"], |db| db == "shop").is_empty());
    }

    #[test]
    fn an_alias_that_shares_a_databases_name_is_refused_too() {
        // A false refusal, accepted deliberately: the alternative is deciding
        // between an alias and a database from the text alone, which cannot be
        // done. The message tells the user to rename the alias.
        let sql = "SELECT payroll.id FROM shop.orders payroll";
        assert_eq!(
            out_of_bounds(sql, ["shop", "payroll"], |db| db == "shop"),
            vec!["payroll"]
        );
    }

    #[test]
    fn a_system_database_is_out_of_bounds_like_any_other() {
        let sql = "SELECT * FROM mysql.user";
        assert_eq!(
            out_of_bounds(sql, ["shop", "mysql"], |db| db == "shop"),
            vec!["mysql"]
        );
    }
}
