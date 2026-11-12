//! How stored results are ordered: the collations and the numeric-type test.
//!
//! SQLite orders values by storage class first (numbers, then text, then
//! blobs) and applies a collation only when both sides are text. The store
//! keeps DECIMAL, BIGINT and unsigned values above `i64::MAX` as text so they
//! stay exact, which means the default text order would put "10" before "9".
//! The collations here are what make those columns sort as numbers, and text
//! columns sort without regard to case.

use std::cmp::Ordering;

/// Collation for text columns: case-insensitive, with a binary tiebreak.
pub(crate) const TEXT_COLLATION: &str = "mas_text";
/// Collation for numeric columns whose values are stored as text.
pub(crate) const DECIMAL_COLLATION: &str = "mas_decimal";
/// Scalar function turning any number into text the decimal collation reads,
/// for a numeric column that holds more than one storage class.
pub(crate) const NUMBER_TEXT_FUNCTION: &str = "mas_number_text";

/// Compare two strings by their Unicode-lowercased characters.
///
/// Lowercasing goes character by character so nothing is allocated for each
/// comparison; a sort of 100,000 rows makes well over a million of them.
pub(crate) fn folded_cmp(a: &str, b: &str) -> Ordering {
    // Most text is ASCII, where lowercasing is one byte at a time and gives
    // the same order as the general path below.
    if a.is_ascii() && b.is_ascii() {
        return a
            .bytes()
            .map(|byte| byte.to_ascii_lowercase())
            .cmp(b.bytes().map(|byte| byte.to_ascii_lowercase()));
    }
    a.chars()
        .flat_map(char::to_lowercase)
        .cmp(b.chars().flat_map(char::to_lowercase))
}

/// The order of a text column: case-insensitive first, then by bytes so that
/// "Abc" and "abc" still have one fixed order between them.
pub(crate) fn text_cmp(a: &str, b: &str) -> Ordering {
    folded_cmp(a, b).then_with(|| a.cmp(b))
}

/// The order of a numeric column stored as text.
///
/// Numbers sort by value, compared digit by digit rather than through `f64`,
/// so two DECIMALs or BIGINTs that differ past the 15th digit are still in
/// the right order. Anything that is not a number (a value the executor could
/// only read as text) sorts after every number, in text order.
pub(crate) fn decimal_cmp(a: &str, b: &str) -> Ordering {
    match (Number::parse(a), Number::parse(b)) {
        (Some(x), Some(y)) => x.cmp(&y).then_with(|| a.cmp(b)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => text_cmp(a, b),
    }
}

/// A decimal literal, read without converting it to a binary number.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Number<'a> {
    NegativeInfinity,
    Finite(Decimal<'a>),
    Infinity,
}

/// Sign, digits and exponent of a finite decimal literal.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Decimal<'a> {
    negative: bool,
    /// Digits before the point, without leading zeros.
    int: &'a [u8],
    /// Digits after the point.
    frac: &'a [u8],
    exponent: i64,
}

impl<'a> Number<'a> {
    /// Read `text` as a decimal number: an optional sign, digits with an
    /// optional point, an optional exponent, or a signed `Infinity`.
    /// Surrounding whitespace is ignored. `None` for anything else.
    pub(crate) fn parse(text: &'a str) -> Option<Self> {
        let bytes = text.trim().as_bytes();
        let (negative, rest) = match bytes.split_first() {
            Some((b'-', rest)) => (true, rest),
            Some((b'+', rest)) => (false, rest),
            _ => (false, bytes),
        };
        if rest == b"Infinity" {
            return Some(if negative {
                Number::NegativeInfinity
            } else {
                Number::Infinity
            });
        }

        let int_len = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        let (int, mut rest) = rest.split_at(int_len);
        let mut frac: &[u8] = &[];
        if let Some((b'.', after)) = rest.split_first() {
            let frac_len = after.iter().take_while(|b| b.is_ascii_digit()).count();
            (frac, rest) = after.split_at(frac_len);
        }
        if int.is_empty() && frac.is_empty() {
            return None;
        }

        let mut exponent: i64 = 0;
        if let Some((b'e' | b'E', after)) = rest.split_first() {
            let (exp_negative, digits) = match after.split_first() {
                Some((b'-', digits)) => (true, digits),
                Some((b'+', digits)) => (false, digits),
                _ => (false, after),
            };
            if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
                return None;
            }
            // Saturating: an absurd exponent only has to stay absurd.
            for digit in digits {
                exponent = exponent
                    .saturating_mul(10)
                    .saturating_add(i64::from(digit - b'0'));
            }
            if exp_negative {
                exponent = -exponent;
            }
            rest = &[];
        }
        if !rest.is_empty() {
            return None;
        }

