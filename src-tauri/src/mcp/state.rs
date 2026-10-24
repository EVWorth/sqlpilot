//! Where the grants live while the app is running.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use mas_mcp::grants::{Grant, Grants};

/// The shared, mutable set of grants.
///
/// Behind a lock rather than cloned into the server because the user can
/// change a grant while a session is attached, and the next tool call should
/// see the new answer. Revoking a connection an agent is mid-conversation with
/// has to take effect at the next call, not at the next restart.
#[derive(Clone, Default)]
pub struct McpState {
    grants: Arc<RwLock<Grants>>,
    /// The `Route::Agent` keys each in-app agent session's MCP sessions run
    /// on, by SQLPilot's id for the in-app session.
    ///
    /// Usually one key; more when the harness reconnected and got a new MCP
    /// session. How the panel's Stop finds the statements its agent has
    /// running (#868). Entries come and go with the workspaces that own them.
    routes: Arc<Mutex<HashMap<String, Vec<String>>>>,
}

impl McpState {
    pub fn new(grants: Grants) -> Self {
        Self {
            grants: Arc::new(RwLock::new(grants)),
            routes: Arc::default(),
        }
    }

    /// Record that `route` runs statements for the in-app session `owner`.
    pub fn link_route(&self, owner: &str, route: &str) {
        let mut routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
        let keys = routes.entry(owner.to_string()).or_default();
        if !keys.iter().any(|key| key == route) {
            keys.push(route.to_string());
        }
    }

    /// Forget `route`, because the MCP session behind it has ended.
    pub fn unlink_route(&self, owner: &str, route: &str) {
        let mut routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(keys) = routes.get_mut(owner) {
            keys.retain(|key| key != route);
            if keys.is_empty() {
                routes.remove(owner);
            }
        }
    }

    /// The route keys the in-app session `owner` runs statements on. Empty
    /// when its agent has not called a tool yet, or has no tools.
    pub fn routes_of(&self, owner: &str) -> Vec<String> {
        self.routes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(owner)
            .cloned()
            .unwrap_or_default()
    }

    pub fn grants(&self) -> Grants {
        // A poisoned lock means a panic while holding it. Refusing to read the
        // grants would leave the app unable to answer "what is shared", and
        // the honest recovery — a clone of whatever was there — is also the
        // safe one, because grants only ever grow more permissive by an
        // explicit write.
        match self.grants.read() {
            Ok(grants) => grants.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    pub fn set(&self, grant: Grant) {
        self.with_grants(|grants| grants.set(grant));
    }

    pub fn revoke(&self, connection_id: &str) {
        self.with_grants(|grants| grants.revoke(connection_id));
    }

    pub fn unlock_ddl(&self, connection_id: &str, unlocked: bool) {
        self.with_grants(|grants| grants.unlock_ddl(connection_id, unlocked));
    }

    fn with_grants(&self, f: impl FnOnce(&mut Grants)) {
        match self.grants.write() {
            Ok(mut grants) => f(&mut grants),
            Err(poisoned) => f(&mut poisoned.into_inner()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_route_is_found_by_its_owner_until_it_is_unlinked() {
        let state = McpState::default();
        state.link_route("panel-1", "agent-a");
        state.link_route("panel-1", "agent-b");
        state.link_route("panel-1", "agent-a");
        state.link_route("panel-2", "agent-c");

        assert_eq!(state.routes_of("panel-1"), vec!["agent-a", "agent-b"]);
        assert_eq!(state.routes_of("panel-2"), vec!["agent-c"]);
        assert!(state.routes_of("panel-3").is_empty());

        state.unlink_route("panel-1", "agent-a");
        assert_eq!(state.routes_of("panel-1"), vec!["agent-b"]);
        state.unlink_route("panel-1", "agent-b");
        assert!(state.routes_of("panel-1").is_empty());
        // Unlinking what is not there is not an error.
        state.unlink_route("panel-1", "agent-b");
        state.unlink_route("nobody", "agent-z");
    }

    #[test]
    fn clones_share_the_routes() {
        // The workspace links through its clone; the command reads through
        // the app's.
        let state = McpState::default();
        state.clone().link_route("panel-1", "agent-a");
        assert_eq!(state.routes_of("panel-1"), vec!["agent-a"]);
    }
}
