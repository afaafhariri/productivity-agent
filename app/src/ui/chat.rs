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
use gpui_kit::component::{Icon, IconName};
use gpui_kit::*;

use crate::backend::protocol::{DoneReason, RunEventParams, SecretName, SettingsResult};
use crate::backend::{Backend, BackendConfig};
use crate::ui::settings::{SecretInputs, render_settings};
use crate::ui::theme::{accent_gradient, logo_mark, palette};
use crate::ui::transcript::{ChatMessage, Role, ToolCallView, ToolStatus, Transcript};

/// Longest tool result shown in a card; the full result goes to the model, not the UI.
const RESULT_PREVIEW_CHARS: usize = 600;

/// Width of the transcript column and the composer.
const COLUMN_WIDTH: f32 = 720.;

/// Starter prompts on the empty chat screen. The text is sent as typed.
const SUGGESTIONS: [(&str, Suggestion); 4] = [
    ("PRs waiting for my review", Suggestion::PullRequest),
    ("Issues assigned to me", Suggestion::Issue),
    ("Summarize my unread mail", Suggestion::Mail),
    ("Draft a reply", Suggestion::Draft),
];

#[derive(Clone, Copy)]
enum Suggestion {
    PullRequest,
    Issue,
    Mail,
    Draft,
}

impl Suggestion {
    fn icon(self) -> Icon {
        use gpui_kit::assets::IconName as Lucide;
        Icon::new(match self {
            Self::PullRequest => Lucide::GitPullRequest,
            Self::Issue => Lucide::CircleDot,
            Self::Mail => Lucide::Mail,
            Self::Draft => Lucide::Pencil,
        })
    }
}

enum Connection {
    Ready,
    Failed(SharedString),
}

/// Outcome of the last save/remove of a secret, shown under its field.
struct KeyMessage {
    text: SharedString,
    is_error: bool,
}

/// The write-only secrets the user can enter in Settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SecretKind {
    GeminiApiKey,
    GithubToken,
}

impl SecretKind {
    fn name(self) -> SecretName {
        match self {
            Self::GeminiApiKey => SecretName::GeminiApiKey,
            Self::GithubToken => SecretName::GithubToken,
        }
    }

    fn is_set(self, settings: &SettingsResult) -> bool {
        match self {
            Self::GeminiApiKey => settings.gemini_api_key_set,
            Self::GithubToken => settings.github_token_set,
        }
    }

    fn placeholder(self) -> &'static str {
        match self {
            Self::GeminiApiKey => "Paste your Gemini API key",
            Self::GithubToken => "Paste your GitHub personal access token",
        }
    }

    fn button_ids(self) -> (&'static str, &'static str) {
        match self {
            Self::GeminiApiKey => ("save-gemini-api-key", "remove-gemini-api-key"),
            Self::GithubToken => ("save-github-token", "remove-github-token"),
        }
    }
}

/// A masked input for one secret. Cleared as soon as the value is handed to the backend;
/// never filled back in, since the backend only reports whether a value is set.
struct SecretField {
    input: Entity<InputState>,
    saving: bool,
    message: Option<KeyMessage>,
}

impl SecretField {
    fn new(kind: SecretKind, window: &mut Window, cx: &mut App) -> Self {
        let input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).masked(true);
            state.set_placeholder(kind.placeholder(), window, cx);
            state
        });
        Self {
            input,
            saving: false,
            message: None,
        }
    }
}

pub struct ChatView {
    backend: Option<Arc<Backend>>,
    connection: Connection,
    conversation_id: String,
    transcript: Transcript,
    settings: Option<SettingsResult>,
    server: Option<SharedString>,
    show_settings: bool,
    input: Entity<InputState>,
    gemini_key: SecretField,
    github_token: SecretField,
    scroller: Entity<MessageScrollerState>,
    _subscriptions: Vec<Subscription>,
    _tasks: Vec<Task<()>>,
}

