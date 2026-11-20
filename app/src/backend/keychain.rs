//! Secrets in the OS credential store: macOS Keychain, Windows Credential Manager, or the
//! Secret Service on Linux. Calls run on a blocking thread because the store may wait, e.g.
//! for a macOS Keychain access prompt.

use agent_core::ports::{SecretStore, SecretStoreError};
use async_trait::async_trait;

/// The same service name the earlier Python backend used, so saved keys keep working.
const SERVICE: &str = "productivity-agent";

pub struct KeychainSecretStore {
    service: &'static str,
}

impl Default for KeychainSecretStore {
    fn default() -> Self {
        Self { service: SERVICE }
    }
}

fn store_error(error: keyring::Error) -> SecretStoreError {
    // keyring errors describe the store, never the secret.
    SecretStoreError(error.to_string())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, SecretStoreError> + Send + 'static,
) -> Result<T, SecretStoreError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| SecretStoreError(error.to_string()))?
}

#[async_trait]
impl SecretStore for KeychainSecretStore {
    async fn get(&self, key: &str) -> Result<Option<String>, SecretStoreError> {
        let (service, key) = (self.service, key.to_owned());
        blocking(move || {
            let entry = keyring::Entry::new(service, &key).map_err(store_error)?;
            match entry.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(store_error(error)),
            }
        })
        .await
    }

    async fn set(&self, key: &str, value: &str) -> Result<(), SecretStoreError> {
        let (service, key, value) = (self.service, key.to_owned(), value.to_owned());
        blocking(move || {
            keyring::Entry::new(service, &key)
                .and_then(|entry| entry.set_password(&value))
                .map_err(store_error)
        })
        .await
    }

    async fn delete(&self, key: &str) -> Result<(), SecretStoreError> {
        let (service, key) = (self.service, key.to_owned());
        blocking(move || {
            let entry = keyring::Entry::new(service, &key).map_err(store_error)?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()), // Already absent.
                Err(error) => Err(store_error(error)),
            }
        })
        .await
    }
}
