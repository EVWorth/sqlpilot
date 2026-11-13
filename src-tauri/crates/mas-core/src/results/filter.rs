//! Per-column filters over a stored result.
//!
//! A port of `matchesFilter`, `compare` and `isActiveFilter` from
//! `src/lib/grid-filter.ts`, so the grid narrows a result the same way
//! whether the rows are in the webview or in the store. The match is one
//! Rust function; the store registers it as a SQLite scalar function and
//! calls it from `WHERE`.
//!
//! Where this cannot be the TypeScript exactly:
//!
//! - **Regex dialect.** Patterns are compiled by the `regex` crate, not by a
//!   JavaScript engine. It has no lookaround and no backreferences (such a
//!   pattern is treated like any other invalid one and matches everything),
//!   and `\d`, `\w`, `\s` and `\b` are Unicode-aware where JavaScript's are
//!   ASCII-only without the `u` flag.
//! - **Text order.** `localeCompare` uses the ICU collation of the user's
//!   locale. Here text is ordered by its Unicode-lowercased characters, with
//!   lowercase before uppercase on a tie as ICU has it. Accented letters,
//!   punctuation and digits-against-letters can order differently.
//! - **Exact numbers.** JavaScript compares through `f64`, so two BIGINTs
//!   that differ past 2^53 compare equal there. Here two decimal literals are
//!   compared digit by digit.
//! - **Binary cells.** A byte array never matches a text or ordered operator;
//!   only `isNull` and `isNotNull` apply to it.

use super::order::{folded_cmp, Number};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::cmp::Ordering;

/// The operators of `src/lib/grid-filter.ts`, serialised to the same strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FilterOperator {
    Contains,
    NotContains,
    Equals,
    NotEquals,
    StartsWith,
    EndsWith,
    Regex,
    IsNull,
    IsNotNull,
    Gt,
    Gte,
    Lt,
    Lte,
    Between,
}

impl FilterOperator {
    const ALL: [FilterOperator; 14] = [
        FilterOperator::Contains,
        FilterOperator::NotContains,
        FilterOperator::Equals,
        FilterOperator::NotEquals,
        FilterOperator::StartsWith,
        FilterOperator::EndsWith,
        FilterOperator::Regex,
        FilterOperator::IsNull,
        FilterOperator::IsNotNull,
        FilterOperator::Gt,
        FilterOperator::Gte,
        FilterOperator::Lt,
        FilterOperator::Lte,
        FilterOperator::Between,
    ];

    /// The number this operator travels as inside a query. Generated here and
    /// read back by `from_code`; it never comes from a caller.
    pub(crate) fn code(self) -> i64 {
        Self::ALL
            .iter()
            .position(|op| *op == self)
            .and_then(|index| i64::try_from(index).ok())
            .unwrap_or_default()
    }

    pub(crate) fn from_code(code: i64) -> Option<Self> {
        usize::try_from(code)
            .ok()
            .and_then(|index| Self::ALL.get(index).copied())
    }

    /// Operators that take no operand.
    fn is_nullary(self) -> bool {
        matches!(self, FilterOperator::IsNull | FilterOperator::IsNotNull)
    }
}

/// One filter on one column of a result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ResultFilter {
    /// Zero-based position of the column in the result.
    #[specta(type = specta_typescript::Number)]
    pub column: usize,
    pub operator: FilterOperator,
    /// Empty for the operators that take no operand.
    pub value: String,
    /// The upper bound, for `between`.
    #[serde(default)]
    pub value2: Option<String>,
}

/// True when a filter would narrow anything.
///
/// A filter with nothing typed into it is ignored rather than applied, so
/// opening the filter menu does not empty the grid.
pub fn is_active_filter(filter: &ResultFilter) -> bool {
    if filter.operator.is_nullary() {
        return true;
    }
    let has_value = !filter.value.trim().is_empty();
    if filter.operator == FilterOperator::Between {
        return has_value
            && filter
                .value2
                .as_deref()
                .is_some_and(|upper| !upper.trim().is_empty());
    }
    has_value
}

/// A cell as the filter sees it, borrowed from wherever it is stored.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FilterCell<'a> {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(&'a str),
    Bytes,
}

