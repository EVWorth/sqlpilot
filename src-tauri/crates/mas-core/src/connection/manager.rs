use crate::error::CoreError;
use crate::models::{ConnectionInfo, ConnectionProfile, SSLMode, TestConnectionResult};
use chrono::Utc;
use dashmap::DashMap;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};
use sqlx::{AssertSqlSafe, MySqlPool};
use std::sync::Arc;
use std::time::Instant;

pub struct ActiveConnection {
    pub info: ConnectionInfo,
    pub pool: MySqlPool,
    /// Copied off the profile at connect time. The profile can be edited while
    /// a connection is live; the limits a query runs under are the ones that
    /// were in force when it was opened.
    pub query_timeout_secs: Option<u32>,
    pub read_only: bool,
    pub pool_max: u32,
    pub acquire_timeout_secs: u64,
    /// Who the server sees this connection as, for the audit line on a write.
    pub actor: String,
    /// Server thread ids this pool has opened.
    ///
    /// Recorded so the process list can tell the application's own sessions
    /// apart from everyone else's, and refuse to kill them (#433). An id stays
    /// after its connection is recycled, which only ever means declining to
    /// kill a thread that no longer exists.
    pub own_threads: Arc<dashmap::DashSet<u64>>,
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

        let charset = profile
            .charset
            .clone()
            .unwrap_or_else(|| "utf8mb4".to_string());
        let mut options = MySqlConnectOptions::new()
            .host(&profile.host)
            .port(profile.port)
            .username(&profile.username)
            .password(&profile.password)
            .charset(&charset);

        if let Some(ref db) = profile.default_database {
            if !db.is_empty() {
                options = options.database(db);
            }
        }

        options = apply_ssl_config(options, profile);

        tracing::debug!(connection_id = %conn_id, "Connecting to MySQL server");

        let charset_for_after_connect = charset.clone();
        let own_threads: Arc<dashmap::DashSet<u64>> = Arc::new(dashmap::DashSet::new());
        let own_threads_for_after_connect = Arc::clone(&own_threads);
        let pool = MySqlPoolOptions::new()
            .min_connections(profile.pool_min)
            .max_connections(profile.pool_max)
            .acquire_timeout(std::time::Duration::from_secs(
                profile.connect_timeout_secs.unwrap_or(10) as u64,
            ))
            .idle_timeout(std::time::Duration::from_secs(300))
            .after_connect(move |conn, _meta| {
                let charset = charset_for_after_connect.clone();
                let own_threads = Arc::clone(&own_threads_for_after_connect);
                Box::pin(async move {
                    sqlx::query(AssertSqlSafe(format!("SET NAMES {}", charset)))
                        .execute(&mut *conn)
                        .await?;
                    // Note which server thread this pooled connection is, so
                    // the admin panel can refuse to kill the application out
                    // from under itself.
                    let (thread_id,): (u64,) = sqlx::query_as("SELECT CONNECTION_ID()")
                        .fetch_one(&mut *conn)
                        .await?;
                    own_threads.insert(thread_id);
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .map_err(|e| {
                tracing::warn!(connection_id = %conn_id, error = %e, "Connection failed");
                super::describe_pool_error(
                    &e,
                    &profile.name,
                    profile.pool_max,
                    profile.connect_timeout_secs.unwrap_or(10) as u64,
                )
                .unwrap_or_else(|| CoreError::Connection(format!("Failed to connect: {}", e)))
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
                query_timeout_secs: profile.query_timeout_secs,
                read_only: profile.read_only,
                pool_max: profile.pool_max,
                acquire_timeout_secs: profile.connect_timeout_secs.unwrap_or(10) as u64,
                actor: format!("{}@{}:{}", profile.username, profile.host, profile.port),
                own_threads: Arc::clone(&own_threads),
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

        let charset = profile
            .charset
            .clone()
            .unwrap_or_else(|| "utf8mb4".to_string());
        let mut options = MySqlConnectOptions::new()
            .host(&profile.host)
            .port(profile.port)
            .username(&profile.username)
            .password(&profile.password)
            .charset(&charset);

        if let Some(ref db) = profile.default_database {
            if !db.is_empty() {
                options = options.database(db);
            }
        }

        options = apply_ssl_config(options, profile);

        tracing::debug!("Testing connection");

        match MySqlPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(
                profile.connect_timeout_secs.unwrap_or(10) as u64,
            ))
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

    /// Pool sizing for a live connection, for the message when it runs out.
    pub fn pool_limits(&self, connection_id: &str) -> Option<(String, u32, u64)> {
        self.connections.get(connection_id).map(|conn| {
            (
                conn.info.name.clone(),
                conn.pool_max,
                conn.acquire_timeout_secs,
            )
        })
    }

    /// Query timeout in force for a live connection. `None` (and a stored `0`)
    /// both mean "no limit" — that is the profile default.
    pub fn get_query_timeout(&self, connection_id: &str) -> Option<std::time::Duration> {
        self.connections
            .get(connection_id)
            .and_then(|conn| conn.query_timeout_secs)
            .filter(|secs| *secs > 0)
            .map(|secs| std::time::Duration::from_secs(secs as u64))
    }

    /// Server version banner for a live connection, used to tell MariaDB's
    /// `ANALYZE` dialect from MySQL's `EXPLAIN ANALYZE`.
    pub fn get_server_version(&self, connection_id: &str) -> Option<String> {
        self.connections
            .get(connection_id)
            .map(|conn| conn.info.server_version.clone())
    }

    /// The account a connection authenticates as, as `user@host:port`.
    ///
    /// A statement that changes something should be attributable to someone;
    /// the executor's log line recorded the SQL but never who ran it (#429).
    pub fn get_actor(&self, connection_id: &str) -> Option<String> {
        self.connections
            .get(connection_id)
            .map(|conn| conn.actor.clone())
    }

    /// Whether `thread_id` is one of this application's own server sessions.
    pub fn is_own_thread(&self, connection_id: &str, thread_id: u64) -> bool {
        self.connections
            .get(connection_id)
            .is_some_and(|conn| conn.own_threads.contains(&thread_id))
    }

    /// The server threads this connection's pool has opened.
    pub fn own_thread_ids(&self, connection_id: &str) -> Vec<u64> {
        self.connections
            .get(connection_id)
            .map(|conn| conn.own_threads.iter().map(|id| *id).collect())
            .unwrap_or_default()
    }

    /// Whether the profile behind a live connection forbids writes.
    pub fn is_read_only(&self, connection_id: &str) -> bool {
        self.connections
            .get(connection_id)
            .map(|conn| conn.read_only)
            .unwrap_or(false)
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
