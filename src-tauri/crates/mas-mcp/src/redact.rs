//! Columns whose values never leave, whatever the posture says.
//!
//! The posture decides how much data an agent may see. This decides what it
//! may not see at any posture, and the two are different questions: someone
//! who shares a development database as `full` has said "you can read this
//! data", not "you can read the password hashes".
//!
//! The rule is deliberately a name match rather than anything cleverer. A
//! column called `password_hash` is a password hash in every schema anyone
//! has ever written, and a rule a user can predict from the column name is
//! worth more than one that is right slightly more often.
//!
//! What this is *not*: a security boundary against a determined agent, which
//! could ask for `SELECT SUBSTRING(password_hash, 1, 10)` and get it. It is a
//! guard against the ordinary case — `SELECT *`, a column profile, the result
//! already on screen — where nobody intended to hand over a credential.

/// Fragments that make a column too sensitive to return.
///
/// Matched as substrings of the lower-cased column name, so `user_password`,
/// `passwordHash` and `PASSWORD` all match one entry.
const SENSITIVE: [&str; 14] = [
    "password",
    "passwd",
    "secret",
    "api_key",
    "apikey",
    "private_key",
    "access_token",
    "refresh_token",
    "session_token",
    "credit_card",
    "card_number",
    "cvv",
    "ssn",
    "social_security",
];

/// What replaces a redacted value.
///
/// Says which rule fired rather than just blanking the cell: an agent that
/// sees `<redacted>` and no reason will try another way to read the column,
/// and one that knows why will stop.
pub const REDACTED: &str = "<redacted: sensitive column name>";

/// Whether a column's values may be returned at all.
pub fn is_sensitive(column: &str) -> bool {
    let name = column.to_ascii_lowercase();
    SENSITIVE.iter().any(|fragment| name.contains(fragment))
}

/// Which of these columns are redacted, by position.
///
/// Positional because a result set's columns are positional: an alias, an
/// expression or a duplicate name all still have an index.
pub fn redacted_columns(columns: &[String]) -> Vec<bool> {
    columns.iter().map(|name| is_sensitive(name)).collect()
}

/// Replace the values in redacted columns, in place.
pub fn apply(rows: &mut [Vec<serde_json::Value>], redacted: &[bool]) {
    for row in rows {
        for (cell, hidden) in row.iter_mut().zip(redacted) {
            // A null stays null: "there is no value here" is not sensitive,
            // and turning it into a string would misreport the data's shape.
            if *hidden && !cell.is_null() {
                *cell = serde_json::Value::String(REDACTED.to_string());
            }
        }
    }
}

/// The sentence to add when something was redacted.
pub fn note(columns: &[String], redacted: &[bool]) -> Option<String> {
    let hidden: Vec<&str> = columns
        .iter()
        .zip(redacted)
        .filter(|(_, hidden)| **hidden)
        .map(|(name, _)| name.as_str())
        .collect();
    if hidden.is_empty() {
        return None;
    }
    Some(format!(
        "Values in {} are not returned: the column name says it holds a credential or personal \
         identifier. Counts and aggregates over it still work.",
        hidden.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_recognised_however_they_are_spelled() {
        for column in [
            "password",
            "PASSWORD",
            "user_password",
            "passwordHash",
            "password_hash",
            "passwd",
            "api_key",
            "apiKey",
            "stripe_secret",
            "access_token",
            "private_key_pem",
        ] {
            assert!(is_sensitive(column), "{column}");
        }
    }

    #[test]
    fn identifiers_people_would_not_want_shared_are_too() {
        for column in [
            "ssn",
            "customer_ssn",
            "credit_card_number",
            "cvv",
            "social_security_no",
        ] {
            assert!(is_sensitive(column), "{column}");
        }
    }

    #[test]
    fn ordinary_columns_are_left_alone() {
        // The rule has to be predictable, and a rule that hides half a schema
        // is one people turn off.
        for column in [
            "id",
            "email",
            "name",
            "created_at",
            "total",
            "status",
            "keyword",
            "description",
        ] {
            assert!(!is_sensitive(column), "{column}");
        }
    }

    #[test]
    fn a_value_is_replaced_with_a_reason_rather_than_a_blank() {
        let columns = vec!["id".to_string(), "password_hash".to_string()];
        let redacted = redacted_columns(&columns);
        let mut rows = vec![vec![serde_json::json!(1), serde_json::json!("$2b$12$abc")]];

        apply(&mut rows, &redacted);

        assert_eq!(rows[0][0], serde_json::json!(1), "other columns untouched");
        assert_eq!(rows[0][1], serde_json::json!(REDACTED));
        // An agent that knows why stops trying; one that sees a blank does not.
        assert!(REDACTED.contains("sensitive"));
    }

    #[test]
    fn a_null_stays_null() {
        // "There is no value here" is not sensitive, and a string in its place
        // would misreport the shape of the data.
        let redacted = redacted_columns(&["password".to_string()]);
        let mut rows = vec![vec![serde_json::Value::Null]];
        apply(&mut rows, &redacted);
        assert!(rows[0][0].is_null());
    }

    #[test]
    fn the_note_names_the_columns_so_nobody_wonders_what_is_missing() {
        let columns = vec!["id".to_string(), "api_key".to_string()];
        let note = note(&columns, &redacted_columns(&columns)).expect("something was hidden");
        assert!(note.contains("api_key"), "{note}");
        assert!(!note.contains("id,"), "{note}");
        // And says what still works, so the answer is not simply "no".
        assert!(note.contains("aggregates"), "{note}");
    }

    #[test]
    fn nothing_hidden_means_nothing_said() {
        let columns = vec!["id".to_string()];
        assert!(note(&columns, &redacted_columns(&columns)).is_none());
    }

    #[test]
    fn a_row_shorter_than_its_header_does_not_panic() {
        // Defensive: a driver that returns a short row would otherwise take
        // the whole tool call down.
        let redacted = vec![false, true, true];
        let mut rows = vec![vec![serde_json::json!(1)]];
        apply(&mut rows, &redacted);
        assert_eq!(rows[0].len(), 1);
    }
}
