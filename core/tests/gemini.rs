//! GeminiModel against a local mock server: no network, no API key.

use std::time::Duration;

use agent_core::llm::config::{GEMINI_API_KEY, LlmConfig, Provider, create_model};
use agent_core::llm::gemini::{GeminiModel, RetryPolicy, to_contents};
use agent_core::llm::{
    FinishReason, LanguageModel, Message, ModelError, ModelPart, ModelRequest, ToolCall,
};
use agent_core::ports::{MemorySecretStore, SecretStore};
use agent_core::tools::{Effect, ToolSpec};
use futures::StreamExt;
use serde_json::{Value, json};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

const MODEL: &str = "some-gemini";

fn model(server: &MockServer) -> GeminiModel {
    GeminiModel::new("test-key", MODEL)
        .with_base_url(server.uri())
        .with_retry(RetryPolicy {
            attempts: 3,
            initial_delay: Duration::from_millis(5),
            max_delay: Duration::from_millis(10),
        })
}

fn sse(events: &[Value]) -> ResponseTemplate {
    let body: String = events
        .iter()
        .map(|e| format!("data: {e}\r\n\r\n"))
        .collect();
    ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_string(body)
}

fn chunk(parts: Value, finish: Option<&str>) -> Value {
    let mut candidate = json!({"content": {"role": "model", "parts": parts}});
    if let Some(reason) = finish {
        candidate["finishReason"] = reason.into();
    }
    json!({"candidates": [candidate]})
}

fn request(messages: Vec<Message>, tools: Vec<ToolSpec>) -> ModelRequest {
    ModelRequest {
        system: "be brief".into(),
        messages,
        tools,
    }
}

fn spec() -> ToolSpec {
    ToolSpec {
        name: "github_list_pull_requests",
        description: "Lists PRs.",
        input_schema: json!({"type": "object", "properties": {"limit": {"type": "integer"}}}),
        effect: Effect::Read,
    }
}

async fn collect(model: &GeminiModel, req: ModelRequest) -> Vec<Result<ModelPart, ModelError>> {
    model.stream(req).collect().await
}

fn stream_path() -> wiremock::matchers::PathExactMatcher {
    path(format!("/v1beta/models/{MODEL}:streamGenerateContent"))
}

#[tokio::test]
async fn streams_text_and_sends_the_request_gemini_expects() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(stream_path())
        .and(query_param("alt", "sse"))
        .and(header("x-goog-api-key", "test-key"))
        .respond_with(sse(&[
            chunk(json!([{"text": "Hel"}]), None),
            chunk(json!([{"text": "lo ✓ ünïcode"}]), Some("STOP")),
        ]))
        .expect(1)
        .mount(&server)
        .await;

    let parts = collect(
        &model(&server),
        request(vec![Message::user("hi")], vec![spec()]),
    )
    .await;
    let parts: Vec<ModelPart> = parts.into_iter().map(Result::unwrap).collect();
    assert_eq!(parts[0], ModelPart::TextDelta("Hel".into()));
    assert_eq!(parts[1], ModelPart::TextDelta("lo ✓ ünïcode".into()));
    assert!(matches!(parts[2], ModelPart::ProviderState(_)));
    assert_eq!(parts[3], ModelPart::Finish(FinishReason::Stop));

    let sent: Value = server.received_requests().await.unwrap()[0]
        .body_json()
        .unwrap();
    assert_eq!(
        sent["systemInstruction"],
        json!({"parts": [{"text": "be brief"}]})
    );
    assert_eq!(
        sent["contents"],
        json!([{"role": "user", "parts": [{"text": "hi"}]}])
    );
    let declaration = &sent["tools"][0]["functionDeclarations"][0];
    assert_eq!(declaration["name"], "github_list_pull_requests");
    assert_eq!(declaration["parametersJsonSchema"], spec().input_schema);
}