impl ChatView {
    /// `config` is `Err` when the configuration is invalid; the window then explains why.
    pub fn new(
        config: anyhow::Result<BackendConfig>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| {
            let mut state = InputState::new(window, cx);
            state.set_placeholder("Ask about your PRs, mail, calendar…", window, cx);
            state
        });
        let gemini_key = SecretField::new(SecretKind::GeminiApiKey, window, cx);
        let github_token = SecretField::new(SecretKind::GithubToken, window, cx);
        let scroller = cx.new(|cx| MessageScrollerState::new(0, cx));
        let mut subscriptions =
            vec![
                cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| {
                    if let InputEvent::PressEnter { shift: false, .. } = event {
                        this.submit(window, cx);
                    }
                }),
            ];
        for (kind, field) in [
            (SecretKind::GeminiApiKey, &gemini_key),
            (SecretKind::GithubToken, &github_token),
        ] {
            subscriptions.push(cx.subscribe_in(
                &field.input,
                window,
                move |this, _, event: &InputEvent, window, cx| {
                    if let InputEvent::PressEnter { .. } = event {
                        this.save_secret(kind, window, cx);
                    }
                },
            ));
        }

        let mut view = Self {
            backend: None,
            connection: Connection::Failed("Not started".into()),
            conversation_id: new_conversation_id(),
            transcript: Transcript::default(),
            settings: None,
            server: None,
            show_settings: false,
            input,
            gemini_key,
            github_token,
            scroller,
            _subscriptions: subscriptions,
            _tasks: Vec::new(),
        };
        view.connect(config, cx);
        view
    }

    fn connect(&mut self, config: anyhow::Result<BackendConfig>, cx: &mut Context<Self>) {
        let started = config.and_then(Backend::start);
        let (backend, events) = match started {
            Ok(started) => started,
            Err(error) => {
                tracing::error!("{error:#}");
                self.connection = Connection::Failed(format!("{error:#}").into());
                return;
            }
        };
        self.backend = Some(backend);
        self.connection = Connection::Ready;
        self.server = Some(format!("agent-core {}", Backend::version()).into());
        self.reload_settings(cx);
        self._tasks
            .push(cx.spawn(async move |this, cx| pump_events(this, events, cx).await));
    }

    fn reload_settings(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        self._tasks.push(
            cx.spawn(async move |this, cx| match backend.settings().await {
                Ok(settings) => {
                    let _ = this.update(cx, |this, cx| {
                        this.settings = Some(settings);
                        cx.notify();
                    });
                }
                Err(error) => tracing::warn!("failed to load settings: {error:#}"),
            }),
        );
    }

    fn secret(&self, kind: SecretKind) -> &SecretField {
        match kind {
            SecretKind::GeminiApiKey => &self.gemini_key,
            SecretKind::GithubToken => &self.github_token,
        }
    }

    fn secret_mut(&mut self, kind: SecretKind) -> &mut SecretField {
        match kind {
            SecretKind::GeminiApiKey => &mut self.gemini_key,
            SecretKind::GithubToken => &mut self.github_token,
        }
    }

    /// Hands the typed value to the backend (which stores it in the OS keychain) and clears
    /// the field right away, so the secret doesn't stay in the UI.
    fn save_secret(&mut self, kind: SecretKind, window: &mut Window, cx: &mut Context<Self>) {
        let (Connection::Ready, Some(backend)) = (&self.connection, self.backend.clone()) else {
            return;
        };
        let field = self.secret(kind);
        let value = field.input.read(cx).value().trim().to_owned();
        if value.is_empty() || field.saving {
            return;
        }
        field
            .input
            .clone()
            .update(cx, |input, cx| input.set_value("", window, cx));
        let field = self.secret_mut(kind);
        field.saving = true;
        field.message = None;
        cx.notify();

        self._tasks.push(cx.spawn(async move |this, cx| {
            let outcome = backend.set_secret(kind.name(), value).await;
            let _ = this.update(cx, |this, cx| {
                this.finish_secret_change(kind, outcome, "Saved to your OS keychain.", cx);
            });
        }));
    }

    fn remove_secret(&mut self, kind: SecretKind, cx: &mut Context<Self>) {
        let (Connection::Ready, Some(backend)) = (&self.connection, self.backend.clone()) else {
            return;
        };
        let field = self.secret_mut(kind);
        if field.saving {
            return;
        }
        field.saving = true;
        field.message = None;
        cx.notify();

        self._tasks.push(cx.spawn(async move |this, cx| {
            let outcome = backend.delete_secret(kind.name()).await;
            let _ = this.update(cx, |this, cx| {
                this.finish_secret_change(kind, outcome, "Removed from your OS keychain.", cx);
            });
        }));
    }

    fn finish_secret_change(
        &mut self,
        kind: SecretKind,
        outcome: anyhow::Result<()>,
        success: &'static str,
        cx: &mut Context<Self>,
    ) {
        let field = self.secret_mut(kind);
        field.saving = false;
        field.message = Some(match outcome {
            Ok(()) => KeyMessage {
                text: success.into(),
                is_error: false,
            },
            Err(error) => KeyMessage {
                text: backend_message(&error).into(),
                is_error: true,
            },
        });
        self.reload_settings(cx);
    }

    fn render_secret(&self, kind: SecretKind, ready: bool, cx: &mut Context<Self>) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        let danger = cx.theme().danger;
        let field = self.secret(kind);
        let is_set = self.settings.as_ref().is_some_and(|s| kind.is_set(s));
        let enabled = ready && !field.saving;
        let (save_id, remove_id) = kind.button_ids();

        let mut controls = div()
            .flex()
            .items_center()
            .gap_2()
            .child(
                div()
                    .flex_1()
                    .max_w(px(420.))
                    .child(Input::new(&field.input).mask_toggle().disabled(!enabled)),
            )
            .child(
                Button::new(save_id)
                    .primary()
                    .small()
                    .label(if is_set { "Replace" } else { "Save" })
                    .disabled(!enabled)
                    .on_click(
                        cx.listener(move |this, _, window, cx| this.save_secret(kind, window, cx)),
                    ),
            );
        if is_set {
            controls = controls.child(
                Button::new(remove_id)
                    .ghost()
                    .small()
                    .label("Remove")
                    .disabled(!enabled)
                    .on_click(cx.listener(move |this, _, _, cx| this.remove_secret(kind, cx))),
            );
        }

        let help = match kind {
            SecretKind::GeminiApiKey => {
                let uses_gemini = self
                    .settings
                    .as_ref()
                    .is_some_and(|s| s.llm_provider == "gemini");
                let mut help = String::from(
                    "Create a key at aistudio.google.com (Get API key). It's kept in your OS \
                     keychain; this screen never shows it again.",
                );
                if !uses_gemini {
                    help.push_str(
                        " It's used when LLM_PROVIDER=gemini is set (in .env or the environment).",
                    );
                }
                help
            }
            SecretKind::GithubToken => String::from(
                "Create a fine-grained personal access token on github.com (Settings → \
                 Developer settings → Fine-grained tokens) with read-only access to Pull \
                 requests and Issues. It's kept in your OS keychain; this screen never shows it \
                 again.",
            ),
        };

        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .gap_4()
                    .py_1()
                    .child(div().w(px(160.)).text_color(muted).child("Status"))
                    .child(if is_set {
                        "Saved in your OS keychain"
                    } else {
                        "Not set"
                    }),
            )
            .child(controls)
            .children(field.message.as_ref().map(|message| {
                div()
                    .text_xs()
                    .text_color(if message.is_error { danger } else { muted })
                    .child(message.text.clone())
            }))
            .child(div().text_xs().text_color(muted).child(help))
            .into_any_element()
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

    /// Sends one of the starter prompts from the empty chat screen.
    fn send_suggestion(&mut self, text: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        self.input
            .update(cx, |input, cx| input.set_value(text, window, cx));
        self.submit(window, cx);
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
                tracing::warn!("failed to cancel run {run_id}: {error:#}");
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

    fn on_run_event(&mut self, params: RunEventParams, cx: &mut Context<Self>) {
        if self.transcript.apply(&params) {
            self.refresh_last_row(cx);
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

    /// A banner under the top bar while the agent can't run (e.g. invalid configuration).
    fn render_status(&self, cx: &App) -> Option<AnyElement> {
        let Connection::Failed(message) = &self.connection else {
            return None;
        };
        let danger = cx.theme().danger;
        Some(
            div()
                .flex()
                .items_center()
                .gap_2()
                .px_4()
                .py_2()
                .text_sm()
                .text_color(danger)
                .bg(danger.opacity(0.1))
                .border_b_1()
                .border_color(danger.opacity(0.3))
                .child(Icon::new(IconName::TriangleAlert).small())
                .child(format!("Agent unavailable: {message}"))
                .into_any_element(),
        )
    }

    /// Connection state as a pill: dot colour plus a short mono label.
    fn render_status_pill(&self, cx: &App) -> impl IntoElement {
        let theme = cx.theme();
        let (dot, label): (Hsla, SharedString) = match &self.connection {
            Connection::Failed(_) => (theme.danger, "Not running".into()),
            Connection::Ready => {
                let label = match &self.settings {
                    Some(settings) => format!(
                        "AGENT · {} · {}",
                        settings.llm_provider,
                        settings.llm_model_id.as_deref().unwrap_or("default")
                    ),
                    None => String::from("AGENT · ready"),
                };
                (palette::cyan(), label.into())
            }
        };
        div()
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .py(px(3.))
            .rounded_full()
            .border_1()
            .border_color(theme.border)
            .bg(palette::surface_2())
            .font_family(theme.mono_font_family.clone())
            .text_xs()
            .text_color(theme.muted_foreground)
            .child(div().size(px(6.)).rounded_full().bg(dot))
            .child(label)
    }

    fn render_top_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let view_pill = div()
            .px_4()
            .py(px(3.))
            .rounded_full()
            .border_1()
            .border_color(theme.border)
            .bg(palette::surface_2())
            .text_xs()
            .font_weight(FontWeight::MEDIUM)
            .child(if self.show_settings {
                "Settings"
            } else {
                "Chat"
            });

        let toggle = if self.show_settings {
            Button::new("toggle-settings")
                .ghost()
                .small()
                .icon(IconName::ArrowLeft)
                .label("Back to chat")
        } else {
            Button::new("toggle-settings")
                .ghost()
                .small()
                .icon(IconName::Settings)
                .tooltip("Settings")
        }
        .on_click(cx.listener(|this, _, _, cx| this.toggle_settings(cx)));

        let mut right = div().flex_1().flex().items_center().justify_end().gap_2();
        if !self.show_settings {
            right = right.child(self.render_status_pill(cx));
        }

        div()
            .h(px(48.))
            .flex_none()
            .flex()
            .items_center()
            .px_4()
            .bg(palette::surface_1())
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                div()
                    .flex_1()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(logo_mark(px(18.)))
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Productivity Agent"),
                    ),
            )
            .child(view_pill)
            .child(right.child(toggle))
    }

    /// First screen of a conversation: greeting plus starter prompts.
    fn render_empty_state(&self, ready: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let mut chips = div()
            .flex()
            .flex_wrap()
            .justify_center()
            .gap_2()
            .mt_8()
            .max_w(px(COLUMN_WIDTH));
        for (ix, (text, kind)) in SUGGESTIONS.into_iter().enumerate() {
            let chip = div()
                .id(("suggestion", ix))
                .flex()
                .items_center()
                .gap_2()
                .px_4()
                .py_2()
                .rounded_full()
                .border_1()
                .border_color(theme.border)
                .bg(palette::surface_1())
                .text_sm()
                .child(kind.icon().small().text_color(palette::cyan()))
                .child(text);
            chips = chips.child(if ready {
                chip.cursor_pointer()
                    .hover(|style| {
                        style
                            .bg(palette::surface_2())
                            .border_color(palette::cyan().opacity(0.4))
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.send_suggestion(text, window, cx)
                    }))
            } else {
                chip.opacity(0.5)
            });
        }

        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .px_6()
            .child(
                div()
                    .max_w(px(COLUMN_WIDTH))
                    .text_center()
                    .text_size(px(44.))
                    .line_height(relative(1.15))
                    .font_weight(FontWeight::LIGHT)
                    .child("What do you want to get done?"),
            )
            .child(
                div()
                    .mt_3()
                    .max_w(px(560.))
                    .text_center()
                    .text_color(theme.muted_foreground)
                    .child(
                        "I can read your GitHub and inbox. I'll always ask before sending or \
                         changing anything.",
                    ),
            )
            .child(chips)
    }

    /// The message box: gradient hairline, borderless input, round send / stop button.
    fn render_composer(&self, ready: bool, busy: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let action = if busy {
            Button::new("stop")
                .danger()
                .outline()
                .small()
                .icon(IconName::Square)
                .label("Stop")
                .on_click(cx.listener(|this, _, _, cx| this.stop(cx)))
                .into_any_element()
        } else {
            let send = div()
                .id("send")
                .size(px(32.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .bg(accent_gradient(135.))
                .child(
                    Icon::new(IconName::ArrowUp)
                        .small()
                        .text_color(palette::ink()),
                );
            if ready {
                send.cursor_pointer()
                    .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx)))
                    .into_any_element()
            } else {
                send.opacity(0.4).into_any_element()
            }
        };

        let frame = div()
            .w_full()
            .max_w(px(COLUMN_WIDTH))
            .p(px(1.))
            .rounded(px(14.));
        let frame = if ready {
            frame.bg(accent_gradient(90.))
        } else {
            frame.bg(theme.border)
        };

        div()
            .flex_none()
            .flex()
            .flex_col()
            .items_center()
            .px_6()
            .pt_2()
            .pb_4()
            .child(
                frame.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .pl_3()
                        .pr_2()
                        .py_2()
                        .rounded(px(13.))
                        .bg(palette::surface_1())
                        .child(
                            div()
                                .flex_1()
                                .child(Input::new(&self.input).appearance(false).disabled(!ready)),
                        )
                        .child(action),
                ),
            )
            .child(
                div()
                    .mt_2()
                    .font_family(theme.mono_font_family.clone())
                    .text_xs()
                    .text_color(palette::faint())
                    .child("Enter to send"),
            )
    }
}

