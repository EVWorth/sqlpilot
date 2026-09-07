use crate::error::SqliteError;
use dashmap::DashMap;
use rusqlite::Connection as SqliteConn;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Every SQLite database begins with these bytes.
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// Check that the path names an existing SQLite database before opening it.
///
/// `rusqlite::Connection::open` is more accommodating than is useful here.
/// Verified against the version in this tree:
///
///   * a path that does not exist is **created** as a new empty database, so
///     a typo leaves a stray file behind and reports success
///   * a file that is not a database opens fine and fails on the first query
///     with "file is not a database" — an error that describes the symptom
///     rather than the cause
///
/// Opening is meant to open something that is already there. Creating a
/// database is a different act and should be a different command (#463).
fn verify_is_sqlite_file(path: &str) -> Result<(), SqliteError> {
    use std::io::Read;

    // An in-memory database has no file to inspect. SQLite spells it
    // `:memory:`, or a URI carrying mode=memory.
    if path == ":memory:" || path.is_empty() || path.contains("mode=memory") {
        return Ok(());
    }

    let meta = std::fs::metadata(path)
        .map_err(|e| SqliteError::NotFound(format!("Cannot open {}: {}", path, e)))?;

    if !meta.is_file() {
        return Err(SqliteError::NotFound(format!(
            "Cannot open {}: not a regular file",
            path
        )));
    }

    // Deliberately no maximum size. A real database can be tens of gigabytes,
    // and refusing to open one because it is large would be a bug wearing the
    // clothes of a safety check.
    let mut header = [0u8; 16];
    let mut file = std::fs::File::open(path)
        .map_err(|e| SqliteError::NotFound(format!("Cannot open {}: {}", path, e)))?;
    let read = file
        .read(&mut header)
        .map_err(|e| SqliteError::NotFound(format!("Cannot read {}: {}", path, e)))?;

    if read < header.len() || &header != SQLITE_MAGIC {
        return Err(SqliteError::NotFound(format!(
            "{} is not a SQLite database",
            path
        )));
    }

    Ok(())
}

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
        verify_is_sqlite_file(path)?;
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
