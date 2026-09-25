use crate::error::CoreError;
use crate::models::{ConnectionInfo, ConnectionProfile, SSLMode, TestConnectionResult};
use chrono::Utc;
use dashmap::DashMap;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};
use sqlx::{AssertSqlSafe, MySqlPool};
use std::sync::Arc;
use std::time::Instant;

/// What a connection is being used for, which decides the pool it comes from.
///
/// One shared pool let any kind of work starve every other: an agent running a
/// few queries, or a backup holding its connection for the length of a dump,
/// could leave the editor waiting for a slot and then failing with "pool timed
/// out" (#731). Each lane is its own pool, so work can only exhaust its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lane {
    /// The editor, schema browsing and the admin panel. Sized by the profile's
    /// "Max pool size".
    Interactive,
    /// Everything an agent does over MCP. FR-6.3.2: a runaway agent query
    /// cannot starve the user's.
    Agent,
    /// Backups and restores, which hold one connection for their whole run.
    Job,
}

/// Where a statement gets its connection: a shared lane, or one editor tab's
/// own session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Lane(Lane),
    /// The dedicated connection an editor tab keeps for as long as it is open,
    /// keyed by whatever id the caller gives the tab (#731).
    Session(String),
}

impl From<Lane> for Route {
    fn from(lane: Lane) -> Self {
        Route::Lane(lane)
    }
}

/// Connections the agent lane may hold: a query and a staged write at once.
pub const AGENT_LANE_MAX: u32 = 2;

/// Connections the job lane may hold: a backup and a restore at once.
pub const JOB_LANE_MAX: u32 = 2;

/// How long an unused agent or job connection is kept before it is closed.
///
/// Short, because these lanes are used in bursts and most sessions never use
/// them at all; an idle server thread held for them is pure cost.
const SIDE_LANE_IDLE_SECS: u64 = 60;

pub struct ActiveConnection {
    pub info: ConnectionInfo,
    /// The interactive lane.
    pub pool: MySqlPool,
    /// The agent lane. Opened lazily: it holds no server connection until an
    /// agent first uses it, and gives them back when idle.
    pub agent_pool: MySqlPool,
    /// The job lane, opened lazily in the same way.
    pub job_pool: MySqlPool,
    /// Copied off the profile at connect time. The profile can be edited while
    /// a connection is live; the limits a query runs under are the ones that
    /// were in force when it was opened.
    pub query_timeout_secs: Option<u32>,
    pub read_only: bool,
    pub pool_max: u32,
    pub acquire_timeout_secs: u64,
    /// Who the server sees this connection as, for the audit line on a write.
    pub actor: String,
    /// What the health checker last saw, and the handle that stops it.
    ///
    /// The sender half of `stop` lives here; dropping the `ActiveConnection`
    /// — which is what disconnecting does — ends the task, so there is no
    /// second registry to keep in step.
    pub health: Arc<std::sync::RwLock<super::health::ConnectionHealth>>,
    _stop_health: tokio::sync::oneshot::Sender<()>,
    /// Server thread ids this pool has opened.
    ///
    /// Recorded so the process list can tell the application's own sessions
    /// apart from everyone else's, and refuse to kill them (#433). An id stays
    /// after its connection is recycled, which only ever means declining to
    /// kill a thread that no longer exists.
    pub own_threads: Arc<dashmap::DashSet<u64>>,
    /// Each editor tab's own connection, opened on the tab's first statement.
    ///
    /// A shared pool hands a statement whichever connection is free, so
    /// anything tied to the session — `SET @var`, `SET SESSION`, a temporary
    /// table, a transaction begun in one run and committed in the next — could
    /// land on a different connection than the one it was set on and silently
    /// not be there (#731). A tab that keeps one connection has none of that.
    pub sessions: DashMap<String, MySqlPool>,
    /// What a new session connects with: the same options and session setup
    /// as every lane, so a statement behaves the same wherever it runs.
    session_connect: MySqlConnectOptions,
    charset: String,
}

impl ActiveConnection {
    /// The pool a lane draws from.
    pub fn lane(&self, lane: Lane) -> &MySqlPool {
        match lane {
            Lane::Interactive => &self.pool,
            Lane::Agent => &self.agent_pool,
            Lane::Job => &self.job_pool,
        }
    }
}

