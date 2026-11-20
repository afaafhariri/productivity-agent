use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_core::ports::{ConfirmationRequest, Decision};
use agent_core::testing::{BlockingConfirmation, FakeConfirmation, runtime};
use agent_core::tools::{
    AgentTool, CallError, Effect, FieldError, RegistryError, ToolContext, ToolError, ToolInput,
    ToolRegistry, ToolResult,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, Deserialize, JsonSchema)]
struct EchoInput {
    text: String,
}
impl ToolInput for EchoInput {}

#[derive(Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
struct SendInput {
    to: String,
}
impl ToolInput for SendInput {
    fn validate(&self) -> Result<(), FieldError> {
        if self.to.contains('@') {
            Ok(())
        } else {
            Err(FieldError::new("to", "must be an email address"))
        }
    }
}

fn echo_tool() -> AgentTool {
    AgentTool::new(
        "echo_read",
        "Echoes the input.",
        Effect::Read,
        |input: EchoInput, _ctx: ToolContext| async move {
            Ok::<ToolResult, ToolError>(json!({ "echoed": input.text }))
        },
    )
}

/// A write tool that records every call it actually runs.
fn send_tool() -> (AgentTool, Arc<Mutex<Vec<String>>>) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let log = sent.clone();
    let tool = AgentTool::new(
        "send_thing",
        "Sends a thing.",
        Effect::Write,
        move |input: SendInput, _ctx: ToolContext| {
            let log = log.clone();
            async move {
                log.lock().unwrap().push(input.to);
                Ok::<ToolResult, ToolError>(json!({ "sent": true }))
            }
        },
    );
    (tool, sent)
}

fn registry_with(tool: AgentTool) -> ToolRegistry {
    let mut registry = ToolRegistry::default();
    registry.register(tool).unwrap();
    registry
}

#[test]
fn rejects_bad_and_duplicate_names() {
    let mut registry = registry_with(echo_tool());
    assert_eq!(
        registry.register(echo_tool()),
        Err(RegistryError::Duplicate("echo_read".into()))
    );
    for bad in [
        "EchoRead",
        "echo__read",
        "echo_",
        "_echo",
        "9echo",
        "echo-read",
    ] {
        let tool = AgentTool::new(bad, "x", Effect::Read, |_: EchoInput, _| async {
            Ok::<ToolResult, ToolError>(Value::Null)
        });
        assert_eq!(
            registry.register(tool),
            Err(RegistryError::BadName(bad.into()))
        );
    }
}

#[test]
fn specs_expose_json_schema_without_meta_keys() {
    let [spec] = registry_with(echo_tool()).specs().try_into().unwrap();
    assert_eq!(spec.name, "echo_read");
    assert_eq!(spec.effect, Effect::Read);
    assert_eq!(spec.input_schema["properties"]["text"]["type"], "string");
    assert!(spec.input_schema.get("$schema").is_none());
}

#[tokio::test]
async fn read_tool_runs_without_confirmation() {
    let confirmation = FakeConfirmation::unexpected();
    let result = registry_with(echo_tool())
        .call(
            "echo_read",
            json!({"text": "hi"}),
            "c1",
            &runtime(confirmation.clone()),
        )
        .await
        .unwrap();
    assert_eq!(result, json!({"echoed": "hi"}));
    assert!(confirmation.requests().is_empty());
}

#[tokio::test]
async fn write_tool_asks_with_exact_input_then_runs() {
    let (tool, sent) = send_tool();
    let confirmation = FakeConfirmation::answering(Decision::Approved);
    let result = registry_with(tool)
        .call(
            "send_thing",
            json!({"to": "a@b.c", "ignored": 1}),
            "c1",
            &runtime(confirmation.clone()),
        )
        .await
        .unwrap();
    assert_eq!(result, json!({"sent": true}));
    assert_eq!(
        confirmation.requests(),
        vec![ConfirmationRequest {
            tool_call_id: "c1".into(),
            tool_name: "send_thing".into(),
            description: "Sends a thing.".into(),
            input: json!({"to": "a@b.c"}),
        }]
    );
    assert_eq!(*sent.lock().unwrap(), ["a@b.c"]);
}

#[tokio::test]
async fn rejected_write_tool_never_runs() {
    let (tool, sent) = send_tool();
    let confirmation = FakeConfirmation::answering(Decision::Rejected {
        reason: Some("no".into()),
    });
    let result = registry_with(tool)
        .call(
            "send_thing",
            json!({"to": "a@b.c"}),
            "c1",
            &runtime(confirmation),
        )
        .await
        .unwrap();
    assert_eq!(result, json!({"status": "rejected", "reason": "no"}));
    assert!(sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn stopping_while_awaiting_confirmation_never_runs() {
    let (tool, sent) = send_tool();
    let registry = registry_with(tool);
    let confirmation = Arc::new(BlockingConfirmation::default());
    let rt = runtime(confirmation.clone());

    let call = registry.call("send_thing", json!({"to": "a@b.c"}), "c1", &rt);
    tokio::select! {
        _ = call => panic!("the call finished without an answer"),
        _ = async {
            confirmation.waiting.notified().await;
            tokio::time::sleep(Duration::from_millis(20)).await;
        } => {} // Dropping `call` here is how a stopped run abandons it.
    }
    assert!(sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn invalid_input_fails_before_confirmation() {
    let (tool, sent) = send_tool();
    let confirmation = FakeConfirmation::answering(Decision::Approved);
    let registry = registry_with(tool);
    let rt = runtime(confirmation.clone());

    for bad in [
        json!({"to": 42}),
        json!({}),
        json!({"to": "not-an-address"}),
    ] {
        let error = registry
            .call("send_thing", bad, "c1", &rt)
            .await
            .unwrap_err();
        assert!(matches!(error, CallError::InvalidInput { ref tool, .. } if tool == "send_thing"));
    }
    assert!(confirmation.requests().is_empty());
    assert!(sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn unknown_tool() {
    let error = ToolRegistry::default()
        .call(
            "nope",
            json!({}),
            "c1",
            &runtime(FakeConfirmation::unexpected()),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, CallError::UnknownTool(name) if name == "nope"));
}

#[tokio::test]
async fn failing_tool_is_an_error_not_a_panic() {
    let tool = AgentTool::new(
        "broken_read",
        "Fails.",
        Effect::Read,
        |_: EchoInput, _| async { Err::<ToolResult, ToolError>("disk on fire".into()) },
    );
    let error = registry_with(tool)
        .call(
            "broken_read",
            json!({"text": ""}),
            "c1",
            &runtime(FakeConfirmation::unexpected()),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, CallError::Failed { .. }));
}

#[tokio::test]
async fn oversized_results_are_truncated() {
    let tool = AgentTool::new("big_read", "Big.", Effect::Read, |_: EchoInput, _| async {
        Ok::<ToolResult, ToolError>(json!({"data": "x".repeat(500)}))
    });
    let mut rt = runtime(FakeConfirmation::unexpected());
    rt.max_result_chars = 100;
    let result = registry_with(tool)
        .call("big_read", json!({"text": ""}), "c1", &rt)
        .await
        .unwrap();
    assert_eq!(result["truncated"], true);
    assert_eq!(result["preview"].as_str().unwrap().chars().count(), 100);
}
