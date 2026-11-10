//! Desktop frontend for the Personal Productivity Agent.
//!
//! The UI stays thin: it renders chat, tool calls and confirmations, and talks to the
//! Python backend in `../agent` over stdio. No secrets or agent logic live here.

use gpui::{
    App, Application, Bounds, Context, SharedString, TitlebarOptions, Window, WindowBounds,
    WindowOptions, div, prelude::*, px, rgb, size,
};

const APP_NAME: &str = "Personal Productivity Agent";
const APP_ID: &str = "dev.afaafhariri.personal-productivity-agent";

struct RootView {
    status: SharedString,
}

impl Render for RootView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .gap_2()
            .justify_center()
            .items_center()
            .bg(rgb(0x09090b))
            .text_color(rgb(0xf4f4f5))
            .child(div().text_xl().child(APP_NAME))
            .child(
                div()
                    .text_sm()
                    .text_color(rgb(0xa1a1aa))
                    .child(self.status.clone()),
            )
    }
}

fn main() {
    Application::new().run(|cx: &mut App| {
        // Quit when the last window closes, on every platform, until a tray mode exists.
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        let bounds = Bounds::centered(None, size(px(900.0), px(670.0)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(APP_NAME.into()),
                    ..Default::default()
                }),
                app_id: Some(APP_ID.to_owned()),
                ..Default::default()
            },
            |_, cx| {
                cx.new(|_| RootView {
                    status: "Scaffold: backend not connected yet".into(),
                })
            },
        )
        .expect("failed to open the main window");
        cx.activate(true);
    });
}
