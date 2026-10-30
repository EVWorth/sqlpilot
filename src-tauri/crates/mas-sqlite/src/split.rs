//! Splitting a script into the statements SQLite will run (#928).
//!
//! SQLite's own answer to "where does this statement end" is
//! `sqlite3_complete`, the state machine the `sqlite3` shell uses to decide
//! whether a line finishes a statement. This is that state machine, ported
//! rather than called through FFI: it needs no `unsafe`, it can report where
//! each statement starts and ends, and it stays linear on a long script where
//! asking `sqlite3_complete` about every `;` would not.
//!
//! What it knows, as the original does: `'strings'`, `"identifiers"`,
//! `` `identifiers` `` and `[identifiers]` hide semicolons, as do `--` and
//! `/* */` comments, and the body of a `CREATE TRIGGER` runs to `END;` however
//! many semicolons are inside it.

/// The tokens the state machine tells apart. Everything else is `Other`.
#[derive(Clone, Copy)]
enum Token {
    Semi = 0,
    /// Whitespace and comments.
    Ws = 1,
    Other = 2,
    Explain = 3,
    Create = 4,
    Temp = 5,
    Trigger = 6,
    End = 7,
}

/// Where a statement is, so far, in SQLite's terms.
const INVALID: u8 = 0;
const START: u8 = 1;

/// `sqlite3_complete`'s transition table, row per state, column per token.
///
/// States: 0 invalid (nothing seen yet), 1 start (just after a complete
/// statement), 2 normal, 3 explain, 4 create, 5 inside a trigger body, 6 a
/// semicolon inside a trigger body, 7 `END` after such a semicolon.
const TRANSITIONS: [[u8; 8]; 8] = [
    //  SEMI WS OTHER EXPLAIN CREATE TEMP TRIGGER END
    [1, 0, 2, 3, 4, 2, 2, 2], // 0 invalid
    [1, 1, 2, 3, 4, 2, 2, 2], // 1 start
    [1, 2, 2, 2, 2, 2, 2, 2], // 2 normal
    [1, 3, 3, 2, 4, 2, 2, 2], // 3 explain
    [1, 4, 2, 2, 2, 4, 5, 2], // 4 create
    [6, 5, 5, 5, 5, 5, 5, 5], // 5 trigger
    [6, 6, 5, 5, 5, 5, 5, 7], // 6 semi
    [1, 7, 5, 5, 5, 5, 5, 5], // 7 end
];

/// One statement of a script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement<'a> {
    /// The text to hand SQLite, from where the statement starts up to and
    /// including its `;` when it has one. Leading comments are kept, so an
    /// error offset SQLite reports still lines up with what was sent.
    pub text: &'a str,
    /// The statement as a person reads it: trimmed, without the terminator.
    pub display: &'a str,
}

/// Split `sql` into the statements SQLite would run, in order.
///
/// A piece with nothing in it but whitespace, comments and semicolons is not
/// a statement and is left out, as SQLite's own batch runner skips it. A last
/// statement without a `;` is still a statement.
pub fn split_statements(sql: &str) -> Vec<Statement<'_>> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut state = INVALID;
    let mut start = 0;
    // Whether the current piece has a token that is not a comment.
    let mut has_content = false;
    let mut i = 0;

    while i < bytes.len() {
        let (token, len) = next_token(&bytes[i..]);
        state = TRANSITIONS[state as usize][token as usize];
        let end = i + len;
        match token {
            Token::Semi if state == START => {
                if has_content {
                    out.push(statement(sql, start, end));
                }
                start = end;
                has_content = false;
            }
            Token::Semi | Token::Ws => {}
            _ => has_content = true,
        }
        i = end;
    }

    if has_content {
        out.push(statement(sql, start, sql.len()));
    }
    out
}

fn statement(sql: &str, start: usize, end: usize) -> Statement<'_> {
    let text = &sql[start..end];
    let display = text.trim();
    let display = display.strip_suffix(';').unwrap_or(display).trim_end();
    Statement { text, display }
}

/// Whether a byte can be part of an identifier or keyword, as SQLite's
/// tokenizer has it: ASCII letters, digits, `_`, `$`, and every byte of a
/// multi-byte UTF-8 character.
fn is_id_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80
}

