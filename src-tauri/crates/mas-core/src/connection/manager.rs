use crate::error::CoreError;
use crate::models::{ConnectionInfo, ConnectionProfile, SSLMode, TestConnectionResult};
use chrono::Utc;
use dashmap::DashMap;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};
use sqlx::MySqlPool;
use std::sync::Arc;
use std::time::Instant;

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

    #[tracing::instrument(skip(self, profile), fields(host = %profile.host, port = %profile.port, user = %profile.username))]
    pub async fn connect(&self, profile: &ConnectionProfile) -> Result<ConnectionInfo, CoreError> {
        let conn_id = uuid::Uuid::new_v4().to_string();

        tracing::debug!(
            connection_id = %conn_id,
            pool_min = profile.pool_min,
            pool_max = profile.pool_max,
            default_database = ?profile.default_database,
            "Creating connection pool"
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

        options = apply_ssl_config(options, profile);

        tracing::debug!(connection_id = %conn_id, "Connecting to MySQL server");

        let pool = MySqlPoolOptions::new()
            .min_connections(profile.pool_min)
            .max_connections(profile.pool_max)
            .acquire_timeout(std::time::Duration::from_secs(5))
            .idle_timeout(std::time::Duration::from_secs(300))
            .after_connect(|conn, _meta| {
                Box::pin(async move {
                    sqlx::query("SET NAMES utf8mb4").execute(&mut *conn).await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .map_err(|e| {
                tracing::warn!(connection_id = %conn_id, error = %e, "Connection failed");
                CoreError::Connection(format!("Failed to connect: {}", e))
            })?;

        // If no default database was specified, auto-select the first user database
        let effective_database: Option<String> = if profile
            .default_database
            .as_deref()
            .map(|s| s.is_empty())
            .unwrap_or(true)
        {
            let system_dbs = ["information_schema", "performance_schema", "mysql", "sys"];
            let db_rows: Vec<(String,)> = sqlx::query_as("SHOW DATABASES")
                .fetch_all(&pool)
                .await
                .unwrap_or_default();
            db_rows
                .into_iter()
                .map(|(name,)| name)
                .find(|name| !system_dbs.contains(&name.to_lowercase().as_str()))
        } else {
            profile.default_database.clone()
        };

        // Get server version
        let version: (String,) = sqlx::query_as("SELECT VERSION()")
            .fetch_one(&pool)
            .await
            .map_err(|e| {
                tracing::warn!(connection_id = %conn_id, error = %e, "Failed to get server version");
                CoreError::Connection(format!("Failed to get server version: {}", e))
            })?;

        let info = ConnectionInfo {
            id: conn_id.clone(),
            profile_id: profile.id.clone(),
            name: profile.name.clone(),
            host: profile.host.clone(),
            port: profile.port,
            database: effective_database,
            server_version: version.0,
            connected_at: Utc::now(),
            color: profile.color.clone(),
            environment: profile.environment.clone(),
        };

        self.connections.insert(
            conn_id,
            ActiveConnection {
                info: info.clone(),
                pool,
            },
        );

        tracing::info!(connection_id = %info.id, version = %info.server_version, "Connected successfully");
        Ok(info)
    }

    #[tracing::instrument(skip(self))]
    pub async fn disconnect(&self, connection_id: &str) -> Result<(), CoreError> {
        if let Some((_, conn)) = self.connections.remove(connection_id) {
            conn.pool.close().await;
            tracing::info!(connection_id = %connection_id, "Disconnected");
            Ok(())
        } else {
            tracing::warn!(connection_id = %connection_id, "Connection not found for disconnect");
            Err(CoreError::NotFound(format!(
                "Connection not found: {}",
                connection_id
            )))
        }
    }

    #[tracing::instrument(skip(profile), fields(host = %profile.host, port = %profile.port))]
    pub async fn test_connection(
        profile: &ConnectionProfile,
    ) -> Result<TestConnectionResult, CoreError> {
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

        options = apply_ssl_config(options, profile);

        tracing::debug!("Testing connection");

        match MySqlPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(5))
            .connect_with(options)
            .await
        {
            Ok(pool) => {
                let version: Result<(String,), _> =
                    sqlx::query_as("SELECT VERSION()").fetch_one(&pool).await;
                pool.close().await;
                let latency = start.elapsed().as_millis() as u64;
                match version {
                    Ok((v,)) => {
                        tracing::info!(version = %v, latency_ms = latency, "Test connection succeeded");
                        Ok(TestConnectionResult {
                            success: true,
                            message: format!("Connected to MySQL {}", v),
                            server_version: Some(v),
                            latency_ms: latency,
                        })
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, latency_ms = latency, "Test connection: connected but query failed");
                        Ok(TestConnectionResult {
                            success: false,
                            message: format!("Connected but failed to query: {}", e),
                            server_version: None,
                            latency_ms: latency,
                        })
                    }
                }
            }
            Err(e) => {
                let latency = start.elapsed().as_millis() as u64;
                tracing::warn!(error = %e, latency_ms = latency, "Test connection failed");
                Ok(TestConnectionResult {
                    success: false,
                    message: format!("Connection failed: {}", e),
                    server_version: None,
                    latency_ms: latency,
                })
            }
        }
    }

    #[tracing::instrument(skip(self))]
    pub fn get_pool(&self, connection_id: &str) -> Result<MySqlPool, CoreError> {
        self.connections
            .get(connection_id)
            .map(|conn| conn.pool.clone())
            .ok_or_else(|| {
                tracing::debug!(connection_id = %connection_id, "Pool not found");
                CoreError::NotFound(format!("Connection not found: {}", connection_id))
            })
    }

    #[tracing::instrument(skip(self))]
    pub fn list_connections(&self) -> Vec<ConnectionInfo> {
        let connections: Vec<ConnectionInfo> = self
            .connections
            .iter()
            .map(|entry| entry.value().info.clone())
            .collect();
        tracing::debug!(count = connections.len(), "Listed active connections");
        connections
    }
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}

fn apply_ssl_config(
    mut options: MySqlConnectOptions,
    profile: &ConnectionProfile,
) -> MySqlConnectOptions {
    if let Some(ref ssl) = profile.ssl_config {
        let mode = match ssl.mode {
            SSLMode::Disabled => MySqlSslMode::Disabled,
            SSLMode::Preferred => MySqlSslMode::Preferred,
            SSLMode::Required => MySqlSslMode::Required,
            SSLMode::VerifyCA => MySqlSslMode::VerifyCa,
            SSLMode::VerifyIdentity => MySqlSslMode::VerifyIdentity,
        };
        options = options.ssl_mode(mode);

        if let Some(ref ca) = ssl.ca_cert_path {
            if !ca.is_empty() {
                options = options.ssl_ca(ca);
            }
        }
        if let Some(ref cert) = ssl.client_cert_path {
            if !cert.is_empty() {
                options = options.ssl_client_cert(cert);
            }
        }
        if let Some(ref key) = ssl.client_key_path {
            if !key.is_empty() {
                options = options.ssl_client_key(key);
            }
        }
    }
    options
}
