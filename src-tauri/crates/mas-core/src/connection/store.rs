use crate::connection::migrations;
use crate::error::CoreError;
use crate::models::{ConnectionProfile, ConnectionProfileSummary};
use chrono::Utc;
use keyring_core::{Entry, Error as KeyringError};
use rusqlite::{params, Connection as SqliteConn};
use std::path::Path;
use std::sync::Mutex;

pub struct ConnectionStore {
    db: Mutex<SqliteConn>,
}

const KEYRING_SERVICE: &str = "sqlpilot.connection_profiles";

/// Keyring slot suffixes for the SSH credentials.
///
/// The main database password is stored under the bare profile id and must
/// stay that way — renaming it would orphan every already-stored password.
/// These hang off the same id with a suffix.
const SSH_PASSWORD_SLOT: &str = "ssh-password";
const SSH_PASSPHRASE_SLOT: &str = "ssh-passphrase";

fn slot_key(profile_id: &str, slot: &str) -> String {
    format!("{profile_id}:{slot}")
}

impl ConnectionStore {
    pub fn new(path: &Path) -> Result<Self, CoreError> {
        let db = SqliteConn::open(path)?;
        let store = Self { db: Mutex::new(db) };
        store.init_tables()?;
        store.migrate_plaintext_passwords()?;
        tracing::info!(path = %path.display(), "Connection store initialized");
        Ok(store)
    }

    fn init_tables(&self) -> Result<(), CoreError> {
        let db = self
            .db
            .lock()
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let applied = migrations::run(&db)
            .map_err(|e| CoreError::Storage(format!("Migration failed: {}", e)))?;
        tracing::debug!(
            schema_version = applied,
            "Connection profiles table initialized"
        );
        Ok(())
    }

