//! The agent service end to end, with mock models and the stub tools. No network.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_core::integrations::github::GitHubApi;
use agent_core::integrations::register_tools;
use agent_core::llm::config::{LlmConfig, Provider};
use agent_core::llm::mock::MockModel;
use agent_core::llm::{FinishReason, LanguageModel, ModelError, ModelPart, ToolCall};
use agent_core::ports::{Decision, MemorySecretStore, SecretStore};
use agent_core::service::{
    AgentService, DoneReason, RunEvent, RunEventParams, SecretName, ServiceDeps, ServiceError,
};
use agent_core::testing::fixed_clock;
use agent_core::tools::{
    AgentTool, Effect, ToolContext, ToolError, ToolInput, ToolRegistry, ToolResult,
};
use futures::StreamExt;
use futures::channel::mpsc::UnboundedReceiver;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::runtime::Handle;

struct Harness {
    service: AgentService,
    events: UnboundedReceiver<RunEventParams>,
    secrets: Arc<MemorySecretStore>,
}

fn harness(
    model: Option<Arc<dyn LanguageModel>>,
    registry: ToolRegistry,
    config: LlmConfig,
) -> Harness {
    let secrets = Arc::new(MemorySecretStore::default());
    let (service, events) = AgentService::new(
        ServiceDeps {
            config,
            registry,
            secrets: secrets.clone(),
            clock: fixed_clock(),
            model,
        },
        Handle::current(),
    );
    Harness {
        service,
        events,
        secrets,
    }
}

fn stub_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::default();
    // Unroutable address: the GitHub tools must not reach it without a token anyway.
    register_tools(&mut registry, GitHubApi::new("http://127.0.0.1:9")).unwrap();
    registry
}

impl Harness {
    async fn next(&mut self) -> RunEventParams {
        tokio::time::timeout(Duration::from_secs(5), self.events.next())
            .await
            .expect("timed out waiting for an event")
            .expect("event channel closed")
    }

    async fn until_done(&mut self, run_id: &str) -> Vec<RunEvent> {
        let mut events = Vec::new();
        loop {
            let params = self.next().await;
            assert_eq!(params.run_id, run_id);
            let terminal = params.event.is_terminal();
            events.push(params.event);
            if terminal {
                return events;
            }
        }
    }
}

