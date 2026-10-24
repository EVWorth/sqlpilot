//! Strip credentials out of a statement before it is written to a log.
//!
//! A statement like `CREATE USER 'x'@'%' IDENTIFIED BY 's3cret'` carries the
//! password in its text. History already redacts these on the way into
//! storage (`src/lib/sql-redact.ts`, #587); the log file recorded the same
//! statements verbatim (#875). This is a port of the frontend's credential
//! rules, kept faithful so that what history hides the log hides too. A change
//! to one belongs in the other.
//!
//! The statement that runs is untouched. Only the copy that is logged loses its
//! credential literals.

use std::borrow::Cow;

/// What replaces a credential literal, quotes and all.
pub const REDACTION: &str = "<redacted>";

/// How much of a statement a span or log line records, in characters, after
/// credentials are redacted. Enough to recognise the statement by.
pub const LOG_PREVIEW_CHARS: usize = 100;

/// How much of the redacted text a literal's context check looks back over,
/// in characters. Matches the frontend, and keeps the scan linear on a long
/// statement rather than re-matching the whole prefix per literal.
const CONTEXT_CHARS: usize = 120;

/// A statement with its credential literals replaced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redacted<'a> {
    pub sql: Cow<'a, str>,
    /// True when at least one literal was replaced.
    pub redacted: bool,
}

/// Replace credential literals in `sql` with [`REDACTION`].
///
/// The result is deliberately not runnable where a literal was removed: a
/// plausible-looking placeholder could be mistaken for the real value.
pub fn redact_credentials(sql: &str) -> Redacted<'_> {
    let literals = find_literals(sql);
    if literals.is_empty() {
        return Redacted {
            sql: Cow::Borrowed(sql),
            redacted: false,
        };
    }

    let mut out = String::with_capacity(sql.len());
    let mut cursor = 0;
    let mut redacted = false;

    for (start, end) in literals {
        out.push_str(&sql[cursor..start]);
        cursor = end;

        if credential_precedes(&tail(&out, CONTEXT_CHARS)) {
            out.push_str(REDACTION);
            redacted = true;
        } else {
            out.push_str(&sql[start..end]);
        }
    }
    out.push_str(&sql[cursor..]);

    if redacted {
        Redacted {
            sql: Cow::Owned(out),
            redacted,
        }
    } else {
        Redacted {
            sql: Cow::Borrowed(sql),
            redacted,
        }
    }
}

/// The first `max_chars` characters of `sql`, with credentials redacted, for
/// a log line.
///
/// Redacting the prefix alone is as safe as redacting the whole statement and
/// truncating: a credential literal that starts inside the prefix is preceded
/// by its keyword inside the prefix too, and one cut off by the prefix reads as
/// unterminated, which is redacted rather than trusted. It keeps the cost of a
/// log line bounded however long the script is.
pub fn redacted_preview(sql: &str, max_chars: usize) -> String {
    let cut = sql
        .char_indices()
        .nth(max_chars)
        .map_or(sql.len(), |(i, _)| i);
    redact_credentials(&sql[..cut]).sql.into_owned()
}

/// The last `n` characters of `s`.
fn tail(s: &str, n: usize) -> Vec<char> {
    let start = s
        .char_indices()
        .rev()
        .nth(n.saturating_sub(1))
        .map_or(0, |(i, _)| i);
    s[start..].chars().collect()
}

