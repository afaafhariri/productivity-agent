//! Deterministic models with no network: the default provider in dev and the one every test uses.

use std::sync::Mutex;
use std::time::Duration;

use futures::StreamExt;
use serde_json::{Value, json};

use super::{
    FinishReason, LanguageModel, Message, ModelError, ModelPart, ModelRequest, PartStream, ToolCall,
};

type Turn = Vec<ModelPart>;
type Respond = dyn Fn(&ModelRequest) -> Result<Turn, ModelError> + Send + Sync;

pub struct MockModel {
    respond: Box<Respond>,
    delay: Duration,
    requests: Mutex<Vec<ModelRequest>>,
}

impl MockModel {
    pub fn new(
        respond: impl Fn(&ModelRequest) -> Result<Turn, ModelError> + Send + Sync + 'static,
        delay: Duration,
    ) -> Self {
        Self {
            respond: Box::new(respond),
            delay,
            requests: Mutex::default(),
        }
    }

    /// Plays `turns` in order, one per model call.
    pub fn scripted(turns: Vec<Turn>) -> Self {
        let remaining = Mutex::new(turns.into_iter());
        Self::new(
            move |_| {
                remaining
                    .lock()
                    .unwrap()
                    .next()
                    .ok_or_else(|| ModelError("MockModel script exhausted".into()))
            },
            Duration::ZERO,
        )
    }

    /// Replies with the last user message, word by word, so streaming is visible.
    pub fn echo(delay: Duration) -> Self {
        Self::new(
            |request| {
                Ok(words(&format!(
                    "(mock) You said: {}",
                    last_user_text(request)
                )))
            },
            delay,
        )
    }

    /// Echo, plus keyword-triggered tool calls so the tool and approval flows can be tried
    /// with no cloud account: mention pull requests, unread email, or sending.
    pub fn demo(delay: Duration) -> Self {
        let calls = Mutex::new(0_u32);
        Self::new(
            move |request| {
                if let Some(Message::ToolResult {
                    tool_name, content, ..
                }) = request.messages.last()
                {
                    return Ok(words(&summarize(tool_name, content)));
                }
                let text = last_user_text(request);
                let available: Vec<&str> = request.tools.iter().map(|t| t.name).collect();
                let Some((name, arguments)) = pick_tool(&text, &available) else {
                    return Ok(words(&format!("(mock) You said: {text}")));
                };
                let mut n = calls.lock().unwrap();
                *n += 1;
                Ok(vec![
                    ModelPart::ToolCall(ToolCall {
                        id: format!("mock-call-{n}"),
                        name: name.into(),
                        arguments,
                    }),
                    ModelPart::Finish(FinishReason::ToolCalls),
                ])
            },
            delay,
        )
    }

    /// Every request this model received, in order. For tests.
    pub fn requests(&self) -> Vec<ModelRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl LanguageModel for MockModel {
    fn stream(&self, request: ModelRequest) -> PartStream {
        let turn = (self.respond)(&request);
        self.requests.lock().unwrap().push(request);
        let parts = match turn {
            Ok(parts) => parts.into_iter().map(Ok).collect(),
            Err(error) => vec![Err(error)],
        };
        let delay = self.delay;
        futures::stream::iter(parts)
            .then(move |part| async move {
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                part
            })
            .boxed()
    }
}

fn last_user_text(request: &ModelRequest) -> String {
    request
        .messages
        .iter()
        .rev()
        .find_map(|m| match m {
            Message::User { text } => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

fn words(text: &str) -> Turn {
    let mut parts: Turn = text
        .split(' ')
        .enumerate()
        .map(|(i, w)| ModelPart::TextDelta(if i == 0 { w.into() } else { format!(" {w}") }))
        .collect();
    parts.push(ModelPart::Finish(FinishReason::Stop));
    parts
}

fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn pick_tool(text: &str, available: &[&str]) -> Option<(&'static str, Value)> {
    let words = tokens(text);
    let has = |options: &[&str]| words.iter().any(|w| options.contains(&w.as_str()));
    let follows = |first: &str, next: &[&str]| {
        words
            .windows(2)
            .any(|p| p[0] == first && next.contains(&p[1].as_str()))
    };

    if available.contains(&"gmail_send_draft")
        && (has(&["send"]) || follows("email", &["him", "her", "them"]))
    {
        return Some((
            "gmail_send_draft",
            json!({"to": "teammate@example.com", "subject": "Quick update", "body": text}),
        ));
    }
    if available.contains(&"github_list_pull_requests")
        && (has(&["pr", "prs"]) || follows("pull", &["request", "requests"]))
    {
        return Some((
            "github_list_pull_requests",
            json!({"filter": "review_requested"}),
        ));
    }
    if available.contains(&"gmail_list_unread")
        && has(&["unread", "inbox", "email", "emails", "mail"])
    {
        return Some(("gmail_list_unread", json!({"limit": 5})));
    }
    None
}

fn summarize(tool_name: &str, content: &Value) -> String {
    let result = content.get("untrusted_content").unwrap_or(content);
    match result["status"].as_str() {
        Some("rejected") => return "(mock) OK, I did not send it.".into(),
        Some("cancelled") => return "(mock) Stopped.".into(),
        _ => {}
    }
    let preview = result.to_string();
    let preview = if preview.chars().count() > 300 {
        format!("{}…", preview.chars().take(300).collect::<String>())
    } else {
        preview
    };
    format!("(mock) {tool_name} returned: {preview}")
}
