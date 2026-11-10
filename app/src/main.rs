//! Desktop frontend for the Personal Productivity Agent.
//!
//! The UI stays thin: it renders chat, tool calls and confirmations, and talks to the
//! Python backend in `../agent` over stdio. No secrets or agent logic live here.

// Used by the chat view, which lands in the next commit.
#[allow(dead_code, unused_imports)]
mod backend;

use gpui_kit::*;

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
            .child(div().text_xl().child(APP_NAME))
            .child(div().text_sm().child(self.status.clone()))
    }
}

fn main() {
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(|cx: &mut App| {
            gpui_kit::init(cx);

            // Quit when the last window closes, on every platform, until a tray mode exists.
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();

            let bounds = Bounds::centered(None, size(px(900.0), px(670.0)), cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(APP_NAME.into()),
                    ..Default::default()
                }),
                app_id: Some(APP_ID.to_owned()),
                ..Default::default()
            };
            gpui_kit::open_window(options, cx, |_, cx| {
                cx.new(|_| RootView {
                    status: "Scaffold: backend not connected yet".into(),
                })
            })
            .expect("failed to open the main window");
            cx.activate(true);
        });
}
