use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub pool_min: u32,
    pub pool_max: u32,
    pub read_only: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub pool_min: u32,
    pub pool_max: u32,
    pub read_only: bool,
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
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SSLConfig {
    pub mode: SSLMode,
    pub ca_cert_path: Option<String>,
    pub client_cert_path: Option<String>,
    pub client_key_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SSLMode {
    Disabled,
    Preferred,
    Required,
    VerifyCA,
    VerifyIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestConnectionResult {
    pub success: bool,
    pub message: String,
    pub server_version: Option<String>,
    pub latency_ms: u64,
}
