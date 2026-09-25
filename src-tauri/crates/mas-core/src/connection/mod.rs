pub mod health;
pub mod manager;
pub mod migrations;
pub mod store;

pub use health::ConnectionHealth;
pub use manager::{ConnectionManager, Lane};
pub use store::ConnectionStore;

pub fn init_keyring(store: std::sync::Arc<keyring_core::CredentialStore>) {
    keyring_core::set_default_store(store);
}

/// Turn a pool-acquire timeout into something a user can act on.
///
/// sqlx reports it as "pool timed out while waiting for an open connection",
/// which says nothing about whose pool, how big it is, or what to change. The
/// numbers that decide the outcome are on the profile, so they belong in the
/// message (#279).
///
/// Only for a pool that is already up and serving. A pool that has never
/// opened a connection reports the same error for a completely different
/// reason, and [`describe_first_connect_failure`] is the one for that.
pub fn describe_pool_error(
    error: &sqlx::Error,
    profile_name: &str,
    pool_max: u32,
    acquire_timeout_secs: u64,
    connections_held: u32,
    lane: manager::Lane,
) -> Option<crate::error::CoreError> {
    if !matches!(error, sqlx::Error::PoolTimedOut) {
        return None;
    }
    // Holding none of them means none are busy: the server went away, or was
    // never there. Whatever that is, it is not a limit the user set too low,
    // so the driver's own error is left to speak for itself.
    if connections_held == 0 {
        return None;
    }
    // Only the interactive lane is sized by the profile. The others are fixed,
    // so "raise Max pool size" would send someone to a setting that cannot
    // help — and would not have been the lane that filled up anyway.
    let message = match lane {
        manager::Lane::Interactive => format!(
            "\"{profile_name}\" reached its limit of {pool_max} simultaneous connections and \
             nothing freed up within {acquire_timeout_secs}s. Either something long-running is \
             holding them — check the process list — or the limit is too low for how this \
             connection is used. Raise \"Max pool size\" on the profile, or wait for the running \
             work to finish."
        ),
        manager::Lane::Agent => format!(
            "The agent is already using all {pool_max} of its connections to \
             \"{profile_name}\" and none freed up within {acquire_timeout_secs}s. Wait for its \
             running queries or staged writes to finish, or cancel them. The agent has its own \
             connections, so the editor is not affected."
        ),
        manager::Lane::Job => format!(
            "{pool_max} backups or restores are already running on \"{profile_name}\" and none \
             finished within {acquire_timeout_secs}s. Wait for one to finish before starting \
             another. They have their own connections, so the editor is not affected."
        ),
    };
    Some(crate::error::CoreError::PoolExhausted(message))
}

/// Why a brand-new pool could not open its first connection.
///
/// sqlx gives a pool that never got a connection the same `PoolTimedOut` it
/// gives a pool whose connections are all busy. On a pool this side of
/// `connect` the second reading is impossible — nobody else can be holding a
/// connection to a pool that did not exist a moment ago — so reporting it as
/// exhaustion sends someone to raise "Max pool size" while their server sits
/// there refusing TCP.
///
/// The real error is recoverable the one way sqlx leaves open: open a single
/// connection outside the pool and let it fail on its own terms. That costs a
/// round trip, on a path that has already spent the connect timeout failing,
/// and it is the difference between "connection refused" and a number the user
/// is invited to change for no reason.
pub async fn describe_first_connect_failure(
    error: &sqlx::Error,
    options: &sqlx::mysql::MySqlConnectOptions,
    profile_name: &str,
    host: &str,
    port: u16,
    timeout_secs: u64,
) -> crate::error::CoreError {
    use sqlx::{ConnectOptions, Connection};

    // Sometimes sqlx hands back the real error and sometimes it hides it
    // behind a pool timeout, depending on how far the attempt got. Only the
    // second case needs a second attempt to find out what happened.
    if !matches!(error, sqlx::Error::PoolTimedOut) {
        return crate::error::CoreError::Connection(format!(
            "Could not connect \"{profile_name}\". {}",
            diagnose_connect_error(error, host, port)
        ));
    }

    let probe = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        options.clone().connect(),
    )
    .await;

    let detail = match probe {
        // It answered when asked directly, so the address and the credentials
        // are right and something transient ate the first attempt.
        Ok(Ok(conn)) => {
            let _ = conn.close().await;
            format!(
                "{host}:{port} answered when tried again, so this looks like a slow or flaky \
                 server rather than a wrong address. Try connecting again, or raise \"Connect \
                 timeout\" above {timeout_secs}s on the profile."
            )
        }
        Ok(Err(error)) => diagnose_connect_error(&error, host, port),
        // Two full timeouts and no answer either way: nothing is coming back.
        Err(_) => format!(
            "{host}:{port} did not answer within {timeout_secs}s. Either the address is wrong, \
             the server is not running, or a firewall is dropping the connection rather than \
             refusing it."
        ),
    };

    crate::error::CoreError::Connection(format!("Could not connect \"{profile_name}\". {detail}"))
}

