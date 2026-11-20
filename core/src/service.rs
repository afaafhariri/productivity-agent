//! The agent service: conversations, runs, approvals, settings and secrets, for one user.
//!
//! This is what a front end talks to. The desktop app calls it in-process; another host could
//! put any transport in front of it. Runs stream `RunEventParams` over an unbounded channel.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures::channel::{mpsc, oneshot};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::agent::{self, AgentEvent, RunError, RunOptions};
use crate::integrations::github::GITHUB_TOKEN;
use crate::llm::config::{GEMINI_API_KEY, LlmConfig, create_model};
use crate::llm::{LanguageModel, Message};
use crate::ports::{Clock, Confirmation, ConfirmationRequest, Decision, SecretStore};
use crate::tools::{DEFAULT_MAX_RESULT_CHARS, Effect, ToolRegistry, ToolRuntime};

pub const MAX_TEXT_CHARS: usize = 32_000;
pub const MAX_ID_CHARS: usize = 128;
pub const MAX_SECRET_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoneReason {
    Stop,
    MaxSteps,
    Cancelled,
}

/// Everything a run reports, in order. `Done` or `Error` is always last.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunEvent {
    TextDelta {
        text: String,
    },
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        input: Value,
    },
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        result: Value,
    },
    ConfirmationRequest {
        tool_call_id: String,
        tool_name: String,
        description: String,
        input: Value,
    },
    Done {
        reason: DoneReason,
    },
    Error {
        message: String,
    },
}

impl RunEvent {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Done { .. } | Self::Error { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunEventParams {
    pub run_id: String,
    pub event: RunEvent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub effect: Effect,
}

/// Non-secret, read-only view of the configuration. Secrets are only reported as set or not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    pub llm_provider: String,
    pub llm_model_id: Option<String>,
    pub gemini_api_key_set: bool,
    pub github_token_set: bool,
    pub tools: Vec<ToolInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretName {
    GeminiApiKey,
    GithubToken,
}

impl SecretName {
    fn key(self) -> &'static str {
        match self {
            Self::GeminiApiKey => GEMINI_API_KEY,
            Self::GithubToken => GITHUB_TOKEN,
        }
    }

    fn invalid_message(self) -> &'static str {
        match self {
            Self::GeminiApiKey => "That doesn't look like an API key",
            Self::GithubToken => "That doesn't look like a GitHub token",
        }
    }
}

/// Why a request was refused. Messages are fit to show the user and never contain secrets.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ServiceError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("A run is already active in this conversation")]
    ConversationBusy,
    #[error("No active run with that id")]
    RunNotFound,
    #[error("No pending confirmation for that call")]
    ConfirmationNotFound,
    #[error("Couldn't use the system keychain. See logs.")]
    SecretStore,
}

pub struct ServiceDeps {
    pub config: LlmConfig,
    pub registry: ToolRegistry,
    pub secrets: Arc<dyn SecretStore>,
    pub clock: Arc<dyn Clock>,
    /// Tests can fix the model; normally it's built from `config` on first use.
    pub model: Option<Arc<dyn LanguageModel>>,
}

#[derive(Clone)]
pub struct AgentService {
    inner: Arc<Inner>,
}

struct Inner {
    config: LlmConfig,
    registry: ToolRegistry,
    secrets: Arc<dyn SecretStore>,
    clock: Arc<dyn Clock>,
    runtime: Handle,
    events: mpsc::UnboundedSender<RunEventParams>,
    model: Mutex<Option<Arc<dyn LanguageModel>>>,
    fixed_model: bool,
    conversations: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Vec<Message>>>>>,
    runs: Mutex<HashMap<String, RunHandle>>,
}

struct RunHandle {
    conversation_id: String,
    cancel: CancellationToken,
    confirmation: Arc<ChannelConfirmation>,
}

impl AgentService {
    /// `runtime` runs the agent (HTTP needs Tokio). Events arrive on the returned receiver.
    pub fn new(
        deps: ServiceDeps,
        runtime: Handle,
    ) -> (Self, mpsc::UnboundedReceiver<RunEventParams>) {
        let (events, receiver) = mpsc::unbounded();
        let fixed_model = deps.model.is_some();
        let inner = Inner {
            config: deps.config,
            registry: deps.registry,
            secrets: deps.secrets,
            clock: deps.clock,
            runtime,
            events,
            model: Mutex::new(deps.model),
            fixed_model,
            conversations: Mutex::default(),
            runs: Mutex::default(),
        };
        (
            Self {
                inner: Arc::new(inner),
            },
            receiver,
        )
    }

