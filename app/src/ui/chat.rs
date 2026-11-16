//! The chat window: transcript, composer, and the connection to the backend.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use futures::channel::mpsc::UnboundedReceiver;
use gpui_kit::component::ActiveTheme as _;
use gpui_kit::component::Disableable as _;
use gpui_kit::component::Sizable as _;
use gpui_kit::component::bubble::{Bubble, BubbleVariant};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::message::MessageAlignment;
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::text::TextView;
use gpui_kit::*;

use crate::backend::protocol::{DoneReason, PROTOCOL_VERSION, SettingsResult};
use crate::backend::{BackendClient, BackendCommand, ServerEvent};
use crate::ui::settings::render_settings;
use crate::ui::transcript::{ChatMessage, Role, ToolCallView, ToolStatus, Transcript};

/// Longest tool result shown in a card; the full result goes to the model, not the UI.
const RESULT_PREVIEW_CHARS: usize = 600;

enum Connection {
    Connecting,
    Ready,
    Failed(SharedString),
}

pub struct ChatView {
    backend: Option<Arc<BackendClient>>,
    connection: Connection,
    conversation_id: String,
    transcript: Transcript,
    settings: Option<SettingsResult>,
    server: Option<SharedString>,
    show_settings: bool,
    input: Entity<InputState>,
    scroller: Entity<MessageScrollerState>,
    _subscriptions: Vec<Subscription>,
    _tasks: Vec<Task<()>>,
}

