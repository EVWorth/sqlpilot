use crate::error::CoreError;
use crate::models::{ConnectionInfo, ConnectionProfile, TestConnectionResult};
use chrono::Utc;
use dashmap::DashMap;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::MySqlPool;
use std::sync::Arc;
use std::time::Instant;
use tracing::info;

pub struct ActiveConnection {
    pub info: ConnectionInfo,
    pub pool: MySqlPool,
}

pub struct ConnectionManager {
    connections: Arc<DashMap<String, ActiveConnection>>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(DashMap::new()),
        }
    }

    pub async fn connect(&self, profile: &ConnectionProfile) -> Result<ConnectionInfo, CoreError> {
        let conn_id = uuid::Uuid::new_v4().to_string();

        info!(
            connection_id = %conn_id,
            host = %profile.host,
            port = %profile.port,
            "Establishing MySQL connection"
        );

        let mut options = MySqlConnectOptions::new()
            .host(&profile.host)
            .port(profile.port)
            .username(&profile.username)
            .password(&profile.password)
            .charset("utf8mb4");

        if let Some(ref db) = profile.default_database {
            if !db.is_empty() {
                options = options.database(db);
            }
        }

        let pool = MySqlPoolOptions::new()
            .min_connections(profile.pool_min)
            .max_connections(profile.pool_max)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .idle_timeout(std::time::Duration::from_secs(300))
            .after_connect(|conn, _meta| {
                Box::pin(async move {
                    sqlx::query("SET NAMES utf8mb4")
                        .execute(&mut *conn)
                        .await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .map_err(|e| CoreError::Connection(format!("Failed to connect: {}", e)))?;

        // Get server version
        let version: (String,) = sqlx::query_as("SELECT VERSION()")
            .fetch_one(&pool)
            .await
            .map_err(|e| CoreError::Connection(format!("Failed to get server version: {}", e)))?;

        let info = ConnectionInfo {
            id: conn_id.clone(),
            profile_id: profile.id.clone(),
            name: profile.name.clone(),
            host: profile.host.clone(),
            port: profile.port,
            database: profile.default_database.clone(),
            server_version: version.0,
            connected_at: Utc::now(),
            color: profile.color.clone(),
        };

        self.connections.insert(conn_id, ActiveConnection {
            info: info.clone(),
            pool,
        });

        info!(connection_id = %info.id, version = %info.server_version, "Connected successfully");
        Ok(info)
    }

    pub async fn disconnect(&self, connection_id: &str) -> Result<(), CoreError> {
        if let Some((_, conn)) = self.connections.remove(connection_id) {
            conn.pool.close().await;
            info!(connection_id = %connection_id, "Disconnected");
            Ok(())
        } else {
            Err(CoreError::NotFound(format!("Connection not found: {}", connection_id)))
        }
    }

    pub async fn test_connection(profile: &ConnectionProfile) -> Result<TestConnectionResult, CoreError> {
        let start = Instant::now();

        let mut options = MySqlConnectOptions::new()
            .host(&profile.host)
            .port(profile.port)
            .username(&profile.username)
            .password(&profile.password)
            .charset("utf8mb4");

        if let Some(ref db) = profile.default_database {
            if !db.is_empty() {
                options = options.database(db);
            }
        }

        match MySqlPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect_with(options)
            .await
        {
            Ok(pool) => {
                let version: Result<(String,), _> = sqlx::query_as("SELECT VERSION()")
                    .fetch_one(&pool)
                    .await;
                pool.close().await;
                let latency = start.elapsed().as_millis() as u64;
                match version {
                    Ok((v,)) => Ok(TestConnectionResult {
                        success: true,
                        message: format!("Connected to MySQL {}", v),
                        server_version: Some(v),
                        latency_ms: latency,
                    }),
                    Err(e) => Ok(TestConnectionResult {
                        success: false,
                        message: format!("Connected but failed to query: {}", e),
                        server_version: None,
                        latency_ms: latency,
                    }),
                }
            }
            Err(e) => {
                let latency = start.elapsed().as_millis() as u64;
                Ok(TestConnectionResult {
                    success: false,
                    message: format!("Connection failed: {}", e),
                    server_version: None,
                    latency_ms: latency,
                })
            }
        }
    }

    pub fn get_pool(&self, connection_id: &str) -> Result<MySqlPool, CoreError> {
        self.connections
            .get(connection_id)
            .map(|conn| conn.pool.clone())
            .ok_or_else(|| CoreError::NotFound(format!("Connection not found: {}", connection_id)))
    }

    pub fn list_connections(&self) -> Vec<ConnectionInfo> {
        self.connections
            .iter()
            .map(|entry| entry.value().info.clone())
            .collect()
    }
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}
