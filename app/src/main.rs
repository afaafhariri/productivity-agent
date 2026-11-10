//! Desktop frontend for the Personal Productivity Agent.
//!
//! The UI stays thin: it renders chat, tool calls and confirmations, and talks to the
//! Python backend in `../agent` over stdio. No secrets or agent logic live here.

mod backend;
mod ui;

use gpui_kit::*;

use crate::backend::BackendCommand;
use crate::ui::chat::ChatView;

const APP_NAME: &str = "Personal Productivity Agent";
const APP_ID: &str = "dev.afaafhariri.personal-productivity-agent";

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
            gpui_kit::open_window(options, cx, |window, cx| {
                cx.new(|cx| ChatView::new(BackendCommand::dev(), window, cx))
            })
            .expect("failed to open the main window");
            cx.activate(true);
        });
}
