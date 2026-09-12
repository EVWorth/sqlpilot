//! Watching a live connection, and saying when it goes away.
//!
//! ARCHITECTURE §3.1 described a `HealthChecker` emitting `connection_lost`,
//! and nothing emitted it. A tab whose server had gone stayed looking normal
//! until the next query failed with "Connection not found" — which describes
//! neither what happened nor when (#276).
//!
//! One task per connection pings the server on a fixed interval. When a ping
//! fails the connection is marked lost and the pings back off — 1s, 2s, 4s,
//! 8s, 16s, then 30s, which is FR-1.2.4's schedule — until one succeeds, at
//! which point it is marked healthy again and the interval returns to normal.
//! Nothing is torn down in between: sqlx reopens a pooled connection by
//! itself, so a server that comes back is usable again without the user doing
//! anything.

use serde::{Deserialize, Serialize};
use sqlx::MySqlPool;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::broadcast;

/// How often a healthy connection is checked.
///
/// Long enough to be free — one `SELECT 1` every fifteen seconds is nothing
/// beside a single query — and short enough that a dropped server shows up
/// before the user's next statement fails on it.
const HEALTHY_INTERVAL: Duration = Duration::from_secs(15);

/// How long a ping may take before it counts as a failure.
const PING_TIMEOUT: Duration = Duration::from_secs(5);

/// The gaps between retries once a connection is lost (FR-1.2.4).
const BACKOFF_SECS: [u64; 6] = [1, 2, 4, 8, 16, 30];

/// What is known about a connection right now.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionHealth {
    pub connection_id: String,
    /// False from the first failed ping until one succeeds again.
    pub healthy: bool,
    /// How long the last successful ping took.
    #[specta(type = Option<specta_typescript::Number>)]
    pub latency_ms: Option<u64>,
    /// Why the last ping failed, when it did.
    pub error: Option<String>,
    /// How many pings have failed in a row. Zero while healthy.
    pub consecutive_failures: u32,
}

impl ConnectionHealth {
    fn healthy(connection_id: &str, latency_ms: u64) -> Self {
        Self {
            connection_id: connection_id.to_string(),
            healthy: true,
            latency_ms: Some(latency_ms),
            error: None,
            consecutive_failures: 0,
        }
    }

    fn lost(connection_id: &str, error: String, failures: u32) -> Self {
        Self {
            connection_id: connection_id.to_string(),
            healthy: false,
            latency_ms: None,
            error: Some(error),
            consecutive_failures: failures,
        }
    }
}

/// How long to wait after `failures` failed pings.
pub fn backoff_after(failures: u32) -> Duration {
    let index = failures.saturating_sub(1) as usize;
    Duration::from_secs(BACKOFF_SECS[index.min(BACKOFF_SECS.len() - 1)])
}

/// Run one ping. Separated so the interval logic can be tested without a
/// server, and so both the task and the on-demand command use the same check.
pub async fn ping(pool: &MySqlPool) -> Result<u64, String> {
    let started = std::time::Instant::now();
    match tokio::time::timeout(PING_TIMEOUT, sqlx::query("SELECT 1").fetch_one(pool)).await {
        Ok(Ok(_)) => Ok(started.elapsed().as_millis() as u64),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!(
            "The server did not answer within {}s",
            PING_TIMEOUT.as_secs()
        )),
    }
}

/// Watch one connection until its handle is dropped.
///
/// The task exits when `stop` is dropped, which happens when the connection is
/// removed from the manager — so disconnecting stops the pings without any
/// separate bookkeeping.
pub fn watch(
    connection_id: String,
    pool: MySqlPool,
    events: broadcast::Sender<ConnectionHealth>,
    state: Arc<RwLock<ConnectionHealth>>,
    mut stop: tokio::sync::oneshot::Receiver<()>,
) {
    tokio::spawn(async move {
        let mut failures: u32 = 0;
        loop {
            let wait = if failures == 0 {
                HEALTHY_INTERVAL
            } else {
                backoff_after(failures)
            };

            tokio::select! {
                _ = &mut stop => return,
                _ = tokio::time::sleep(wait) => {}
            }

            let result = ping(&pool).await;
            let next = match result {
                Ok(latency) => {
                    let recovered = failures > 0;
                    failures = 0;
                    if recovered {
                        tracing::info!(connection_id = %connection_id, "Connection is back");
                    }
                    ConnectionHealth::healthy(&connection_id, latency)
                }
                Err(error) => {
                    failures = failures.saturating_add(1);
                    if failures == 1 {
                        tracing::warn!(connection_id = %connection_id, %error, "Connection lost");
                    }
                    ConnectionHealth::lost(&connection_id, error, failures)
                }
            };

            let changed = match state.write() {
                Ok(mut current) => {
                    let changed = current.healthy != next.healthy;
                    *current = next.clone();
                    changed
                }
                // A poisoned lock means a panic elsewhere; keep reporting
                // rather than going quiet about a connection's state.
                Err(_) => true,
            };

            // Every check while unhealthy, so the UI can count the attempts,
            // but only the transitions while healthy — a heartbeat every
            // fifteen seconds is not news.
            if changed || !next.healthy {
                // No receivers is the ordinary case in tests and before the
                // frontend subscribes; it is not an error.
                let _ = events.send(next);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_backoff_is_the_one_the_requirements_name() {
        // FR-1.2.4: 1s, 2s, 4s, 8s, 16s, then 30s capped.
        let seconds: Vec<u64> = (1..=8).map(|n| backoff_after(n).as_secs()).collect();
        assert_eq!(seconds, vec![1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn the_first_retry_does_not_wait_thirty_seconds() {
        // A server that blinked should be found again almost at once.
        assert_eq!(backoff_after(1), Duration::from_secs(1));
        // And a zero — which should not happen — must not index out of range.
        assert_eq!(backoff_after(0), Duration::from_secs(1));
    }

    #[test]
    fn a_healthy_report_carries_no_error_and_a_lost_one_does() {
        let healthy = ConnectionHealth::healthy("c1", 3);
        assert!(healthy.healthy);
        assert_eq!(healthy.latency_ms, Some(3));
        assert!(healthy.error.is_none());
        assert_eq!(healthy.consecutive_failures, 0);

        let lost = ConnectionHealth::lost("c1", "connection refused".into(), 2);
        assert!(!lost.healthy);
        assert!(lost.latency_ms.is_none());
        assert_eq!(lost.error.as_deref(), Some("connection refused"));
        assert_eq!(lost.consecutive_failures, 2);
    }
}
