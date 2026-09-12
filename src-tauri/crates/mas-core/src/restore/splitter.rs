/// Splitting a dump into statements, a chunk at a time.
///
/// The restore used to read the whole file into a JavaScript string, split it
/// in the renderer and send the pieces back one by one. That caps a restore at
/// whatever the WebView can hold, and it means the file crosses the IPC
/// boundary in full before the first statement runs.
///
/// This is fed bytes as they are read and yields statements as they complete,
/// so memory is bounded by the longest single statement rather than by the
/// file. The rules are MySQL's: `''` and `\'` inside a string, `--` only when
/// followed by whitespace, `#` and `/* */` comments, backtick and
/// double-quote identifiers, and `DELIMITER` to change the terminator for
/// stored programs.
#[derive(Debug, Default)]
pub struct StatementSplitter {
    current: String,
    delimiter: String,
    state: State,
    /// Set while the last character was a backslash inside a string, so an
    /// escaped quote spanning a chunk boundary is still one escape.
    escaped: bool,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum State {
    #[default]
    Sql,
    SingleQuote,
    DoubleQuote,
    Backtick,
    LineComment,
    BlockComment,
}

/// Why a file could not be split.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SplitError {
    /// The file ended inside a string, a comment or a statement.
    ///
    /// A truncated dump used to leave the splitter waiting for a terminator
    /// that never came: no progress, no error, and nothing to tell the user
    /// their file was cut short (#360).
    Truncated { what: &'static str, tail: String },
}

impl std::fmt::Display for SplitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SplitError::Truncated { what, tail } => write!(
                f,
                "The file ends in the middle of {what} — it looks truncated. \
                 The last thing in it was: {tail}"
            ),
        }
    }
}

impl StatementSplitter {
    pub fn new() -> Self {
        Self {
            current: String::new(),
            delimiter: ";".to_string(),
            state: State::Sql,
            escaped: false,
        }
    }

