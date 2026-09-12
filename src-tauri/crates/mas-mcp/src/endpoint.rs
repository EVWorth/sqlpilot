//! Where a harness connects.
//!
//! In this crate rather than in the app, because nothing here needs the app:
//! it is a socket, a token and the tool surface. Keeping it out of the Tauri
//! crate means the tests below run anywhere `cargo test` runs, rather than
//! only where a GUI toolchain is installed.
//!
//! The server listens on loopback only. There is no configuration for that and
//! no plan to add one: this is a door into the user's databases, and a door
//! into the user's databases does not go on a network interface because
//! someone's `--host` flag said so.
//!
//! Loopback is not on its own an authorisation boundary — every process on the
//! machine can reach it, including a browser page that guesses the port — so
//! every request also carries a bearer token. The token is a file in the app's
//! data directory, created once and readable only by its owner, because the
//! alternative is regenerating it each launch and invalidating a harness
//! config the user wrote by hand a month ago.

use axum::response::IntoResponse;
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::StreamableHttpServerConfig;
use rmcp::transport::streamable_http_server::StreamableHttpService;

use crate::server::SqlPilot;
use crate::workspace::Workspace;

/// The path under the MCP server's origin that speaks MCP.
///
/// Named rather than `/`, so that a request from something that is not a
/// harness — a browser following a guessed URL — lands on nothing.
pub const MCP_PATH: &str = "/mcp";

/// The port SQLPilot asks for.
///
/// Stable across launches so that a config file written once keeps working.
/// Nothing well-known sits here, and if it is taken the server takes whatever
/// it is given and reports it.
pub const PREFERRED_PORT: u16 = 47311;

/// A running MCP endpoint.
pub struct Endpoint {
    pub address: SocketAddr,
    pub token: String,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

impl Endpoint {
    /// The URL a harness is configured with.
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}{MCP_PATH}", self.address.port())
    }

    /// Stop listening. In-flight requests finish; new ones are refused.
    pub fn stop(self) {
        // The receiver is gone only if the server task already ended, which is
        // the same outcome by another route.
        let _ = self.shutdown.send(());
    }
}

/// Read the bearer token, creating it if this is the first time.
///
/// Failing to tighten the permissions is not fatal on its own — some
/// filesystems cannot express them — but it is worth knowing about, so it
/// comes back as an error rather than being swallowed.
pub fn load_or_create_token(data_dir: &Path) -> std::io::Result<String> {
    let path = token_path(data_dir);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }

    let token = generate_token();
    write_private(&path, &token)?;
    Ok(token)
}

pub fn token_path(data_dir: &Path) -> PathBuf {
    data_dir.join("agent-token")
}

/// A fresh token, replacing whatever was there.
///
/// The "someone else has my token" button. Every configured harness stops
/// working until it is given the new one, which is the intended effect.
pub fn rotate_token(data_dir: &Path) -> std::io::Result<String> {
    let token = generate_token();
    write_private(&token_path(data_dir), &token)?;
    Ok(token)
}

fn generate_token() -> String {
    // Two v4 UUIDs: 256 bits of the same randomness the rest of the app
    // already relies on, without another dependency to audit.
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn write_private(path: &Path, token: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(token.as_bytes())?;
    file.flush()?;

    // An existing file keeps its old mode through `open`, so set it again.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Start listening, and serve until the returned endpoint is stopped.
pub async fn start(
    workspace: Arc<dyn Workspace>,
    token: String,
    port: u16,
) -> std::io::Result<Endpoint> {
    let service = StreamableHttpService::new(
        {
            let workspace = workspace.clone();
            move || Ok(SqlPilot::new(workspace.clone()))
        },
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );

    let app = axum::Router::new()
        .nest_service(MCP_PATH, service)
        .layer(axum::middleware::from_fn_with_state(
            token.clone(),
            require_token,
        ))
        .with_state(token.clone());

    // The preferred port first, because a stable URL is what makes a
    // hand-written harness config keep working. Anything else beats refusing
    // to start because some other program got there first.
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
    };
    let address = listener.local_addr()?;
    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();

    tokio::spawn(async move {
        let served = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
        if let Err(e) = served {
            tracing::error!(error = %e, "the agent endpoint stopped");
        }
    });

    tracing::info!(%address, "agent endpoint listening");
    Ok(Endpoint {
        address,
        token,
        shutdown,
    })
}

/// Reject anything that does not present the token.
async fn require_token(
    axum::extract::State(expected): axum::extract::State<String>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let presented = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("");

    if constant_time_eq(presented.as_bytes(), expected.as_bytes()) {
        return next.run(request).await;
    }

    // 401 with a WWW-Authenticate header, because that is what an MCP client
    // is written to understand, and a client that is merely misconfigured
    // should be able to say so to its user.
    (
        axum::http::StatusCode::UNAUTHORIZED,
        [(axum::http::header::WWW_AUTHENTICATE, "Bearer")],
        "SQLPilot's agent endpoint needs the token from Settings → Agents.",
    )
        .into_response()
}

/// Compare without leaking where the two differ through timing.
///
/// A token is guessable one byte at a time if comparison stops at the first
/// difference and an attacker can measure it. That attack is awkward over
/// loopback and this is cheap, which is the whole argument for doing it.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_survives_a_restart() {
        // Otherwise every launch silently invalidates the config the user
        // pasted into their harness.
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_token(dir.path()).unwrap();
        let second = load_or_create_token(dir.path()).unwrap();
        assert_eq!(first, second);
        assert!(!first.is_empty());
    }

    #[test]
    fn rotating_replaces_it() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_token(dir.path()).unwrap();
        let rotated = rotate_token(dir.path()).unwrap();
        assert_ne!(first, rotated);
        assert_eq!(load_or_create_token(dir.path()).unwrap(), rotated);
    }

    #[test]
    fn a_token_is_long_enough_to_be_worth_having() {
        let dir = tempfile::tempdir().unwrap();
        // 64 hex characters: 256 bits. A short token on loopback is a token
        // that can be guessed by a script in an afternoon.
        assert_eq!(load_or_create_token(dir.path()).unwrap().len(), 64);
    }

    #[cfg(unix)]
    #[test]
    fn the_token_file_is_not_readable_by_other_users() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load_or_create_token(dir.path()).unwrap();
        let mode = std::fs::metadata(token_path(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "group and other should have nothing");
    }

    #[cfg(unix)]
    #[test]
    fn a_loose_token_file_is_tightened_when_it_is_rotated() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = token_path(dir.path());
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        rotate_token(dir.path()).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
    }

    #[test]
    fn an_empty_token_file_is_replaced_rather_than_honoured() {
        // A truncated write would otherwise leave the endpoint accepting the
        // empty string forever.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(token_path(dir.path()), "   \n").unwrap();
        assert_eq!(load_or_create_token(dir.path()).unwrap().len(), 64);
    }

    #[test]
    fn the_empty_token_never_matches() {
        // The case that turns "no Authorization header" into "authorised".
        assert!(!constant_time_eq(b"", b""));
        assert!(!constant_time_eq(b"", b"secret"));
    }

    #[test]
    fn comparison_is_exact() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secreT"));
        assert!(!constant_time_eq(b"secret", b"secret "));
    }
}