fn text_of(events: &[RunEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            RunEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn echo() -> Option<Arc<dyn LanguageModel>> {
    Some(Arc::new(MockModel::echo(Duration::ZERO)))
}

#[tokio::test]
async fn run_streams_and_keeps_the_conversation() {
    let mut h = harness(echo(), ToolRegistry::default(), LlmConfig::default());
    let run = h.service.start_run("c", "hello there").unwrap();
    let events = h.until_done(&run).await;
    assert_eq!(text_of(&events), "(mock) You said: hello there");
    assert_eq!(
        events.last(),
        Some(&RunEvent::Done {
            reason: DoneReason::Stop
        })
    );

    let second = h.service.start_run("c", "again").unwrap();
    assert_ne!(second, run);
    h.until_done(&second).await;
}

#[tokio::test]
async fn invalid_requests_are_refused() {
    let h = harness(echo(), ToolRegistry::default(), LlmConfig::default());
    assert!(matches!(
        h.service.start_run("c", ""),
        Err(ServiceError::InvalidInput(_))
    ));
    assert!(matches!(
        h.service.start_run("", "hi"),
        Err(ServiceError::InvalidInput(_))
    ));
    let long = "x".repeat(32_001);
    assert!(matches!(
        h.service.start_run("c", &long),
        Err(ServiceError::InvalidInput(_))
    ));
    assert_eq!(
        h.service.cancel_run("missing"),
        Err(ServiceError::RunNotFound)
    );
}

#[tokio::test]
async fn cancel_stops_a_streaming_run_and_frees_the_conversation() {
    let mut h = harness(
        Some(Arc::new(MockModel::echo(Duration::from_millis(50)))),
        ToolRegistry::default(),
        LlmConfig::default(),
    );
    let run = h.service.start_run("c", "a b c d e f g h").unwrap();
    assert!(matches!(h.next().await.event, RunEvent::TextDelta { .. }));
    assert_eq!(
        h.service.start_run("c", "x"),
        Err(ServiceError::ConversationBusy)
    );
    h.service.cancel_run(&run).unwrap();
    let events = h.until_done(&run).await;
    assert_eq!(
        events.last(),
        Some(&RunEvent::Done {
            reason: DoneReason::Cancelled
        })
    );

    let again = h.service.start_run("c", "x").unwrap();
    h.until_done(&again).await;
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct SendInput {
    to: String,
}
impl ToolInput for SendInput {}

fn send_registry(sent: Arc<Mutex<Vec<String>>>) -> ToolRegistry {
    let mut registry = ToolRegistry::default();
    registry
        .register(AgentTool::new(
            "email_send",
            "Sends an email.",
            Effect::Write,
            move |input: SendInput, _: ToolContext| {
                let sent = sent.clone();
                async move {
                    sent.lock().unwrap().push(input.to);
                    Ok::<ToolResult, ToolError>(json!({"sent": true}))
                }
            },
        ))
        .unwrap();
    registry
}

fn send_then_reply() -> Option<Arc<dyn LanguageModel>> {
    Some(Arc::new(MockModel::scripted(vec![
        vec![
            ModelPart::ToolCall(ToolCall {
                id: "c1".into(),
                name: "email_send".into(),
                arguments: json!({"to": "a@example.com"}),
            }),
            ModelPart::Finish(FinishReason::ToolCalls),
        ],
        vec![
            ModelPart::TextDelta("Done.".into()),
            ModelPart::Finish(FinishReason::Stop),
        ],
    ])))
}

async fn until_confirmation(h: &mut Harness) -> RunEvent {
    loop {
        let event = h.next().await.event;
        if matches!(event, RunEvent::ConfirmationRequest { .. }) {
            return event;
        }
    }
}

#[tokio::test]
async fn write_tool_waits_for_approval_then_runs() {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let mut h = harness(
        send_then_reply(),
        send_registry(sent.clone()),
        LlmConfig::default(),
    );
    let run = h.service.start_run("c", "email a").unwrap();
    assert_eq!(
        until_confirmation(&mut h).await,
        RunEvent::ConfirmationRequest {
            tool_call_id: "c1".into(),
            tool_name: "email_send".into(),
            description: "Sends an email.".into(),
            input: json!({"to": "a@example.com"}),
        }
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        sent.lock().unwrap().is_empty(),
        "nothing runs before the answer"
    );

    assert_eq!(
        h.service
            .respond_confirmation(&run, "zzz", Decision::Approved),
        Err(ServiceError::ConfirmationNotFound)
    );
    h.service
        .respond_confirmation(&run, "c1", Decision::Approved)
        .unwrap();
    let events = h.until_done(&run).await;
    assert!(events.contains(&RunEvent::ToolResult {
        tool_call_id: "c1".into(),
        tool_name: "email_send".into(),
        result: json!({"sent": true}),
    }));
    assert_eq!(*sent.lock().unwrap(), ["a@example.com"]);
    assert_eq!(
        h.service
            .respond_confirmation(&run, "c1", Decision::Approved),
        Err(ServiceError::RunNotFound)
    );
}

#[tokio::test]
async fn rejection_never_runs_the_tool() {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let mut h = harness(
        send_then_reply(),
        send_registry(sent.clone()),
        LlmConfig::default(),
    );
    let run = h.service.start_run("c", "email a").unwrap();
    until_confirmation(&mut h).await;
    h.service
        .respond_confirmation(
            &run,
            "c1",
            Decision::Rejected {
                reason: Some("no".into()),
            },
        )
        .unwrap();
    let events = h.until_done(&run).await;
    assert!(
        matches!(&events[0], RunEvent::ToolResult { result, .. } if result["status"] == "rejected")
    );
    assert!(sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn stopping_while_awaiting_approval_never_runs_the_tool() {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let mut h = harness(
        send_then_reply(),
        send_registry(sent.clone()),
        LlmConfig::default(),
    );
    let run = h.service.start_run("c", "email a").unwrap();
    until_confirmation(&mut h).await;
    h.service.cancel_run(&run).unwrap();
    let events = h.until_done(&run).await;
    assert_eq!(
        events.last(),
        Some(&RunEvent::Done {
            reason: DoneReason::Cancelled
        })
    );
    assert!(sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn model_errors_reach_the_user_as_error_events() {
    let model = MockModel::new(
        |_| Err(ModelError("Your Gemini API credits are used up.".into())),
        Duration::ZERO,
    );
    let mut h = harness(
        Some(Arc::new(model)),
        ToolRegistry::default(),
        LlmConfig::default(),
    );
    let run = h.service.start_run("c", "hi").unwrap();
    assert_eq!(
        h.until_done(&run).await,
        [RunEvent::Error {
            message: "Your Gemini API credits are used up.".into()
        }]
    );
}

#[tokio::test]
async fn gemini_without_a_key_asks_for_one_then_uses_the_new_key() {
    let config = LlmConfig {
        provider: Provider::Gemini,
        model_id: Some("m".into()),
    };
    let mut h = harness(None, ToolRegistry::default(), config);
    let run = h.service.start_run("c", "hi").unwrap();
    let events = h.until_done(&run).await;
    assert!(
        matches!(&events[0], RunEvent::Error { message } if message.contains("Add your Gemini API key"))
    );

    h.service
        .set_secret(SecretName::GeminiApiKey, "  key-123  ")
        .await
        .unwrap();
    assert_eq!(
        h.secrets.get("gemini_api_key").await.unwrap().as_deref(),
        Some("key-123")
    );
    let settings = h.service.settings().await.unwrap();
    assert!(settings.gemini_api_key_set && !settings.github_token_set);
}

#[tokio::test]
async fn secrets_are_validated_and_never_echoed() {
    let h = harness(echo(), ToolRegistry::default(), LlmConfig::default());
    for bad in [
        "",
        "   ",
        "has space",
        "tab\there",
        "naïve-key",
        &"x".repeat(513),
    ] {
        let error = h
            .service
            .set_secret(SecretName::GithubToken, bad)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            ServiceError::InvalidInput("That doesn't look like a GitHub token".into())
        );
    }
    h.service
        .set_secret(SecretName::GithubToken, "ghp_ok")
        .await
        .unwrap();
    assert!(h.service.settings().await.unwrap().github_token_set);
    h.service
        .delete_secret(SecretName::GithubToken)
        .await
        .unwrap();
    assert!(!h.service.settings().await.unwrap().github_token_set);
}

#[tokio::test]
async fn settings_list_provider_and_tools_but_no_secret_values() {
    let h = harness(None, stub_registry(), LlmConfig::default());
    h.service
        .set_secret(SecretName::GeminiApiKey, "super-secret")
        .await
        .unwrap();
    let settings = h.service.settings().await.unwrap();
    assert_eq!(settings.llm_provider, "mock");
    let names: Vec<(&str, Effect)> = settings
        .tools
        .iter()
        .map(|t| (t.name.as_str(), t.effect))
        .collect();
    assert!(names.contains(&("gmail_send_draft", Effect::Write)));
    assert!(names.contains(&("github_list_pull_requests", Effect::Read)));
    assert!(
        !serde_json::to_string(&settings)
            .unwrap()
            .contains("super-secret")
    );
}

#[tokio::test]
async fn demo_mock_drives_the_stub_tools_end_to_end() {
    let mut h = harness(None, stub_registry(), LlmConfig::default());

    // "PRs" → GitHub, which isn't connected (no token, no request).
    let run = h
        .service
        .start_run("a", "What PRs need my review?")
        .unwrap();
    let events = h.until_done(&run).await;
    assert!(events.iter().any(
        |e| matches!(e, RunEvent::ToolResult { tool_name, result, .. }
        if tool_name == "github_list_pull_requests" && result["status"] == "not_connected")
    ));

    // Unread mail includes the injection sample, and it doesn't cause a send.
    let run = h
        .service
        .start_run("b", "anything unread in my inbox?")
        .unwrap();
    let events = h.until_done(&run).await;
    assert!(
        serde_json::to_string(&events)
            .unwrap()
            .contains("ignore your previous instructions")
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, RunEvent::ConfirmationRequest { .. }))
    );

    // "send" proposes the write tool and waits for approval; rejecting it is reported.
    let run = h
        .service
        .start_run("c", "send Sam the release notes")
        .unwrap();
    let RunEvent::ConfirmationRequest {
        tool_call_id,
        tool_name,
        input,
        ..
    } = until_confirmation(&mut h).await
    else {
        unreachable!()
    };
    assert_eq!(tool_name, "gmail_send_draft");
    assert_eq!(input["body"], "send Sam the release notes");
    h.service
        .respond_confirmation(&run, &tool_call_id, Decision::Rejected { reason: None })
        .unwrap();
    let events = h.until_done(&run).await;
    assert_eq!(text_of(&events), "(mock) OK, I did not send it.");
}
