//! Reading what a statement actually does.
//!
//! The first keyword of a statement is not always the one that decides its
//! behaviour. `WITH doomed AS (SELECT id FROM t) DELETE FROM t WHERE ...` is a
//! DELETE, and MySQL 8 runs it as one. Reading only the leading word calls it a
//! WITH, which gets two separate decisions wrong: whether EXPLAIN ANALYZE may
//! safely run it (#412), and whether it answers with rows or a row count
//! (#422). Both go through here so they cannot drift apart.

/// Advance past whitespace and comments starting at `i`.
fn skip_trivia(chars: &[char], mut i: usize) -> usize {
    loop {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i + 1 < chars.len() && chars[i] == '-' && chars[i + 1] == '-' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if i + 1 < chars.len() && chars[i] == '/' && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            continue;
        }
        return i;
    }
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Whether `word` sits at `i` as a whole word, case-insensitively.
fn match_word(chars: &[char], i: usize, word: &str) -> bool {
    let w: Vec<char> = word.chars().collect();
    if i + w.len() > chars.len() {
        return false;
    }
    for (k, wc) in w.iter().enumerate() {
        if !chars[i + k].eq_ignore_ascii_case(wc) {
            return false;
        }
    }
    // Must not run into a longer identifier: DESC should not match DESCRIBE.
    !chars.get(i + w.len()).is_some_and(|c| is_word_char(*c))
}

/// Read the whole word at `i`, uppercased.
fn word_at(chars: &[char], i: usize) -> String {
    let mut end = i;
    while end < chars.len() && is_word_char(chars[end]) {
        end += 1;
    }
    chars[i..end].iter().collect::<String>().to_uppercase()
}

/// Step over one quoted literal or quoted identifier starting at `i`.
///
/// Returns `i` unchanged when there is no quote there.
fn skip_quoted(chars: &[char], i: usize) -> usize {
    let quote = chars[i];
    if quote != '\'' && quote != '"' && quote != '`' {
        return i;
    }
    let mut j = i + 1;
    while j < chars.len() {
        if chars[j] == '\\' && quote != '`' {
            j += 2;
            continue;
        }
        if chars[j] == quote {
            // A doubled quote is an escaped quote, not the end.
            if chars.get(j + 1) == Some(&quote) {
                j += 2;
                continue;
            }
            return j + 1;
        }
        j += 1;
    }
    j
}

/// The statement a leading `WITH` clause prefixes, or the input unchanged when
/// there is no CTE.
///
/// Walks each `name [(cols)] AS ( body )` in turn — tracking quotes, comments
/// and nesting so an `AS` or comma inside a CTE body is not mistaken for
/// structure — and returns whatever follows the last one.
pub fn statement_after_cte(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut i = skip_trivia(&chars, 0);
    if !match_word(&chars, i, "WITH") {
        return sql.trim().to_string();
    }
    i = skip_trivia(&chars, i + 4);
    if match_word(&chars, i, "RECURSIVE") {
        i = skip_trivia(&chars, i + 9);
    }

    loop {
        // Find this CTE's `AS` at nesting depth zero. An optional column list
        // sits at depth one, and so do any aliases inside a previous body.
        let mut depth = 0usize;
        let mut found_as = None;
        while i < chars.len() {
            let c = chars[i];
            if c == '\'' || c == '"' || c == '`' {
                i = skip_quoted(&chars, i);
                continue;
            }
            let after_trivia = skip_trivia(&chars, i);
            if after_trivia != i {
                i = after_trivia;
                continue;
            }
            if c == '(' {
                depth += 1;
            } else if c == ')' {
                depth = depth.saturating_sub(1);
            } else if depth == 0 && match_word(&chars, i, "AS") {
                found_as = Some(i + 2);
                break;
            }
            i += 1;
        }
        let Some(after_as) = found_as else {
            // Malformed or unrecognised — fall back to the whole statement
            // rather than guessing, which keeps the safety check conservative.
            return sql.trim().to_string();
        };

        // Skip the parenthesised body.
        i = skip_trivia(&chars, after_as);
        if i >= chars.len() || chars[i] != '(' {
            return sql.trim().to_string();
        }
        let mut depth = 0usize;
        while i < chars.len() {
            let c = chars[i];
            if c == '\'' || c == '"' || c == '`' {
                i = skip_quoted(&chars, i);
                continue;
            }
            let after_trivia = skip_trivia(&chars, i);
            if after_trivia != i {
                i = after_trivia;
                continue;
            }
            if c == '(' {
                depth += 1;
            } else if c == ')' {
                depth -= 1;
                if depth == 0 {
                    i += 1;
                    break;
                }
            }
            i += 1;
        }

        i = skip_trivia(&chars, i);
        if i < chars.len() && chars[i] == ',' {
            i = skip_trivia(&chars, i + 1);
            continue;
        }
        return chars[i..].iter().collect::<String>().trim().to_string();
    }
}

