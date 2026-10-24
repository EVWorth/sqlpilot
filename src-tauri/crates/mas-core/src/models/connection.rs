use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// What a profile without pool fields is stored with, matching the columns'
/// defaults (`migrations.rs`).
fn legacy_pool_min() -> u32 {
    1
}

fn legacy_pool_max() -> u32 {
    5
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub enum ConnectionEnvironment {
    #[serde(rename = "development")]
    Development,
    #[serde(rename = "staging")]
    Staging,
    #[serde(rename = "production")]
    Production,
}

impl std::fmt::Display for ConnectionEnvironment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Development => write!(f, "development"),
            Self::Staging => write!(f, "staging"),
            Self::Production => write!(f, "production"),
        }
    }
}

// `Debug` is written by hand so a password never reaches a log line (#882).
// A plain comment, so it stays out of the generated TypeScript.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub group: Option<String>,
    pub color: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(skip_serializing, default)]
    pub password: String,
    pub default_database: Option<String>,
    pub ssh_config: Option<SSHConfig>,
    pub ssl_config: Option<SSLConfig>,
    /// Stored and no longer read: connections are no longer sized per
    /// profile (#731). Kept so profiles saved by older builds, and the
    /// frontend that still sends them, keep round-tripping.
    #[serde(default = "legacy_pool_min")]
    pub pool_min: u32,
    /// See `pool_min`.
    #[serde(default = "legacy_pool_max")]
    pub pool_max: u32,
    pub read_only: bool,
    pub connect_timeout_secs: Option<u32>,
    pub query_timeout_secs: Option<u32>,
    pub charset: Option<String>,
    pub environment: Option<ConnectionEnvironment>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ConnectionProfileSummary {
    pub id: String,
    pub name: String,
    pub group: Option<String>,
    pub color: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub default_database: Option<String>,
    pub ssh_config: Option<SSHConfig>,
    pub ssl_config: Option<SSLConfig>,
    /// Stored and no longer read: connections are no longer sized per
    /// profile (#731). Kept so profiles saved by older builds, and the
    /// frontend that still sends them, keep round-tripping.
    #[serde(default = "legacy_pool_min")]
    pub pool_min: u32,
    /// See `pool_min`.
    #[serde(default = "legacy_pool_max")]
    pub pool_max: u32,
    pub read_only: bool,
    pub connect_timeout_secs: Option<u32>,
    pub query_timeout_secs: Option<u32>,
    pub charset: Option<String>,
    pub environment: Option<ConnectionEnvironment>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Default for ConnectionProfile {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: String::new(),
            group: None,
            color: None,
            host: "127.0.0.1".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: String::new(),
            default_database: None,
            ssh_config: None,
            ssl_config: None,
            pool_min: 1,
            pool_max: 5,
            read_only: false,
            connect_timeout_secs: Some(10),
            query_timeout_secs: None,
            charset: Some("utf8mb4".to_string()),
            environment: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }
}

// `Debug` is written by hand so a password or passphrase never reaches a
// log line (#882).
#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub struct SSHConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(skip_serializing, default)]
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    #[serde(skip_serializing, default)]
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SSLConfig {
    pub mode: SSLMode,
    pub ca_cert_path: Option<String>,
    pub client_cert_path: Option<String>,
    pub client_key_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub enum SSLMode {
    Disabled,
    Preferred,
    Required,
    VerifyCA,
    VerifyIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ConnectionInfo {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: Option<String>,
    pub server_version: String,
    pub connected_at: DateTime<Utc>,
    pub color: Option<String>,
    pub environment: Option<ConnectionEnvironment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TestConnectionResult {
    pub success: bool,
    pub message: String,
    pub server_version: Option<String>,
    // JSON already serialises this as a number and JS truncates past 2^53;
    // declaring it as f64 documents the existing behaviour rather than
    // changing it. Row counts, byte sizes, timings and ids never approach it.
    #[specta(type = specta_typescript::Number)]
    pub latency_ms: u64,
}

/// How a secret appears in `Debug` output: whether one is set, never what it is.
fn secret(value: &str) -> &'static str {
    if value.is_empty() {
        "\"\""
    } else {
        "<redacted>"
    }
}

/// A `Debug` value printed verbatim, for the redaction markers above.
struct Shown(&'static str);

impl std::fmt::Debug for Shown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::fmt::Debug for ConnectionProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionProfile")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("group", &self.group)
            .field("color", &self.color)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &Shown(secret(&self.password)))
            .field("default_database", &self.default_database)
            .field("ssh_config", &self.ssh_config)
            .field("ssl_config", &self.ssl_config)
            .field("pool_min", &self.pool_min)
            .field("pool_max", &self.pool_max)
            .field("read_only", &self.read_only)
            .field("connect_timeout_secs", &self.connect_timeout_secs)
            .field("query_timeout_secs", &self.query_timeout_secs)
            .field("charset", &self.charset)
            .field("environment", &self.environment)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

impl std::fmt::Debug for SSHConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let optional = |v: &Option<String>| Shown(v.as_deref().map_or("None", secret));
        f.debug_struct("SSHConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &optional(&self.password))
            .field("private_key_path", &self.private_key_path)
            .field("passphrase", &optional(&self.passphrase))
            .finish()
    }
}

#[cfg(test)]
mod debug_tests {
    use super::*;

    #[test]
    fn debug_output_never_contains_a_secret() {
        let profile = ConnectionProfile {
            password: "hunter2".to_string(),
            ssh_config: Some(SSHConfig {
                host: "bastion".to_string(),
                port: 22,
                username: "ops".to_string(),
                password: Some("hunter3".to_string()),
                private_key_path: None,
                passphrase: Some("hunter4".to_string()),
            }),
            ..ConnectionProfile::default()
        };
        let out = format!("{profile:?} {profile:#?}");
        for secret in ["hunter2", "hunter3", "hunter4"] {
            assert!(!out.contains(secret), "{secret} leaked: {out}");
        }
        assert!(out.contains("password: <redacted>"));
        assert!(out.contains("passphrase: <redacted>"));
        assert!(out.contains("bastion"), "non-secret fields still print");
    }

    #[test]
    fn debug_output_shows_whether_a_secret_is_set() {
        let profile = ConnectionProfile::default();
        assert!(format!("{profile:?}").contains("password: \"\""));
        let ssh = SSHConfig {
            host: "h".to_string(),
            port: 22,
            username: "u".to_string(),
            password: None,
            private_key_path: None,
            passphrase: None,
        };
        assert!(format!("{ssh:?}").contains("password: None"));
    }
}
