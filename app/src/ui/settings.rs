//! Settings panel: which backend, LLM provider and tools are active, plus the Gemini API key
//! and the GitHub token.
//!
//! The provider and model are changed in `agent/.env` (see DEVELOPMENT.md). Secrets are
//! write-only: the app hands them to the backend, which stores them in the OS keychain, and
//! only ever learns whether each is set. The secret sections are built by `ChatView`, which
//! owns their inputs and actions.

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::*;

use crate::backend::protocol::{SettingsResult, ToolEffect};

/// The secret sections, rendered by `ChatView`.
pub struct SecretInputs {
    pub gemini_key: AnyElement,
    pub github_token: AnyElement,
}

pub fn render_settings(
    settings: Option<&SettingsResult>,
    server: Option<&SharedString>,
    secrets: SecretInputs,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    let Some(settings) = settings else {
        return div()
            .p_4()
            .text_sm()
            .text_color(theme.muted_foreground)
            .child("Loading settings from the backend…")
            .into_any_element();
    };

    let row = |label: &'static str, value: Option<&str>| {
        div()
            .flex()
            .gap_4()
            .py_1()
            .child(
                div()
                    .w(px(160.))
                    .text_color(theme.muted_foreground)
                    .child(label),
            )
            .child(div().child(value.unwrap_or("—").to_owned()))
    };
    let heading = |text: &'static str| {
        div()
            .pt_4()
            .pb_1()
            .text_sm()
            .font_weight(FontWeight::SEMIBOLD)
            .child(text)
    };

    let mut tools = div().flex().flex_col().gap_2();
    for tool in &settings.tools {
        let (badge, color) = match tool.effect {
            ToolEffect::Read => ("read", theme.muted_foreground),
            ToolEffect::Write => ("write · asks for approval", theme.warning),
        };
        tools = tools.child(
            div()
                .flex()
                .flex_col()
                .gap_1()
                .px_3()
                .py_2()
                .rounded_md()
                .border_1()
                .border_color(theme.border)
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .child(
                            div()
                                .font_family(theme.mono_font_family.clone())
                                .child(tool.name.clone()),
                        )
                        .child(div().text_xs().text_color(color).child(badge)),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(tool.description.clone()),
                ),
        );
    }

    div()
        .id("settings")
        .size_full()
        .overflow_y_scroll()
        .px_6()
        .py_4()
        .text_sm()
        .child(heading("Backend"))
        .child(row("Server", server.map(|s| s.as_ref())))
        .child(heading("Language model"))
        .child(row("Provider", Some(&settings.llm_provider)))
        .child(row("Model", settings.llm_model_id.as_deref()))
        .child(
            div()
                .pt_1()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(
                    "Change the provider and model in agent/.env and restart the app \
                     (see DEVELOPMENT.md).",
                ),
        )
        .child(heading("Gemini API key"))
        .child(secrets.gemini_key)
        .child(heading("GitHub"))
        .child(secrets.github_token)
        .child(heading("Tools"))
        .child(tools)
        .into_any_element()
}