impl FilterCell<'_> {
    /// The cell as text, the way JavaScript's `String(cell)` spells it.
    fn text(&self) -> Option<Cow<'_, str>> {
        match self {
            FilterCell::Null | FilterCell::Bytes => None,
            FilterCell::Bool(value) => Some(Cow::Borrowed(if *value { "true" } else { "false" })),
            FilterCell::Int(value) => Some(Cow::Owned(value.to_string())),
            FilterCell::Float(value) => Some(Cow::Owned(js_number_text(*value))),
            FilterCell::Text(value) => Some(Cow::Borrowed(value)),
        }
    }
}

/// A filter with the work that does not depend on the cell done once: the
/// needle lowercased and the pattern compiled. The store keeps one of these
/// for the whole scan instead of rebuilding it for every row.
#[derive(Debug)]
pub struct CompiledFilter {
    operator: FilterOperator,
    value: String,
    value2: String,
    needle: String,
    /// `None` when the pattern does not compile, which matches everything.
    regex: Option<regex::Regex>,
}

impl CompiledFilter {
    pub fn new(operator: FilterOperator, value: &str, value2: Option<&str>) -> Self {
        let regex = if operator == FilterOperator::Regex {
            // Not JavaScript's dialect: no lookaround, no backreferences.
            // Those fail to compile here and so match everything, the same
            // as a half-typed pattern.
            regex::RegexBuilder::new(value)
                .case_insensitive(true)
                .build()
                .ok()
        } else {
            None
        };
        Self {
            operator,
            value: value.to_string(),
            value2: value2.unwrap_or_default().to_string(),
            needle: value.to_lowercase(),
            regex,
        }
    }

    /// Does one cell pass this filter?
    ///
    /// NULL passes only `isNull`. Every other operator on a NULL cell is
    /// false, as in SQL: "does not equal x" must not start reporting rows
    /// whose value is unknown.
    pub fn matches(&self, cell: &FilterCell<'_>) -> bool {
        let is_null = matches!(cell, FilterCell::Null);
        match self.operator {
            FilterOperator::IsNull => return is_null,
            FilterOperator::IsNotNull => return !is_null,
            _ => {}
        }
        // A binary cell has no text to search or order.
        let Some(text) = cell.text() else {
            return false;
        };
        let text = text.as_ref();
        let lower = || text.to_lowercase();

        match self.operator {
            FilterOperator::Contains => lower().contains(&self.needle),
            FilterOperator::NotContains => !lower().contains(&self.needle),
            FilterOperator::Equals => lower() == self.needle,
            FilterOperator::NotEquals => lower() != self.needle,
            FilterOperator::StartsWith => lower().starts_with(&self.needle),
            FilterOperator::EndsWith => lower().ends_with(&self.needle),
            // A half-typed pattern is not a reason to empty the grid; it
            // shows everything until the pattern is valid.
            FilterOperator::Regex => self.regex.as_ref().is_none_or(|re| re.is_match(text)),
            FilterOperator::Gt => compare(cell, text, &self.value) == Ordering::Greater,
            FilterOperator::Gte => compare(cell, text, &self.value) != Ordering::Less,
            FilterOperator::Lt => compare(cell, text, &self.value) == Ordering::Less,
            FilterOperator::Lte => compare(cell, text, &self.value) != Ordering::Greater,
            FilterOperator::Between => {
                compare(cell, text, &self.value) != Ordering::Less
                    && compare(cell, text, &self.value2) != Ordering::Greater
            }
            FilterOperator::IsNull | FilterOperator::IsNotNull => false,
        }
    }
}

/// Does `cell` pass `filter`? The whole of `matchesFilter`, for callers and
/// tests that have one cell rather than a scan.
pub fn matches_filter(cell: &FilterCell<'_>, filter: &ResultFilter) -> bool {
    CompiledFilter::new(filter.operator, &filter.value, filter.value2.as_deref()).matches(cell)
}

