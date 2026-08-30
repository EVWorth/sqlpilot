pub mod manager;
pub mod migrations;
pub mod store;

pub use manager::ConnectionManager;
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
pub fn describe_pool_error(
    error: &sqlx::Error,
    profile_name: &str,
    pool_max: u32,
    acquire_timeout_secs: u64,
) -> Option<crate::error::CoreError> {
    if !matches!(error, sqlx::Error::PoolTimedOut) {
        return None;
    }
    Some(crate::error::CoreError::PoolExhausted(format!(
        "\"{}\" reached its limit of {} simultaneous connections and nothing freed up within \
         {}s. Either something long-running is holding them — check the process list — or the \
         limit is too low for how this connection is used. Raise \"Max pool size\" on the \
         profile, or wait for the running work to finish.",
        profile_name, pool_max, acquire_timeout_secs
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pool_timeout_names_the_profile_and_the_limit() {
        // sqlx says only "pool timed out while waiting for an open connection",
        // which names neither the pool nor the number that caused it (#279).
        let described = describe_pool_error(&sqlx::Error::PoolTimedOut, "prod-eu", 5, 10)
            .expect("a pool timeout should be described");
        let message = described.to_string();
        assert!(message.contains("prod-eu"), "{message}");
        assert!(message.contains('5'), "{message}");
        assert!(message.contains("10s"), "{message}");
        // It should say what to do about it, not just what happened.
        assert!(message.contains("Max pool size"), "{message}");
    }

    #[test]
    fn other_errors_are_left_alone() {
        // Only the pool case gets rewritten; everything else keeps whatever
        // the driver said, which is usually more specific than we could be.
        assert!(describe_pool_error(&sqlx::Error::RowNotFound, "prod-eu", 5, 10).is_none());
        assert!(describe_pool_error(&sqlx::Error::WorkerCrashed, "prod-eu", 5, 10).is_none());
    }
}