impl ChatView {
    pub fn new(command: BackendCommand, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            let mut state = InputState::new(window, cx);
            state.set_placeholder("Ask about your PRs, mail, calendar…", window, cx);
            state
        });
        let scroller = cx.new(|cx| MessageScrollerState::new(0, cx));
        let subscriptions =
            vec![
                cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| {
                    if let InputEvent::PressEnter { shift: false, .. } = event {
                        this.submit(window, cx);
                    }
                }),
            ];

        let mut view = Self {
            backend: None,
            connection: Connection::Connecting,
            conversation_id: new_conversation_id(),
            transcript: Transcript::default(),
            settings: None,
            server: None,
            show_settings: false,
            input,
            scroller,
            _subscriptions: subscriptions,
            _tasks: Vec::new(),
        };
        view.connect(&command, cx);
        view
    }

    fn connect(&mut self, command: &BackendCommand, cx: &mut Context<Self>) {
        let (client, events) = match BackendClient::spawn(command) {
            Ok(spawned) => spawned,
            Err(error) => {
                self.connection = Connection::Failed(format!("{error:#}").into());
                return;
            }
        };
        let client = Arc::new(client);
        self.backend = Some(client.clone());

        self._tasks.push(cx.spawn(async move |this, cx| {
            let outcome = client.initialize().await;
            let ready = this.update(cx, |this, cx| {
                this.connection = match outcome {
                    Ok(info) if info.protocol_version == PROTOCOL_VERSION => {
                        this.server = Some(
                            format!(
                                "{} {} (protocol {})",
                                info.server_name, info.server_version, info.protocol_version
                            )
                            .into(),
                        );
                        Connection::Ready
                    }
                    Ok(info) => Connection::Failed(
                        format!(
                            "protocol version {} is not supported (expected {PROTOCOL_VERSION})",
                            info.protocol_version
                        )
                        .into(),
                    ),
                    Err(error) => Connection::Failed(format!("{error:#}").into()),
                };
                cx.notify();
                matches!(this.connection, Connection::Ready)
            });
            if !matches!(ready, Ok(true)) {
                return;
            }
            match client.settings().await {
                Ok(settings) => {
                    let _ = this.update(cx, |this, cx| {
                        this.settings = Some(settings);
                        cx.notify();
                    });
                }
                Err(error) => eprintln!("failed to load settings: {error:#}"),
            }
        }));
        self._tasks
            .push(cx.spawn(async move |this, cx| pump_events(this, events, cx).await));
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Connection::Ready, Some(backend)) = (&self.connection, self.backend.clone()) else {
            return;
        };
        let draft = self.input.read(cx).value();
        let Some(text) = self.transcript.begin_turn(&draft) else {
            return;
        };
        self.input
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.sync_rows(cx);

        let conversation_id = self.conversation_id.clone();
        self._tasks.push(cx.spawn(async move |this, cx| {
            let outcome = backend.start_run(&conversation_id, &text).await;
            let _ = this.update(cx, |this, cx| {
                match outcome {
                    Ok(run_id) => this.transcript.run_started(run_id),
                    Err(error) => this.transcript.run_failed_to_start(format!("{error:#}")),
                }
                this.refresh_last_row(cx);
            });
        }));
    }

    fn toggle_settings(&mut self, cx: &mut Context<Self>) {
        self.show_settings = !self.show_settings;
        cx.notify();
    }

    fn stop(&mut self, cx: &mut Context<Self>) {
        let (Some(backend), Some(run_id)) = (
            self.backend.clone(),
            self.transcript.active_run_id().map(str::to_owned),
        ) else {
            return;
        };
        self._tasks.push(cx.spawn(async move |_, _| {
            if let Err(error) = backend.cancel_run(&run_id).await {
                eprintln!("failed to cancel run {run_id}: {error:#}");
            }
        }));
    }

    /// Sends the user's approve/reject answer for a pending write tool. Only an explicit
    /// click on the approval card calls this; nothing approves automatically.
    fn answer(&mut self, tool_call_id: &str, approved: bool, cx: &mut Context<Self>) {
        let (Some(backend), Some(run_id)) = (
            self.backend.clone(),
            self.transcript.active_run_id().map(str::to_owned),
        ) else {
            return;
        };
        if !self.transcript.answer_approval(tool_call_id, approved) {
            return;
        }
        self.refresh_last_row(cx);

        let tool_call_id = tool_call_id.to_owned();
        self._tasks.push(cx.spawn(async move |this, cx| {
            let reason = (!approved).then_some("The user rejected this action in the app.");
            let outcome = backend
                .respond_confirmation(&run_id, &tool_call_id, approved, reason)
                .await;
            if let Err(error) = outcome {
                let _ = this.update(cx, |this, cx| {
                    this.transcript
                        .answer_failed(format!("Could not send your answer: {error:#}"));
                    this.refresh_last_row(cx);
                });
            }
        }));
    }

    fn on_server_event(&mut self, event: ServerEvent, cx: &mut Context<Self>) {
        match event {
            ServerEvent::Run(params) => {
                if self.transcript.apply(&params) {
                    self.refresh_last_row(cx);
                }
            }
            ServerEvent::Exited => {
                self.transcript.backend_exited();
                self.connection = Connection::Failed("The backend stopped.".into());
                self.backend = None;
                self.refresh_last_row(cx);
            }
        }
    }

    /// Makes the list's row count match the transcript (new rows are appended).
    fn sync_rows(&mut self, cx: &mut Context<Self>) {
        let count = self.transcript.messages().len();
        self.scroller.update(cx, |scroller, cx| {
            let known = scroller.item_count();
            if count > known {
                scroller.append(count - known, cx);
            }
        });
        cx.notify();
    }

    /// The streaming reply changes height as text arrives.
    fn refresh_last_row(&mut self, cx: &mut Context<Self>) {
        self.sync_rows(cx);
        let count = self.transcript.messages().len();
        if count > 0 {
            self.scroller.update(cx, |scroller, cx| {
                scroller.remeasure_items(count - 1..count, cx);
            });
        }
        cx.notify();
    }

    fn render_status(&self, cx: &App) -> Option<AnyElement> {
        let (text, color) = match &self.connection {
            Connection::Ready => return None,
            Connection::Connecting => ("Starting the backend…".into(), cx.theme().muted_foreground),
            Connection::Failed(message) => (
                SharedString::from(format!("Backend unavailable: {message}")),
                cx.theme().danger,
            ),
        };
        Some(
            div()
                .px_4()
                .py_2()
                .text_sm()
                .text_color(color)
                .child(text)
                .into_any_element(),
        )
    }
}

async fn pump_events(
    this: WeakEntity<ChatView>,
    mut events: UnboundedReceiver<ServerEvent>,
    cx: &mut AsyncApp,
) {
    while let Some(event) = events.next().await {
        if this
            .update(cx, |this, cx| this.on_server_event(event, cx))
            .is_err()
        {
            break;
        }
    }
}

fn new_conversation_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("conv-{nanos}")
}

