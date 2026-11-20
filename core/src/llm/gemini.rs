//! Gemini through its REST API (Google AI Studio API key), streamed as server-sent events.
//!
//! Function calling is manual: the agent loop runs tools itself, so every write goes through
//! the approval gate. Each model turn's raw content is returned as provider state and sent
//! back verbatim next turn, which keeps Gemini's thought signatures intact (function calling
//! fails without them).

use std::time::Duration;

use futures::StreamExt;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use super::task_stream::TaskStream;
use super::{
    FinishReason, LanguageModel, Message, ModelError, ModelPart, ModelRequest, PartStream, ToolCall,
};
use crate::tools::ToolSpec;

pub const API_URL: &str = "https://generativelanguage.googleapis.com";

/// How long to wait for Gemini's first or next chunk. Generous, because a thinking model can
/// be silent for a while before its first chunk.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(90);

const GENERATED_ID_PREFIX: &str = "gen-";

/// Retries for short spikes (429 rate limits, 5xx "high demand") and network blips, before
/// anything has been streamed. 402 and other 4xx are never retried: trying again can't help.
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub attempts: u32,
    pub initial_delay: Duration,
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            attempts: 3,
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(4),
        }
    }
}

#[derive(Clone)]
pub struct GeminiModel {
    http: reqwest::Client,
    api_key: String,
    model_id: String,
    base_url: String,
    idle_timeout: Duration,
    retry: RetryPolicy,
}