    pub async fn settings(&self) -> Result<Settings, ServiceError> {
        let inner = &self.inner;
        Ok(Settings {
            llm_provider: inner.config.provider.as_str().into(),
            llm_model_id: inner.config.model_id.clone(),
            gemini_api_key_set: self.is_set(GEMINI_API_KEY).await?,
            github_token_set: self.is_set(GITHUB_TOKEN).await?,
            tools: inner
                .registry
                .specs()
                .into_iter()
                .map(|s| ToolInfo {
                    name: s.name.into(),
                    description: s.description.into(),
                    effect: s.effect,
                })
                .collect(),
        })
    }

    async fn is_set(&self, key: &str) -> Result<bool, ServiceError> {
        let value = self.inner.secrets.get(key).await.map_err(|error| {
            tracing::warn!(%error, "secret store read failed");
            ServiceError::SecretStore
        })?;
        Ok(value.is_some_and(|v| !v.is_empty()))
    }

    /// Write-only: the value is stored in the secret store and never returned.
    pub async fn set_secret(&self, name: SecretName, value: &str) -> Result<(), ServiceError> {
        let value = value.trim();
        let valid = !value.is_empty()
            && value.chars().count() <= MAX_SECRET_CHARS
            && value.chars().all(|c| c.is_ascii_graphic());
        if !valid {
            // Never echo the value back: it is (or contains) a secret.
            return Err(ServiceError::InvalidInput(name.invalid_message().into()));
        }
        self.inner
            .secrets
            .set(name.key(), value)
            .await
            .map_err(|error| {
                tracing::warn!(%error, "secret store write failed");
                ServiceError::SecretStore
            })?;
        self.forget_model();
        tracing::info!(secret = ?name, "secret stored");
        Ok(())
    }

    pub async fn delete_secret(&self, name: SecretName) -> Result<(), ServiceError> {
        self.inner
            .secrets
            .delete(name.key())
            .await
            .map_err(|error| {
                tracing::warn!(%error, "secret store delete failed");
                ServiceError::SecretStore
            })?;
        self.forget_model();
        tracing::info!(secret = ?name, "secret deleted");
        Ok(())
    }

    /// The next run builds the model again, e.g. with a new API key.
    fn forget_model(&self) {
        if !self.inner.fixed_model {
            *self.inner.model.lock().unwrap() = None;
        }
    }

    /// Starts a run in `conversation_id` and returns its id. Events follow on the channel.
    pub fn start_run(&self, conversation_id: &str, text: &str) -> Result<String, ServiceError> {
        let id_len = conversation_id.chars().count();
        if id_len == 0 || id_len > MAX_ID_CHARS {
            return Err(ServiceError::InvalidInput("Invalid conversation id".into()));
        }
        let text_len = text.chars().count();
        if text_len == 0 || text_len > MAX_TEXT_CHARS {
            return Err(ServiceError::InvalidInput(format!(
                "Messages must be 1 to {MAX_TEXT_CHARS} characters"
            )));
        }

        let run_id = uuid::Uuid::new_v4().simple().to_string();
        let cancel = CancellationToken::new();
        let confirmation = Arc::new(ChannelConfirmation {
            run_id: run_id.clone(),
            events: self.inner.events.clone(),
            pending: Mutex::default(),
        });
        {
            let mut runs = self.inner.runs.lock().unwrap();
            if runs.values().any(|r| r.conversation_id == conversation_id) {
                return Err(ServiceError::ConversationBusy);
            }
            runs.insert(
                run_id.clone(),
                RunHandle {
                    conversation_id: conversation_id.to_owned(),
                    cancel: cancel.clone(),
                    confirmation: confirmation.clone(),
                },
            );
        }
        let history = self
            .inner
            .conversations
            .lock()
            .unwrap()
            .entry(conversation_id.to_owned())
            .or_default()
            .clone();

        let inner = self.inner.clone();
        let text = text.to_owned();
        let id = run_id.clone();
        self.inner.runtime.spawn(async move {
            let terminal = inner.run(&id, history, text, cancel, confirmation).await;
            inner.runs.lock().unwrap().remove(&id);
            inner.emit(&id, terminal);
        });
        Ok(run_id)
    }

    pub fn cancel_run(&self, run_id: &str) -> Result<(), ServiceError> {
        let runs = self.inner.runs.lock().unwrap();
        let run = runs.get(run_id).ok_or(ServiceError::RunNotFound)?;
        run.cancel.cancel();
        Ok(())
    }

