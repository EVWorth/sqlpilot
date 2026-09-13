//! What an agent is allowed to see and do, and why.
//!
//! Three axes decide every tool call: what the connection's data posture
//! permits to leave the database, which environment it is, and what class of
//! statement is being asked for. None of this is new machinery — the profile
//! already carries an environment and a read-only flag, and `mas-core` already
//! classifies statements — but until now nothing composed them into a single
//! answer, which is what a tool boundary needs.
//!
//! The rule that matters most is not in this file: **approval for a
//! destructive action happens in SQLPilot's own window**, whatever harness is
//! driving (AI_INTEGRATION.md §2). This module decides *whether a thing is
//! allowed at all* and *whether it must be asked about*. The asking is the
//! app's.

use serde::{Deserialize, Serialize};

/// How much of a database's contents may reach an agent.
///
/// The posture is a property of the connection profile, not of the session:
/// a user decides once that their production database is schema-only, and
/// every session that attaches inherits it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum DataPosture {
    /// Names, types, relationships and aggregates. No row values.
    ///
    /// The default on production. An agent can still do most of its job —
    /// write a query, read a plan, profile a column — because the analysis
    /// tools compute in the database and return numbers.
    SchemaOnly,
    /// A bounded number of rows, redacted, for the shape of the data.
    Samples,
    /// Rows up to the connection's own row cap, redacted.
    Full,
}

impl DataPosture {
    /// How many rows a tool may return under this posture.
    ///
    /// `None` means the connection's own cap applies; `Some(0)` means no rows
    /// at all.
    pub fn row_allowance(self, sample_size: u32) -> Option<u32> {
        match self {
            DataPosture::SchemaOnly => Some(0),
            DataPosture::Samples => Some(sample_size),
            DataPosture::Full => None,
        }
    }

    /// Whether individual values may be shown at all.
    ///
    /// Aggregates are not values: a count, a null rate or a range says
    /// something about a column without disclosing a row, which is the whole
    /// point of profiling in the database.
    pub fn allows_values(self) -> bool {
        !matches!(self, DataPosture::SchemaOnly)
    }
}

/// Which environment the connection's profile says it is.
///
/// Mirrors `ConnectionEnvironment` in `mas-core`, kept as its own type here so
/// the policy can give an answer for a profile that names none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Development,
    Staging,
    Production,
    /// The profile does not say. Treated as staging: not the strictest, but
    /// not the most permissive either — an unlabelled database is more often
    /// something that matters than something that does not.
    Unknown,
}

impl Environment {
    pub fn from_profile(value: Option<&str>) -> Self {
        match value.map(str::to_ascii_lowercase).as_deref() {
            Some("development") => Environment::Development,
            Some("staging") => Environment::Staging,
            Some("production") => Environment::Production,
            _ => Environment::Unknown,
        }
    }

    pub fn is_production(self) -> bool {
        matches!(self, Environment::Production)
    }
}

/// What a statement does, for the purpose of deciding who has to approve it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum VerbClass {
    /// `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `TABLE`, `VALUES`, `WITH`
    /// resolving to one of those.
    Read,
    /// `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CALL`, `LOAD`.
    Write,
    /// `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `RENAME`.
    Ddl,
    /// `GRANT`, `REVOKE`, `SET GLOBAL`, `KILL`, `FLUSH`, `SHUTDOWN`.
    ///
    /// Not exposed to agents at all. The admin panel is where a person does
    /// these, with their own confirmations.
    Admin,
}

/// What the policy says about one attempted call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum Decision {
    /// Run it. Reads that cost nothing to allow.
    Allow,
    /// Run it only after the user says so **in SQLPilot's window**.
    ///
    /// The reason is shown in that dialog, so it is written for the person
    /// reading it rather than for a log.
    Ask { reason: String },
    /// Do not run it, and tell the agent why in terms it can act on.
    ///
    /// A refusal that just says "denied" invites the model to retry the same
    /// thing; one that says what is allowed instead redirects it.
    Refuse { reason: String },
}

