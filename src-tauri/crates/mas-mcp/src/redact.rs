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
//! The built-in list is the ordinary case. A schema that spells it differently
//! — `pw`, `card_pan`, `nino` — adds its own patterns per connection, and they
//! work the same way: a bare word matches anywhere in the name, and `*` is a
//! wildcard for the schemas where a prefix or suffix is what identifies these
//! columns.
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

/// The built-in list plus whatever this connection adds.
#[derive(Debug, Clone, Default)]
pub struct Rules {
    /// Lower-cased, from the connection's grant.
    extra: Vec<String>,
}

impl Rules {
    /// The rules for a connection whose grant names these patterns.
    ///
    /// Empty patterns are dropped rather than kept: a blank line in a settings
    /// field would otherwise match every column, and a user who redacted their
    /// whole database by pressing return twice would have no idea why.
    pub fn new<'a>(extra: impl IntoIterator<Item = &'a str>) -> Self {
        Self {
            extra: extra
                .into_iter()
                .map(|pattern| pattern.trim().to_ascii_lowercase())
                .filter(|pattern| !pattern.is_empty() && pattern != "*")
                .collect(),
        }
    }

    /// Whether a column's values may be returned at all.
    pub fn is_sensitive(&self, column: &str) -> bool {
        let name = column.to_ascii_lowercase();
        SENSITIVE.iter().any(|fragment| name.contains(fragment))
            || self.extra.iter().any(|pattern| matches(pattern, &name))
    }

    /// Which of these columns are redacted, by position.
    ///
    /// Positional because a result set's columns are positional: an alias, an
    /// expression or a duplicate name all still have an index.
    pub fn redacted_columns(&self, columns: &[String]) -> Vec<bool> {
        columns.iter().map(|name| self.is_sensitive(name)).collect()
    }
}

/// Whether a pattern matches a lower-cased column name.
///
/// Without a `*` it matches anywhere in the name, which is how the built-in
/// list behaves and what someone typing `pw` means. With one it is a glob
/// anchored at both ends, so `*_enc` matches only a suffix and `token_*` only
/// a prefix — the distinction schemas that name things systematically need.
fn matches(pattern: &str, name: &str) -> bool {
    if !pattern.contains('*') {
        return name.contains(pattern);
    }

    let parts: Vec<&str> = pattern.split('*').collect();
    let mut rest = name;

    // The first and last parts are anchored; everything between floats.
    if let Some(first) = parts.first() {
        if !rest.starts_with(first) {
            return false;
        }
        rest = &rest[first.len()..];
    }
    if let Some(last) = parts.last() {
        if parts.len() > 1 {
            if !rest.ends_with(last) || rest.len() < last.len() {
                return false;
            }
            rest = &rest[..rest.len() - last.len()];
        }
    }
    for middle in parts.iter().skip(1).take(parts.len().saturating_sub(2)) {
        match rest.find(middle) {
            Some(at) => rest = &rest[at + middle.len()..],
            None => return false,
        }
    }
    true
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
            assert!(Rules::default().is_sensitive(column), "{column}");
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
            assert!(Rules::default().is_sensitive(column), "{column}");
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
            assert!(!Rules::default().is_sensitive(column), "{column}");
        }
    }

    #[test]
    fn a_value_is_replaced_with_a_reason_rather_than_a_blank() {
        let columns = vec!["id".to_string(), "password_hash".to_string()];
        let redacted = Rules::default().redacted_columns(&columns);
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
        let redacted = Rules::default().redacted_columns(&["password".to_string()]);
        let mut rows = vec![vec![serde_json::Value::Null]];
        apply(&mut rows, &redacted);
        assert!(rows[0][0].is_null());
    }

    #[test]
    fn the_note_names_the_columns_so_nobody_wonders_what_is_missing() {
        let columns = vec!["id".to_string(), "api_key".to_string()];
        let note = note(&columns, &Rules::default().redacted_columns(&columns))
            .expect("something was hidden");
        assert!(note.contains("api_key"), "{note}");
        assert!(!note.contains("id,"), "{note}");
        // And says what still works, so the answer is not simply "no".
        assert!(note.contains("aggregates"), "{note}");
    }

    #[test]
    fn nothing_hidden_means_nothing_said() {
        let columns = vec!["id".to_string()];
        assert!(note(&columns, &Rules::default().redacted_columns(&columns)).is_none());
    }

    #[test]
    fn a_connection_can_add_the_word_its_schema_uses() {
        // The built-in list cannot know that this schema calls it `pw`.
        let rules = Rules::new(["pw", "nino"]);
        assert!(rules.is_sensitive("user_pw"));
        assert!(rules.is_sensitive("NINO"));
        assert!(!rules.is_sensitive("id"));
        // And the built-in list still applies.
        assert!(rules.is_sensitive("password_hash"));
    }

    #[test]
    fn a_star_anchors_what_a_bare_word_does_not() {
        // `token` as a bare word would hide `tokenised_at`; `*_token` is how a
        // schema that names things systematically says what it means.
        let bare = Rules::new(["token"]);
        assert!(bare.is_sensitive("tokenised_at"));

        let suffix = Rules::new(["*_token"]);
        assert!(suffix.is_sensitive("reset_token"));
        assert!(!suffix.is_sensitive("tokenised_at"));

        // Not a word from the built-in list, or that would match anyway.
        let prefix = Rules::new(["nino_*"]);
        assert!(prefix.is_sensitive("nino_value"));
        assert!(!prefix.is_sensitive("employee_nino_value"));
    }

    #[test]
    fn a_pattern_with_a_star_in_the_middle_matches_around_it() {
        let rules = Rules::new(["card*number"]);
        assert!(rules.is_sensitive("card_holder_number"));
        assert!(rules.is_sensitive("cardnumber"));
        assert!(!rules.is_sensitive("number_card"));
    }

    #[test]
    fn a_blank_pattern_does_not_redact_the_whole_database() {
        // A settings field with a stray blank line, which would otherwise
        // match every column and leave the user with no idea why.
        let rules = Rules::new(["", "   ", "*"]);
        assert!(!rules.is_sensitive("id"));
        assert!(!rules.is_sensitive("total"));
        // The built-in list is untouched by the nonsense.
        assert!(rules.is_sensitive("password"));
    }

    #[test]
    fn patterns_are_matched_without_regard_to_case() {
        assert!(Rules::new(["PW"]).is_sensitive("user_pw"));
        assert!(Rules::new(["pw"]).is_sensitive("USER_PW"));
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