/// Every string literal in `sql` as byte ranges, skipping comments and
/// backtick identifiers.
///
/// Handles both escape conventions, a backslash and a doubled quote: a
/// password containing a quote is exactly the case where a naive scan would
/// end the literal early and leave the rest of it in the recorded text.
///
/// Works on bytes. Every delimiter is ASCII, and no byte of a multi-byte UTF-8
/// character is, so each range starts and ends on a character boundary.
fn find_literals(sql: &str) -> Vec<(usize, usize)> {
    let b = sql.as_bytes();
    let len = b.len();
    let at = |i: usize| b.get(i).copied();
    let line_end = |from: usize| {
        b[from.min(len)..]
            .iter()
            .position(|&c| c == b'\n')
            .map_or(len, |p| from + p + 1)
    };

    let mut found = Vec::new();
    let mut i = 0;

    while i < len {
        let ch = b[i];

        // Comments cannot contain a literal worth redacting, and their
        // contents would otherwise unbalance the quote scan.
        if (ch == b'-' && at(i + 1) == Some(b'-')) || ch == b'#' {
            i = line_end(i);
            continue;
        }
        if ch == b'/' && at(i + 1) == Some(b'*') {
            i = b[i + 2..]
                .windows(2)
                .position(|w| w == b"*/")
                .map_or(len, |p| i + 2 + p + 2);
            continue;
        }
        // Backtick-quoted identifiers are not string literals, but they can
        // hold quote characters, so they are stepped over rather than scanned.
        if ch == b'`' {
            let mut j = i + 1;
            while j < len {
                if b[j] == b'`' && at(j + 1) == Some(b'`') {
                    j += 2;
                } else if b[j] == b'`' {
                    break;
                } else {
                    j += 1;
                }
            }
            i = j + 1;
            continue;
        }

        if ch == b'\'' || ch == b'"' {
            let quote = ch;
            let mut j = i + 1;
            while j < len {
                // A backslash escape, or a doubled quote.
                if b[j] == b'\\' || (b[j] == quote && at(j + 1) == Some(quote)) {
                    j += 2;
                } else if b[j] == quote {
                    break;
                } else {
                    j += 1;
                }
            }
            // An unterminated literal runs to the end of the text. Treating
            // it as a literal anyway is the safe reading: a truncated
            // statement should not become a way to keep a password.
            let end = (j + 1).min(len);
            found.push((i, end));
            i = end;
            continue;
        }

        i += 1;
    }

    found
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\b` before position `i`, for a keyword that starts with a word character.
fn boundary_before(s: &[char], i: usize) -> bool {
    i == 0 || !is_word(s[i - 1])
}

/// Step back over whitespace ending at `i`; the new position and how many
/// characters were stepped over.
fn ws_back(s: &[char], mut i: usize) -> (usize, usize) {
    let end = i;
    while i > 0 && s[i - 1].is_whitespace() {
        i -= 1;
    }
    (i, end - i)
}

/// `kw` (ASCII, case-insensitive) ending at `i`, and where it starts.
fn kw_back(s: &[char], i: usize, kw: &str) -> Option<usize> {
    let n = kw.len();
    if i < n {
        return None;
    }
    let start = i - n;
    s[start..i]
        .iter()
        .zip(kw.chars())
        .all(|(a, b)| a.eq_ignore_ascii_case(&b))
        .then_some(start)
}

/// `kw` (ASCII, case-insensitive) starting at `i`, and where it ends.
fn kw_fwd(s: &[char], i: usize, kw: &str) -> Option<usize> {
    let end = i + kw.len();
    if end > s.len() {
        return None;
    }
    s[i..end]
        .iter()
        .zip(kw.chars())
        .all(|(a, b)| a.eq_ignore_ascii_case(&b))
        .then_some(end)
}

/// Whether the text before a literal makes it a credential.
///
/// Each rule mirrors one of `CREDENTIAL_PRECEDES` in `src/lib/sql-redact.ts`,
/// anchored at the end of `context`. Working from the keyword to the literal,
/// rather than pattern-matching whole statements, means an unfamiliar
/// statement shape cannot smuggle a password past by putting it somewhere a
/// whole-statement pattern did not expect.
fn credential_precedes(context: &[char]) -> bool {
    identified_by(context)
        || identified_with(context)
        || password_eq_or_paren(context)
        || set_password_for(context)
        || replication_password(context)
        || password_space(context)
}

/// `\bIDENTIFIED\s+BY\s+(?:PASSWORD\s+)?$`: CREATE USER ... IDENTIFIED BY 'pw'
/// and IDENTIFIED BY PASSWORD '<hash>'.
fn identified_by(s: &[char]) -> bool {
    let (i, n) = ws_back(s, s.len());
    if n == 0 {
        return false;
    }
    let by_then_identified = |i: usize| {
        let Some(i) = kw_back(s, i, "BY") else {
            return false;
        };
        let (i, n) = ws_back(s, i);
        n > 0 && kw_back(s, i, "IDENTIFIED").is_some_and(|i| boundary_before(s, i))
    };
    // With the optional PASSWORD, then without it.
    if let Some(j) = kw_back(s, i, "PASSWORD") {
        let (j, n) = ws_back(s, j);
        if n > 0 && by_then_identified(j) {
            return true;
        }
    }
    by_then_identified(i)
}

/// ``\bIDENTIFIED\s+WITH\s+[`"'\w]+\s+(?:BY|AS)\s+$``: MySQL's plugin form,
/// IDENTIFIED WITH caching_sha2_password BY 'pw' | AS '<hash>'.
fn identified_with(s: &[char]) -> bool {
    let (i, n) = ws_back(s, s.len());
    if n == 0 {
        return false;
    }
    let Some(i) = kw_back(s, i, "BY").or_else(|| kw_back(s, i, "AS")) else {
        return false;
    };
    let (mut i, n) = ws_back(s, i);
    if n == 0 {
        return false;
    }
    let plugin_end = i;
    while i > 0 && (is_word(s[i - 1]) || matches!(s[i - 1], '`' | '"' | '\'')) {
        i -= 1;
    }
    if i == plugin_end {
        return false;
    }
    let (i, n) = ws_back(s, i);
    if n == 0 {
        return false;
    }
    let Some(i) = kw_back(s, i, "WITH") else {
        return false;
    };
    let (i, n) = ws_back(s, i);
    n > 0 && kw_back(s, i, "IDENTIFIED").is_some_and(|i| boundary_before(s, i))
}

/// `\bPASSWORD\s*(?:=|\()\s*$`: SET PASSWORD = 'pw', and the legacy
/// PASSWORD('pw') wrapper.
fn password_eq_or_paren(s: &[char]) -> bool {
    let (i, _) = ws_back(s, s.len());
    if i == 0 || !matches!(s[i - 1], '=' | '(') {
        return false;
    }
    let (i, _) = ws_back(s, i - 1);
    kw_back(s, i, "PASSWORD").is_some_and(|i| boundary_before(s, i))
}

/// `\bSET\s+PASSWORD\b[^;]*=\s*$`: SET PASSWORD FOR 'u'@'h' = 'pw'. The target
/// sits between the keyword and the literal, so this reaches over it without
/// crossing a statement break.
fn set_password_for(s: &[char]) -> bool {
    let (eq, _) = ws_back(s, s.len());
    if eq == 0 || s[eq - 1] != '=' {
        return false;
    }
    let eq = eq - 1;
    let from = s[..eq].iter().rposition(|&c| c == ';').map_or(0, |p| p + 1);
    (from..eq).any(|i| {
        if !boundary_before(s, i) {
            return false;
        }
        let Some(j) = kw_fwd(s, i, "SET") else {
            return false;
        };
        let mut k = j;
        while k < eq && s[k].is_whitespace() {
            k += 1;
        }
        if k == j {
            return false;
        }
        // PASSWORD ends at or before the `=`, which is not a word character,
        // so `\b` after it holds whenever the next character is not one.
        kw_fwd(s, k, "PASSWORD").is_some_and(|end| end <= eq && !is_word(s[end]))
    })
}

/// `\b(?:MASTER_PASSWORD|SOURCE_PASSWORD)\s*=\s*$`: CHANGE MASTER TO
/// MASTER_PASSWORD = 'pw', and its 8.0 rename.
fn replication_password(s: &[char]) -> bool {
    let (i, _) = ws_back(s, s.len());
    if i == 0 || s[i - 1] != '=' {
        return false;
    }
    let (i, _) = ws_back(s, i - 1);
    ["MASTER_PASSWORD", "SOURCE_PASSWORD"]
        .iter()
        .any(|kw| kw_back(s, i, kw).is_some_and(|i| boundary_before(s, i)))
}

/// `\bPASSWORD\s+$`: CREATE SERVER ... OPTIONS (USER 'u', PASSWORD 'pw').
fn password_space(s: &[char]) -> bool {
    let (i, n) = ws_back(s, s.len());
    n > 0 && kw_back(s, i, "PASSWORD").is_some_and(|i| boundary_before(s, i))
}

#[cfg(test)]
mod tests {
    use super::*;

    // These mirror `src/lib/__tests__/sql-redact.test.ts`, so the log and
    // history agree on what a credential is.

    /// Assert the secret is gone and the statement still reads as itself.
    fn expect_redacted(sql: &str, secret: &str) -> String {
        let result = redact_credentials(sql);
        assert!(result.redacted, "not redacted: {sql}");
        assert!(!result.sql.contains(secret), "secret kept: {}", result.sql);
        assert!(result.sql.contains(REDACTION));
        result.sql.into_owned()
    }

    fn expect_untouched(sql: &str) {
        let result = redact_credentials(sql);
        assert_eq!(
            result,
            Redacted {
                sql: Cow::Borrowed(sql),
                redacted: false
            }
        );
    }

    #[test]
    fn create_user_identified_by() {
        let sql = expect_redacted("CREATE USER 'app'@'%' IDENTIFIED BY 's3cret'", "s3cret");
        // The user and host are not credentials and stay readable.
        assert_eq!(
            sql,
            format!("CREATE USER 'app'@'%' IDENTIFIED BY {REDACTION}")
        );
    }

    #[test]
    fn alter_user_identified_by() {
        expect_redacted(
            "ALTER USER 'app'@'localhost' IDENTIFIED BY 'hunter2'",
            "hunter2",
        );
    }

    #[test]
    fn identified_by_password_hash() {
        expect_redacted(
            "CREATE USER 'a'@'%' IDENTIFIED BY PASSWORD '*ABC123'",
            "*ABC123",
        );
    }

    #[test]
    fn plugin_form_by() {
        expect_redacted(
            "CREATE USER 'a'@'%' IDENTIFIED WITH caching_sha2_password BY 'pw'",
            "'pw'",
        );
    }

    #[test]
    fn plugin_form_as_hash() {
        expect_redacted(
            "CREATE USER 'a'@'%' IDENTIFIED WITH mysql_native_password AS '*DEADBEEF'",
            "*DEADBEEF",
        );
    }

    #[test]
    fn plugin_form_quoted_plugin_name() {
        expect_redacted(
            "CREATE USER 'a'@'%' IDENTIFIED WITH 'caching_sha2_password' BY 'pw9'",
            "pw9",
        );
    }

    #[test]
    fn set_password_for_user() {
        expect_redacted("SET PASSWORD FOR 'a'@'%' = 'topsecret'", "topsecret");
    }

    #[test]
    fn legacy_password_wrapper() {
        expect_redacted("SET PASSWORD = PASSWORD('topsecret')", "topsecret");
    }

    #[test]
    fn grant_identified_by() {
        expect_redacted(
            "GRANT ALL ON db.* TO 'a'@'%' IDENTIFIED BY 'legacy'",
            "legacy",
        );
    }

    #[test]
    fn replication_passwords_both_spellings() {
        expect_redacted("CHANGE MASTER TO MASTER_PASSWORD = 'replpw'", "replpw");
        expect_redacted(
            "CHANGE REPLICATION SOURCE TO SOURCE_PASSWORD = 'replpw'",
            "replpw",
        );
    }

    #[test]
    fn create_server_options() {
        expect_redacted(
            "CREATE SERVER s FOREIGN DATA WRAPPER mysql OPTIONS (USER 'u', PASSWORD 'pw2')",
            "'pw2'",
        );
    }

    #[test]
    fn keywords_are_case_and_whitespace_insensitive() {
        expect_redacted("create user 'a'@'%'\n  identified   by\n  'lower'", "lower");
    }

    #[test]
    fn backslash_escaped_quote() {
        expect_redacted("ALTER USER 'a'@'%' IDENTIFIED BY 'it\\'s mine'", "mine");
    }

    #[test]
    fn doubled_quote() {
        expect_redacted("ALTER USER 'a'@'%' IDENTIFIED BY 'it''s mine'", "mine");
    }

    #[test]
    fn double_quoted_password() {
        expect_redacted("ALTER USER 'a'@'%' IDENTIFIED BY \"s3cret\"", "s3cret");
    }

    #[test]
    fn double_quoted_password_with_escapes() {
        expect_redacted(
            "ALTER USER 'a'@'%' IDENTIFIED BY \"say \\\"hi\\\" \"\"twice\"\"\"",
            "twice",
        );
    }

    #[test]
    fn semicolon_inside_password_mid_batch() {
        let sql = expect_redacted(
            "SELECT 1; ALTER USER 'a'@'%' IDENTIFIED BY 'a;b;c'; SELECT 2",
            "a;b;c",
        );
        assert!(sql.contains("SELECT 1;"));
        assert!(sql.contains("SELECT 2"));
    }

    #[test]
    fn password_that_looks_like_a_keyword() {
        expect_redacted(
            "ALTER USER 'a'@'%' IDENTIFIED BY 'IDENTIFIED BY'",
            "'IDENTIFIED BY'",
        );
    }

    #[test]
    fn unterminated_literal_is_redacted() {
        let result = redact_credentials("ALTER USER 'a'@'%' IDENTIFIED BY 'half-typed");
        assert!(result.redacted);
        assert!(!result.sql.contains("half-typed"));
    }

    #[test]
    fn several_in_one_batch() {
        let result = redact_credentials(
            "CREATE USER 'a'@'%' IDENTIFIED BY 'first'; CREATE USER 'b'@'%' IDENTIFIED BY 'second'",
        );
        assert!(!result.sql.contains("first"));
        assert!(!result.sql.contains("second"));
    }

    #[test]
    fn non_ascii_text_around_a_password() {
        let sql = expect_redacted(
            "-- ünïcødé\nCREATE USER 'ü'@'%' IDENTIFIED BY 'pässwörd'; SELECT 'ok'",
            "pässwörd",
        );
        assert!(sql.contains("'ü'@'%'"));
        assert!(sql.ends_with("SELECT 'ok'"));
    }

    #[test]
    fn ordinary_select_untouched() {
        expect_untouched("SELECT * FROM users WHERE name = 'alice'");
    }

    #[test]
    fn column_called_password_untouched() {
        expect_untouched("SELECT password FROM users WHERE email = 'a@b.c'");
    }

    #[test]
    fn update_of_password_column_is_redacted() {
        // `SET password = '...'` is indistinguishable from `SET PASSWORD =
        // '...'` by keyword alone, so this one IS redacted: over-redacting a
        // column write costs nothing, under-redacting a credential costs the
        // password.
        let result = redact_credentials("UPDATE users SET password = 'x' WHERE id = 1");
        assert!(result.redacted);
    }

    #[test]
    fn unrelated_keyword_untouched() {
        expect_untouched("INSERT INTO audit (action) VALUES ('identified the issue')");
    }

    #[test]
    fn keyword_in_line_comment_untouched() {
        expect_untouched("-- IDENTIFIED BY\nSELECT 'kept'");
        expect_untouched("# IDENTIFIED BY\nSELECT 'kept'");
    }

    #[test]
    fn keyword_in_block_comment_untouched() {
        expect_untouched("/* IDENTIFIED BY */ SELECT 'kept'");
    }

    #[test]
    fn backtick_identifier_with_quote_untouched() {
        expect_untouched("SELECT `it's odd` FROM t WHERE x = 'plain'");
    }

    #[test]
    fn no_literals_untouched() {
        expect_untouched("SHOW GRANTS");
    }

    #[test]
    fn empty_untouched() {
        expect_untouched("");
    }

    #[test]
    fn preview_redacts_and_truncates() {
        let preview = redacted_preview("CREATE USER 'a'@'%' IDENTIFIED BY 'hunter2'", 100);
        assert_eq!(
            preview,
            format!("CREATE USER 'a'@'%' IDENTIFIED BY {REDACTION}")
        );

        let preview = redacted_preview("SELECT 'abcdef'", 10);
        assert_eq!(preview, "SELECT 'ab");
    }

    #[test]
    fn preview_cut_inside_a_password_keeps_none_of_it() {
        // The cut leaves the literal unterminated, which is still redacted.
        let preview = redacted_preview("ALTER USER 'a'@'%' IDENTIFIED BY 'hunter2'", 38);
        assert!(!preview.contains("hun"), "{preview}");
        assert!(preview.contains(REDACTION));
    }

    #[test]
    fn preview_counts_characters_not_bytes() {
        assert_eq!(redacted_preview("ééééé", 3), "ééé");
    }
}
