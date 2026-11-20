//! Test doubles for the ports. Enabled with the `testing` feature.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::sync::Notify;

use crate::ports::{Confirmation, ConfirmationRequest, Decision, FixedClock, MemorySecretStore};
use crate::tools::{DEFAULT_MAX_RESULT_CHARS, ToolRuntime};

/// Answers every request with a fixed decision and records what was asked.
/// With no decision, any request fails the test.
pub struct FakeConfirmation {
    decision: Option<Decision>,
    pub requests: Mutex<Vec<ConfirmationRequest>>,
}

impl FakeConfirmation {
    pub fn answering(decision: Decision) -> Arc<Self> {
        Arc::new(Self {
            decision: Some(decision),
            requests: Mutex::default(),
        })
    }

    pub fn unexpected() -> Arc<Self> {
        Arc::new(Self {
            decision: None,
            requests: Mutex::default(),
        })
    }

    pub fn requests(&self) -> Vec<ConfirmationRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl Confirmation for FakeConfirmation {
    async fn request(&self, request: ConfirmationRequest) -> Decision {
        self.requests.lock().unwrap().push(request);
        self.decision
            .clone()
            .expect("confirmation was not expected")
    }
}

/// Never answers, like a user who hasn't clicked yet. `waiting` fires when asked.
#[derive(Default)]
pub struct BlockingConfirmation {
    pub waiting: Notify,
}

#[async_trait]
impl Confirmation for BlockingConfirmation {
    async fn request(&self, _request: ConfirmationRequest) -> Decision {
        self.waiting.notify_one();
        std::future::pending().await
    }
}

/// 2026-01-01T00:00:00Z.
pub fn fixed_clock() -> Arc<FixedClock> {
    Arc::new(FixedClock("2026-01-01T00:00:00Z".parse().unwrap()))
}

pub fn runtime(confirmation: Arc<dyn Confirmation>) -> ToolRuntime {
    ToolRuntime {
        confirmation,
        secrets: Arc::new(MemorySecretStore::default()),
        clock: fixed_clock(),
        max_result_chars: DEFAULT_MAX_RESULT_CHARS,
    }
}
