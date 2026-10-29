//! Statements that run outside the executor, within reach of its cancel.
//!
//! [`QueryExecutor::cancel`](crate::query::QueryExecutor::cancel) can only
//! stop what it knows is running: it kills server threads from its in-flight
//! table. The executor registers its own batches there, but a staged write
//! holds its own connection for its transaction, and the schema inspector
//! reads through `sqlx` directly. Neither went through the table, so the
//! agent panel's Stop could not reach a long staged `DELETE` or a slow schema
//! read, and both ran on to their end (#894).
//!
//! An [`InFlightTracker`] is a handle on the executor's table for that code.
//! It asks the connection for its thread id and registers it under the
//! connection and route, exactly as the executor does for its own batches, and
//! the [`InFlightTicket`] it returns removes the entry when dropped.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use sqlx::MySqlConnection;

use crate::connection::Route;
use crate::error::CoreError;

/// `(connection id, server thread id)` -> what is running there.
///
/// Keyed by both because a thread id is unique only within one server: two
/// connections to different servers can each have a thread 7 running at once,
/// and keying by the id alone let the second replace the first, so cancel on
/// the first connection missed it (#901).
pub(crate) type InFlightMap = Arc<DashMap<(String, u64), InFlightEntry>>;

/// One running statement batch in the in-flight table.
#[derive(Clone, Debug)]
pub(crate) struct InFlightEntry {
    pub(crate) route: Route,
    /// Which registration this is. A pooled connection keeps its thread id
    /// across checkouts, so the next batch on it can register the same key
    /// before the last one's ticket drops; the token keeps that late drop
    /// from removing the newer entry.
    token: u64,
}

static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

/// Registers statements run outside the executor in its in-flight table, so
/// its cancel reaches them. Cheap to clone: every clone shares the one table.
#[derive(Clone)]
pub struct InFlightTracker {
    in_flight: InFlightMap,
}

impl InFlightTracker {
    pub(crate) fn new(in_flight: InFlightMap) -> Self {
        Self { in_flight }
    }

    /// Register `connection` as running on `connection_id` and `route` until
    /// the returned ticket is dropped.
    ///
    /// Costs one round trip, `SELECT CONNECTION_ID()`: a connection taken from
    /// a pool does not say which server thread it is.
    pub async fn track(
        &self,
        connection: &mut MySqlConnection,
        connection_id: &str,
        route: &Route,
    ) -> Result<InFlightTicket, CoreError> {
        let (thread_id,): (u64,) = sqlx::query_as("SELECT CONNECTION_ID()")
            .fetch_one(&mut *connection)
            .await
            .map_err(|e| CoreError::Query(format!("Could not read the connection's id: {e}")))?;
        Ok(self.register(thread_id, connection_id, route))
    }

    /// Register a thread whose id the caller already knows.
    pub(crate) fn register(
        &self,
        thread_id: u64,
        connection_id: &str,
        route: &Route,
    ) -> InFlightTicket {
        let key = (connection_id.to_string(), thread_id);
        let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
        self.in_flight.insert(
            key.clone(),
            InFlightEntry {
                route: route.clone(),
                token,
            },
        );
        tracing::debug!(connection_id, ?route, thread_id, "Statement in flight");
        InFlightTicket {
            in_flight: Arc::clone(&self.in_flight),
            key,
            token,
        }
    }
}

/// One registered thread. Dropping it takes the thread out of reach of cancel.
pub struct InFlightTicket {
    in_flight: InFlightMap,
    key: (String, u64),
    token: u64,
}

impl InFlightTicket {
    /// The server thread this ticket registered.
    pub fn thread_id(&self) -> u64 {
        self.key.1
    }
}

impl Drop for InFlightTicket {
    fn drop(&mut self) {
        // Only this ticket's own entry: a later batch on the same pooled
        // connection may have registered the same key since.
        self.in_flight
            .remove_if(&self.key, |_, entry| entry.token == self.token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(connection: &str, thread_id: u64) -> (String, u64) {
        (connection.to_string(), thread_id)
    }

    fn route_of(table: &InFlightMap, connection: &str, thread_id: u64) -> Option<Route> {
        table
            .get(&key(connection, thread_id))
            .map(|entry| entry.route.clone())
    }

    #[test]
    fn a_ticket_registers_until_it_is_dropped() {
        let table: InFlightMap = Arc::new(DashMap::new());
        let tracker = InFlightTracker::new(Arc::clone(&table));
        let route = Route::Agent("a".to_string());

        let ticket = tracker.register(7, "c1", &route);
        assert_eq!(ticket.thread_id(), 7);
        assert_eq!(route_of(&table, "c1", 7), Some(route));

        drop(ticket);
        assert!(table.is_empty());
    }

    #[test]
    fn the_same_thread_id_on_two_connections_is_two_entries() {
        // Two servers can both have a thread 7 running (#901).
        let table: InFlightMap = Arc::new(DashMap::new());
        let tracker = InFlightTracker::new(Arc::clone(&table));

        let first = tracker.register(7, "c1", &Route::Agent("a".to_string()));
        let second = tracker.register(7, "c2", &Route::Interactive);
        assert_eq!(table.len(), 2, "the second must not replace the first");

        drop(first);
        assert_eq!(route_of(&table, "c1", 7), None);
        assert_eq!(route_of(&table, "c2", 7), Some(Route::Interactive));

        drop(second);
        assert!(table.is_empty());
    }

    #[test]
    fn a_late_drop_leaves_a_newer_registration_alone() {
        // A pooled connection keeps its thread id: the next batch on it can
        // register before the previous batch's ticket drops.
        let table: InFlightMap = Arc::new(DashMap::new());
        let tracker = InFlightTracker::new(Arc::clone(&table));

        let earlier = tracker.register(7, "c1", &Route::Interactive);
        let _later = tracker.register(7, "c1", &Route::Session("tab".to_string()));
        drop(earlier);

        assert_eq!(
            route_of(&table, "c1", 7),
            Some(Route::Session("tab".to_string()))
        );
    }
}