impl Render for ChatView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity();
        let busy = self.transcript.is_busy();
        let ready = matches!(self.connection, Connection::Ready);

        let messages = MessageScroller::new(
            "transcript",
            self.scroller.clone(),
            move |ix, _, cx| match view.read(cx).transcript.messages().get(ix) {
                Some(message) => render_message(&view, ix, message, cx).into_any_element(),
                None => div().into_any_element(),
            },
        );

        let action = if busy {
            Button::new("stop")
                .danger()
                .label("Stop")
                .on_click(cx.listener(|this, _, _, cx| this.stop(cx)))
        } else {
            Button::new("send")
                .primary()
                .label("Send")
                .disabled(!ready)
                .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx)))
        };

        let header =
            div()
                .flex()
                .items_center()
                .justify_between()
                .px_4()
                .py_2()
                .border_b_1()
                .border_color(cx.theme().border)
                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(
                    if self.show_settings {
                        "Settings"
                    } else {
                        "Chat"
                    },
                ))
                .child(
                    Button::new("toggle-settings")
                        .ghost()
                        .small()
                        .label(if self.show_settings {
                            "Back to chat"
                        } else {
                            "Settings"
                        })
                        .on_click(cx.listener(|this, _, _, cx| this.toggle_settings(cx))),
                );

        let root = div()
            .size_full()
            .flex()
            .flex_col()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(header)
            .children(self.render_status(cx));

        if self.show_settings {
            return root.child(div().flex_1().min_h_0().child(render_settings(
                self.settings.as_ref(),
                self.server.as_ref(),
                cx,
            )));
        }

        root.child(div().flex_1().min_h_0().child(messages)).child(
            div()
                .flex()
                .gap_2()
                .p_3()
                .border_t_1()
                .border_color(cx.theme().border)
                .child(
                    div()
                        .flex_1()
                        .child(Input::new(&self.input).disabled(!ready)),
                )
                .child(action),
        )
    }
}

fn render_message(
    view: &Entity<ChatView>,
    ix: usize,
    message: &ChatMessage,
    cx: &App,
) -> impl IntoElement {
    let muted = cx.theme().muted_foreground;
    let body = match message.role {
        Role::User => Bubble::new()
            .alignment(MessageAlignment::End)
            .child(message.text.clone())
            .into_any_element(),
        Role::Assistant => {
            let mut column = div().flex().flex_col().gap_2().max_w(relative(0.85));
            for tool in &message.tools {
                column = column.child(render_tool(view, tool, cx));
            }
            if !message.text.is_empty() {
                column = column.child(
                    Bubble::new()
                        .with_variant(BubbleVariant::Ghost)
                        .child(TextView::markdown(("reply", ix), message.text.clone())),
                );
            } else if message.ended.is_none() && message.error.is_none() && message.tools.is_empty()
            {
                column = column.child(div().text_sm().text_color(muted).child("Thinking…"));
            }
            if message.ended == Some(DoneReason::Cancelled) {
                column = column.child(div().text_xs().text_color(muted).child("Stopped."));
            }
            if let Some(error) = &message.error {
                column = column.child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().danger)
                        .child(error.clone()),
                );
            }
            column.into_any_element()
        }
    };
    let row = div().w_full().px_4().py_2().flex();
    match message.role {
        Role::User => row.justify_end().child(body),
        Role::Assistant => row.justify_start().child(body),
    }
}

fn render_tool(view: &Entity<ChatView>, tool: &ToolCallView, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let card = div()
        .flex()
        .flex_col()
        .gap_1()
        .px_3()
        .py_2()
        .rounded_md()
        .border_1()
        .text_xs();
    let code = |text: String| {
        div()
            .font_family(theme.mono_font_family.clone())
            .text_xs()
            .p_2()
            .rounded_sm()
            .bg(theme.muted)
            .child(text)
    };

    match &tool.status {
        ToolStatus::AwaitingApproval { description } => {
            let approve_view = view.clone();
            let reject_view = view.clone();
            let approve_id = tool.id.clone();
            let reject_id = tool.id.clone();
            card.border_color(theme.warning)
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(format!("Approve {}?", tool.name)),
                )
                .child(
                    div()
                        .text_color(theme.muted_foreground)
                        .child(description.clone()),
                )
                .child(div().child("It will run with exactly these arguments:"))
                .child(code(pretty(&tool.input)))
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .pt_1()
                        .child(
                            Button::new(SharedString::from(format!("reject-{}", tool.id)))
                                .label("Reject")
                                .small()
                                .on_click(move |_, _, cx| {
                                    reject_view.update(cx, |v, cx| v.answer(&reject_id, false, cx));
                                }),
                        )
                        .child(
                            Button::new(SharedString::from(format!("approve-{}", tool.id)))
                                .primary()
                                .label("Approve")
                                .small()
                                .on_click(move |_, _, cx| {
                                    approve_view
                                        .update(cx, |v, cx| v.answer(&approve_id, true, cx));
                                }),
                        ),
                )
                .into_any_element()
        }
        status => {
            let label = match status {
                ToolStatus::Running => "running…",
                ToolStatus::Answered { approved: true } => "approved, running…",
                ToolStatus::Answered { approved: false } => "rejected",
                _ => "done",
            };
            let mut card = card.border_color(theme.border).child(
                div()
                    .text_color(theme.muted_foreground)
                    .child(format!("Tool {} · {label}", tool.name)),
            );
            if let ToolStatus::Finished { result } = status {
                card = card.child(code(preview(result)));
            }
            card.into_any_element()
        }
    }
}