    /// Feed some more of the file. Returns whatever statements completed.
    pub fn push(&mut self, text: &str) -> Vec<String> {
        let mut out = Vec::new();
        let chars: Vec<char> = text.chars().collect();
        let mut i = 0;

        while i < chars.len() {
            let ch = chars[i];
            let next = chars.get(i + 1).copied();

            match self.state {
                State::LineComment => {
                    self.current.push(ch);
                    if ch == '\n' {
                        self.state = State::Sql;
                    }
                    i += 1;
                }
                State::BlockComment => {
                    self.current.push(ch);
                    if ch == '*' && next == Some('/') {
                        self.current.push('/');
                        self.state = State::Sql;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                State::SingleQuote => {
                    self.current.push(ch);
                    if self.escaped {
                        // Whatever follows a backslash is literal, including
                        // a quote and another backslash.
                        self.escaped = false;
                    } else if ch == '\\' {
                        self.escaped = true;
                    } else if ch == '\'' {
                        if next == Some('\'') {
                            // A doubled quote is one quote, not the end.
                            self.current.push('\'');
                            i += 1;
                        } else {
                            self.state = State::Sql;
                        }
                    }
                    i += 1;
                }
                State::DoubleQuote | State::Backtick => {
                    let closing = if self.state == State::DoubleQuote {
                        '"'
                    } else {
                        '`'
                    };
                    self.current.push(ch);
                    if ch == closing {
                        self.state = State::Sql;
                    }
                    i += 1;
                }
                State::Sql => {
                    // `--` opens a comment only when whitespace follows it,
                    // which is what keeps `5--1` arithmetic.
                    if ch == '-' && next == Some('-') {
                        let after = chars.get(i + 2).copied().unwrap_or('\n');
                        if after.is_whitespace() {
                            self.state = State::LineComment;
                            self.current.push(ch);
                            i += 1;
                            continue;
                        }
                    }
                    if ch == '#' {
                        self.state = State::LineComment;
                        self.current.push(ch);
                        i += 1;
                        continue;
                    }
                    if ch == '/' && next == Some('*') {
                        self.state = State::BlockComment;
                        self.current.push(ch);
                        i += 1;
                        continue;
                    }
                    if ch == '\'' {
                        self.state = State::SingleQuote;
                        self.current.push(ch);
                        i += 1;
                        continue;
                    }
                    if ch == '"' {
                        self.state = State::DoubleQuote;
                        self.current.push(ch);
                        i += 1;
                        continue;
                    }
                    if ch == '`' {
                        self.state = State::Backtick;
                        self.current.push(ch);
                        i += 1;
                        continue;
                    }

                    // DELIMITER, only at the start of a statement. Matching it
                    // anywhere let a column called `delimiter` change the
                    // terminator mid-file.
                    if self.current.trim().is_empty() && starts_with_delimiter(&chars[i..]) {
                        let rest: String = chars[i + "DELIMITER".len()..].iter().collect();
                        let line_end = rest.find('\n').unwrap_or(rest.len());
                        let word = rest[..line_end].trim().to_string();
                        if !word.is_empty() {
                            self.delimiter = word;
                            self.current.clear();
                            i += "DELIMITER".len() + line_end;
                            continue;
                        }
                    }

                    if matches_at(&chars, i, &self.delimiter) {
                        let statement = self.current.trim().to_string();
                        if !statement.is_empty() {
                            out.push(statement);
                        }
                        self.current.clear();
                        i += self.delimiter.chars().count();
                        continue;
                    }

                    self.current.push(ch);
                    i += 1;
                }
            }
        }
        out
    }

    /// No more input. Returns the last statement if the file ended cleanly.
    ///
    /// A file may end without a final terminator — mysqldump's do not, but
    /// hand-written ones often do — so a complete trailing statement is
    /// returned rather than refused. Ending inside a string, a comment or a
    /// custom delimiter block is a truncated file, and says so.
    pub fn finish(self) -> Result<Option<String>, SplitError> {
        let tail = self.current.trim().to_string();
        let what = match self.state {
            State::SingleQuote => Some("a quoted string"),
            State::DoubleQuote | State::Backtick => Some("a quoted identifier"),
            State::BlockComment => Some("a /* */ comment"),
            State::Sql | State::LineComment => None,
        };
        if let Some(what) = what {
            return Err(SplitError::Truncated {
                what,
                tail: snippet(&tail),
            });
        }
        // A non-`;` delimiter still in force means a stored program was opened
        // and never closed — the case that used to hang.
        if self.delimiter != ";" && !tail.is_empty() {
            return Err(SplitError::Truncated {
                what: "a stored program, with its DELIMITER never restored",
                tail: snippet(&tail),
            });
        }
        Ok(if tail.is_empty() { None } else { Some(tail) })
    }
}

/// Enough of the tail to recognise the file, without printing a megabyte.
fn snippet(text: &str) -> String {
    let cleaned = text.replace('\n', " ");
    if cleaned.chars().count() <= 120 {
        return cleaned;
    }
    let head: String = cleaned.chars().take(120).collect();
    format!("{head}…")
}

fn starts_with_delimiter(chars: &[char]) -> bool {
    let word = "DELIMITER";
    if chars.len() < word.len() + 1 {
        return false;
    }
    chars[..word.len()]
        .iter()
        .zip(word.chars())
        .all(|(a, b)| a.eq_ignore_ascii_case(&b))
        && chars[word.len()].is_whitespace()
}

fn matches_at(chars: &[char], index: usize, needle: &str) -> bool {
    let needle: Vec<char> = needle.chars().collect();
    if index + needle.len() > chars.len() {
        return false;
    }
    chars[index..index + needle.len()] == needle[..]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(sql: &str) -> Result<Vec<String>, SplitError> {
        let mut splitter = StatementSplitter::new();
        let mut out = splitter.push(sql);
        if let Some(last) = splitter.finish()? {
            out.push(last);
        }
        Ok(out)
    }

    #[test]
    fn splits_on_semicolons() {
        assert_eq!(
            split("SELECT 1; SELECT 2;").unwrap(),
            vec!["SELECT 1", "SELECT 2"]
        );
    }

    #[test]
    fn keeps_a_trailing_statement_without_a_terminator() {
        assert_eq!(
            split("SELECT 1; SELECT 2").unwrap(),
            vec!["SELECT 1", "SELECT 2"]
        );
    }

    #[test]
    fn a_semicolon_inside_a_string_is_not_a_boundary() {
        assert_eq!(
            split("INSERT INTO t VALUES ('a;b');").unwrap(),
            vec!["INSERT INTO t VALUES ('a;b')"]
        );
    }

    #[test]
    fn a_doubled_quote_does_not_end_the_string() {
        assert_eq!(
            split("INSERT INTO t VALUES ('it''s; fine');").unwrap(),
            vec!["INSERT INTO t VALUES ('it''s; fine')"]
        );
    }

    #[test]
    fn a_backslash_escaped_quote_does_not_end_the_string() {
        assert_eq!(
            split("INSERT INTO t VALUES ('a\\'; b');").unwrap(),
            vec!["INSERT INTO t VALUES ('a\\'; b')"]
        );
    }

    #[test]
    fn a_semicolon_in_a_comment_is_not_a_boundary() {
        assert_eq!(
            split("SELECT 1 -- a; b\n;").unwrap(),
            vec!["SELECT 1 -- a; b"]
        );
        assert_eq!(
            split("SELECT /* a; b */ 1;").unwrap(),
            vec!["SELECT /* a; b */ 1"]
        );
        assert_eq!(
            split("SELECT 1 # a; b\n;").unwrap(),
            vec!["SELECT 1 # a; b"]
        );
    }

    #[test]
    fn two_dashes_without_whitespace_are_arithmetic_not_a_comment() {
        assert_eq!(split("SELECT 5--1;").unwrap(), vec!["SELECT 5--1"]);
    }

    #[test]
    fn a_semicolon_inside_a_quoted_identifier_is_not_a_boundary() {
        assert_eq!(
            split("SELECT * FROM `odd;name`;").unwrap(),
            vec!["SELECT * FROM `odd;name`"]
        );
    }

    #[test]
    fn a_stored_program_under_its_own_delimiter_is_one_statement() {
        let sql = "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SET @a=1; SET @b=2; END$$\nDELIMITER ;\nSELECT 1;";
        let statements = split(sql).unwrap();
        assert_eq!(statements.len(), 2);
        assert!(statements[0].contains("SET @b=2"));
        assert_eq!(statements[1], "SELECT 1");
    }

    #[test]
    fn a_truncated_stored_program_is_an_error_rather_than_a_hang() {
        // The file ends with the custom delimiter still in force: the old
        // splitter waited for a terminator that never came, with no progress
        // and no error (#360).
        let err = split("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SET @a=1;").unwrap_err();
        assert!(matches!(err, SplitError::Truncated { .. }));
        assert!(err.to_string().contains("truncated"));
    }

    #[test]
    fn a_file_ending_inside_a_string_is_an_error() {
        let err = split("INSERT INTO t VALUES ('unfinished").unwrap_err();
        assert!(err.to_string().contains("quoted string"));
    }

    #[test]
    fn a_file_ending_inside_a_block_comment_is_an_error() {
        let err = split("SELECT 1 /* never closed").unwrap_err();
        assert!(err.to_string().contains("comment"));
    }

    #[test]
    fn the_error_quotes_enough_of_the_tail_to_recognise_the_file() {
        let err = split("INSERT INTO orders VALUES ('unfinished").unwrap_err();
        assert!(err.to_string().contains("INSERT INTO orders"));
    }

    #[test]
    fn the_error_does_not_quote_a_megabyte_back_at_the_user() {
        let long = format!("INSERT INTO t VALUES ('{}", "x".repeat(100_000));
        let err = split(&long).unwrap_err();
        assert!(err.to_string().len() < 400);
    }

    #[test]
    fn the_word_delimiter_in_a_statement_does_not_change_the_terminator() {
        // Only at the start of a statement. Matching it anywhere let a column
        // of that name break the rest of the file.
        let statements = split("SELECT delimiter FROM t; SELECT 2;").unwrap();
        assert_eq!(statements.len(), 2);
    }

    #[test]
    fn a_statement_split_across_chunks_is_still_one_statement() {
        // The point of feeding it a chunk at a time: the file is read in
        // pieces that fall wherever they fall.
        let mut splitter = StatementSplitter::new();
        let mut out = splitter.push("INSERT INTO t VALUES ('a;");
        out.extend(splitter.push("b'), ('c');"));
        out.extend(splitter.finish().unwrap());
        assert_eq!(out, vec!["INSERT INTO t VALUES ('a;b'), ('c')"]);
    }

    #[test]
    fn an_escape_across_a_chunk_boundary_is_still_an_escape() {
        let mut splitter = StatementSplitter::new();
        let mut out = splitter.push("SELECT 'a\\");
        out.extend(splitter.push("'; b';"));
        out.extend(splitter.finish().unwrap());
        assert_eq!(out, vec!["SELECT 'a\\'; b'"]);
    }

    #[test]
    fn a_delimiter_change_across_a_chunk_boundary_still_applies() {
        let mut splitter = StatementSplitter::new();
        let mut out = splitter.push("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SET @a=1;");
        out.extend(splitter.push(" END$$\nDELIMITER ;\n"));
        out.extend(splitter.finish().unwrap());
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("END"));
    }

    #[test]
    fn an_empty_file_yields_nothing() {
        assert!(split("").unwrap().is_empty());
        assert!(split("\n\n-- just a comment\n").unwrap().len() <= 1);
    }
}