/// Pool options every lane shares: the session setup each new connection gets.
///
/// One definition so the lanes cannot drift apart. A statement should behave
/// the same whichever lane runs it, and every lane's threads have to be known
/// as the application's own, or the admin panel would offer to kill an agent's
/// or a backup's session out from under it (#433).
fn lane_pool_options(charset: &str, own_threads: &Arc<dashmap::DashSet<u64>>) -> MySqlPoolOptions {
    let charset = charset.to_string();
    let own_threads = Arc::clone(own_threads);
    MySqlPoolOptions::new().after_connect(move |conn, _meta| {
        let charset = charset.clone();
        let own_threads = Arc::clone(&own_threads);
        Box::pin(async move {
            sqlx::query(AssertSqlSafe(format!("SET NAMES {}", charset)))
                .execute(&mut *conn)
                .await?;
            // Note which server thread this pooled connection is, so the admin
            // panel can refuse to kill the application out from under itself.
            let (thread_id,): (u64,) = sqlx::query_as("SELECT CONNECTION_ID()")
                .fetch_one(&mut *conn)
                .await?;
            own_threads.insert(thread_id);
            Ok(())
        })
    })
}

pub struct ConnectionManager {
    connections: Arc<DashMap<String, ActiveConnection>>,
    /// Health changes, for whoever wants to hear about them. A broadcast
    /// rather than a callback so the core stays free of the app's event
    /// plumbing, and so a test can subscribe as easily as the UI does.
    health_events: tokio::sync::broadcast::Sender<super::health::ConnectionHealth>,
}

/// How much of a pool is in use, for the status bar (FR-1.2.3).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolStats {
    pub connection_id: String,
    /// Connections the pool holds, open or idle.
    pub size: u32,
    /// Of those, how many are not in use.
    pub idle: u32,
    /// What the profile allows.
    pub max: u32,
}

/// The smallest and largest pool a profile may open.
///
/// FR-1.2.3: "configurable pool size (default: 5, max: 50)". The ceiling is
/// not arbitrary — every pooled connection is a server thread, and fifty per
/// profile across a handful of profiles is already more than most servers'
/// `max_connections` allows for one client.
pub const POOL_MAX_LIMIT: u32 = 50;

/// Bring a stored pool size into range.
///
/// A max of zero makes sqlx panic, and a min above the max makes it refuse to
/// build the pool at all — neither is something a user should meet because a
/// number in a form was wrong.
pub fn clamped_pool_sizing(min: u32, max: u32) -> (u32, u32) {
    let max = max.clamp(1, POOL_MAX_LIMIT);
    (min.min(max), max)
}

/// Refuse a profile whose traffic the user expects to be tunnelled.
///
/// The dialog collects an SSH host, username, password and key passphrase,
/// and the store keeps them — but nothing reads them. There is no ssh2 or
/// russh dependency in the tree and `connect` builds its options from
/// `profile.host` and `profile.port` alone, so a profile configured with a
/// tunnel connected **straight to the database host** while the UI implied
/// otherwise (#273).
///
/// Connecting anyway is the dangerous answer: someone who believes their
/// traffic is tunnelled may be reaching a database over the open internet.
/// Refusing is loud, reversible, and leaves the stored configuration alone
/// for whenever the tunnel is actually built.
fn refuse_unimplemented_ssh(profile: &ConnectionProfile) -> Result<(), CoreError> {
    let Some(ssh) = profile.ssh_config.as_ref() else {
        return Ok(());
    };
    if ssh.host.trim().is_empty() {
        return Ok(());
    }

    tracing::warn!(
        profile = %profile.name,
        ssh_host = %ssh.host,
        "Refused a connection configured for SSH tunnelling, which is not implemented"
    );
    Err(CoreError::SSH(format!(
        "This profile is set to tunnel through {}, but SSH tunnelling is not implemented yet. \
         Connecting would have gone straight to {}:{} instead, which is not what the tunnel \
         settings say. Remove the SSH settings to connect directly, or open a tunnel yourself \
         and point the profile at the forwarded local port.",
        ssh.host, profile.host, profile.port
    )))
}

impl ConnectionManager {
    pub fn new() -> Self {
        // Capacity is generous: a slow subscriber lagging past it loses the
        // oldest events, which for a heartbeat is the right thing to lose.
        let (health_events, _) = tokio::sync::broadcast::channel(64);
        Self {
            connections: Arc::new(DashMap::new()),
            health_events,
        }
    }