fn pretty(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn preview(value: &serde_json::Value) -> String {
    let text = pretty(value);
    match text.char_indices().nth(RESULT_PREVIEW_CHARS) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text,
    }
}

#[cfg(test)]
mod tests {
    //! Headless UI tests against the real Python backend (mock LLM, no network).
    use std::time::{Duration, Instant};

    // No glob imports here: gpui_kit re-exports `gpui` and `test`, which would make
    // `#[gpui::test]` (from the gpui-pre dev-dependency) ambiguous.
    use gpui_kit::{Entity, Focusable as _, TestAppContext, VisualTestContext};

    use super::{ChatView, Connection};
    use crate::backend::BackendCommand;
    use crate::backend::protocol::{DoneReason, ToolEffect};
    use crate::ui::transcript::{Role, ToolStatus};

    fn mock_backend() -> BackendCommand {
        let mut command = BackendCommand::dev();
        command.envs.push(("LLM_PROVIDER".into(), "mock".into()));
        command
    }

    /// Lets real I/O threads deliver while GPUI's test executor runs ready tasks.
    fn wait_until(
        cx: &mut VisualTestContext,
        view: &Entity<ChatView>,
        what: &str,
        mut done: impl FnMut(&ChatView) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            cx.run_until_parked();
            // Paint a frame each tick so render code (cards, previews) runs in tests too.
            cx.update(|window, cx| window.draw(cx).clear(cx));
            if cx.update(|_, cx| done(view.read(cx))) {
                return;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn open_chat(cx: &mut TestAppContext) -> (Entity<ChatView>, &mut VisualTestContext) {
        cx.executor().allow_parking();
        cx.update(gpui_kit::init);
        let (view, visual) =
            cx.add_window_view(|window, cx| ChatView::new(mock_backend(), window, cx));
        wait_until(visual, &view, "the backend handshake", |v| {
            matches!(v.connection, Connection::Ready)
        });
        (view, visual)
    }

    fn type_and_send(cx: &mut VisualTestContext, view: &Entity<ChatView>, text: &str) {
        cx.update(|window, cx| {
            let handle = view.read(cx).input.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
        });
        cx.simulate_input(text);
        cx.simulate_keystrokes("enter");
    }

    #[gpui::test]
    fn typing_and_enter_streams_a_reply(cx: &mut TestAppContext) {
        let (view, cx) = open_chat(cx);
        type_and_send(cx, &view, "hello from the UI");

        wait_until(cx, &view, "the reply to finish", |v| {
            v.transcript
                .messages()
                .get(1)
                .is_some_and(|m| m.ended.is_some())
        });
        cx.update(|_, cx| {
            let view = view.read(cx);
            let messages = view.transcript.messages();
            assert_eq!(messages[0].role, Role::User);
            assert_eq!(messages[0].text, "hello from the UI");
            assert_eq!(messages[1].text, "(mock) You said: hello from the UI");
            assert_eq!(messages[1].ended, Some(DoneReason::Stop));
            assert_eq!(
                view.input.read(cx).value(),
                "",
                "input clears after sending"
            );
            assert!(!view.transcript.is_busy());
        });
    }

    #[gpui::test]
    fn stop_cancels_a_streaming_reply(cx: &mut TestAppContext) {
        let (view, cx) = open_chat(cx);
        let long = "word ".repeat(60);
        type_and_send(cx, &view, long.trim());

        wait_until(cx, &view, "the first streamed words", |v| {
            v.transcript.active_run_id().is_some()
                && v.transcript
                    .messages()
                    .get(1)
                    .is_some_and(|m| !m.text.is_empty())
        });
        view.update(cx, |view, cx| view.stop(cx));
        wait_until(cx, &view, "the run to stop", |v| !v.transcript.is_busy());
        cx.update(|_, cx| {
            let reply = &view.read(cx).transcript.messages()[1];
            assert_eq!(reply.ended, Some(DoneReason::Cancelled));
            assert!(reply.text.len() < "(mock) You said: ".len() + long.len());
        });
    }

    /// Sends a message that makes the demo mock call the stub `gmail_send_draft` (a write
    /// tool), and waits for the approval card. Returns the pending tool call id.
    fn request_send(cx: &mut VisualTestContext, view: &Entity<ChatView>) -> String {
        type_and_send(cx, view, "send Sam the release notes");
        wait_until(cx, view, "the approval request", |v| {
            v.transcript
                .messages()
                .get(1)
                .and_then(|m| m.tools.first())
                .is_some_and(|t| matches!(t.status, ToolStatus::AwaitingApproval { .. }))
        });
        cx.update(|_, cx| {
            let tool = &view.read(cx).transcript.messages()[1].tools[0];
            assert_eq!(tool.name, "gmail_send_draft");
            assert_eq!(tool.input["to"], "teammate@example.com");
            assert_eq!(tool.input["body"], "send Sam the release notes");
            tool.id.clone()
        })
    }

    fn final_reply(cx: &mut VisualTestContext, view: &Entity<ChatView>) -> (String, ToolStatus) {
        wait_until(cx, view, "the run to finish", |v| !v.transcript.is_busy());
        cx.update(|_, cx| {
            let reply = &view.read(cx).transcript.messages()[1];
            (reply.text.clone(), reply.tools[0].status.clone())
        })
    }

    #[gpui::test]
    fn write_tool_waits_for_approval_then_runs(cx: &mut TestAppContext) {
        let (view, cx) = open_chat(cx);
        let call_id = request_send(cx, &view);

        // Nothing happens until the user answers.
        std::thread::sleep(Duration::from_millis(200));
        cx.run_until_parked();
        cx.update(|_, cx| assert!(view.read(cx).transcript.is_busy()));

        view.update(cx, |v, cx| v.answer(&call_id, true, cx));
        view.update(cx, |v, cx| v.answer(&call_id, true, cx)); // double click is ignored
        let (text, status) = final_reply(cx, &view);
        let ToolStatus::Finished { result } = status else {
            panic!("tool did not finish: {status:?}");
        };
        assert_eq!(result["status"], "sent");
        assert!(text.starts_with("(mock) gmail_send_draft returned:"));
    }

    #[gpui::test]
    fn rejected_write_tool_never_runs(cx: &mut TestAppContext) {
        let (view, cx) = open_chat(cx);
        let call_id = request_send(cx, &view);

        view.update(cx, |v, cx| v.answer(&call_id, false, cx));
        let (text, status) = final_reply(cx, &view);
        let ToolStatus::Finished { result } = status else {
            panic!("tool did not finish: {status:?}");
        };
        assert_eq!(result["status"], "rejected");
        assert_eq!(text, "(mock) OK, I did not send it.");
    }

    #[gpui::test]
    fn settings_panel_shows_backend_config_and_tools(cx: &mut TestAppContext) {
        let (view, cx) = open_chat(cx);
        wait_until(cx, &view, "settings to load", |v| v.settings.is_some());

        view.update(cx, |v, cx| v.toggle_settings(cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.update(|_, cx| {
            let view = view.read(cx);
            assert!(view.show_settings);
            let server = view.server.as_ref().expect("server version is known");
            assert!(server.starts_with("productivity-agent "));
            let settings = view.settings.as_ref().unwrap();
            assert_eq!(settings.llm_provider, "mock");
            let effects: Vec<_> = settings
                .tools
                .iter()
                .map(|t| (t.name.as_str(), t.effect))
                .collect();
            assert!(effects.contains(&("gmail_send_draft", ToolEffect::Write)));
            assert!(effects.contains(&("github_list_pull_requests", ToolEffect::Read)));
        });

        view.update(cx, |v, cx| v.toggle_settings(cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.update(|_, cx| assert!(!view.read(cx).show_settings));
    }
}