async fn pump_events(
    this: WeakEntity<ChatView>,
    mut events: UnboundedReceiver<RunEventParams>,
    cx: &mut AsyncApp,
) {
    while let Some(event) = events.next().await {
        if this
            .update(cx, |this, cx| this.on_run_event(event, cx))
            .is_err()
        {
            break;
        }
    }
}

/// The agent's own message for refused requests (e.g. "That doesn't look like an API key").
fn backend_message(error: &anyhow::Error) -> String {
    format!("{error:#}")
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

        let root = div()
            .size_full()
            .flex()
            .flex_col()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(self.render_top_bar(cx))
            .children(self.render_status(cx));

        if self.show_settings {
            let secrets = SecretInputs {
                gemini_key: self.render_secret(SecretKind::GeminiApiKey, ready, cx),
                github_token: self.render_secret(SecretKind::GithubToken, ready, cx),
            };
            return root.child(div().flex_1().min_h_0().child(render_settings(
                self.settings.as_ref(),
                self.server.as_ref(),
                secrets,
                cx,
            )));
        }

        let body = if self.transcript.messages().is_empty() {
            self.render_empty_state(ready, cx).into_any_element()
        } else {
            messages.into_any_element()
        };
        root.child(div().flex_1().min_h_0().child(body))
            .child(self.render_composer(ready, busy, cx))
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
    //! Headless UI tests against the real agent core (mock LLM, in-memory secrets, no network).
    use std::time::{Duration, Instant};

    // No glob imports here: gpui_kit re-exports `gpui` and `test`, which would make
    // `#[gpui::test]` (from the gpui-pre dev-dependency) ambiguous.
    use gpui_kit::{Entity, Focusable as _, TestAppContext, VisualTestContext};

    use super::{ChatView, Connection, SecretKind};
    use crate::backend::BackendConfig;
    use crate::backend::protocol::{DoneReason, ToolEffect};
    use crate::ui::transcript::{Role, ToolStatus};

    /// The demo model, and secrets in memory so tests never touch the real keychain.
    fn mock_backend() -> anyhow::Result<BackendConfig> {
        Ok(BackendConfig::mock_in_memory())
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
    fn starter_prompt_is_sent_as_a_message(cx: &mut TestAppContext) {
        let (view, cx) = open_chat(cx);
        cx.update(|window, cx| {
            view.update(cx, |v, cx| {
                v.send_suggestion("PRs waiting for my review", window, cx)
            })
        });
        wait_until(cx, &view, "the reply to finish", |v| {
            v.transcript
                .messages()
                .get(1)
                .is_some_and(|m| m.ended.is_some())
        });
        cx.update(|_, cx| {
            let view = view.read(cx);
            assert_eq!(
                view.transcript.messages()[0].text,
                "PRs waiting for my review"
            );
            assert_eq!(view.input.read(cx).value(), "");
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
    fn settings_panel_shows_agent_config_and_tools(cx: &mut TestAppContext) {
        let (view, cx) = open_chat(cx);
        wait_until(cx, &view, "settings to load", |v| v.settings.is_some());

        view.update(cx, |v, cx| v.toggle_settings(cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.update(|_, cx| {
            let view = view.read(cx);
            assert!(view.show_settings);
            let server = view.server.as_ref().expect("server version is known");
            assert!(server.starts_with("agent-core "));
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

    fn enter_and_save(
        cx: &mut VisualTestContext,
        view: &Entity<ChatView>,
        kind: SecretKind,
        value: &str,
    ) {
        cx.update(|window, cx| {
            let input = view.read(cx).secret(kind).input.clone();
            input.update(cx, |input, cx| input.set_value(value, window, cx));
        });
        cx.update(|_, cx| {
            // Masking only changes rendering: the real text is what gets sent.
            assert_eq!(view.read(cx).secret(kind).input.read(cx).value(), value);
        });
        cx.update(|window, cx| view.update(cx, |v, cx| v.save_secret(kind, window, cx)));
        cx.update(|_, cx| {
            assert_eq!(
                view.read(cx).secret(kind).input.read(cx).value(),
                "",
                "the secret leaves the UI as soon as it is sent"
            );
        });
        wait_until(cx, view, "the secret to be saved", |v| {
            !v.secret(kind).saving
        });
    }

    fn open_settings(cx: &mut TestAppContext) -> (Entity<ChatView>, &mut VisualTestContext) {
        let (view, cx) = open_chat(cx);
        wait_until(cx, &view, "settings to load", |v| v.settings.is_some());
        view.update(cx, |v, cx| v.toggle_settings(cx));
        (view, cx)
    }

    fn last_message(view: &ChatView, kind: SecretKind) -> (String, bool) {
        let message = view
            .secret(kind)
            .message
            .as_ref()
            .expect("a message is shown");
        (message.text.to_string(), message.is_error)
    }

    #[gpui::test]
    fn api_key_is_saved_and_removed_from_settings(cx: &mut TestAppContext) {
        let kind = SecretKind::GeminiApiKey;
        let (view, cx) = open_settings(cx);
        cx.update(|_, cx| {
            assert!(!view.read(cx).settings.as_ref().unwrap().gemini_api_key_set);
        });

        enter_and_save(cx, &view, kind, "not a key");
        cx.update(|_, cx| {
            assert_eq!(
                last_message(view.read(cx), kind),
                ("That doesn't look like an API key".into(), true)
            );
        });

        enter_and_save(cx, &view, kind, "AIza-not-a-real-key");
        wait_until(cx, &view, "settings to show the key", |v| {
            v.settings.as_ref().is_some_and(|s| s.gemini_api_key_set)
        });
        cx.update(|_, cx| assert!(!last_message(view.read(cx), kind).1));

        view.update(cx, |v, cx| v.remove_secret(kind, cx));
        wait_until(cx, &view, "the key to be removed", |v| {
            !v.secret(kind).saving && v.settings.as_ref().is_some_and(|s| !s.gemini_api_key_set)
        });
    }

    #[gpui::test]
    fn github_token_is_saved_and_removed_on_its_own(cx: &mut TestAppContext) {
        let kind = SecretKind::GithubToken;
        let (view, cx) = open_settings(cx);
        cx.update(|_, cx| {
            assert!(!view.read(cx).settings.as_ref().unwrap().github_token_set);
        });

        enter_and_save(cx, &view, kind, "has spaces");
        cx.update(|_, cx| {
            assert_eq!(
                last_message(view.read(cx), kind),
                ("That doesn't look like a GitHub token".into(), true)
            );
        });

        enter_and_save(cx, &view, kind, "github_pat_not_a_real_token");
        wait_until(cx, &view, "settings to show the token", |v| {
            v.settings.as_ref().is_some_and(|s| s.github_token_set)
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.update(|_, cx| {
            let view = view.read(cx);
            let settings = view.settings.as_ref().unwrap();
            assert!(!settings.gemini_api_key_set, "the Gemini key is untouched");
            assert!(view.secret(SecretKind::GeminiApiKey).message.is_none());
            assert!(!last_message(view, kind).1);
        });

        view.update(cx, |v, cx| v.remove_secret(kind, cx));
        wait_until(cx, &view, "the token to be removed", |v| {
            !v.secret(kind).saving && v.settings.as_ref().is_some_and(|s| !s.github_token_set)
        });
    }
}
