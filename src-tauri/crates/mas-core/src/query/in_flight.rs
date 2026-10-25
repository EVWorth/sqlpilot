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

use std::sync::Arc;

use dashmap::DashMap;
use sqlx::MySqlConnection;

use crate::connection::Route;
use crate::error::CoreError;

/// Server thread id -> the connection and route it belongs to.
pub(crate) type InFlightMap = Arc<DashMap<u64, (String, Route)>>;

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

    fn register(&self, thread_id: u64, connection_id: &str, route: &Route) -> InFlightTicket {
        self.in_flight
            .insert(thread_id, (connection_id.to_string(), route.clone()));
        tracing::debug!(connection_id, ?route, thread_id, "Statement in flight");
        InFlightTicket {
            in_flight: Arc::clone(&self.in_flight),
            thread_id,
            connection_id: connection_id.to_string(),
            route: route.clone(),
        }
    }
}

/// One registered thread. Dropping it takes the thread out of reach of cancel.
pub struct InFlightTicket {
    in_flight: InFlightMap,
    thread_id: u64,
    connection_id: String,
    route: Route,
}

impl Drop for InFlightTicket {
    fn drop(&mut self) {
        // Only this ticket's own entry. The table is keyed by thread id alone,
        // and a thread with the same id on another server must not be taken
        // out of reach by this one finishing.
        self.in_flight
            .remove_if(&self.thread_id, |_, (connection, route)| {
                connection == &self.connection_id && route == &self.route
            });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ticket_registers_until_it_is_dropped() {
        let table: InFlightMap = Arc::new(DashMap::new());
        let tracker = InFlightTracker::new(Arc::clone(&table));
        let route = Route::Agent("a".to_string());

        let ticket = tracker.register(7, "c1", &route);
        assert_eq!(
            table.get(&7).map(|entry| entry.value().clone()),
            Some(("c1".to_string(), route))
        );

        drop(ticket);
        assert!(table.is_empty());
    }

    #[test]
    fn a_ticket_leaves_another_connections_thread_alone() {
        // Two servers can both have a thread 7. The second to register
        // replaces the first, and the first finishing must not remove it.
        let table: InFlightMap = Arc::new(DashMap::new());
        let tracker = InFlightTracker::new(Arc::clone(&table));

        let first = tracker.register(7, "c1", &Route::Agent("a".to_string()));
        let _second = tracker.register(7, "c2", &Route::Interactive);
        drop(first);

        assert_eq!(
            table.get(&7).map(|entry| entry.value().0.clone()),
            Some("c2".to_string())
        );
    }
}
