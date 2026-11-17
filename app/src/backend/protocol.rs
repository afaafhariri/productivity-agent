//! Wire types mirroring `agent/src/productivity_agent/rpc/protocol.py`.
//!
//! JSON-RPC 2.0, one message per line. Keep in sync with the Python side and bump
//! `PROTOCOL_VERSION` on both sides for breaking changes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Serialize)]
pub struct InitializeParams<'a> {
    pub protocol_version: u32,
    pub client_name: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct InitializeResult {
    pub protocol_version: u32,
    pub server_name: String,
    pub server_version: String,
}

#[derive(Debug, Serialize)]
pub struct RunStartParams<'a> {
    pub conversation_id: &'a str,
    pub text: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct RunStartResult {
    pub run_id: String,
}

#[derive(Debug, Serialize)]
pub struct RunCancelParams<'a> {
    pub run_id: &'a str,
}

#[derive(Debug, Serialize)]
pub struct ConfirmationRespondParams<'a> {
    pub run_id: &'a str,
    pub tool_call_id: &'a str,
    pub approved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolEffect {
    Read,
    Write,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub effect: ToolEffect,
}

/// Non-secret, read-only view of the backend's configuration (`settings.get`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SettingsResult {
    pub llm_provider: String,
    pub llm_model_id: Option<String>,
    /// Whether a Gemini API key is stored. The backend never sends the key itself.
    pub gemini_api_key_set: bool,
    /// Whether a GitHub personal access token is stored. Never sent to the app either.
    pub github_token_set: bool,
    pub tools: Vec<ToolInfo>,
}

/// Name of the Gemini API key secret (`secrets.set` / `secrets.delete`).
pub const GEMINI_API_KEY: &str = "gemini_api_key";

/// Name of the GitHub personal access token secret (`secrets.set` / `secrets.delete`).
pub const GITHUB_TOKEN: &str = "github_token";

/// Write-only: the backend stores `value` in the OS keychain and never sends it back.
#[derive(Serialize)]
pub struct SecretsSetParams<'a> {
    pub name: &'a str,
    pub value: &'a str,
}

impl std::fmt::Debug for SecretsSetParams<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretsSetParams")
            .field("name", &self.name)
            .field("value", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Serialize)]
pub struct SecretsDeleteParams<'a> {
    pub name: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoneReason {
    Stop,
    MaxSteps,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RunEventParams {
    pub run_id: String,
    pub event: RunEvent,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_every_event_the_backend_sends() {
        let cases = [
            (
                json!({"type": "text_delta", "text": "Hi"}),
                RunEvent::TextDelta { text: "Hi".into() },
            ),
            (
                json!({"type": "tool_call", "tool_call_id": "c1", "tool_name": "t", "input": {"a": 1}}),
                RunEvent::ToolCall {
                    tool_call_id: "c1".into(),
                    tool_name: "t".into(),
                    input: json!({"a": 1}),
                },
            ),
            (
                json!({"type": "tool_result", "tool_call_id": "c1", "tool_name": "t", "result": null}),
                RunEvent::ToolResult {
                    tool_call_id: "c1".into(),
                    tool_name: "t".into(),
                    result: Value::Null,
                },
            ),
            (
                json!({"type": "confirmation_request", "tool_call_id": "c1", "tool_name": "t",
                       "description": "d", "input": {}}),
                RunEvent::ConfirmationRequest {
                    tool_call_id: "c1".into(),
                    tool_name: "t".into(),
                    description: "d".into(),
                    input: json!({}),
                },
            ),
            (
                json!({"type": "done", "reason": "max_steps"}),
                RunEvent::Done {
                    reason: DoneReason::MaxSteps,
                },
            ),
            (
                json!({"type": "error", "message": "x"}),
                RunEvent::Error {
                    message: "x".into(),
                },
            ),
        ];
        for (wire, expected) in cases {
            assert_eq!(serde_json::from_value::<RunEvent>(wire).unwrap(), expected);
        }
    }

    #[test]
    fn secret_params_never_show_the_value_in_debug_output() {
        let params = SecretsSetParams {
            name: GEMINI_API_KEY,
            value: "AIza-not-real",
        };
        assert!(!format!("{params:?}").contains("AIza"));
        assert_eq!(
            serde_json::to_value(params).unwrap(),
            json!({"name": "gemini_api_key", "value": "AIza-not-real"})
        );
    }

    #[test]
    fn omits_absent_rejection_reason() {
        let params = ConfirmationRespondParams {
            run_id: "r",
            tool_call_id: "c",
            approved: true,
            reason: None,
        };
        assert_eq!(
            serde_json::to_value(params).unwrap(),
            json!({"run_id": "r", "tool_call_id": "c", "approved": true})
        );
    }
}