    #[tracing::instrument(skip(self, profile), fields(profile_id = %profile.id, profile_name = %profile.name))]
    pub fn save(&self, profile: &ConnectionProfile) -> Result<(), CoreError> {
        tracing::debug!("Saving connection profile");
        if profile.password.is_empty() {
            self.delete_password(&profile.id)?;
        } else {
            self.set_password(&profile.id, &profile.password)?;
        }

        // SSH credentials are #[serde(skip_serializing)], so they never reach
        // the JSON below. Store them in the keyring like the main password.
        self.set_ssh_secret(
            &profile.id,
            SSH_PASSWORD_SLOT,
            profile
                .ssh_config
                .as_ref()
                .and_then(|c| c.password.as_deref()),
        )?;
        self.set_ssh_secret(
            &profile.id,
            SSH_PASSPHRASE_SLOT,
            profile
                .ssh_config
                .as_ref()
                .and_then(|c| c.passphrase.as_deref()),
        )?;

        let db = self
            .db
            .lock()
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let ssh_json = profile
            .ssh_config
            .as_ref()
            .map(|c| serde_json::to_string(c).unwrap_or_default());
        let ssl_json = profile
            .ssl_config
            .as_ref()
            .map(|c| serde_json::to_string(c).unwrap_or_default());

        db.execute(
            "INSERT OR REPLACE INTO connection_profiles
             (id, name, grp, color, host, port, username, password, default_database,
              ssh_config, ssl_config, pool_min, pool_max, read_only, created_at, updated_at, env,
              connect_timeout_secs, query_timeout_secs, charset)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                profile.id,
                profile.name,
                profile.group,
                profile.color,
                profile.host,
                profile.port,
                profile.username,
                "",
                profile.default_database,
                ssh_json,
                ssl_json,
                profile.pool_min,
                profile.pool_max,
                profile.read_only as i32,
                profile.created_at.to_rfc3339(),
                Utc::now().to_rfc3339(),
                profile.environment.as_ref().map(|e| e.to_string()),
                profile.connect_timeout_secs,
                profile.query_timeout_secs,
                profile.charset,
            ],
        )?;
        tracing::debug!("Connection profile saved");
        Ok(())
    }

    #[tracing::instrument(skip(self))]
    pub fn list(&self) -> Result<Vec<ConnectionProfileSummary>, CoreError> {
        tracing::debug!("Listing connection profiles");
        let db = self
            .db
            .lock()
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let mut stmt = db.prepare(
            "SELECT id, name, grp, color, host, port, username, default_database,
                    ssh_config, ssl_config, pool_min, pool_max, read_only, created_at, updated_at, env,
                    connect_timeout_secs, query_timeout_secs, charset
              FROM connection_profiles ORDER BY name",
        )?;

        let profiles = stmt
            .query_map([], |row| {
                let ssh_str: Option<String> = row.get(8)?;
                let ssl_str: Option<String> = row.get(9)?;
                let created_str: String = row.get(13)?;
                let updated_str: String = row.get(14)?;
                let env_str: Option<String> = row.get(15)?;

                Ok(ConnectionProfileSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    group: row.get(2)?,
                    color: row.get(3)?,
                    host: row.get(4)?,
                    port: row.get::<_, i32>(5)? as u16,
                    username: row.get(6)?,
                    default_database: row.get(7)?,
                    ssh_config: ssh_str.and_then(|s| serde_json::from_str(&s).ok()),
                    ssl_config: ssl_str.and_then(|s| serde_json::from_str(&s).ok()),
                    pool_min: row.get::<_, i32>(10)? as u32,
                    pool_max: row.get::<_, i32>(11)? as u32,
                    read_only: row.get::<_, i32>(12)? != 0,
                    connect_timeout_secs: row.get(16)?,
                    query_timeout_secs: row.get(17)?,
                    charset: row.get(18)?,
                    environment: env_str.and_then(|s| match s.as_str() {
                        "development" => Some(crate::models::ConnectionEnvironment::Development),
                        "staging" => Some(crate::models::ConnectionEnvironment::Staging),
                        "production" => Some(crate::models::ConnectionEnvironment::Production),
                        _ => None,
                    }),
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|_| chrono::Utc::now()),
                    updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|_| chrono::Utc::now()),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        tracing::debug!(count = profiles.len(), "Listed connection profiles");
        Ok(profiles)
    }

    #[tracing::instrument(skip(self))]
    /// The stored profile, or `None` if there is no such profile yet.
    ///
    /// The distinction matters when filling in credentials the frontend did
    /// not send back. "Nothing stored" means a new profile, where an empty
    /// password really is the user's intent. A keyring that is locked or
    /// unavailable is a different thing entirely, and treating it as "no
    /// password" makes the next save delete the credential (#274) — so that
    /// case is returned as an error rather than folded into `None`.
    pub fn get_existing(&self, id: &str) -> Result<Option<ConnectionProfile>, CoreError> {
        match self.get(id) {
            Ok(profile) => Ok(Some(profile)),
            Err(CoreError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn get(&self, id: &str) -> Result<ConnectionProfile, CoreError> {
        tracing::debug!("Getting connection profile");
        let db = self
            .db
            .lock()
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let mut stmt = db.prepare(
            "SELECT id, name, grp, color, host, port, username, password, default_database,
                    ssh_config, ssl_config, pool_min, pool_max, read_only, created_at, updated_at, env,
                    connect_timeout_secs, query_timeout_secs, charset
              FROM connection_profiles WHERE id = ?1",
        )?;

        let mut profile = stmt
            .query_row(params![id], |row| {
                let ssh_str: Option<String> = row.get(9)?;
                let ssl_str: Option<String> = row.get(10)?;
                let created_str: String = row.get(14)?;
                let updated_str: String = row.get(15)?;
                let env_str: Option<String> = row.get(16)?;
                Ok(ConnectionProfile {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    group: row.get(2)?,
                    color: row.get(3)?,
                    host: row.get(4)?,
                    port: row.get::<_, i32>(5)? as u16,
                    username: row.get(6)?,
                    password: row.get(7)?,
                    default_database: row.get(8)?,
                    ssh_config: ssh_str.and_then(|s| serde_json::from_str(&s).ok()),
                    ssl_config: ssl_str.and_then(|s| serde_json::from_str(&s).ok()),
                    pool_min: row.get::<_, i32>(11)? as u32,
                    pool_max: row.get::<_, i32>(12)? as u32,
                    read_only: row.get::<_, i32>(13)? != 0,
                    connect_timeout_secs: row.get(17)?,
                    query_timeout_secs: row.get(18)?,
                    charset: row.get(19)?,
                    environment: env_str.and_then(|s| match s.as_str() {
                        "development" => Some(crate::models::ConnectionEnvironment::Development),
                        "staging" => Some(crate::models::ConnectionEnvironment::Staging),
                        "production" => Some(crate::models::ConnectionEnvironment::Production),
                        _ => None,
                    }),
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|_| chrono::Utc::now()),
                    updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|_| chrono::Utc::now()),
                })
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    CoreError::NotFound(format!("Connection profile not found: {}", id))
                }
                _ => CoreError::Rusqlite(e),
            })?;
        drop(stmt);
        drop(db);

        // The stored JSON never contains these, so put them back from the keyring.
        if let Some(ssh) = profile.ssh_config.as_mut() {
            ssh.password = self.get_ssh_secret(id, SSH_PASSWORD_SLOT)?;
            ssh.passphrase = self.get_ssh_secret(id, SSH_PASSPHRASE_SLOT)?;
        }

        let legacy_password = profile.password.clone();
        if let Some(password) = self.get_password(id)? {
            profile.password = password;
            if !legacy_password.is_empty() {
                self.clear_plaintext_password(id)?;
            }
            return Ok(profile);
        }

        if !legacy_password.is_empty() {
            self.set_password(id, &legacy_password)?;
            self.clear_plaintext_password(id)?;
            profile.password = legacy_password;
            return Ok(profile);
        }

        profile.password = String::new();
        Ok(profile)
    }

    #[tracing::instrument(skip(self))]
    pub fn delete(&self, id: &str) -> Result<(), CoreError> {
        tracing::debug!("Deleting connection profile");
        let db = self
            .db
            .lock()
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        db.execute("DELETE FROM connection_profiles WHERE id = ?1", params![id])?;
        drop(db);
        self.delete_password(id)?;
        self.delete_password(&slot_key(id, SSH_PASSWORD_SLOT))?;
        self.delete_password(&slot_key(id, SSH_PASSPHRASE_SLOT))?;
        tracing::debug!("Connection profile deleted");
        Ok(())
    }

    fn keyring_entry(&self, key: &str) -> Result<Entry, CoreError> {
        Entry::new(KEYRING_SERVICE, key).map_err(|e| {
            CoreError::Storage(format!(
                "Failed to initialize keyring entry for {}: {}",
                key, e
            ))
        })
    }

    /// Write one SSH secret, or remove it when absent/empty.
    fn set_ssh_secret(
        &self,
        profile_id: &str,
        slot: &str,
        value: Option<&str>,
    ) -> Result<(), CoreError> {
        let key = slot_key(profile_id, slot);
        match value.filter(|v| !v.is_empty()) {
            Some(v) => self.set_password(&key, v),
            None => self.delete_password(&key),
        }
    }

    fn get_ssh_secret(&self, profile_id: &str, slot: &str) -> Result<Option<String>, CoreError> {
        self.get_password(&slot_key(profile_id, slot))
    }

    fn set_password(&self, key: &str, password: &str) -> Result<(), CoreError> {
        let entry = self.keyring_entry(key)?;
        entry.set_password(password).map_err(|e| {
            CoreError::Storage(format!(
                "Failed to store password in keyring for {}: {}",
                key, e
            ))
        })
    }

    fn get_password(&self, key: &str) -> Result<Option<String>, CoreError> {
        let entry = self.keyring_entry(key)?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(e) => Err(CoreError::Storage(format!(
                "Failed to read password from keyring for {}: {}",
                key, e
            ))),
        }
    }

    fn delete_password(&self, key: &str) -> Result<(), CoreError> {
        let entry = self.keyring_entry(key)?;
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(e) => Err(CoreError::Storage(format!(
                "Failed to delete password from keyring for {}: {}",
                key, e
            ))),
        }
    }

    fn clear_plaintext_password(&self, profile_id: &str) -> Result<(), CoreError> {
        let db = self
            .db
            .lock()
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        db.execute(
            "UPDATE connection_profiles SET password = '' WHERE id = ?1",
            params![profile_id],
        )?;
        Ok(())
    }

    fn migrate_plaintext_passwords(&self) -> Result<(), CoreError> {
        let db = self
            .db
            .lock()
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let mut stmt = db.prepare(
            "SELECT id, password FROM connection_profiles WHERE password IS NOT NULL AND password != ''",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let password: String = row.get(1)?;
                Ok((id, password))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        drop(db);

        for (id, password) in rows {
            // A keyring that will not answer must not stop the app opening.
            // This ran from ConnectionStore::new, whose caller `.expect()`s,
            // so a locked Secret Service or a sandbox without one made the
            // app unlaunchable for anyone with a saved profile (#278). The
            // plaintext row is left alone so the migration can be retried on
            // a later launch, once the keyring works.
            if let Err(e) = self.set_password(&id, &password) {
                tracing::warn!(
                    profile_id = %id,
                    error = %e,
                    "Could not move a stored password into the keyring; leaving it in place \
                     and continuing. It will be migrated on a later launch."
                );
                continue;
            }
            if let Err(e) = self.clear_plaintext_password(&id) {
                tracing::warn!(profile_id = %id, error = %e, "Migrated password but could not clear the old copy");
                continue;
            }
            tracing::info!(profile_id = %id, "Migrated plaintext password to keyring");
        }

        Ok(())
    }
}
