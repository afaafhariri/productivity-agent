//! What the core needs from its host. Hosts provide the implementations.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;

/// A secret store failure, e.g. a locked keychain. The message never contains a secret.
#[derive(Debug, thiserror::Error)]
#[error("secret store error: {0}")]
pub struct SecretStoreError(pub String);

/// Encrypted key/value storage for credentials. Values never reach logs or the model.
#[async_trait]
pub trait SecretStore: Send + Sync {
    async fn get(&self, key: &str) -> Result<Option<String>, SecretStoreError>;
    async fn set(&self, key: &str, value: &str) -> Result<(), SecretStoreError>;
    async fn delete(&self, key: &str) -> Result<(), SecretStoreError>;
}

/// Keeps secrets in memory only. For tests and `PRODUCTIVITY_AGENT_SECRETS=memory`.
#[derive(Default)]
pub struct MemorySecretStore {
    values: Mutex<HashMap<String, String>>,
}

#[async_trait]
impl SecretStore for MemorySecretStore {
    async fn get(&self, key: &str) -> Result<Option<String>, SecretStoreError> {
        Ok(self.values.lock().unwrap().get(key).cloned())
    }

    async fn set(&self, key: &str, value: &str) -> Result<(), SecretStoreError> {
        self.values
            .lock()
            .unwrap()
            .insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<(), SecretStoreError> {
        self.values.lock().unwrap().remove(key);
        Ok(())
    }
}

pub trait Clock: Send + Sync {
    fn now(&self) -> jiff::Timestamp;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> jiff::Timestamp {
        jiff::Timestamp::now()
    }
}

/// Always returns the same instant. For tests.
pub struct FixedClock(pub jiff::Timestamp);

impl Clock for FixedClock {
    fn now(&self) -> jiff::Timestamp {
        self.0
    }
}

/// What the user is asked to approve before a `write` tool runs.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConfirmationRequest {
    pub tool_call_id: String,
    pub tool_name: String,
    /// The tool's description, so the user knows what the action does.
    pub description: String,
    /// The exact, validated arguments the tool will be called with.
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Approved,
    Rejected { reason: Option<String> },
}

/// Asks the user to approve or reject a state-changing action.
///
/// If the run is stopped while waiting, the caller drops this future and the tool never runs.
#[async_trait]
pub trait Confirmation: Send + Sync {
    async fn request(&self, request: ConfirmationRequest) -> Decision;
}
