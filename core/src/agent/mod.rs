//! The agent loop: model turn → tool calls → tool results → next turn, until the model stops.

mod prompt;

use futures::StreamExt;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

pub use prompt::SYSTEM_PROMPT;

use crate::llm::{LanguageModel, Message, ModelError, ModelPart, ModelRequest, ToolCall};
use crate::tools::{CallError, ToolRegistry, ToolRuntime};

pub const DEFAULT_MAX_STEPS: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    TextDelta(String),
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoneReason {
    /// The model answered without asking for more tools.
    Stop,
    /// `max_steps` model turns ran.
    MaxSteps,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum RunError {
    #[error("the run was stopped")]
    Cancelled,
    #[error(transparent)]
    Model(#[from] ModelError),
}

/// Delimits tool output so the model treats it as data (see `SYSTEM_PROMPT`).
pub fn wrap_untrusted(tool_name: &str, result: Value) -> Value {
    json!({"tool": tool_name, "untrusted_content": result})
}

pub struct RunOptions<'a> {
    pub system: &'a str,
    pub max_steps: usize,
}

impl Default for RunOptions<'_> {
    fn default() -> Self {
        Self {
            system: SYSTEM_PROMPT,
            max_steps: DEFAULT_MAX_STEPS,
        }
    }
}

/// Runs until the model answers without tool calls or `max_steps` turns have run.
///
/// Appends every assistant message and tool result to `history`, so the caller keeps the
/// conversation. When `cancel` fires, the run stops at once, including a pending approval
/// (that tool never runs), and every tool call still open gets a "cancelled" result so the
/// history stays valid for the next turn.
pub async fn run_agent(
    model: &dyn LanguageModel,
    registry: &ToolRegistry,
    runtime: &ToolRuntime,
    history: &mut Vec<Message>,
    cancel: &CancellationToken,
    emit: &mut (dyn FnMut(AgentEvent) + Send),
    options: RunOptions<'_>,
) -> Result<DoneReason, RunError> {
    let tools = registry.specs();
    for _ in 0..options.max_steps {
        let mut stream = model.stream(ModelRequest {
            system: options.system.to_owned(),
            messages: history.clone(),
            tools: tools.clone(),
        });
        let mut text = String::new();
        let mut calls: Vec<ToolCall> = Vec::new();
        let mut provider_state = None;
        loop {
            let part = tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(RunError::Cancelled),
                part = stream.next() => part,
            };
            match part {
                None => break,
                Some(Err(error)) => return Err(error.into()),
                Some(Ok(ModelPart::TextDelta(delta))) => {
                    text.push_str(&delta);
                    emit(AgentEvent::TextDelta(delta));
                }
                Some(Ok(ModelPart::ToolCall(call))) => calls.push(call),
                Some(Ok(ModelPart::ProviderState(state))) => provider_state = Some(state),
                Some(Ok(ModelPart::Finish(_))) => {}
            }
        }

        history.push(Message::Assistant {
            text,
            tool_calls: calls.clone(),
            provider_state,
        });
        if calls.is_empty() {
            return Ok(DoneReason::Stop);
        }

        for (i, call) in calls.iter().enumerate() {
            emit(AgentEvent::ToolCall {
                tool_call_id: call.id.clone(),
                tool_name: call.name.clone(),
                input: call.arguments.clone(),
            });
            let result = tokio::select! {
                biased;
                () = cancel.cancelled() => {
                    // Keep history valid for the next run: every tool call needs a result.
                    for open in &calls[i..] {
                        history.push(Message::ToolResult {
                            tool_call_id: open.id.clone(),
                            tool_name: open.name.clone(),
                            content: json!({
                                "status": "cancelled",
                                "reason": "The user stopped the run.",
                            }),
                        });
                    }
                    return Err(RunError::Cancelled);
                }
                result = call_tool(registry, runtime, call) => result,
            };
            history.push(Message::ToolResult {
                tool_call_id: call.id.clone(),
                tool_name: call.name.clone(),
                content: wrap_untrusted(&call.name, result.clone()),
            });
            emit(AgentEvent::ToolResult {
                tool_call_id: call.id.clone(),
                tool_name: call.name.clone(),
                result,
            });
        }
    }
    Ok(DoneReason::MaxSteps)
}

/// Errors become results the model can react to; they never crash the run.
async fn call_tool(registry: &ToolRegistry, runtime: &ToolRuntime, call: &ToolCall) -> Value {
    match registry
        .call(&call.name, call.arguments.clone(), &call.id, runtime)
        .await
    {
        Ok(result) => result,
        Err(CallError::UnknownTool(name)) => json!({
            "status": "error",
            "error": "unknown_tool",
            "message": format!("No tool named {name}."),
        }),
        Err(CallError::InvalidInput { errors, .. }) => json!({
            "status": "error",
            "error": "invalid_input",
            "details": errors,
        }),
        Err(CallError::Failed { tool, source }) => {
            tracing::error!(tool, tool_call_id = call.id, error = %source, "tool failed");
            json!({"status": "error", "error": "tool_failed", "message": "The tool failed to run."})
        }
    }
}
