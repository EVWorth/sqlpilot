pub mod manager;
pub mod migrations;
pub mod store;

pub use manager::ConnectionManager;
pub use store::ConnectionStore;

pub fn init_keyring(store: std::sync::Arc<keyring_core::CredentialStore>) {
    keyring_core::set_default_store(store);
}