#[tokio::test]
async fn function_call_keeps_thought_signature_for_next_turn_and_hides_thoughts() {
    let server = MockServer::start().await;
    let call_part = json!({
        "functionCall": {"id": "fc-1", "name": "github_list_pull_requests", "args": {}},
        "thoughtSignature": "b3BhcXVl",
    });
    Mock::given(method("POST"))
        .respond_with(sse(&[
            chunk(json!([{"text": "pondering", "thought": true}]), None),
            chunk(json!([call_part.clone()]), None),
        ]))
        .mount(&server)
        .await;

    let parts: Vec<ModelPart> = collect(
        &model(&server),
        request(vec![Message::user("PRs?")], vec![]),
    )
    .await
    .into_iter()
    .map(Result::unwrap)
    .collect();
    assert_eq!(
        parts[0],
        ModelPart::ToolCall(ToolCall {
            id: "fc-1".into(),
            name: "github_list_pull_requests".into(),
            arguments: json!({})
        })
    );
    assert_eq!(
        parts.last(),
        Some(&ModelPart::Finish(FinishReason::ToolCalls))
    );
    let ModelPart::ProviderState(state) = parts[1].clone() else {
        panic!("no provider state")
    };

    let contents = to_contents(&[
        Message::user("PRs?"),
        Message::Assistant {
            text: String::new(),
            tool_calls: vec![],
            provider_state: Some(state),
        },
        Message::ToolResult {
            tool_call_id: "fc-1".into(),
            tool_name: "github_list_pull_requests".into(),
            content: json!({"untrusted_content": []}),
        },
    ]);
    assert_eq!(
        contents[1]["parts"][1], call_part,
        "signature sent back verbatim"
    );
    assert_eq!(
        contents[2]["parts"][0]["functionResponse"],
        json!({"id": "fc-1", "name": "github_list_pull_requests", "response": {"output": {"untrusted_content": []}}})
    );
}

#[tokio::test]
async fn parallel_results_share_one_turn_and_generated_ids_stay_local() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(sse(&[chunk(
            json!([{"functionCall": {"name": "a", "args": {"x": 1}}}]),
            None,
        )]))
        .mount(&server)
        .await;
    let parts = collect(&model(&server), request(vec![], vec![])).await;
    let Ok(ModelPart::ToolCall(call)) = &parts[0] else {
        panic!("no call")
    };
    assert!(call.id.starts_with("gen-"));
    assert_eq!(call.arguments, json!({"x": 1}));

    let contents = to_contents(&[
        Message::Assistant {
            text: String::new(),
            tool_calls: vec![
                ToolCall {
                    id: call.id.clone(),
                    name: "a".into(),
                    arguments: json!({}),
                },
                ToolCall {
                    id: "fc-2".into(),
                    name: "b".into(),
                    arguments: json!({}),
                },
            ],
            provider_state: None,
        },
        Message::ToolResult {
            tool_call_id: call.id.clone(),
            tool_name: "a".into(),
            content: json!(1),
        },
        Message::ToolResult {
            tool_call_id: "fc-2".into(),
            tool_name: "b".into(),
            content: json!(2),
        },
        Message::user("thanks"),
    ]);
    let roles: Vec<&str> = contents
        .iter()
        .map(|c| c["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["model", "user", "user"]);
    assert!(contents[0]["parts"][0]["functionCall"].get("id").is_none());
    let responses = contents[1]["parts"].as_array().unwrap();
    assert!(responses[0]["functionResponse"].get("id").is_none());
    assert_eq!(responses[1]["functionResponse"]["id"], "fc-2");
}

#[tokio::test]
async fn max_tokens_maps_to_length() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(sse(&[chunk(json!([{"text": "…"}]), Some("MAX_TOKENS"))]))
        .mount(&server)
        .await;
    let parts = collect(&model(&server), request(vec![], vec![])).await;
    assert_eq!(
        parts.last(),
        Some(&Ok(ModelPart::Finish(FinishReason::Length)))
    );
}

async fn error_for(status: u16, message: &str) -> ModelError {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(status)
                .set_body_json(json!({"error": {"code": status, "message": message}})),
        )
        .mount(&server)
        .await;
    let parts = collect(&model(&server), request(vec![], vec![])).await;
    assert_eq!(parts.len(), 1);
    parts.into_iter().next().unwrap().unwrap_err()
}

#[tokio::test]
async fn api_errors_become_plain_messages_without_google_text() {
    let cases = [
        (401, "secret detail", "didn't accept your API key"),
        (403, "secret detail", "didn't accept your API key"),
        (
            400,
            "API key not valid. Please pass a valid API key.",
            "didn't accept your API key",
        ),
        (402, "secret detail", "credits are used up"),
        (
            404,
            "secret detail",
            "doesn't have a model called 'some-gemini'",
        ),
        (429, "secret detail", "rate limit or quota"),
        (
            503,
            "secret detail",
            "having problems right now (error 503)",
        ),
        (400, "secret detail", "rejected the request (error 400)"),
    ];
    for (status, google, expected) in cases {
        let ModelError(message) = error_for(status, google).await;
        assert!(message.contains(expected), "{status}: {message}");
        assert!(!message.contains("secret detail"));
    }
}

