//! Which connections an agent can see at all.
//!
//! The policy in [`crate::policy`] grades what may be *done* to a connection.
//! This is the question before it: whether the agent knows the connection
//! exists. Nothing is exposed by default. A harness that starts up with no
//! grants gets an empty `list_connections` and a sentence explaining where to
//! change that — not an error, and not every database the user has ever saved.
//!
//! That ordering matters more than it looks. A grant is the one place the user
//! makes a deliberate, per-connection decision about an agent, so it is also
//! where the posture lives: how much real data may leave the database. Putting
//! posture on the connection profile instead would have meant a setting that
//! reads as being about SQLPilot when it is really about what an agent is told.

use serde::{Deserialize, Serialize};

use crate::policy::{ConnectionPolicy, DataPosture, Environment};

/// What the policy needs to know about a connection, without `mas-mcp`
/// depending on how profiles are stored.
#[derive(Debug, Clone)]
pub struct ConnectionFacts {
    pub id: String,
    pub name: String,
    /// The profile's environment label, if it has one. `None` is not
    /// "development"; see [`Environment::from_profile`].
    pub environment: Option<String>,
    /// The connection's own read-only setting. A grant cannot widen it.
    pub read_only: bool,
}

/// One connection, exposed to agents on the user's terms.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub connection_id: String,
    /// How much of the data may be returned. Defaults to the narrowest thing
    /// that is still useful, not to the most useful thing that is still legal.
    pub posture: DataPosture,
    /// Databases the agent may touch on this connection. `None` means all of
    /// them; an empty list is a grant that exposes nothing, which the UI
    /// should not be able to produce but which is harmless if it does.
    pub databases: Option<Vec<String>>,
    /// Column-name patterns whose values never leave, on top of the built-in
    /// credential list. A bare word matches anywhere in the name; `*` is a
    /// wildcard.
    #[serde(default)]
    pub redact: Vec<String>,
    /// Whether schema changes are permitted on a production connection.
    ///
    /// Deliberately not persisted with the rest — see [`Grants::unlock_ddl`].
    #[serde(skip, default)]
    pub ddl_unlocked: bool,
}

impl Grant {
    /// A grant with the defaults: samples, every database, no DDL unlock.
    pub fn new(connection_id: impl Into<String>) -> Self {
        Self {
            connection_id: connection_id.into(),
            posture: DataPosture::Samples,
            databases: None,
            redact: Vec::new(),
            ddl_unlocked: false,
        }
    }

    /// Redact these column-name patterns as well as the built-in list.
    pub fn redacting(mut self, patterns: Vec<String>) -> Self {
        self.redact = patterns;
        self
    }

    pub fn with_posture(mut self, posture: DataPosture) -> Self {
        self.posture = posture;
        self
    }

    pub fn limited_to(mut self, databases: Vec<String>) -> Self {
        self.databases = Some(databases);
        self
    }

    /// Whether this grant covers a database.
    ///
    /// Names are compared case-insensitively because MySQL on macOS and
    /// Windows does, and a grant that works on Linux but not on a colleague's
    /// laptop is a grant nobody trusts.
    pub fn covers(&self, database: &str) -> bool {
        match &self.databases {
            None => true,
            Some(allowed) => allowed.iter().any(|d| d.eq_ignore_ascii_case(database)),
        }
    }
}

/// Why a connection is not available to this agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotGranted {
    /// The user has not exposed this connection.
    Connection { name: Option<String> },
    /// The connection is exposed, but not this database.
    Database {
        connection: String,
        database: String,
    },
}

impl std::fmt::Display for NotGranted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Naming a connection the agent cannot use is not a leak: it asked
            // by id, so it had the id already, and "no such thing" would send
            // it looking for a typo that isn't there.
            NotGranted::Connection { name: Some(name) } => write!(
                f,
                "The connection “{name}” is not shared with agents. The user can share it from \
                 Settings → Agents, where they also choose how much of its data is visible."
            ),
            NotGranted::Connection { name: None } => write!(
                f,
                "There is no such connection, or it is not shared with agents. `list_connections` \
                 returns the ones that are."
            ),
            NotGranted::Database {
                connection,
                database,
            } => write!(
                f,
                "“{connection}” is shared with agents, but only for some of its databases, and \
                 “{database}” is not one of them. `list_databases` returns the ones it is."
            ),
        }
    }
}

/// The set of connections exposed to agents.
#[derive(Debug, Clone, Default)]
pub struct Grants {
    grants: Vec<Grant>,
}