/// The keyword that decides what a statement does, uppercased.
///
/// Looks through a leading CTE and past leading comments and any `(` opening a
/// parenthesised SELECT.
pub fn effective_verb(sql: &str) -> String {
    let inner = statement_after_cte(sql);
    let chars: Vec<char> = inner.chars().collect();
    let mut i = skip_trivia(&chars, 0);
    while i < chars.len() && chars[i] == '(' {
        i = skip_trivia(&chars, i + 1);
    }
    if i >= chars.len() {
        return String::new();
    }
    word_at(&chars, i)
}

/// Whether a statement carries nothing but whitespace and comments.
///
/// The statement splitter emits a trailing `-- note` as its own entry, which
/// would otherwise make an ordinary commented query look like a script (#418).
pub fn is_blank_or_comment_only(sql: &str) -> bool {
    let chars: Vec<char> = sql.chars().collect();
    skip_trivia(&chars, 0) >= chars.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_statement_without_a_cte_is_returned_as_is() {
        assert_eq!(effective_verb("SELECT 1"), "SELECT");
        assert_eq!(effective_verb("  delete from t  "), "DELETE");
        assert_eq!(effective_verb("(SELECT 1)"), "SELECT");
        assert_eq!(effective_verb("-- note\nSELECT 1"), "SELECT");
        assert_eq!(effective_verb("/* note */ SELECT 1"), "SELECT");
    }

    #[test]
    fn a_cte_prefixed_write_reads_as_the_write() {
        // The finding this module exists for: MySQL 8 runs this as a DELETE.
        assert_eq!(
            effective_verb("WITH doomed AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM doomed)"),
            "DELETE"
        );
        assert_eq!(
            effective_verb("WITH x AS (SELECT 1) UPDATE t SET a = 1"),
            "UPDATE"
        );
        assert_eq!(
            effective_verb("with x as (select 1) select * from x"),
            "SELECT"
        );
    }

    #[test]
    fn several_ctes_are_walked_in_turn() {
        assert_eq!(
            effective_verb("WITH a AS (SELECT 1), b AS (SELECT 2) DELETE FROM t"),
            "DELETE"
        );
        assert_eq!(
            effective_verb("WITH a AS (SELECT 1), b AS (SELECT 2), c AS (SELECT 3) SELECT 1"),
            "SELECT"
        );
    }

    #[test]
    fn recursive_and_column_lists_are_handled() {
        assert_eq!(
            effective_verb("WITH RECURSIVE t (n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n < 5) SELECT * FROM t"),
            "SELECT"
        );
        assert_eq!(
            effective_verb("WITH x (a, b) AS (SELECT 1, 2) DELETE FROM t"),
            "DELETE"
        );
    }

    #[test]
    fn structure_inside_a_body_is_not_mistaken_for_structure() {
        // Nested parens, an aliasing AS, and a comma all sit inside the body.
        assert_eq!(
            effective_verb("WITH x AS (SELECT (1 + 2) AS n, 3 FROM (SELECT 1) y) DELETE FROM t"),
            "DELETE"
        );
        // A comma and the word AS inside a string literal.
        assert_eq!(
            effective_verb("WITH x AS (SELECT 'a, b AS c') DELETE FROM t"),
            "DELETE"
        );
        // A quoted identifier containing a parenthesis.
        assert_eq!(
            effective_verb("WITH x AS (SELECT 1 AS `we(ird`) DELETE FROM t"),
            "DELETE"
        );
    }

    #[test]
    fn a_table_named_with_is_not_read_as_a_cte() {
        // WITHDRAWALS starts with WITH but is one word.
        assert_eq!(effective_verb("SELECT * FROM withdrawals"), "SELECT");
        assert_eq!(
            effective_verb("INSERT INTO withdrawals VALUES (1)"),
            "INSERT"
        );
    }

    #[test]
    fn malformed_input_falls_back_to_the_whole_statement() {
        // No AS at all — better to report WITH and be treated as unrecognised
        // (and therefore unsafe) than to guess.
        assert_eq!(effective_verb("WITH"), "WITH");
        assert_eq!(effective_verb("WITH x"), "WITH");
        assert_eq!(effective_verb(""), "");
    }

    #[test]
    fn comment_only_statements_are_recognised() {
        assert!(is_blank_or_comment_only(""));
        assert!(is_blank_or_comment_only("   \n  "));
        assert!(is_blank_or_comment_only("-- just a note"));
        assert!(is_blank_or_comment_only("/* block */"));
        assert!(is_blank_or_comment_only("-- one\n /* two */ \n-- three"));
        assert!(!is_blank_or_comment_only("SELECT 1"));
        assert!(!is_blank_or_comment_only("-- note\nSELECT 1"));
    }
}
