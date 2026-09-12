/// How a cell is written into a dump.
///
/// The dump reads rows over MySQL's **text** protocol, so every value arrives
/// as the bytes the server would print — the exact digits of a DECIMAL, the
/// full fractional seconds of a DATETIME(6), a BIGINT that no f64 could hold.
/// Formatting from those bytes rather than from a decoded value is what keeps
/// a dump a faithful copy: the previous generator decoded every cell through
/// the grid's value type, which formats DATETIME as `%Y-%m-%d %H:%M:%S` and so
/// silently dropped sub-second precision from every backup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellShape {
    /// Written bare: `42`, `-1.5`, `9223372036854775807`.
    Numeric,
    /// Written as `X'..'`, which needs no escaping in any SQL mode.
    Binary,
    /// Written as a quoted literal.
    Text,
}

/// What shape a column's values take, from the type name sqlx reports.
pub fn shape_of(type_name: &str) -> CellShape {
    let t = type_name.to_uppercase();
    let t = t.trim();
    match t {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" | "FLOAT"
        | "DOUBLE" | "REAL" | "DECIMAL" | "NUMERIC" | "YEAR" | "BOOLEAN" | "BOOL" => {
            CellShape::Numeric
        }
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "BIGINT UNSIGNED" | "FLOAT UNSIGNED" | "DOUBLE UNSIGNED" | "DECIMAL UNSIGNED" => {
            CellShape::Numeric
        }
        // BIT arrives as raw bits, not as digits, so hex is the only form that
        // round-trips. GEOMETRY is a binary blob with its own text syntax that
        // a dump cannot reconstruct from the bytes; hex restores identically.
        "BIT" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY"
        | "GEOMETRY" | "POINT" | "LINESTRING" | "POLYGON" | "MULTIPOINT" | "MULTILINESTRING"
        | "MULTIPOLYGON" | "GEOMETRYCOLLECTION" => CellShape::Binary,
        _ => CellShape::Text,
    }
}

/// One cell, as it goes into the file.
///
/// `raw` is None for a SQL NULL, which is the one case that must not be
/// quoted: `'NULL'` is the four-character string.
pub fn format_cell(raw: Option<&[u8]>, shape: CellShape) -> String {
    let Some(bytes) = raw else {
        return "NULL".to_string();
    };

    match shape {
        CellShape::Binary => hex_literal(bytes),
        CellShape::Numeric => match std::str::from_utf8(bytes) {
            // A number the server printed is already a literal. The guard is
            // for a column whose type we classified as numeric but whose
            // value is not — writing that bare would produce a file that does
            // not parse, so it falls back to a quoted string.
            Ok(text) if is_numeric_literal(text) => text.to_string(),
            Ok(text) => escape_string(text),
            Err(_) => hex_literal(bytes),
        },
        CellShape::Text => match std::str::from_utf8(bytes) {
            Ok(text) => escape_string(text),
            // Invalid UTF-8 in a text column happens — a latin1 column read
            // as utf8mb4, a column holding bytes it was never meant to. Hex
            // restores the bytes exactly; a lossy conversion would replace
            // them with U+FFFD and call it a backup.
            Err(_) => hex_literal(bytes),
        },
    }
}

fn hex_literal(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2 + 3);
    out.push_str("X'");
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out.push('\'');
    out
}

/// Whether text can be written into a dump without quotes.
fn is_numeric_literal(text: &str) -> bool {
    let mut chars = text.chars().peekable();
    if matches!(chars.peek(), Some('-') | Some('+')) {
        chars.next();
    }
    let mut mantissa_digits = 0;
    let mut exponent_digits = 0;
    let mut seen_dot = false;
    let mut seen_exp = false;
    let mut sign_allowed = false;
    for ch in chars {
        match ch {
            '0'..='9' => {
                if seen_exp {
                    exponent_digits += 1;
                } else {
                    mantissa_digits += 1;
                }
                sign_allowed = false;
            }
            '.' if !seen_dot && !seen_exp => {
                seen_dot = true;
                sign_allowed = false;
            }
            'e' | 'E' if !seen_exp && mantissa_digits > 0 => {
                seen_exp = true;
                // Only immediately after the `e`.
                sign_allowed = true;
            }
            '-' | '+' if sign_allowed => sign_allowed = false,
            _ => return false,
        }
    }
    // `1e` is not a number, and neither is `.`.
    mantissa_digits > 0 && (!seen_exp || exponent_digits > 0)
}