impl GeminiModel {
    pub fn new(api_key: impl Into<String>, model_id: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .user_agent("productivity-agent")
                .build()
                .expect("TLS backend is available"),
            api_key: api_key.into(),
            model_id: model_id.into(),
            base_url: API_URL.into(),
            idle_timeout: IDLE_TIMEOUT,
            retry: RetryPolicy::default(),
        }
    }

    /// Points at another server (tests).
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn with_idle_timeout(mut self, idle_timeout: Duration) -> Self {
        self.idle_timeout = idle_timeout;
        self
    }

    pub fn with_retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    fn url(&self) -> String {
        format!(
            "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
            self.base_url.trim_end_matches('/'),
            self.model_id
        )
    }

    /// Sends the request, retrying transient failures. Returns the streaming response.
    async fn send(&self, body: &Value) -> Result<reqwest::Response, ModelError> {
        let mut delay = self.retry.initial_delay;
        for attempt in 1..=self.retry.attempts.max(1) {
            let last = attempt >= self.retry.attempts;
            let request = self
                .http
                .post(self.url())
                .header("x-goog-api-key", &self.api_key)
                .json(body)
                .send();
            match tokio::time::timeout(self.idle_timeout, request).await {
                Err(_) => return Err(self.idle_error()),
                Ok(Ok(response)) if response.status().as_u16() < 400 => return Ok(response),
                Ok(Ok(response)) => {
                    let status = response.status().as_u16();
                    if last || !matches!(status, 429 | 500 | 502 | 503 | 504) {
                        return Err(self.status_error(response).await);
                    }
                    tracing::info!(attempt, status, "Gemini busy; retrying");
                }
                Ok(Err(error)) => {
                    if last || !(error.is_connect() || error.is_timeout()) {
                        return Err(connection_error(&error));
                    }
                    tracing::info!(attempt, "Gemini unreachable; retrying");
                }
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(self.retry.max_delay);
        }
        unreachable!("the last attempt always returns")
    }

    async fn status_error(&self, response: reqwest::Response) -> ModelError {
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let message = body["error"]["message"].as_str().unwrap_or("");
        // Google's error text carries no credentials; it's logged for diagnosis only.
        tracing::warn!(status, message, "Gemini API error");
        ModelError(api_error_message(status, message, &self.model_id))
    }

    fn idle_error(&self) -> ModelError {
        tracing::warn!(
            seconds = self.idle_timeout.as_secs(),
            "Gemini went quiet; giving up"
        );
        ModelError(format!(
            "Gemini didn't respond for {} seconds. It may be busy; try again in a moment.",
            self.idle_timeout.as_secs()
        ))
    }

    async fn produce(self, body: Value, tx: mpsc::Sender<Result<ModelPart, ModelError>>) {
        let outcome = self.stream_into(&body, &tx).await;
        if let Err(error) = outcome {
            let _ = tx.send(Err(error)).await;
        }
    }

    async fn stream_into(
        &self,
        body: &Value,
        tx: &mpsc::Sender<Result<ModelPart, ModelError>>,
    ) -> Result<(), ModelError> {
        let response = self.send(body).await?;
        let mut bytes = response.bytes_stream();
        let mut events = SseBuffer::default();
        let mut raw_parts: Vec<Value> = Vec::new();
        let mut saw_call = false;
        let mut finish: Option<String> = None;

        loop {
            let chunk = match tokio::time::timeout(self.idle_timeout, bytes.next()).await {
                Err(_) => return Err(self.idle_error()),
                Ok(None) => break,
                Ok(Some(Err(error))) => return Err(connection_error(&error)),
                Ok(Some(Ok(chunk))) => chunk,
            };
            for data in events.push(&chunk) {
                let Ok(event) = serde_json::from_str::<Value>(&data) else {
                    tracing::warn!("Gemini sent an event that isn't JSON; skipping it");
                    continue;
                };
                if let Some(error) = event.get("error") {
                    let status = error["code"].as_u64().unwrap_or(500) as u16;
                    let message = error["message"].as_str().unwrap_or("");
                    tracing::warn!(status, message, "Gemini error in stream");
                    return Err(ModelError(api_error_message(
                        status,
                        message,
                        &self.model_id,
                    )));
                }
                let candidate = &event["candidates"][0];
                if let Some(reason) = candidate["finishReason"].as_str() {
                    finish = Some(reason.to_owned());
                }
                let parts = candidate["content"]["parts"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                for part in parts {
                    let thought = part["thought"].as_bool().unwrap_or(false);
                    let text = part["text"].as_str().map(str::to_owned);
                    let call = part.get("functionCall").cloned();
                    raw_parts.push(part);
                    if thought {
                        continue; // Thought summaries are not shown to the user.
                    }
                    if let Some(text) = text.filter(|t| !t.is_empty()) {
                        send(tx, ModelPart::TextDelta(text)).await?;
                    }
                    if let Some(call) = call {
                        saw_call = true;
                        send(tx, ModelPart::ToolCall(tool_call(&call))).await?;
                    }
                }
            }
        }

        let state = json!({"role": "model", "parts": raw_parts});
        send(tx, ModelPart::ProviderState(state)).await?;
        send(
            tx,
            ModelPart::Finish(finish_reason(finish.as_deref(), saw_call)),
        )
        .await
    }
}

/// The receiver is gone (the run was stopped): stop producing.
async fn send(
    tx: &mpsc::Sender<Result<ModelPart, ModelError>>,
    part: ModelPart,
) -> Result<(), ModelError> {
    tx.send(Ok(part))
        .await
        .map_err(|_| ModelError("The run was stopped.".into()))
}

impl LanguageModel for GeminiModel {
    fn stream(&self, request: ModelRequest) -> PartStream {
        let body = request_body(&request);
        let model = self.clone();
        TaskStream::spawn(move |tx| model.produce(body, tx)).boxed()
    }
}

pub fn request_body(request: &ModelRequest) -> Value {
    let mut body = json!({
        "systemInstruction": {"parts": [{"text": request.system}]},
        "contents": to_contents(&request.messages),
    });
    if let Some(tools) = tools(&request.tools) {
        body["tools"] = tools;
    }
    body
}

/// Converts history to Gemini contents. Consecutive tool results share one turn.
pub fn to_contents(messages: &[Message]) -> Vec<Value> {
    let mut contents: Vec<Value> = Vec::new();
    for message in messages {
        match message {
            Message::User { text } => {
                contents.push(json!({"role": "user", "parts": [{"text": text}]}));
            }
            Message::Assistant {
                provider_state: Some(raw),
                ..
            } => contents.push(raw.clone()), // Verbatim, so thought signatures survive.
            Message::Assistant {
                text, tool_calls, ..
            } => {
                let mut parts = Vec::new();
                if !text.is_empty() {
                    parts.push(json!({"text": text}));
                }
                for call in tool_calls {
                    let mut function_call = Map::new();
                    if let Some(id) = provider_id(&call.id) {
                        function_call.insert("id".into(), id.into());
                    }
                    function_call.insert("name".into(), call.name.clone().into());
                    function_call.insert("args".into(), args(&call.arguments));
                    parts.push(json!({"functionCall": function_call}));
                }
                contents.push(json!({"role": "model", "parts": parts}));
            }
            Message::ToolResult {
                tool_call_id,
                tool_name,
                content,
            } => {
                let mut response = Map::new();
                if let Some(id) = provider_id(tool_call_id) {
                    response.insert("id".into(), id.into());
                }
                response.insert("name".into(), tool_name.clone().into());
                response.insert("response".into(), json!({"output": content}));
                let part = json!({"functionResponse": response});
                match contents.last_mut() {
                    Some(last) if is_function_responses(last) => {
                        last["parts"].as_array_mut().unwrap().push(part);
                    }
                    _ => contents.push(json!({"role": "user", "parts": [part]})),
                }
            }
        }
    }
    contents
}

fn is_function_responses(content: &Value) -> bool {
    content["role"] == "user"
        && content["parts"].as_array().is_some_and(|parts| {
            !parts.is_empty() && parts.iter().all(|p| p.get("functionResponse").is_some())
        })
}

fn tools(specs: &[ToolSpec]) -> Option<Value> {
    if specs.is_empty() {
        return None;
    }
    let declarations: Vec<Value> = specs
        .iter()
        .map(|s| {
            json!({
                "name": s.name,
                "description": s.description,
                "parametersJsonSchema": s.input_schema,
            })
        })
        .collect();
    Some(json!([{"functionDeclarations": declarations}]))
}

fn tool_call(call: &Value) -> ToolCall {
    let id = call["id"].as_str().filter(|id| !id.is_empty()).map_or_else(
        || format!("{GENERATED_ID_PREFIX}{}", uuid::Uuid::new_v4().simple()),
        str::to_owned,
    );
    ToolCall {
        id,
        name: call["name"].as_str().unwrap_or_default().to_owned(),
        arguments: args(&call["args"]),
    }
}

/// Ids we generated were never seen by Gemini, so they aren't sent back.
fn provider_id(call_id: &str) -> Option<&str> {
    (!call_id.starts_with(GENERATED_ID_PREFIX)).then_some(call_id)
}

fn args(arguments: &Value) -> Value {
    if arguments.is_object() {
        arguments.clone()
    } else {
        json!({})
    }
}

fn finish_reason(reason: Option<&str>, saw_call: bool) -> FinishReason {
    if saw_call {
        return FinishReason::ToolCalls;
    }
    match reason {
        None | Some("STOP") => FinishReason::Stop,
        Some("MAX_TOKENS") => FinishReason::Length,
        Some(_) => FinishReason::Other,
    }
}

/// A message the user can act on, built only from the status code and our own config.
pub fn api_error_message(status: u16, google_message: &str, model_id: &str) -> String {
    let status = if status == 400 && google_message.to_lowercase().contains("api key") {
        401 // Gemini reports a malformed or unknown key as 400 INVALID_ARGUMENT.
    } else {
        status
    };
    match status {
        401 | 403 => "Gemini didn't accept your API key. Check it in Settings, or create a new \
                      one in Google AI Studio."
            .into(),
        402 => "Your Gemini API credits are used up. Top up your project's prepaid balance in \
                Google AI Studio, then try again."
            .into(),
        404 => format!(
            "Gemini doesn't have a model called '{model_id}'. Set LLM_MODEL_ID to a current \
             model and restart the app."
        ),
        429 => "Gemini's rate limit or quota was reached. Wait a moment and try again, or check \
                your project's limits in Google AI Studio."
            .into(),
        500.. => {
            format!("Gemini is having problems right now (error {status}). Try again in a moment.")
        }
        _ => format!("Gemini rejected the request (error {status})."),
    }
}

fn connection_error(error: &reqwest::Error) -> ModelError {
    // No credentials in these: the key travels in a header, never in the URL.
    tracing::warn!(error = %error, "Gemini connection error");
    ModelError(if error.is_connect() || error.is_timeout() {
        "Couldn't reach Gemini. Check your internet connection and try again.".into()
    } else {
        "The connection to Gemini was interrupted. Check your internet connection and try again."
            .into()
    })
}

/// Splits a byte stream into server-sent-event `data` payloads. Works on bytes, so a
/// multi-byte character split across network chunks is decoded only once it's complete.
#[derive(Default)]
struct SseBuffer {
    pending: Vec<u8>,
}

impl SseBuffer {
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        // CR only appears in SSE line endings (JSON escapes it), so dropping it turns CRLF into LF.
        self.pending.extend(chunk.iter().filter(|&&b| b != b'\r'));
        let mut events = Vec::new();
        while let Some(end) = self.pending.windows(2).position(|w| w == b"\n\n") {
            let block: Vec<u8> = self.pending.drain(..end + 2).collect();
            let block = String::from_utf8_lossy(&block);
            let data: Vec<&str> = block
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(|d| d.strip_prefix(' ').unwrap_or(d))
                .collect();
            if !data.is_empty() {
                events.push(data.join("\n"));
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::SseBuffer;

    #[test]
    fn sse_events_survive_split_characters_and_crlf() {
        let event = "data: {\"text\":\"héllo ✓\"}\r\n\r\ndata: {\"n\":2}\n\n".as_bytes();
        let split = event.iter().position(|&b| b == 0xC3).unwrap() + 1; // Inside "é".
        let mut buffer = SseBuffer::default();
        assert!(buffer.push(&event[..split]).is_empty());
        assert_eq!(
            buffer.push(&event[split..]),
            ["{\"text\":\"héllo ✓\"}", "{\"n\":2}"]
        );
    }
}