        let leading_zeros = int.iter().take_while(|b| **b == b'0').count();
        Some(Number::Finite(Decimal {
            negative,
            int: &int[leading_zeros..],
            frac,
            exponent,
        }))
    }

    pub(crate) fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Number::Finite(a), Number::Finite(b)) => a.cmp(b),
            _ => self.rank().cmp(&other.rank()),
        }
    }

    fn rank(&self) -> u8 {
        match self {
            Number::NegativeInfinity => 0,
            Number::Finite(_) => 1,
            Number::Infinity => 2,
        }
    }
}

impl Decimal<'_> {
    /// The digits from the first non-zero one on.
    fn digits(&self) -> impl Iterator<Item = u8> + '_ {
        self.int
            .iter()
            .chain(self.frac.iter())
            .copied()
            .skip_while(|b| *b == b'0')
    }

    fn is_zero(&self) -> bool {
        self.digits().next().is_none()
    }

    /// Where the first non-zero digit sits relative to the decimal point:
    /// 3 for 123.4, 0 for 0.5, -2 for 0.005. Only meaningful when not zero.
    fn magnitude(&self) -> i64 {
        let position = if self.int.is_empty() {
            let zeros = self.frac.iter().take_while(|b| **b == b'0').count();
            -i64::try_from(zeros).unwrap_or(i64::MAX)
        } else {
            i64::try_from(self.int.len()).unwrap_or(i64::MAX)
        };
        position.saturating_add(self.exponent)
    }

    /// -1, 0 or 1. Zero has no sign, so "-0" and "0" compare equal.
    fn signum(&self) -> i8 {
        if self.is_zero() {
            0
        } else if self.negative {
            -1
        } else {
            1
        }
    }

    fn cmp_magnitude(&self, other: &Self) -> Ordering {
        self.magnitude().cmp(&other.magnitude()).then_with(|| {
            // Same position for the leading digit, so the digit strings line
            // up; a shorter one is padded with zeros ("1.5" against "1.50").
            let mut a = self.digits();
            let mut b = other.digits();
            loop {
                match (a.next(), b.next()) {
                    (None, None) => return Ordering::Equal,
                    (x, y) => {
                        let (x, y) = (x.unwrap_or(b'0'), y.unwrap_or(b'0'));
                        if x != y {
                            return x.cmp(&y);
                        }
                    }
                }
            }
        })
    }

    fn cmp(&self, other: &Self) -> Ordering {
        let (a, b) = (self.signum(), other.signum());
        a.cmp(&b).then_with(|| match a {
            1 => self.cmp_magnitude(other),
            -1 => other.cmp_magnitude(self),
            _ => Ordering::Equal,
        })
    }
}

/// Text for a float that the decimal collation orders correctly.
///
/// Rust prints a finite `f64` as the shortest decimal that reads back to the
/// same value and never uses an exponent, which is exactly what the collation
/// compares.
pub(crate) fn float_text(value: f64) -> String {
    if value == f64::INFINITY {
        "Infinity".to_string()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".to_string()
    } else {
        value.to_string()
    }
}