/// The token at the start of `rest`, and how many bytes it spans.
///
/// An unterminated string or comment runs to the end of the input, which
/// leaves the statement incomplete and lets SQLite report the error.
/// Token boundaries always fall on ASCII bytes or the end, so slicing the
/// script at them never splits a UTF-8 character.
fn next_token(rest: &[u8]) -> (Token, usize) {
    let to = |pos: Option<usize>, extra: usize| pos.map_or(rest.len(), |p| p + extra);
    match rest[0] {
        b';' => (Token::Semi, 1),
        b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' => (Token::Ws, 1),
        b'/' if rest.get(1) == Some(&b'*') => {
            // SQLite's tokenizer lets an unclosed comment run to the end of
            // the input, and so does this.
            let close = rest[2..].windows(2).position(|w| w == b"*/");
            (Token::Ws, to(close, 4))
        }
        b'-' if rest.get(1) == Some(&b'-') => {
            (Token::Ws, to(rest.iter().position(|&b| b == b'\n'), 1))
        }
        b'[' => (Token::Other, to(rest.iter().position(|&b| b == b']'), 1)),
        q @ (b'\'' | b'"' | b'`') => {
            // A doubled quote reads as two strings back to back, which is
            // the same thing for the purpose of finding a boundary.
            (Token::Other, to(rest[1..].iter().position(|&b| b == q), 2))
        }
        b if is_id_char(b) => {
            let len = rest
                .iter()
                .position(|&b| !is_id_char(b))
                .unwrap_or(rest.len());
            (keyword(&rest[..len]), len)
        }
        _ => (Token::Other, 1),
    }
}

fn keyword(word: &[u8]) -> Token {
    let is = |k: &str| word.eq_ignore_ascii_case(k.as_bytes());
    if is("create") {
        Token::Create
    } else if is("trigger") {
        Token::Trigger
    } else if is("temp") || is("temporary") {
        Token::Temp
    } else if is("end") {
        Token::End
    } else if is("explain") {
        Token::Explain
    } else {
        Token::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn displays(sql: &str) -> Vec<&str> {
        split_statements(sql)
            .into_iter()
            .map(|s| s.display)
            .collect()
    }

    #[test]
    fn splits_on_semicolons() {
        assert_eq!(
            displays("CREATE TABLE a(x); CREATE TABLE b(y);"),
            ["CREATE TABLE a(x)", "CREATE TABLE b(y)"]
        );
    }

    #[test]
    fn a_last_statement_needs_no_terminator() {
        assert_eq!(displays("SELECT 1;\nSELECT 2"), ["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn empty_pieces_are_not_statements() {
        assert_eq!(
            displays(";; SELECT 1;;\n-- trailing note\n/* and another */;"),
            ["SELECT 1"]
        );
        assert!(split_statements("   ").is_empty());
        assert!(split_statements("-- just a comment").is_empty());
        assert_eq!(
            displays("SELECT 1; /* never closed; SELECT 2"),
            ["SELECT 1"]
        );
    }

    #[test]
    fn semicolons_in_strings_and_identifiers_do_not_split() {
        assert_eq!(
            displays(
                "INSERT INTO t VALUES ('a;b', 'it''s; fine'); SELECT \"x;y\", `p;q`, [r;s] FROM t;"
            ),
            [
                "INSERT INTO t VALUES ('a;b', 'it''s; fine')",
                "SELECT \"x;y\", `p;q`, [r;s] FROM t",
            ]
        );
    }

    #[test]
    fn semicolons_in_comments_do_not_split() {
        assert_eq!(
            displays("SELECT 1 -- one; two\n; SELECT /* a;b */ 2;"),
            ["SELECT 1 -- one; two", "SELECT /* a;b */ 2"]
        );
    }

    #[test]
    fn a_trigger_body_runs_to_its_end() {
        let sql = "CREATE TABLE t(x);\n\
                   CREATE TEMP TRIGGER IF NOT EXISTS tr AFTER INSERT ON t BEGIN\n\
                     UPDATE t SET x = CASE WHEN x > 0 THEN 1 END;\n\
                     DELETE FROM t WHERE x IS NULL;\n\
                   END;\n\
                   INSERT INTO t VALUES (1);";
        let got = displays(sql);
        assert_eq!(got.len(), 3, "{got:?}");
        assert!(got[1].starts_with("CREATE TEMP TRIGGER"));
        assert!(got[1].ends_with("END"));
        assert_eq!(got[2], "INSERT INTO t VALUES (1)");
    }

    #[test]
    fn a_column_named_end_does_not_close_anything() {
        assert_eq!(
            displays("SELECT end FROM t; SELECT 2"),
            ["SELECT end FROM t", "SELECT 2"]
        );
    }

    #[test]
    fn the_text_keeps_the_terminator_and_leading_comments() {
        let parts = split_statements("-- first\nSELECT 1; SELECT 2");
        assert_eq!(parts[0].text, "-- first\nSELECT 1;");
        assert_eq!(parts[1].text, " SELECT 2");
    }

    #[test]
    fn an_unterminated_string_swallows_the_rest() {
        assert_eq!(displays("SELECT 'a; SELECT 2"), ["SELECT 'a; SELECT 2"]);
    }

    #[test]
    fn multibyte_text_is_sliced_safely() {
        assert_eq!(
            displays("SELECT 'héllo;'; SELECT ünïcode FROM t"),
            ["SELECT 'héllo;'", "SELECT ünïcode FROM t"]
        );
    }
}