/// Compare as numbers when both sides really are numbers, as text otherwise.
///
/// A column's declared type is not enough on its own: BIGINT and DECIMAL are
/// carried as text, and a text column can still hold "10". Falling back to
/// text keeps `between` usable on a VARCHAR without making `'10' < '9'` a
/// surprise on an INT.
fn compare(cell: &FilterCell<'_>, text: &str, operand: &str) -> Ordering {
    if !operand.trim().is_empty() && !text.trim().is_empty() {
        // JavaScript reads a boolean cell through its text, "true", which is
        // not a number; only a float cell is a number without being parsed.
        let cell_number = match cell {
            FilterCell::Float(value) => Some(*value).filter(|v| v.is_finite()),
            _ => js_number(text),
        };
        if let (Some(a), Some(b)) = (cell_number, js_number(operand)) {
            // Two decimal literals are compared by their digits, so values
            // past 2^53 are not rounded together. A float cell stays an f64:
            // it has no more digits than that to compare.
            if !matches!(cell, FilterCell::Float(_)) {
                if let (Some(x), Some(y)) = (Number::parse(text), Number::parse(operand)) {
                    return x.cmp(&y);
                }
            }
            return a.partial_cmp(&b).unwrap_or(Ordering::Equal);
        }
    }
    locale_cmp(text, operand)
}

/// The nearest thing to `localeCompare` without ICU: case-insensitive, and
/// on a tie lowercase sorts before uppercase.
fn locale_cmp(a: &str, b: &str) -> Ordering {
    folded_cmp(a, b).then_with(|| {
        for (x, y) in a.chars().zip(b.chars()) {
            if x != y {
                return match (x.is_lowercase(), y.is_lowercase()) {
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    _ => x.cmp(&y),
                };
            }
        }
        a.len().cmp(&b.len())
    })
}

/// JavaScript's `Number(text)`, when the result is finite.
///
/// The grammar is JavaScript's rather than Rust's: surrounding whitespace is
/// ignored, an empty string is zero, `0x`, `0o` and `0b` prefixes are read,
/// and words such as "inf" or "nan" (which Rust would accept) are not
/// numbers.
fn js_number(text: &str) -> Option<f64> {
    let text = text.trim();
    if text.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            if digits.starts_with(['+', '-']) {
                return None;
            }
            // u128 holds 32 hex digits; a longer literal is treated as text.
            #[allow(clippy::cast_precision_loss)]
            return u128::from_str_radix(digits, radix)
                .ok()
                .map(|value| value as f64);
        }
    }
    if !text
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        return None;
    }
    text.parse::<f64>().ok().filter(|value| value.is_finite())
}

/// A float as JavaScript's `String(number)` writes it.
///
/// Both languages print the shortest digits that read back to the same
/// value; they differ in when they switch to an exponent. A filter such as
/// `contains "e+21"` has to see what the grid shows.
fn js_number_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    // "1.2345e21": the shortest digits and the power of ten of the first one.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exponent: i32 = exponent.parse().unwrap_or_default();
    let count = i32::try_from(digits.len()).unwrap_or(i32::MAX);
    // Digits before the decimal point, as ECMAScript's Number::toString
    // counts them.
    let point = exponent + 1;
    let zeros = |n: i32| "0".repeat(usize::try_from(n).unwrap_or_default());

    let body = if count <= point && point <= 21 {
        format!("{digits}{}", zeros(point - count))
    } else if 0 < point && point <= 21 {
        let (whole, fraction) = digits.split_at(usize::try_from(point).unwrap_or_default());
        format!("{whole}.{fraction}")
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", zeros(-point))
    } else {
        let (first, rest) = digits.split_at(1);
        let sign = if exponent < 0 { '-' } else { '+' };
        let rest = if rest.is_empty() {
            String::new()
        } else {
            format!(".{rest}")
        };
        format!("{first}{rest}e{sign}{}", exponent.abs())
    };
    if value < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

#[cfg(test)]
mod tests {
    use super::FilterCell::{Bool, Bytes, Float, Int, Null, Text};
    use super::FilterOperator as Op;
    use super::*;

    fn f(operator: Op, value: &str) -> ResultFilter {
        ResultFilter {
            column: 0,
            operator,
            value: value.to_string(),
            value2: None,
        }
    }

    fn between(low: &str, high: &str) -> ResultFilter {
        ResultFilter {
            value2: Some(high.to_string()),
            ..f(Op::Between, low)
        }
    }

