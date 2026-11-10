//! Chat state, kept free of GPUI so it can be unit-tested.

use serde_json::Value;

use crate::backend::protocol::{DoneReason, RunEvent, RunEventParams};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ToolStatus {
    Running,
    AwaitingApproval { description: String },
    Finished { result: Value },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallView {
    pub id: String,
    pub name: String,
    pub input: Value,
    pub status: ToolStatus,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatMessage {
    pub role: Role,
    pub text: String,
    pub tools: Vec<ToolCallView>,
    pub error: Option<String>,
    pub ended: Option<DoneReason>,
}

impl ChatMessage {
    fn new(role: Role, text: impl Into<String>) -> Self {
        Self {
            role,
            text: text.into(),
            tools: Vec::new(),
            error: None,
            ended: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum RunSlot {
    Idle,
    /// `run.start` was sent; its response and first events may arrive in either order.
    Starting,
    Running(String),
}

#[derive(Debug)]
pub struct Transcript {
    messages: Vec<ChatMessage>,
    run: RunSlot,
}

impl Default for Transcript {
    fn default() -> Self {
        Self {
            messages: Vec::new(),
            run: RunSlot::Idle,
        }
    }
}

impl Transcript {
    pub fn messages(&self) -> &[ChatMessage] {
        &self.messages
    }

    pub fn is_busy(&self) -> bool {
        self.run != RunSlot::Idle
    }

    pub fn active_run_id(&self) -> Option<&str> {
        match &self.run {
            RunSlot::Running(id) => Some(id),
            _ => None,
        }
    }

    /// Adds the user's message and an empty assistant reply. Returns the trimmed text to send,
    /// or None if it is empty or a run is already in progress.
    pub fn begin_turn(&mut self, text: &str) -> Option<String> {
        let text = text.trim();
        if text.is_empty() || self.is_busy() {
            return None;
        }
        self.messages.push(ChatMessage::new(Role::User, text));
        self.messages.push(ChatMessage::new(Role::Assistant, ""));
        self.run = RunSlot::Starting;
        Some(text.to_owned())
    }

    pub fn run_started(&mut self, run_id: String) {
        if self.run == RunSlot::Starting {
            self.run = RunSlot::Running(run_id);
        }
    }

    pub fn run_failed_to_start(&mut self, message: String) {
        if self.run == RunSlot::Starting {
            self.fail(message);
        }
    }

    pub fn backend_exited(&mut self) {
        if self.is_busy() {
            self.fail("The backend stopped unexpectedly.".into());
        }
    }

    /// Applies a backend event. Events for other runs are ignored. Returns whether anything
    /// changed.
    pub fn apply(&mut self, params: &RunEventParams) -> bool {
        match &self.run {
            RunSlot::Running(id) if *id == params.run_id => {}
            RunSlot::Starting => self.run = RunSlot::Running(params.run_id.clone()),
            _ => return false,
        }
        let Some(reply) = self.current_reply() else {
            return false;
        };
        match &params.event {
            RunEvent::TextDelta { text } => reply.text.push_str(text),
            RunEvent::ToolCall {
                tool_call_id,
                tool_name,
                input,
            } => reply.tools.push(ToolCallView {
                id: tool_call_id.clone(),
                name: tool_name.clone(),
                input: input.clone(),
                status: ToolStatus::Running,
            }),
            RunEvent::ConfirmationRequest {
                tool_call_id,
                description,
                ..
            } => {
                if let Some(tool) = reply.tools.iter_mut().find(|t| t.id == *tool_call_id) {
                    tool.status = ToolStatus::AwaitingApproval {
                        description: description.clone(),
                    };
                }
            }
            RunEvent::ToolResult {
                tool_call_id,
                result,
                ..
            } => {
                if let Some(tool) = reply.tools.iter_mut().find(|t| t.id == *tool_call_id) {
                    tool.status = ToolStatus::Finished {
                        result: result.clone(),
                    };
                }
            }
            RunEvent::Done { reason } => {
                reply.ended = Some(*reason);
                self.run = RunSlot::Idle;
            }
            RunEvent::Error { message } => {
                reply.error = Some(message.clone());
                self.run = RunSlot::Idle;
            }
        }
        true
    }

    fn current_reply(&mut self) -> Option<&mut ChatMessage> {
        self.messages
            .last_mut()
            .filter(|m| m.role == Role::Assistant)
    }

    fn fail(&mut self, message: String) {
        if let Some(reply) = self.current_reply() {
            reply.error = Some(message);
        }
        self.run = RunSlot::Idle;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(run_id: &str, event: RunEvent) -> RunEventParams {
        RunEventParams {
            run_id: run_id.into(),
            event,
        }
    }

    fn delta(text: &str) -> RunEvent {
        RunEvent::TextDelta { text: text.into() }
    }

    #[test]
    fn ignores_empty_input_and_input_while_busy() {
        let mut t = Transcript::default();
        assert_eq!(t.begin_turn("   "), None);
        assert_eq!(t.begin_turn(" hi "), Some("hi".into()));
        assert_eq!(t.begin_turn("again"), None);
        assert_eq!(t.messages().len(), 2);
        assert_eq!(t.messages()[0].text, "hi");
    }

    #[test]
    fn streams_text_and_finishes() {
        let mut t = Transcript::default();
        t.begin_turn("hi");
        t.run_started("r1".into());
        assert!(t.apply(&event("r1", delta("Hel"))));
        assert!(t.apply(&event("r1", delta("lo"))));
        assert!(t.apply(&event(
            "r1",
            RunEvent::Done {
                reason: DoneReason::Stop
            }
        )));
        let reply = &t.messages()[1];
        assert_eq!(reply.text, "Hello");
        assert_eq!(reply.ended, Some(DoneReason::Stop));
        assert!(!t.is_busy());
    }

    #[test]
    fn adopts_the_run_when_events_beat_the_start_response() {
        let mut t = Transcript::default();
        t.begin_turn("hi");
        assert!(t.apply(&event("r1", delta("x"))));
        t.run_started("r1".into());
        assert_eq!(t.active_run_id(), Some("r1"));
        assert!(!t.apply(&event("other", delta("y"))));
        assert_eq!(t.messages()[1].text, "x");
    }

    #[test]
    fn tracks_tool_calls_through_approval_and_result() {
        let mut t = Transcript::default();
        t.begin_turn("send it");
        t.run_started("r1".into());
        t.apply(&event(
            "r1",
            RunEvent::ToolCall {
                tool_call_id: "c1".into(),
                tool_name: "email_send".into(),
                input: json!({"to": "a@b.c"}),
            },
        ));
        t.apply(&event(
            "r1",
            RunEvent::ConfirmationRequest {
                tool_call_id: "c1".into(),
                tool_name: "email_send".into(),
                description: "Sends an email.".into(),
                input: json!({"to": "a@b.c"}),
            },
        ));
        assert!(matches!(
            t.messages()[1].tools[0].status,
            ToolStatus::AwaitingApproval { .. }
        ));
        t.apply(&event(
            "r1",
            RunEvent::ToolResult {
                tool_call_id: "c1".into(),
                tool_name: "email_send".into(),
                result: json!({"sent": true}),
            },
        ));
        assert_eq!(
            t.messages()[1].tools[0].status,
            ToolStatus::Finished {
                result: json!({"sent": true})
            }
        );
    }

    #[test]
    fn errors_and_backend_exit_end_the_run() {
        let mut t = Transcript::default();
        t.begin_turn("a");
        t.run_started("r1".into());
        t.apply(&event(
            "r1",
            RunEvent::Error {
                message: "boom".into(),
            },
        ));
        assert_eq!(t.messages()[1].error.as_deref(), Some("boom"));
        assert!(!t.is_busy());

        t.begin_turn("b");
        t.backend_exited();
        assert!(t.messages()[3].error.is_some());
        assert!(!t.is_busy());

        t.begin_turn("c");
        t.run_failed_to_start("nope".into());
        assert_eq!(t.messages()[5].error.as_deref(), Some("nope"));
        assert!(!t.is_busy());
    }
}
