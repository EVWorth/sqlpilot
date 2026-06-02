use crate::error::SqliteError;
use dashmap::DashMap;
use rusqlite::Connection as SqliteConn;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct SqliteConnection {
    pub id: String,
    pub path: PathBuf,
    pub db: Mutex<SqliteConn>,
}

pub struct SqliteConnectionManager {
    connections: DashMap<String, Arc<SqliteConnection>>,
}

impl SqliteConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: DashMap::new(),
        }
    }

    pub fn open(&self, id: &str, path: &str) -> Result<Arc<SqliteConnection>, SqliteError> {
        let db = SqliteConn::open(path)?;
        let conn = Arc::new(SqliteConnection {
            id: id.to_string(),
            path: PathBuf::from(path),
            db: Mutex::new(db),
        });
        self.connections.insert(id.to_string(), conn.clone());
        Ok(conn)
    }

    pub fn get(&self, id: &str) -> Result<Arc<SqliteConnection>, SqliteError> {
        self.connections
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| SqliteError::NotFound(format!("SQLite connection not found: {}", id)))
    }

    pub fn close(&self, id: &str) -> Result<(), SqliteError> {
        if self.connections.remove(id).is_some() {
            Ok(())
        } else {
            Err(SqliteError::NotFound(format!(
                "SQLite connection not found: {}",
                id
            )))
        }
    }

    pub fn list(&self) -> Vec<String> {
        self.connections.iter().map(|e| e.key().clone()).collect()
    }
}

impl Default for SqliteConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}