    /// The cases of `src/lib/__tests__/grid-filter.test.ts`, in its order and
    /// under its headings, so the two files can be read side by side.
    #[test]
    fn matches_filter_agrees_with_the_typescript_cases() {
        let cases: Vec<(&str, FilterCell<'_>, ResultFilter, bool)> = vec![
            (
                "matches text case-insensitively",
                Text("Alice"),
                f(Op::Contains, "ali"),
                true,
            ),
            (
                "matches text case-insensitively",
                Text("Alice"),
                f(Op::Equals, "alice"),
                true,
            ),
            (
                "matches text case-insensitively",
                Text("Alice"),
                f(Op::StartsWith, "AL"),
                true,
            ),
            (
                "matches text case-insensitively",
                Text("Alice"),
                f(Op::EndsWith, "CE"),
                true,
            ),
            (
                "matches text case-insensitively",
                Text("Alice"),
                f(Op::Contains, "bob"),
                false,
            ),
            ("negates", Text("Alice"), f(Op::NotContains, "bob"), true),
            ("negates", Text("Alice"), f(Op::NotEquals, "alice"), false),
            (
                "matches a regex",
                Text("a1b"),
                f(Op::Regex, "^a\\db$"),
                true,
            ),
            // Emptying the grid on every keystroke that lands mid-pattern
            // would make the input unusable.
            (
                "shows everything while a regex is half-typed",
                Text("anything"),
                f(Op::Regex, "a(b"),
                true,
            ),
            (
                "NULL is found only by isNull",
                Null,
                f(Op::IsNull, ""),
                true,
            ),
            (
                "NULL is found only by isNull",
                Text("x"),
                f(Op::IsNull, ""),
                false,
            ),
            (
                "NULL is found only by isNull",
                Null,
                f(Op::IsNotNull, ""),
                false,
            ),
            (
                "NULL is found only by isNull",
                Text("x"),
                f(Op::IsNotNull, ""),
                true,
            ),
            (
                "NULL does not slip through a negated filter",
                Null,
                f(Op::NotEquals, "x"),
                false,
            ),
            (
                "NULL does not slip through a negated filter",
                Null,
                f(Op::NotContains, "x"),
                false,
            ),
            (
                "NULL does not slip through a negated filter",
                Null,
                f(Op::Contains, ""),
                false,
            ),
            ("compares numbers as numbers", Int(9), f(Op::Lt, "10"), true),
            (
                "compares numbers as numbers",
                Int(9),
                f(Op::Gt, "10"),
                false,
            ),
            (
                "compares numbers as numbers",
                Int(10),
                f(Op::Gte, "10"),
                true,
            ),
            (
                "compares numbers as numbers",
                Int(10),
                f(Op::Lte, "10"),
                true,
            ),
            // BIGINT and DECIMAL are carried as text; comparing those as
            // text makes '9' > '10'.
            (
                "compares a BIGINT carried as a string as a number",
                Text("9"),
                f(Op::Lt, "10"),
                true,
            ),
            (
                "compares a BIGINT carried as a string as a number",
                Text("100"),
                f(Op::Gt, "99"),
                true,
            ),
            (
                "falls back to text when either side is not a number",
                Text("apple"),
                f(Op::Lt, "banana"),
                true,
            ),
            (
                "falls back to text when either side is not a number",
                Text("banana"),
                f(Op::Lt, "apple"),
                false,
            ),
            (
                "covers a range inclusively",
                Int(5),
                between("1", "10"),
                true,
            ),
            (
                "covers a range inclusively",
                Int(1),
                between("1", "10"),
                true,
            ),
            (
                "covers a range inclusively",
                Int(10),
                between("1", "10"),
                true,
            ),
            (
                "covers a range inclusively",
                Int(11),
                between("1", "10"),
                false,
            ),
            (
                "covers a date range",
                Text("2026-03-04"),
                between("2026-01-01", "2026-12-31"),
                true,
            ),
            (
                "covers a date range",
                Text("2025-12-31"),
                between("2026-01-01", "2026-12-31"),
                false,
            ),
        ];
        for (name, cell, filter, expected) in cases {
            assert_eq!(
                matches_filter(&cell, &filter),
                expected,
                "{name}: {cell:?} {filter:?}"
            );
        }
    }