/// A string as a quoted literal.
///
/// A quote is escaped by doubling it rather than with a backslash. The
/// backslash form is not an escape under `NO_BACKSLASH_ESCAPES` — which ANSI
/// mode turns on — and there it does not merely fail: a value of
/// `x', 1); DROP TABLE victim; -- ` becomes `'x\', 1); DROP TABLE victim; -- '`,
/// whose `\` is literal, so the quote after it closes the string and the rest
/// of the row runs as SQL. Verified against MySQL 8.0.46, where it dropped the
/// table (#285).
///
/// The dump's header sets `SQL_MODE`, which clears that mode and is what makes
/// the file safe to restore whole. That is a good belt, but the escaping must
/// not depend on it: one INSERT copied out of a dump loses the protection.
/// Doubling is correct in both modes.
///
/// The remaining backslash escapes — `\n`, `\r`, `\0`, `\Z` and the doubled
/// backslash itself — are genuinely mode-dependent and cannot be written
/// portably inside a literal. They rely on the header, as mysqldump's do.
pub fn escape_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("''"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\0' => out.push_str("\\0"),
            '\u{1a}' => out.push_str("\\Z"),
            other => out.push(other),
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> String {
        format_cell(Some(s.as_bytes()), CellShape::Text)
    }

    #[test]
    fn a_quote_is_doubled_not_backslashed() {
        assert_eq!(text("it's"), "'it''s'");
    }

    #[test]
    fn the_injection_that_dropped_a_table_round_trips_as_data() {
        let escaped = text("x', 1); DROP TABLE victim; -- ");
        assert_eq!(escaped, "'x'', 1); DROP TABLE victim; -- '");
        assert!(!escaped.contains("\\'"));
    }

    #[test]
    fn a_backslash_is_doubled_and_control_characters_use_mysqldumps_forms() {
        assert_eq!(text("a\\b"), "'a\\\\b'");
        assert_eq!(text("a\nb"), "'a\\nb'");
        assert_eq!(text("a\rb"), "'a\\rb'");
        assert_eq!(text("a\0b"), "'a\\0b'");
        assert_eq!(text("a\u{1a}b"), "'a\\Zb'");
    }

    #[test]
    fn null_is_a_keyword_and_the_string_null_is_not() {
        assert_eq!(format_cell(None, CellShape::Text), "NULL");
        assert_eq!(format_cell(None, CellShape::Numeric), "NULL");
        assert_eq!(text("NULL"), "'NULL'");
    }

    #[test]
    fn a_number_keeps_every_digit_the_server_printed() {
        // The reason the dump formats from raw bytes: no f64 holds these, and
        // a DECIMAL through a float is exactly the corruption the type exists
        // to prevent.
        for n in [
            "9223372036854775807",
            "18446744073709551615",
            "0.10000000000000000001",
        ] {
            assert_eq!(format_cell(Some(n.as_bytes()), CellShape::Numeric), n);
        }
    }

    #[test]
    fn a_datetime_keeps_its_fractional_seconds() {
        // Decoding through the grid's value type formatted these as
        // `%Y-%m-%d %H:%M:%S`, so every backup silently lost the microseconds.
        assert_eq!(
            text("2026-09-03 11:22:33.123456"),
            "'2026-09-03 11:22:33.123456'"
        );
    }

    #[test]
    fn binary_is_hex_so_no_escaping_applies_to_it() {
        assert_eq!(
            format_cell(Some(&[0x00, 0x27, 0xff]), CellShape::Binary),
            "X'0027ff'"
        );
    }

    #[test]
    fn bytes_that_are_not_utf8_are_written_as_hex_rather_than_replaced() {
        // A lossy conversion would put U+FFFD in the file and call it a
        // backup.
        assert_eq!(format_cell(Some(&[0xff, 0xfe]), CellShape::Text), "X'fffe'");
    }

    #[test]
    fn something_unparseable_in_a_numeric_column_is_quoted_rather_than_left_bare() {
        // Better a value the file can carry than a file that does not parse.
        assert_eq!(
            format_cell(Some(b"not a number"), CellShape::Numeric),
            "'not a number'"
        );
    }

    #[test]
    fn numeric_literals_are_recognised_in_the_forms_mysql_prints() {
        for ok in [
            "0",
            "-1",
            "+1",
            "1.5",
            "-0.001",
            "1e10",
            "1.5E-3",
            "1234567890123456789",
        ] {
            assert!(is_numeric_literal(ok), "{ok} should be a numeric literal");
        }
        for bad in [
            "", "-", ".", "1.2.3", "0x10", "1e", "e5", "1 OR 1=1", "NULL",
        ] {
            assert!(!is_numeric_literal(bad), "{bad} should not be");
        }
    }

    #[test]
    fn every_numeric_column_type_is_classified_as_numeric() {
        for t in ["INT", "BIGINT UNSIGNED", "DECIMAL", "double", "YEAR"] {
            assert_eq!(shape_of(t), CellShape::Numeric, "{t}");
        }
    }

    #[test]
    fn binary_and_spatial_columns_are_classified_as_binary() {
        for t in ["BLOB", "VARBINARY", "BIT", "GEOMETRY", "point"] {
            assert_eq!(shape_of(t), CellShape::Binary, "{t}");
        }
    }

    #[test]
    fn anything_unrecognised_is_treated_as_text() {
        // Quoting an unknown type is safe; writing it bare is not.
        for t in ["VARCHAR", "JSON", "ENUM", "SOMETHING_NEW"] {
            assert_eq!(shape_of(t), CellShape::Text, "{t}");
        }
    }

    #[test]
    fn a_unicode_value_is_not_mangled() {
        assert_eq!(text("café 日本"), "'café 日本'");
    }
}