    /// Listen for connections going away and coming back.
    pub fn subscribe_health(
        &self,
    ) -> tokio::sync::broadcast::Receiver<super::health::ConnectionHealth> {
        self.health_events.subscribe()
    }

    /// What the checker last saw for a connection.
    pub fn health_of(&self, connection_id: &str) -> Option<super::health::ConnectionHealth> {
        self.connections
            .get(connection_id)
            .and_then(|conn| conn.health.read().ok().map(|h| h.clone()))
    }

    /// How full each live pool is.
    pub fn pool_stats(&self) -> Vec<PoolStats> {
        self.connections
            .iter()
            .map(|entry| PoolStats {
                connection_id: entry.key().clone(),
                size: entry.pool.size(),
                idle: entry.pool.num_idle() as u32,
                max: entry.pool_max,
            })
            .collect()
    }

    #[tracing::instrument(skip(self, profile), fields(host = %profile.host, port = %profile.port, user = %profile.username))]
    pub async fn connect(&self, profile: &ConnectionProfile) -> Result<ConnectionInfo, CoreError> {
        refuse_unimplemented_ssh(profile)?;

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

        let own_threads: Arc<dashmap::DashSet<u64>> = Arc::new(dashmap::DashSet::new());
        // FR-1.2.3 sets the range; a profile can hold anything, including a
        // zero max (which sqlx panics on) or a min above the max (which it
        // refuses). Clamping here means a stored profile from an older build,
        // or one edited by hand, still connects.
        let (pool_min, pool_max) = clamped_pool_sizing(profile.pool_min, profile.pool_max);
        if pool_min != profile.pool_min || pool_max != profile.pool_max {
            tracing::warn!(
                profile = %profile.name,
                stored_min = profile.pool_min,
                stored_max = profile.pool_max,
                used_min = pool_min,
                used_max = pool_max,
                "Pool sizing was out of range and has been clamped"
            );
        }

        let acquire_timeout =
            std::time::Duration::from_secs(profile.connect_timeout_secs.unwrap_or(10) as u64);
        let pool = lane_pool_options(&charset, &own_threads)
            .min_connections(pool_min)
            .max_connections(pool_max)
            .acquire_timeout(acquire_timeout)
            .idle_timeout(std::time::Duration::from_secs(300))
            .connect_with(options.clone())
            .await;

        let pool = match pool {
            Ok(pool) => pool,
            Err(e) => {
                tracing::warn!(connection_id = %conn_id, error = %e, "Connection failed");
                // Not `describe_pool_error`: this pool is one line old, so a
                // timeout here cannot mean its connections are all busy. It
                // means the first one never opened, and only a direct attempt
                // can say why.
                return Err(super::describe_first_connect_failure(
                    &e,
                    &options,
                    &profile.name,
                    &profile.host,
                    profile.port,
                    profile.connect_timeout_secs.unwrap_or(10) as u64,
                )
                .await);
            }
        };

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

        // The other lanes connect on first use, not now: most sessions never
        // run an agent or a backup, and a lane nobody uses should cost the
        // server nothing. Same options and session setup as the interactive
        // lane, so a statement behaves identically whichever lane runs it.
        let side_lane = |max: u32| {
            lane_pool_options(&charset, &own_threads)
                .min_connections(0)
                .max_connections(max)
                .acquire_timeout(acquire_timeout)
                .idle_timeout(std::time::Duration::from_secs(SIDE_LANE_IDLE_SECS))
                .connect_lazy_with(options.clone())
        };
        let agent_pool = side_lane(AGENT_LANE_MAX);
        let job_pool = side_lane(JOB_LANE_MAX);

        // Watching starts as soon as the connection exists, and stops when it
        // is removed: the stop sender is owned by the entry below.
        let (stop_health, stop_rx) = tokio::sync::oneshot::channel();
        let health = Arc::new(std::sync::RwLock::new(super::health::ConnectionHealth {
            connection_id: conn_id.clone(),
            healthy: true,
            latency_ms: None,
            error: None,
            consecutive_failures: 0,
        }));
        super::health::watch(
            conn_id.clone(),
            pool.clone(),
            self.health_events.clone(),
            Arc::clone(&health),
            stop_rx,
        );

        self.connections.insert(
            conn_id,
            ActiveConnection {
                info: info.clone(),
                pool,
                agent_pool,
                job_pool,
                health,
                _stop_health: stop_health,
                query_timeout_secs: profile.query_timeout_secs,
                read_only: profile.read_only,
                pool_max,
                acquire_timeout_secs: profile.connect_timeout_secs.unwrap_or(10) as u64,
                actor: format!("{}@{}:{}", profile.username, profile.host, profile.port),
                own_threads: Arc::clone(&own_threads),
                sessions: DashMap::new(),
                session_connect: options.clone(),
                charset: charset.clone(),
            },
        );

        tracing::info!(connection_id = %info.id, version = %info.server_version, "Connected successfully");
        Ok(info)
    }