/// Whether a column's server type is a number, whatever its values are
/// stored as.
///
/// The same list and the same reduction to a base name as `isNumericSqlType`
/// in `src/lib/sql-types.ts`: `DECIMAL(20,4)` and `BIGINT UNSIGNED` both
/// count.
pub(crate) fn is_numeric_type(data_type: &str) -> bool {
    let upper = data_type.to_uppercase();
    let base = upper.split('(').next().unwrap_or_default();
    let base = base
        .split_whitespace()
        .filter(|word| *word != "UNSIGNED" && *word != "ZEROFILL")
        .collect::<Vec<_>>()
        .join(" ");
    matches!(
        base.as_str(),
        "TINYINT"
            | "SMALLINT"
            | "MEDIUMINT"
            | "INT"
            | "INTEGER"
            | "BIGINT"
            | "DECIMAL"
            | "NUMERIC"
            | "FLOAT"
            | "DOUBLE"
            | "REAL"
            | "BIT"
            | "YEAR"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(mut values: Vec<&str>, cmp: fn(&str, &str) -> Ordering) -> Vec<&str> {
        values.sort_by(|a, b| cmp(a, b));
        values
    }

    #[test]
    fn text_order_ignores_case_and_breaks_ties_by_bytes() {
        assert_eq!(
            sorted(
                vec!["banana", "Apple", "apple", "cherry", "Banana"],
                text_cmp
            ),
            vec!["Apple", "apple", "Banana", "banana", "cherry"]
        );
        // Unicode lowercasing, not only ASCII.
        assert_eq!(folded_cmp("ÉCOLE", "école"), Ordering::Equal);
        assert_eq!(folded_cmp("ЯБЛОКО", "яблоко"), Ordering::Equal);
    }

    #[test]
    fn decimal_order_is_numeric_and_exact() {
        assert_eq!(
            sorted(
                vec!["10", "9", "-3", "100.5", "0.25", "-20", "1e2", "0"],
                decimal_cmp
            ),
            vec!["-20", "-3", "0", "0.25", "9", "10", "1e2", "100.5"]
        );
        // Both of these are the same f64; the digits still tell them apart.
        assert_eq!(
            decimal_cmp("9007199254740993", "9007199254740992"),
            Ordering::Greater
        );
        assert_eq!(
            decimal_cmp("18446744073709551615", "18446744073709551614"),
            Ordering::Greater
        );
        assert_eq!(
            decimal_cmp(
                "12345678901234567890.123456789012345678",
                "12345678901234567890.123456789012345679"
            ),
            Ordering::Less
        );
    }

    #[test]
    fn decimal_order_reads_every_spelling_of_a_number() {
        let equal = |a: &str, b: &str| {
            let (Some(x), Some(y)) = (Number::parse(a), Number::parse(b)) else {
                panic!("not numbers: {a} {b}");
            };
            assert_eq!(x.cmp(&y), Ordering::Equal, "{a} vs {b}");
        };
        equal("1.50", "1.5");
        equal("001", "1");
        equal("-0", "0");
        equal("0.0", "0");
        equal("1e3", "1000");
        equal("12.5e-1", "1.25");
        equal(".5", "0.5");
        equal("5.", "5");
        equal(" 7 ", "7");
        equal("+7", "7");

        assert_eq!(decimal_cmp("-1.5", "-1.25"), Ordering::Less);
        assert_eq!(decimal_cmp("0.005", "0.05"), Ordering::Less);
        assert_eq!(decimal_cmp("-Infinity", "-1e300"), Ordering::Less);
        assert_eq!(decimal_cmp("Infinity", "1e300"), Ordering::Greater);

        for not_a_number in [
            "", ".", "e5", "1e", "1.2.3", "abc", "0x10", "1 2", "NaN", "--1",
        ] {
            assert!(
                Number::parse(not_a_number).is_none(),
                "{not_a_number:?} is not a number"
            );
        }
    }

    #[test]
    fn text_that_is_not_a_number_sorts_after_every_number() {
        assert_eq!(
            sorted(vec!["pear", "10", "Apple", "9"], decimal_cmp),
            vec!["9", "10", "Apple", "pear"]
        );
    }

    #[test]
    fn float_text_is_exact_and_has_no_exponent() {
        assert_eq!(float_text(1.5), "1.5");
        assert_eq!(float_text(-0.1), "-0.1");
        assert_eq!(float_text(1e21), "1000000000000000000000");
        assert_eq!(float_text(f64::INFINITY), "Infinity");
        assert_eq!(float_text(f64::NEG_INFINITY), "-Infinity");
        assert!(Number::parse(&float_text(1e-300)).is_some());
    }

    #[test]
    fn numeric_types_match_the_frontend_list() {
        for numeric in [
            "INT",
            "int",
            "BIGINT UNSIGNED",
            "DECIMAL(20,4)",
            "decimal",
            "INT UNSIGNED ZEROFILL",
            "TINYINT(1)",
            "DOUBLE",
            "YEAR",
            "BIT",
            "INTEGER",
            "NUMERIC",
        ] {
            assert!(is_numeric_type(numeric), "{numeric}");
        }
        for other in ["VARCHAR", "TEXT", "DATETIME", "BLOB", "JSON", "", "BOOLEAN"] {
            assert!(!is_numeric_type(other), "{other}");
        }
    }
}
