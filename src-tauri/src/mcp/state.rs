//! Where the grants live while the app is running.

use std::sync::{Arc, RwLock};

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
}

impl McpState {
    pub fn new(grants: Grants) -> Self {
        Self {
            grants: Arc::new(RwLock::new(grants)),
        }
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
