use std::sync::Arc;

use serde::Serialize;
use serde_json::{Value, json};

use super::{AgentTool, Effect, FieldError, ToolContext, ToolError, ToolResult};
use crate::ports::{Clock, Confirmation, ConfirmationRequest, Decision, SecretStore};

/// Backstop only: tools should paginate/truncate themselves well below this.
pub const DEFAULT_MAX_RESULT_CHARS: usize = 20_000;

/// What the model sees for a tool (plus `effect`, which providers ignore).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub effect: Effect,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RegistryError {
    #[error("tool name must be snake_case: \"{0}\"")]
    BadName(String),
    #[error("tool already registered: \"{0}\"")]
    Duplicate(String),
}

#[derive(Debug, thiserror::Error)]
pub enum CallError {
    #[error("unknown tool: {0}")]
    UnknownTool(String),
    /// The model sent arguments that don't match the tool's input type.
    #[error("invalid input for {tool}")]
    InvalidInput {
        tool: String,
        errors: Vec<FieldError>,
    },
    #[error("tool {tool} failed: {source}")]
    Failed { tool: String, source: ToolError },
}

#[derive(Clone)]
pub struct ToolRuntime {
    pub confirmation: Arc<dyn Confirmation>,
    pub secrets: Arc<dyn SecretStore>,
    pub clock: Arc<dyn Clock>,
    pub max_result_chars: usize,
}

#[derive(Default)]
pub struct ToolRegistry {
    tools: Vec<AgentTool>,
}

impl ToolRegistry {
    pub fn register(&mut self, tool: AgentTool) -> Result<(), RegistryError> {
        if !is_snake_case(tool.name) {
            return Err(RegistryError::BadName(tool.name.to_owned()));
        }
        if self.get(tool.name).is_some() {
            return Err(RegistryError::Duplicate(tool.name.to_owned()));
        }
        self.tools.push(tool);
        Ok(())
    }

    pub fn get(&self, name: &str) -> Option<&AgentTool> {
        self.tools.iter().find(|t| t.name == name)
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        self.tools
            .iter()
            .map(|t| ToolSpec {
                name: t.name,
                description: t.description,
                input_schema: t.input_schema.clone(),
                effect: t.effect,
            })
            .collect()
    }

    /// Validates, gates (for write tools), executes and size-bounds one tool call.
    ///
    /// Errors are for the agent loop to report to the model. A rejected write is not an
    /// error: it returns `{"status": "rejected", ...}`.
    pub async fn call(
        &self,
        name: &str,
        raw_input: Value,
        tool_call_id: &str,
        runtime: &ToolRuntime,
    ) -> Result<ToolResult, CallError> {
        let tool = self
            .get(name)
            .ok_or_else(|| CallError::UnknownTool(name.to_owned()))?;
        let prepared = tool
            .prepare(raw_input)
            .map_err(|errors| CallError::InvalidInput {
                tool: name.to_owned(),
                errors,
            })?;

        if tool.effect == Effect::Write {
            let decision = runtime
                .confirmation
                .request(ConfirmationRequest {
                    tool_call_id: tool_call_id.to_owned(),
                    tool_name: name.to_owned(),
                    description: tool.description.to_owned(),
                    input: prepared.input.clone(),
                })
                .await;
            if let Decision::Rejected { reason } = decision {
                tracing::info!(tool = name, tool_call_id, "tool rejected by user");
                return Ok(json!({
                    "status": "rejected",
                    "reason": reason.unwrap_or_else(|| "The user rejected this action.".into()),
                }));
            }
        }

        let ctx = ToolContext {
            tool_call_id: tool_call_id.to_owned(),
            secrets: runtime.secrets.clone(),
            clock: runtime.clock.clone(),
        };
        let result = prepared
            .run(ctx)
            .await
            .map_err(|source| CallError::Failed {
                tool: name.to_owned(),
                source,
            })?;
        Ok(bound(result, runtime.max_result_chars))
    }
}

fn is_snake_case(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && !name.ends_with('_')
        && !name.contains("__")
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn bound(result: ToolResult, max_chars: usize) -> ToolResult {
    let serialized = result.to_string();
    let length = serialized.chars().count();
    if length <= max_chars {
        return result;
    }
    json!({
        "truncated": true,
        "note": format!(
            "Result was {length} characters and was cut to {max_chars}. \
             Ask for a narrower query or the next page."
        ),
        "preview": serialized.chars().take(max_chars).collect::<String>(),
    })
}