impl Decision {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Decision::Allow)
    }
}

/// Everything the policy needs to know about where a call is going.
#[derive(Debug, Clone)]
pub struct ConnectionPolicy {
    pub name: String,
    pub environment: Environment,
    pub posture: DataPosture,
    /// The profile's read-only flag. The executor enforces this too, before a
    /// batch is assembled; this is the second lock, and the one that can
    /// explain itself.
    pub read_only: bool,
    /// Whether the session has been explicitly unlocked for schema changes.
    /// Off by default, and meaningless on a read-only connection.
    pub ddl_unlocked: bool,
    /// Column-name patterns this connection redacts on top of the built-in
    /// list. Carried on the policy because every tool that could return a
    /// value already has the policy in hand.
    pub redact: Vec<String>,
}

impl ConnectionPolicy {
    /// What to do about a statement of this class.
    pub fn decide(&self, verb: VerbClass) -> Decision {
        match verb {
            VerbClass::Admin => Decision::Refuse {
                reason: "Administrative statements — grants, kills, server variables — are not \
                         available to an agent. A person does those in the admin panel."
                    .to_string(),
            },

            VerbClass::Read => Decision::Allow,

            VerbClass::Write if self.read_only => Decision::Refuse {
                reason: format!(
                    "\"{}\" is a read-only connection, so nothing can write to it. Read tools and \
                     EXPLAIN still work.",
                    self.name
                ),
            },

            VerbClass::Write => Decision::Ask {
                reason: format!(
                    "This changes data on \"{}\"{}.",
                    self.name,
                    if self.environment.is_production() {
                        ", which is marked production"
                    } else {
                        ""
                    }
                ),
            },

            VerbClass::Ddl if self.read_only => Decision::Refuse {
                reason: format!(
                    "\"{}\" is a read-only connection, so its schema cannot be changed.",
                    self.name
                ),
            },

            // Production DDL is the one thing a session cannot talk its way
            // into: the unlock is a deliberate act by the user, in the app.
            VerbClass::Ddl if self.environment.is_production() && !self.ddl_unlocked => {
                Decision::Refuse {
                    reason: format!(
                        "\"{}\" is marked production, so schema changes are not available to an \
                         agent unless the session is unlocked for them. Write the migration and \
                         open it as a draft instead — the user can review and run it.",
                        self.name
                    ),
                }
            }

            VerbClass::Ddl => Decision::Ask {
                reason: format!("This changes the schema of \"{}\".", self.name),
            },
        }
    }

    /// Whether a tool may return row values, and how many.
    ///
    /// Separate from `decide` because a `SELECT` is always allowed to *run* —
    /// what the posture controls is how much of the answer comes back.
    pub fn row_allowance(&self, sample_size: u32) -> Option<u32> {
        self.posture.row_allowance(sample_size)
    }