    #[tracing::instrument(skip(self))]
    pub async fn disconnect(&self, connection_id: &str) -> Result<(), CoreError> {
        if let Some((_, conn)) = self.connections.remove(connection_id) {
            // Every lane, together: a backup or agent connection left open
            // after disconnect is a server thread nobody can see or reach.
            // Editor sessions too: closing them is what rolls back a
            // transaction a tab left open.
            let sessions: Vec<MySqlPool> =
                conn.sessions.iter().map(|s| s.value().clone()).collect();
            tokio::join!(
                conn.pool.close(),
                conn.agent_pool.close(),
                conn.job_pool.close(),
                futures::future::join_all(sessions.iter().map(|pool| pool.close()))
            );
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
        // Same refusal as connect. A Test Connection that reports success by
        // reaching the database directly would be the strongest possible
        // false assurance that the tunnel works.
        refuse_unimplemented_ssh(profile)?;

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

    /// The pool for one lane of a live connection.
    ///
    /// [`get_pool`](Self::get_pool) is the interactive lane; agent and job
    /// work asks for its own here so it cannot take the editor's slots.
    pub fn get_lane_pool(&self, connection_id: &str, lane: Lane) -> Result<MySqlPool, CoreError> {
        self.connections
            .get(connection_id)
            .map(|conn| conn.lane(lane).clone())
            .ok_or_else(|| CoreError::NotFound(format!("Connection not found: {}", connection_id)))
    }

    /// The pool a route draws from, opening a tab's session on first use.
    pub fn route_pool(&self, connection_id: &str, route: &Route) -> Result<MySqlPool, CoreError> {
        match route {
            Route::Lane(lane) => self.get_lane_pool(connection_id, *lane),
            Route::Session(session) => self.session_pool(connection_id, session),
        }
    }

    /// An editor tab's own connection, opened lazily.
    ///
    /// A one-connection pool rather than a bare connection, for the reconnect
    /// and session setup a pool already does. Never recycled while the tab is
    /// open — no idle timeout, no maximum lifetime — because recycling it is
    /// exactly the loss of session state this exists to prevent. A connection
    /// the server drops still reconnects; that loses the state, as it would in
    /// any client.
    pub fn session_pool(&self, connection_id: &str, session: &str) -> Result<MySqlPool, CoreError> {
        let conn = self.connections.get(connection_id).ok_or_else(|| {
            CoreError::NotFound(format!("Connection not found: {}", connection_id))
        })?;
        let pool = conn
            .sessions
            .entry(session.to_string())
            .or_insert_with(|| {
                tracing::debug!(connection_id, session, "Opening an editor session");
                lane_pool_options(&conn.charset, &conn.own_threads)
                    .min_connections(0)
                    .max_connections(1)
                    .acquire_timeout(std::time::Duration::from_secs(conn.acquire_timeout_secs))
                    .idle_timeout(None)
                    .max_lifetime(None)
                    .connect_lazy_with(conn.session_connect.clone())
            })
            .clone();
        Ok(pool)
    }

    /// Close an editor tab's session, rolling back anything it left open.
    ///
    /// Closing the connection is what ends the server session, and the server
    /// rolls back an uncommitted transaction when it does — the same as
    /// closing a tab in any other client. A tab with no session, or a
    /// connection that is already gone, is nothing to do.
    pub async fn close_session(&self, connection_id: &str, session: &str) {
        let pool = self
            .connections
            .get(connection_id)
            .and_then(|conn| conn.sessions.remove(session).map(|(_, pool)| pool));
        if let Some(pool) = pool {
            pool.close().await;
            tracing::debug!(connection_id, session, "Closed an editor session");
        }
    }

    /// How many editor tabs hold a session on a connection.
    pub fn session_count(&self, connection_id: &str) -> usize {
        self.connections
            .get(connection_id)
            .map(|conn| conn.sessions.len())
            .unwrap_or(0)
    }

    /// Pool sizing for one lane of a live connection, for the message when it
    /// runs out.
    ///
    /// The count of connections the pool is actually holding comes with it: a
    /// pool that holds none cannot have run out of them, however it reports
    /// the failure, and saying otherwise is how a server that went away gets
    /// described as a setting the user should change.
    pub fn pool_limits(&self, connection_id: &str, lane: Lane) -> Option<(String, u32, u64, u32)> {
        self.connections.get(connection_id).map(|conn| {
            let max = match lane {
                Lane::Interactive => conn.pool_max,
                Lane::Agent => AGENT_LANE_MAX,
                Lane::Job => JOB_LANE_MAX,
            };
            (
                conn.info.name.clone(),
                max,
                conn.acquire_timeout_secs,
                conn.lane(lane).size(),
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

#[cfg(test)]
mod ssh_refusal_tests {
    use super::*;
    use crate::models::SSHConfig;
    use chrono::Utc;

    fn profile() -> ConnectionProfile {
        ConnectionProfile {
            id: "p1".to_string(),
            name: "prod".to_string(),
            group: None,
            color: None,
            host: "db.internal".to_string(),
            port: 3306,
            username: "u".to_string(),
            password: "p".to_string(),
            default_database: None,
            ssh_config: None,
            ssl_config: None,
            pool_min: 1,
            pool_max: 5,
            read_only: false,
            connect_timeout_secs: None,
            query_timeout_secs: None,
            charset: None,
            environment: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn with_ssh(host: &str) -> ConnectionProfile {
        let mut p = profile();
        p.ssh_config = Some(SSHConfig {
            host: host.to_string(),
            port: 22,
            username: "tunnel".to_string(),
            password: None,
            private_key_path: None,
            passphrase: None,
        });
        p
    }

    #[test]
    fn a_profile_without_ssh_is_allowed() {
        assert!(refuse_unimplemented_ssh(&profile()).is_ok());
    }

    #[test]
    fn a_profile_expecting_a_tunnel_is_refused() {
        // Connecting would have reached db.internal directly while the UI
        // said the traffic went through the bastion (#273).
        let err = refuse_unimplemented_ssh(&with_ssh("bastion.example.com")).unwrap_err();
        let message = err.to_string();
        assert!(message.contains("bastion.example.com"), "{message}");
        assert!(message.contains("db.internal:3306"), "{message}");
        assert!(message.contains("not implemented"), "{message}");
    }

    #[test]
    fn an_empty_ssh_host_is_not_a_tunnel() {
        // The dialog can leave a blank config behind after the fields are
        // cleared; that is not a request to tunnel anywhere.
        assert!(refuse_unimplemented_ssh(&with_ssh("")).is_ok());
        assert!(refuse_unimplemented_ssh(&with_ssh("   ")).is_ok());
    }
}

#[cfg(test)]
mod pool_sizing_tests {
    use super::*;

    #[test]
    fn the_ordinary_case_is_left_alone() {
        assert_eq!(clamped_pool_sizing(1, 5), (1, 5));
        assert_eq!(clamped_pool_sizing(2, 50), (2, 50));
    }

    #[test]
    fn a_max_of_zero_becomes_one() {
        // sqlx panics on a zero-max pool, and a profile can hold one. A min of
        // zero is left alone: it is valid, and means the pool opens a
        // connection when one is first asked for.
        assert_eq!(clamped_pool_sizing(0, 0), (0, 1));
        assert_eq!(clamped_pool_sizing(3, 0), (1, 1));
    }

    #[test]
    fn a_max_above_the_ceiling_is_brought_down() {
        // Every pooled connection is a server thread; FR-1.2.3 caps it at 50.
        assert_eq!(clamped_pool_sizing(1, 5000), (1, POOL_MAX_LIMIT));
    }

    #[test]
    fn a_min_above_the_max_is_brought_down_to_it() {
        // sqlx refuses to build the pool otherwise.
        assert_eq!(clamped_pool_sizing(20, 5), (5, 5));
    }
}