    #[test]
    fn is_active_filter_agrees_with_the_typescript_cases() {
        let cases = [
            // Opening the menu should not empty the grid.
            (
                "ignores a filter with nothing typed into it",
                f(Op::Contains, ""),
                false,
            ),
            (
                "ignores a filter with nothing typed into it",
                f(Op::Contains, "   "),
                false,
            ),
            (
                "counts the operators that take no operand",
                f(Op::IsNull, ""),
                true,
            ),
            (
                "counts the operators that take no operand",
                f(Op::IsNotNull, ""),
                true,
            ),
            ("waits for both ends of a range", f(Op::Between, "1"), false),
            ("waits for both ends of a range", between("1", "10"), true),
            ("waits for both ends of a range", between("1", "  "), false),
            ("waits for both ends of a range", between("", "10"), false),
        ];
        for (name, filter, expected) in cases {
            assert_eq!(is_active_filter(&filter), expected, "{name}: {filter:?}");
        }
    }

    #[test]
    fn every_operator_has_a_case_of_its_own() {
        let cases: Vec<(FilterCell<'_>, ResultFilter, bool)> = vec![
            (Text("Hello World"), f(Op::Contains, "LO W"), true),
            (Text("Hello World"), f(Op::NotContains, "LO W"), false),
            (Text("Hello"), f(Op::Equals, "hELLO"), true),
            (Text("Hello"), f(Op::Equals, "hell"), false),
            (Text("Hello"), f(Op::NotEquals, "hell"), true),
            (Text("Hello"), f(Op::StartsWith, "he"), true),
            (Text("Hello"), f(Op::StartsWith, "lo"), false),
            (Text("Hello"), f(Op::EndsWith, "LO"), true),
            (Text("Hello"), f(Op::EndsWith, "he"), false),
            (Text("Hello"), f(Op::Regex, "^h.l+o$"), true),
            (Text("Hello"), f(Op::Regex, "^\\d+$"), false),
            (Int(5), f(Op::Gt, "4"), true),
            (Int(5), f(Op::Gt, "5"), false),
            (Int(5), f(Op::Gte, "5"), true),
            (Int(5), f(Op::Lt, "6"), true),
            (Int(5), f(Op::Lt, "5"), false),
            (Int(5), f(Op::Lte, "5"), true),
            (Float(2.5), between("2", "3"), true),
            (Float(3.5), between("2", "3"), false),
            // Unicode lowercasing on both sides.
            (Text("ÉCOLE"), f(Op::Equals, "école"), true),
            (Text("Straße"), f(Op::Contains, "STRASSE"), false),
            // Numbers are searched by their text.
            (Int(1234), f(Op::Contains, "23"), true),
            (Float(1.5), f(Op::Equals, "1.5"), true),
            (Bool(true), f(Op::Equals, "TRUE"), true),
            (Bool(false), f(Op::Contains, "als"), true),
        ];
        for (cell, filter, expected) in cases {
            assert_eq!(
                matches_filter(&cell, &filter),
                expected,
                "{cell:?} {filter:?}"
            );
        }
    }

    #[test]
    fn a_binary_cell_matches_only_the_null_operators() {
        assert!(matches_filter(&Bytes, &f(Op::IsNotNull, "")));
        assert!(!matches_filter(&Bytes, &f(Op::IsNull, "")));
        for operator in [
            Op::Contains,
            Op::NotContains,
            Op::Equals,
            Op::NotEquals,
            Op::StartsWith,
            Op::EndsWith,
            Op::Regex,
            Op::Gt,
            Op::Gte,
            Op::Lt,
            Op::Lte,
        ] {
            assert!(!matches_filter(&Bytes, &f(operator, "1")), "{operator:?}");
        }
        assert!(!matches_filter(&Bytes, &between("0", "9")));
    }

    #[test]
    fn ordered_operators_choose_numbers_or_text_as_typescript_does() {
        // A whitespace-only side is not a number, though Number(" ") is 0.
        assert_eq!(compare(&Text(" "), " ", "5"), locale_cmp(" ", "5"));
        // Number("") is 0, but an empty operand means text comparison.
        assert_eq!(compare(&Int(5), "5", ""), Ordering::Greater);
        // Hex literals are numbers to JavaScript.
        assert_eq!(compare(&Int(16), "16", "0x10"), Ordering::Equal);
        // "Infinity" is not finite, so this is a text comparison.
        assert_eq!(
            compare(&Int(5), "5", "Infinity"),
            locale_cmp("5", "Infinity")
        );
        // A boolean is compared by its text.
        assert_eq!(compare(&Bool(true), "true", "1"), locale_cmp("true", "1"));
        // Mixed number and word: text.
        assert_eq!(compare(&Text("10"), "10", "9a"), Ordering::Less);
        // Exponents and signs.
        assert_eq!(compare(&Text("1e3"), "1e3", "999"), Ordering::Greater);
        assert_eq!(compare(&Int(-5), "-5", "-4"), Ordering::Less);
        assert_eq!(compare(&Float(0.1), "0.1", "0.1"), Ordering::Equal);
    }