    /// What to tell an agent that asked for rows it cannot have.
    ///
    /// Phrased as a redirection: the tools that still work are named, because
    /// a model that knows `profile_column` exists will use it instead of
    /// retrying the SELECT.
    pub fn no_values_hint(&self) -> String {
        format!(
            "\"{}\" is set to share schema only, so row values are not returned. The shape of the \
             result is above. To characterise the data without reading it, use profile_column, \
             table_stats or explain.",
            self.name
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(environment: Environment, posture: DataPosture) -> ConnectionPolicy {
        ConnectionPolicy {
            name: "shop".to_string(),
            environment,
            posture,
            read_only: false,
            ddl_unlocked: false,
            redact: Vec::new(),
        }
    }

    #[test]
    fn reads_are_allowed_everywhere_including_production() {
        // Reading is what an agent is for. The posture decides what comes
        // back, not whether the statement may run.
        for environment in [
            Environment::Development,
            Environment::Staging,
            Environment::Production,
            Environment::Unknown,
        ] {
            let decision = policy(environment, DataPosture::SchemaOnly).decide(VerbClass::Read);
            assert!(decision.is_allowed(), "{environment:?}: {decision:?}");
        }
    }

    #[test]
    fn every_write_is_asked_about_even_in_development() {
        // Not graded by environment: a delete on a laptop is still a delete,
        // and "it was only dev" is how people lose their fixtures.
        let decision = policy(Environment::Development, DataPosture::Full).decide(VerbClass::Write);
        assert!(matches!(decision, Decision::Ask { .. }), "{decision:?}");
    }

    #[test]
    fn a_production_write_says_so_in_the_reason() {
        // The reason reaches the confirmation dialog, so it is written for
        // the person reading it.
        let Decision::Ask { reason } =
            policy(Environment::Production, DataPosture::SchemaOnly).decide(VerbClass::Write)
        else {
            panic!("a production write should be asked about");
        };
        assert!(reason.contains("production"), "{reason}");
        assert!(reason.contains("shop"), "{reason}");
    }

    #[test]
    fn a_read_only_connection_refuses_writes_and_says_what_still_works() {
        let mut p = policy(Environment::Development, DataPosture::Full);
        p.read_only = true;

        let Decision::Refuse { reason } = p.decide(VerbClass::Write) else {
            panic!("a read-only connection cannot be written to");
        };
        assert!(reason.contains("read-only"), "{reason}");
        // A refusal that only says no invites a retry of the same thing.
        assert!(reason.contains("EXPLAIN"), "{reason}");
    }

    #[test]
    fn production_ddl_is_refused_until_the_session_is_unlocked() {
        let mut p = policy(Environment::Production, DataPosture::SchemaOnly);
        let Decision::Refuse { reason } = p.decide(VerbClass::Ddl) else {
            panic!("production DDL is refused by default");
        };
        // And the refusal points at the thing that does work.
        assert!(reason.contains("draft"), "{reason}");

        p.ddl_unlocked = true;
        assert!(matches!(p.decide(VerbClass::Ddl), Decision::Ask { .. }));
    }

    #[test]
    fn unlocking_ddl_does_not_defeat_read_only() {
        // The two flags are not a hierarchy: read-only wins.
        let mut p = policy(Environment::Production, DataPosture::Full);
        p.read_only = true;
        p.ddl_unlocked = true;
        assert!(matches!(p.decide(VerbClass::Ddl), Decision::Refuse { .. }));
    }

    #[test]
    fn admin_statements_are_never_available_to_an_agent() {
        let mut p = policy(Environment::Development, DataPosture::Full);
        p.ddl_unlocked = true;
        assert!(matches!(
            p.decide(VerbClass::Admin),
            Decision::Refuse { .. }
        ));
    }

    #[test]
    fn schema_only_returns_no_rows_but_still_allows_aggregates() {
        let p = policy(Environment::Production, DataPosture::SchemaOnly);
        assert_eq!(p.row_allowance(20), Some(0));
        assert!(!p.posture.allows_values());
        // The hint names the tools that do work, so a model redirects rather
        // than retrying.
        assert!(p.no_values_hint().contains("profile_column"));
    }

    #[test]
    fn samples_are_bounded_and_full_defers_to_the_connection() {
        assert_eq!(DataPosture::Samples.row_allowance(20), Some(20));
        assert_eq!(DataPosture::Full.row_allowance(20), None);
        assert!(DataPosture::Samples.allows_values());
    }

    #[test]
    fn an_unlabelled_environment_is_not_treated_as_development() {
        // An unlabelled database is more often something that matters than
        // something that does not.
        assert_eq!(Environment::from_profile(None), Environment::Unknown);
        assert_eq!(
            Environment::from_profile(Some("nonsense")),
            Environment::Unknown
        );
        assert!(!Environment::from_profile(None).is_production());
    }

    #[test]
    fn the_environment_names_match_what_a_profile_stores() {
        assert_eq!(
            Environment::from_profile(Some("production")),
            Environment::Production
        );
        assert_eq!(
            Environment::from_profile(Some("PRODUCTION")),
            Environment::Production
        );
        assert_eq!(
            Environment::from_profile(Some("development")),
            Environment::Development
        );
    }
}