#[tokio::test]
async fn busy_errors_are_retried_then_succeed() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .up_to_n_times(2)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .respond_with(sse(&[chunk(json!([{"text": "ok"}]), Some("STOP"))]))
        .mount(&server)
        .await;
    let parts = collect(&model(&server), request(vec![], vec![])).await;
    assert_eq!(parts[0], Ok(ModelPart::TextDelta("ok".into())));
    assert_eq!(server.received_requests().await.unwrap().len(), 3);
}

#[tokio::test]
async fn credit_errors_are_not_retried() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(402))
        .mount(&server)
        .await;
    let _ = collect(&model(&server), request(vec![], vec![])).await;
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn error_inside_the_stream_is_reported() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(sse(&[
            chunk(json!([{"text": "par"}]), None),
            json!({"error": {"code": 500, "message": "internal"}}),
        ]))
        .mount(&server)
        .await;
    let parts = collect(&model(&server), request(vec![], vec![])).await;
    assert_eq!(parts[0], Ok(ModelPart::TextDelta("par".into())));
    assert!(matches!(&parts[1], Err(ModelError(m)) if m.contains("error 500")));
}

#[tokio::test]
async fn silence_times_out_with_a_plain_message() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(sse(&[]).set_delay(Duration::from_secs(5)))
        .mount(&server)
        .await;
    let model = model(&server).with_idle_timeout(Duration::from_millis(100));
    let parts = collect(&model, request(vec![], vec![])).await;
    assert!(matches!(&parts[0], Err(ModelError(m)) if m.contains("didn't respond")));
}

#[tokio::test]
async fn unreachable_server_says_so() {
    // Port 9 (discard) on localhost: nothing listens there in CI.
    let model = GeminiModel::new("k", MODEL)
        .with_base_url("http://127.0.0.1:9")
        .with_retry(RetryPolicy {
            attempts: 1,
            initial_delay: Duration::ZERO,
            max_delay: Duration::ZERO,
        });
    let parts = collect(&model, request(vec![], vec![])).await;
    assert!(matches!(&parts[0], Err(ModelError(m)) if m.contains("Couldn't reach Gemini")));
}

#[tokio::test]
async fn api_key_only_travels_in_the_header() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(sse(&[chunk(json!([{"text": "x"}]), Some("STOP"))]))
        .mount(&server)
        .await;
    let _ = collect(&model(&server), request(vec![Message::user("hi")], vec![])).await;
    let received: Vec<Request> = server.received_requests().await.unwrap();
    assert!(!received[0].url.as_str().contains("test-key"));
    assert!(!String::from_utf8_lossy(&received[0].body).contains("test-key"));
}

#[test]
fn config_defaults_to_mock_and_validates() {
    let env = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned())
        }
    };
    assert_eq!(
        LlmConfig::from_env(env(&[])).unwrap().provider,
        Provider::Mock
    );
    assert_eq!(
        LlmConfig::from_env(env(&[("LLM_PROVIDER", "")]))
            .unwrap()
            .provider,
        Provider::Mock
    );
    let gemini =
        LlmConfig::from_env(env(&[("LLM_PROVIDER", "gemini"), ("LLM_MODEL_ID", "m")])).unwrap();
    assert_eq!(
        (gemini.provider, gemini.model_id.as_deref()),
        (Provider::Gemini, Some("m"))
    );
    assert!(LlmConfig::from_env(env(&[("LLM_PROVIDER", "gemini")])).is_err());
    let removed = LlmConfig::from_env(env(&[("LLM_PROVIDER", "vertex")])).unwrap_err();
    assert!(removed.0.contains("no longer supported"));
    assert!(LlmConfig::from_env(env(&[("LLM_PROVIDER", "gateway")])).is_err());
}

#[tokio::test]
async fn gemini_without_a_key_asks_for_one() {
    let config = LlmConfig {
        provider: Provider::Gemini,
        model_id: Some("m".into()),
    };
    let secrets = MemorySecretStore::default();
    let error = create_model(&config, &secrets).await.err().unwrap();
    assert!(error.0.contains("Add your Gemini API key in Settings"));
    secrets.set(GEMINI_API_KEY, "key").await.unwrap();
    assert!(create_model(&config, &secrets).await.is_ok());
}
