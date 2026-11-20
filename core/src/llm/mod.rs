//! Provider-neutral model interface. Each provider adapts its API to these types.

pub mod config;
pub mod gemini;
pub mod mock;
mod task_stream;

use futures::stream::BoxStream;
use serde_json::Value;

use crate::tools::ToolSpec;

/// A model call failed for a reason the user should see (no credit, bad key, rate limit, ...).
/// The message is shown to the user, so it must never contain secrets.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ModelError(pub String);

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    User {
        text: String,
    },
    Assistant {
        text: String,
        tool_calls: Vec<ToolCall>,
        /// Opaque provider data sent back verbatim next turn (e.g. Gemini thought
        /// signatures). Only the provider that produced it reads it.
        provider_state: Option<Value>,
    },
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        /// What the model sees. Untrusted tool output is wrapped by the agent loop.
        content: Value,
    },
}

impl Message {
    pub fn user(text: impl Into<String>) -> Self {
        Self::User { text: text.into() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
    Other,
}

/// One piece of a streamed model turn.
#[derive(Debug, Clone, PartialEq)]
pub enum ModelPart {
    TextDelta(String),
    ToolCall(ToolCall),
    /// Emitted once per turn, before `Finish`, by providers that need their raw turn back.
    ProviderState(Value),
    Finish(FinishReason),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelRequest {
    pub system: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
}

pub type PartStream = BoxStream<'static, Result<ModelPart, ModelError>>;

/// Streams one model turn: text deltas and/or tool calls, then a `Finish`.
pub trait LanguageModel: Send + Sync {
    fn stream(&self, request: ModelRequest) -> PartStream;
}