/// Say what a driver error means, for the handful that have a plain cause.
///
/// Deliberately shallow: the driver's own message is kept in every case, and a
/// sentence is added only where the cause is unambiguous and the fix is
/// somewhere other than where the user would look first.
fn diagnose_connect_error(error: &sqlx::Error, host: &str, port: u16) -> String {
    let raw = error.to_string();
    let lowered = raw.to_lowercase();

    let hint = if lowered.contains("connection refused") {
        Some(format!(
            "Nothing is listening on {host}:{port}. The server is stopped, or it is listening on \
             a different port."
        ))
    } else if lowered.contains("access denied") {
        Some(
            "The server is reachable and rejected the credentials. Check the username and \
             password on the profile, and that this user is allowed to connect from this machine."
                .to_string(),
        )
    } else if lowered.contains("unknown database") {
        Some(
            "The server is reachable and the credentials work; the database named on the profile \
             does not exist on it."
                .to_string(),
        )
    } else if lowered.contains("name or service not known")
        || lowered.contains("failed to lookup address")
        || lowered.contains("temporary failure in name resolution")
    {
        Some(format!("The host name \"{host}\" does not resolve."))
    } else if lowered.contains("certificate") || lowered.contains("tls") {
        Some(
            "The connection failed while setting up TLS. Check the SSL mode and any certificate \
             files on the profile."
                .to_string(),
        )
    } else {
        None
    };

    match hint {
        Some(hint) => format!("{hint} ({raw})"),
        None => raw,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use manager::Lane;

    #[test]
    fn a_pool_timeout_names_the_profile_and_the_limit() {
        // sqlx says only "pool timed out while waiting for an open connection",
        // which names neither the pool nor the number that caused it (#279).
        let described = describe_pool_error(
            &sqlx::Error::PoolTimedOut,
            "prod-eu",
            5,
            10,
            5,
            Lane::Interactive,
        )
        .expect("a pool timeout should be described");
        let message = described.to_string();
        assert!(message.contains("prod-eu"), "{message}");
        assert!(message.contains('5'), "{message}");
        assert!(message.contains("10s"), "{message}");
        // It should say what to do about it, not just what happened.
        assert!(message.contains("Max pool size"), "{message}");
    }

    #[test]
    fn a_pool_holding_nothing_has_not_run_out_of_anything() {
        // A server that went away mid-session empties the pool and then times
        // out on acquire, which looks identical to saturation from the error
        // alone. Zero connections held is what tells them apart.
        assert!(
            describe_pool_error(
                &sqlx::Error::PoolTimedOut,
                "prod-eu",
                5,
                10,
                0,
                Lane::Interactive
            )
            .is_none(),
            "an empty pool should fall through to the driver's own error"
        );
    }

    #[test]
    fn a_refused_port_is_not_reported_as_a_pool_setting() {
        // The bug this replaces: a server that was simply not running came
        // back as "reached its limit of 5 simultaneous connections", which
        // invites the user to raise a number that has nothing to do with it.
        let refused = sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "Connection refused (os error 111)",
        ));
        let message = diagnose_connect_error(&refused, "10.0.1.11", 3306);
        assert!(
            message.contains("Nothing is listening on 10.0.1.11:3306"),
            "{message}"
        );
        assert!(!message.contains("Max pool size"), "{message}");
        // The driver's own words are kept, not replaced by our guess.
        assert!(message.contains("os error 111"), "{message}");
    }

    #[test]
    fn a_rejected_password_says_the_server_was_reached() {
        // Which half failed is the whole question: reachable-but-rejected and
        // unreachable send you to completely different places.
        let denied = sqlx::Error::Protocol(
            "1045 (28000): Access denied for user 'root'@'10.0.1.5'".to_string(),
        );
        let message = diagnose_connect_error(&denied, "10.0.1.11", 3306);
        assert!(message.contains("reachable"), "{message}");
        assert!(message.contains("username and password"), "{message}");
    }

    #[test]
    fn a_name_that_does_not_resolve_says_so() {
        let dns = sqlx::Error::Io(std::io::Error::other(
            "failed to lookup address information: Name or service not known",
        ));
        let message = diagnose_connect_error(&dns, "nas.lan", 3306);
        assert!(message.contains("does not resolve"), "{message}");
        assert!(message.contains("nas.lan"), "{message}");
    }

    #[test]
    fn an_error_we_have_nothing_to_add_to_is_passed_through_unchanged() {
        // Better a driver message than a wrong explanation wrapped around one.
        let odd = sqlx::Error::Protocol("something we have never seen".to_string());
        assert_eq!(diagnose_connect_error(&odd, "host", 3306), odd.to_string());
    }

    #[test]
    fn a_full_agent_lane_does_not_blame_the_profile() {
        // The agent's lane is a fixed size, so "raise Max pool size" would send
        // someone to a setting that cannot help. What they can do is wait for,
        // or cancel, what the agent is running (#731).
        let message =
            describe_pool_error(&sqlx::Error::PoolTimedOut, "prod-eu", 2, 10, 2, Lane::Agent)
                .expect("a full agent lane is described")
                .to_string();
        assert!(message.contains("agent"), "{message}");
        assert!(message.contains("prod-eu"), "{message}");
        assert!(message.contains("editor is not affected"), "{message}");
        assert!(!message.contains("Max pool size"), "{message}");
    }

    #[test]
    fn a_full_job_lane_says_backups_are_the_reason() {
        let message =
            describe_pool_error(&sqlx::Error::PoolTimedOut, "prod-eu", 2, 10, 2, Lane::Job)
                .expect("a full job lane is described")
                .to_string();
        assert!(message.contains("backups or restores"), "{message}");
        assert!(!message.contains("Max pool size"), "{message}");
    }

    #[test]
    fn other_errors_are_left_alone() {
        // Only the pool case gets rewritten; everything else keeps whatever
        // the driver said, which is usually more specific than we could be.
        assert!(describe_pool_error(
            &sqlx::Error::RowNotFound,
            "prod-eu",
            5,
            10,
            5,
            Lane::Interactive
        )
        .is_none());
        assert!(describe_pool_error(
            &sqlx::Error::WorkerCrashed,
            "prod-eu",
            5,
            10,
            5,
            Lane::Interactive
        )
        .is_none());
    }
}