impl Grants {
    pub fn new(grants: Vec<Grant>) -> Self {
        Self { grants }
    }

    pub fn is_empty(&self) -> bool {
        self.grants.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Grant> {
        self.grants.iter()
    }

    pub fn get(&self, connection_id: &str) -> Option<&Grant> {
        self.grants
            .iter()
            .find(|g| g.connection_id == connection_id)
    }

    /// Add a grant, or replace the one for the same connection.
    ///
    /// Replacing rather than appending because two grants for one connection
    /// would make "which posture applies" a question of ordering, and the
    /// answer to that question should never be "whichever was saved last".
    pub fn set(&mut self, grant: Grant) {
        match self
            .grants
            .iter_mut()
            .find(|g| g.connection_id == grant.connection_id)
        {
            Some(existing) => {
                // An unlock survives a posture change made while a session is
                // running; it is revoked by revoking, not by editing.
                let unlocked = existing.ddl_unlocked;
                *existing = grant;
                existing.ddl_unlocked = unlocked;
            }
            None => self.grants.push(grant),
        }
    }

    pub fn revoke(&mut self, connection_id: &str) {
        self.grants.retain(|g| g.connection_id != connection_id);
    }

    /// Permit schema changes on a production connection for as long as the
    /// grant lasts.
    ///
    /// This is not persisted, so it lapses when the app closes. Someone who
    /// unlocked production to let an agent add an index in the afternoon
    /// should not find it still unlocked next week; if that is annoying, it is
    /// annoying in the direction that does no harm.
    pub fn unlock_ddl(&mut self, connection_id: &str, unlocked: bool) {
        if let Some(grant) = self
            .grants
            .iter_mut()
            .find(|g| g.connection_id == connection_id)
        {
            grant.ddl_unlocked = unlocked;
        }
    }

    /// The policy for a connection, or why the agent may not use it.
    pub fn policy_for(&self, facts: &ConnectionFacts) -> Result<ConnectionPolicy, NotGranted> {
        let grant = self.get(&facts.id).ok_or_else(|| NotGranted::Connection {
            name: Some(facts.name.clone()),
        })?;

        Ok(ConnectionPolicy {
            name: facts.name.clone(),
            environment: Environment::from_profile(facts.environment.as_deref()),
            posture: grant.posture,
            read_only: facts.read_only,
            ddl_unlocked: grant.ddl_unlocked,
            redact: grant.redact.clone(),
        })
    }

    /// The policy for a connection and a particular database.
    pub fn policy_for_database(
        &self,
        facts: &ConnectionFacts,
        database: &str,
    ) -> Result<ConnectionPolicy, NotGranted> {
        let policy = self.policy_for(facts)?;
        // Looked up rather than unwrapped: `policy_for` found it a line ago
        // and cannot have lost it, but a panic here would be a tool call that
        // never answers rather than an error anyone can read.
        let Some(grant) = self.get(&facts.id) else {
            return Err(NotGranted::Connection {
                name: Some(facts.name.clone()),
            });
        };
        if !grant.covers(database) {
            return Err(NotGranted::Database {
                connection: facts.name.clone(),
                database: database.to_string(),
            });
        }
        Ok(policy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(id: &str) -> ConnectionFacts {
        ConnectionFacts {
            id: id.to_string(),
            name: format!("{id} server"),
            environment: Some("production".into()),
            read_only: false,
        }
    }

    #[test]
    fn nothing_is_exposed_until_the_user_exposes_it() {
        let grants = Grants::default();
        assert!(matches!(
            grants.policy_for(&facts("c1")),
            Err(NotGranted::Connection { .. })
        ));
    }

    #[test]
    fn a_refusal_says_where_to_change_it() {
        // A model told only "no" retries. Told where the switch is, it can
        // tell the user something useful instead.
        let message = NotGranted::Connection {
            name: Some("prod".into()),
        }
        .to_string();
        assert!(message.contains("Settings"), "{message}");
    }

    #[test]
    fn a_grant_defaults_to_samples_rather_than_everything() {
        // The default is what most users will run with, so it is the setting
        // that actually decides how much data leaves the database.
        assert_eq!(Grant::new("c1").posture, DataPosture::Samples);
    }

    #[test]
    fn a_grant_cannot_widen_a_read_only_connection() {
        // read_only comes from the connection, not the grant, so there is no
        // way to spell "share this read-only database as writable".
        let mut grants = Grants::default();
        grants.set(Grant::new("c1"));
        let mut facts = facts("c1");
        facts.read_only = true;
        assert!(grants.policy_for(&facts).unwrap().read_only);
    }

    #[test]
    fn the_environment_comes_from_the_profile() {
        let mut grants = Grants::default();
        grants.set(Grant::new("c1"));
        let policy = grants.policy_for(&facts("c1")).unwrap();
        assert_eq!(policy.environment, Environment::Production);
    }

    #[test]
    fn a_grant_can_be_limited_to_some_databases() {
        let mut grants = Grants::default();
        grants.set(Grant::new("c1").limited_to(vec!["analytics".into()]));
        let facts = facts("c1");
        assert!(grants.policy_for_database(&facts, "analytics").is_ok());
        assert!(matches!(
            grants.policy_for_database(&facts, "payroll"),
            Err(NotGranted::Database { .. })
        ));
    }

    #[test]
    fn database_names_are_matched_the_way_mysql_matches_them() {
        // Case-sensitive on Linux, not on macOS. A grant that works on one
        // machine and not another is a grant nobody trusts.
        let grant = Grant::new("c1").limited_to(vec!["Analytics".into()]);
        assert!(grant.covers("analytics"));
        assert!(grant.covers("ANALYTICS"));
        assert!(!grant.covers("analytics_archive"));
    }

    #[test]
    fn an_unlimited_grant_covers_every_database() {
        assert!(Grant::new("c1").covers("anything"));
    }

    #[test]
    fn regranting_a_connection_replaces_it_rather_than_stacking() {
        let mut grants = Grants::default();
        grants.set(Grant::new("c1").with_posture(DataPosture::Full));
        grants.set(Grant::new("c1").with_posture(DataPosture::SchemaOnly));
        assert_eq!(grants.iter().count(), 1);
        assert_eq!(grants.get("c1").unwrap().posture, DataPosture::SchemaOnly);
    }

    #[test]
    fn editing_a_grant_does_not_quietly_relock_a_session() {
        // Tightening posture mid-session should not also cancel the unlock the
        // user granted a minute ago — that reads as the app forgetting.
        let mut grants = Grants::default();
        grants.set(Grant::new("c1"));
        grants.unlock_ddl("c1", true);
        grants.set(Grant::new("c1").with_posture(DataPosture::SchemaOnly));
        assert!(grants.get("c1").unwrap().ddl_unlocked);
    }

    #[test]
    fn revoking_takes_the_connection_back() {
        let mut grants = Grants::default();
        grants.set(Grant::new("c1"));
        grants.unlock_ddl("c1", true);
        grants.revoke("c1");
        assert!(grants.is_empty());
        assert!(grants.policy_for(&facts("c1")).is_err());
    }

    #[test]
    fn a_connections_own_patterns_reach_its_policy() {
        // The policy is what every tool has in hand, so that is where the
        // rules have to arrive.
        let mut grants = Grants::default();
        grants.set(Grant::new("c1").redacting(vec!["nino".into()]));
        assert_eq!(
            grants.policy_for(&facts("c1")).unwrap().redact,
            vec!["nino"]
        );
    }

    #[test]
    fn patterns_survive_being_saved_and_read_back() {
        let grant = Grant::new("c1").redacting(vec!["pw".into(), "*_enc".into()]);
        let json = serde_json::to_string(&grant).unwrap();
        let restored: Grant = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.redact, vec!["pw", "*_enc"]);
    }

    #[test]
    fn a_grant_saved_before_patterns_existed_still_reads() {
        // The field is new; grants on disk predate it.
        let restored: Grant =
            serde_json::from_str(r#"{"connectionId":"c1","posture":"samples","databases":null}"#)
                .unwrap();
        assert!(restored.redact.is_empty());
    }

    #[test]
    fn an_unlock_is_not_something_that_gets_saved() {
        // It lapses when the app closes, which is the only way an unlock stays
        // meaningful.
        let mut grant = Grant::new("c1");
        grant.ddl_unlocked = true;
        let json = serde_json::to_string(&grant).unwrap();
        assert!(!json.contains("ddlUnlocked"), "{json}");
        let restored: Grant = serde_json::from_str(&json).unwrap();
        assert!(!restored.ddl_unlocked);
    }

    #[test]
    fn unlocking_a_connection_nobody_granted_does_nothing() {
        let mut grants = Grants::default();
        grants.unlock_ddl("c1", true);
        assert!(grants.is_empty());
    }
}