    /// Answers a pending approval. Only an explicit user action should call this.
    pub fn respond_confirmation(
        &self,
        run_id: &str,
        tool_call_id: &str,
        decision: Decision,
    ) -> Result<(), ServiceError> {
        let confirmation = self
            .inner
            .runs
            .lock()
            .unwrap()
            .get(run_id)
            .map(|r| r.confirmation.clone())
            .ok_or(ServiceError::RunNotFound)?;
        if confirmation.respond(tool_call_id, decision) {
            Ok(())
        } else {
            Err(ServiceError::ConfirmationNotFound)
        }
    }

    /// Stops every run (e.g. when the app quits). Pending approvals are never executed.
    pub fn cancel_all(&self) {
        for run in self.inner.runs.lock().unwrap().values() {
            run.cancel.cancel();
        }
    }
}

impl Inner {
    fn emit(&self, run_id: &str, event: RunEvent) {
        let _ = self.events.unbounded_send(RunEventParams {
            run_id: run_id.to_owned(),
            event,
        });
    }

    async fn model(&self) -> Result<Arc<dyn LanguageModel>, crate::llm::ModelError> {
        if let Some(model) = self.model.lock().unwrap().clone() {
            return Ok(model);
        }
        let model = create_model(&self.config, self.secrets.as_ref()).await?;
        *self.model.lock().unwrap() = Some(model.clone());
        Ok(model)
    }

    /// Runs one turn and returns the terminal event (`Done` or `Error`).
    async fn run(
        &self,
        run_id: &str,
        history: Arc<tokio::sync::Mutex<Vec<Message>>>,
        text: String,
        cancel: CancellationToken,
        confirmation: Arc<ChannelConfirmation>,
    ) -> RunEvent {
        let mut history = history.lock().await;
        history.push(Message::User { text });
        let model = tokio::select! {
            () = cancel.cancelled() => return RunEvent::Done { reason: DoneReason::Cancelled },
            model = self.model() => match model {
                Ok(model) => model,
                Err(error) => return RunEvent::Error { message: error.0 },
            },
        };
        let runtime = ToolRuntime {
            confirmation,
            secrets: self.secrets.clone(),
            clock: self.clock.clone(),
            max_result_chars: DEFAULT_MAX_RESULT_CHARS,
        };
        let mut emit = |event: AgentEvent| self.emit(run_id, wire(event));
        let outcome = agent::run_agent(
            model.as_ref(),
            &self.registry,
            &runtime,
            &mut history,
            &cancel,
            &mut emit,
            RunOptions::default(),
        )
        .await;
        match outcome {
            Ok(agent::DoneReason::Stop) => RunEvent::Done {
                reason: DoneReason::Stop,
            },
            Ok(agent::DoneReason::MaxSteps) => RunEvent::Done {
                reason: DoneReason::MaxSteps,
            },
            Err(RunError::Cancelled) => RunEvent::Done {
                reason: DoneReason::Cancelled,
            },
            // No API key, no credit, rate limit, ...: the user can fix these.
            Err(RunError::Model(error)) => RunEvent::Error { message: error.0 },
        }
    }
}

fn wire(event: AgentEvent) -> RunEvent {
    match event {
        AgentEvent::TextDelta(text) => RunEvent::TextDelta { text },
        AgentEvent::ToolCall {
            tool_call_id,
            tool_name,
            input,
        } => RunEvent::ToolCall {
            tool_call_id,
            tool_name,
            input,
        },
        AgentEvent::ToolResult {
            tool_call_id,
            tool_name,
            result,
        } => RunEvent::ToolResult {
            tool_call_id,
            tool_name,
            result,
        },
    }
}

/// The approval port for one run: emits `ConfirmationRequest` and waits for
/// `respond_confirmation`. If the run is stopped, the wait is dropped and the tool never runs.
struct ChannelConfirmation {
    run_id: String,
    events: mpsc::UnboundedSender<RunEventParams>,
    pending: Mutex<HashMap<String, oneshot::Sender<Decision>>>,
}

impl ChannelConfirmation {
    fn respond(&self, tool_call_id: &str, decision: Decision) -> bool {
        match self.pending.lock().unwrap().remove(tool_call_id) {
            Some(waiter) => waiter.send(decision).is_ok(),
            None => false,
        }
    }
}

#[async_trait]
impl Confirmation for ChannelConfirmation {
    async fn request(&self, request: ConfirmationRequest) -> Decision {
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap()
            .insert(request.tool_call_id.clone(), tx);
        let _ = self.events.unbounded_send(RunEventParams {
            run_id: self.run_id.clone(),
            event: RunEvent::ConfirmationRequest {
                tool_call_id: request.tool_call_id,
                tool_name: request.tool_name,
                description: request.description,
                input: request.input,
            },
        });
        // A dropped sender means nobody can answer any more: treat it as a rejection.
        rx.await.unwrap_or(Decision::Rejected { reason: None })
    }
}
