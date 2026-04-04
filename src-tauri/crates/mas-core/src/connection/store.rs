use crate::error::CoreError;
use crate::models::ConnectionProfile;
use chrono::Utc;
use rusqlite::{params, Connection as SqliteConn};
use std::path::Path;
use std::sync::Mutex;

pub struct ConnectionStore {
    db: Mutex<SqliteConn>,
}

impl ConnectionStore {
    pub fn new(path: &Path) -> Result<Self, CoreError> {
        let db = SqliteConn::open(path)?;
        let store = Self { db: Mutex::new(db) };
        store.init_tables()?;
        tracing::info!(path = %path.display(), "Connection store initialized");
        Ok(store)
    }

    fn init_tables(&self) -> Result<(), CoreError> {
        let db = self.db.lock().map_err(|e| CoreError::Storage(e.to_string()))?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS connection_profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                grp TEXT,
                color TEXT,
                host TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 3306,
                username TEXT NOT NULL,
                password TEXT NOT NULL DEFAULT '',
                default_database TEXT,
                ssh_config TEXT,
                ssl_config TEXT,
                pool_min INTEGER NOT NULL DEFAULT 1,
                pool_max INTEGER NOT NULL DEFAULT 5,
                read_only INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"
        )?;
        tracing::debug!("Connection profiles table initialized");
        Ok(())
    }

    #[tracing::instrument(skip(self, profile), fields(profile_id = %profile.id, profile_name = %profile.name))]
    pub fn save(&self, profile: &ConnectionProfile) -> Result<(), CoreError> {
        tracing::debug!("Saving connection profile");
        let db = self.db.lock().map_err(|e| CoreError::Storage(e.to_string()))?;
        let ssh_json = profile.ssh_config.as_ref().map(|c| serde_json::to_string(c).unwrap_or_default());
        let ssl_json = profile.ssl_config.as_ref().map(|c| serde_json::to_string(c).unwrap_or_default());

        db.execute(
            "INSERT OR REPLACE INTO connection_profiles
             (id, name, grp, color, host, port, username, password, default_database,
              ssh_config, ssl_config, pool_min, pool_max, read_only, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                profile.id,
                profile.name,
                profile.group,
                profile.color,
                profile.host,
                profile.port,
                profile.username,
                profile.password,
                profile.default_database,
                ssh_json,
                ssl_json,
                profile.pool_min,
                profile.pool_max,
                profile.read_only as i32,
                profile.created_at.to_rfc3339(),
                Utc::now().to_rfc3339(),
            ],
        )?;
        tracing::debug!("Connection profile saved");
        Ok(())
    }

    #[tracing::instrument(skip(self))]
    pub fn list(&self) -> Result<Vec<ConnectionProfile>, CoreError> {
        tracing::debug!("Listing connection profiles");
        let db = self.db.lock().map_err(|e| CoreError::Storage(e.to_string()))?;
        let mut stmt = db.prepare(
            "SELECT id, name, grp, color, host, port, username, password, default_database,
                    ssh_config, ssl_config, pool_min, pool_max, read_only, created_at, updated_at
             FROM connection_profiles ORDER BY name"
        )?;

        let profiles = stmt.query_map([], |row| {
            let ssh_str: Option<String> = row.get(9)?;
            let ssl_str: Option<String> = row.get(10)?;
            let created_str: String = row.get(14)?;
            let updated_str: String = row.get(15)?;

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
                created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
                    .map(|dt| dt.with_timezone(&chrono::Utc))
                    .unwrap_or_else(|_| chrono::Utc::now()),
                updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
                    .map(|dt| dt.with_timezone(&chrono::Utc))
                    .unwrap_or_else(|_| chrono::Utc::now()),
            })
        })?.collect::<Result<Vec<_>, _>>()?;

        tracing::debug!(count = profiles.len(), "Listed connection profiles");
        Ok(profiles)
    }

    #[tracing::instrument(skip(self))]
    pub fn get(&self, id: &str) -> Result<ConnectionProfile, CoreError> {
        tracing::debug!("Getting connection profile");
        let profiles = self.list()?;
        profiles.into_iter().find(|p| p.id == id)
            .ok_or_else(|| CoreError::NotFound(format!("Connection profile not found: {}", id)))
    }

    #[tracing::instrument(skip(self))]
    pub fn delete(&self, id: &str) -> Result<(), CoreError> {
        tracing::debug!("Deleting connection profile");
        let db = self.db.lock().map_err(|e| CoreError::Storage(e.to_string()))?;
        db.execute("DELETE FROM connection_profiles WHERE id = ?1", params![id])?;
        tracing::debug!("Connection profile deleted");
        Ok(())
    }
}