    #[test]
    fn big_numbers_carried_as_text_are_compared_exactly() {
        // The same f64 on both sides; JavaScript would call them equal.
        assert!(matches_filter(
            &Text("9007199254740993"),
            &f(Op::Gt, "9007199254740992")
        ));
        assert!(matches_filter(
            &Text("18446744073709551615"),
            &f(Op::Gt, "18446744073709551614")
        ));
        assert!(matches_filter(
            &Text("123456789012345678.10"),
            &between("123456789012345678.09", "123456789012345678.11")
        ));
    }

    #[test]
    fn text_order_puts_lowercase_first_on_a_tie() {
        assert_eq!(locale_cmp("a", "A"), Ordering::Less);
        assert_eq!(locale_cmp("A", "a"), Ordering::Greater);
        assert_eq!(locale_cmp("apple", "Banana"), Ordering::Less);
        assert_eq!(locale_cmp("same", "same"), Ordering::Equal);
        assert!(matches_filter(&Text("A"), &f(Op::Gte, "a")));
    }

    #[test]
    fn an_unsupported_regex_feature_matches_everything() {
        // Lookahead compiles in JavaScript and not here; it is treated as a
        // pattern still being typed.
        assert!(matches_filter(&Text("anything"), &f(Op::Regex, "a(?=b)")));
        assert!(matches_filter(&Text("anything"), &f(Op::Regex, "(a)\\1")));
    }

    #[test]
    fn js_number_reads_what_javascript_reads() {
        let cases: [(&str, Option<f64>); 19] = [
            ("10", Some(10.0)),
            (" 10 ", Some(10.0)),
            ("", Some(0.0)),
            ("-1.5", Some(-1.5)),
            ("+2", Some(2.0)),
            (".5", Some(0.5)),
            ("5.", Some(5.0)),
            ("1e3", Some(1000.0)),
            ("0x1F", Some(31.0)),
            ("0b101", Some(5.0)),
            ("0o17", Some(15.0)),
            ("abc", None),
            ("1,000", None),
            ("1_000", None),
            ("inf", None),
            ("nan", None),
            ("Infinity", None),
            ("1e999", None),
            ("2026-03-04", None),
        ];
        for (text, expected) in cases {
            assert_eq!(js_number(text), expected, "{text:?}");
        }
    }

    #[test]
    fn floats_are_written_as_javascript_writes_them() {
        let cases = [
            (1.0, "1"),
            (1.5, "1.5"),
            (-0.0, "0"),
            (0.1, "0.1"),
            (123.456, "123.456"),
            (-2.5, "-2.5"),
            (100.0, "100"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (0.000_001, "0.000001"),
            (0.000_000_1, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e300, "1e+300"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (f64::NAN, "NaN"),
        ];
        for (value, expected) in cases {
            assert_eq!(js_number_text(value), expected, "{value:e}");
        }
    }

    #[test]
    fn operators_serialise_to_the_frontend_names() {
        let names = [
            "contains",
            "notContains",
            "equals",
            "notEquals",
            "startsWith",
            "endsWith",
            "regex",
            "isNull",
            "isNotNull",
            "gt",
            "gte",
            "lt",
            "lte",
            "between",
        ];
        assert_eq!(names.len(), Op::ALL.len());
        for (operator, name) in Op::ALL.iter().zip(names) {
            assert_eq!(
                serde_json::to_value(operator).expect("serialises"),
                serde_json::Value::String(name.to_string())
            );
            assert_eq!(Op::from_code(operator.code()), Some(*operator));
        }
        assert_eq!(Op::from_code(99), None);

        let filter: ResultFilter =
            serde_json::from_str(r#"{"column":2,"operator":"startsWith","value":"a"}"#)
                .expect("value2 may be left out");
        assert_eq!(filter.column, 2);
        assert_eq!(filter.operator, Op::StartsWith);
        assert_eq!(filter.value2, None);
    }
}
