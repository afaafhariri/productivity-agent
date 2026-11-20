//! Desktop frontend for the Personal Productivity Agent.
//!
//! The UI stays thin: it renders chat, tool calls and approvals. The agent itself (the
//! `agent-core` crate) runs in-process on its own runtime; see `backend`.

mod assets;
mod backend;
mod ui;

use gpui_kit::*;

use crate::assets::AppAssets;
use crate::backend::BackendConfig;
use crate::ui::chat::ChatView;

const APP_NAME: &str = "Personal Productivity Agent";
const APP_ID: &str = "dev.afaafhariri.personal-productivity-agent";

fn main() {
    // A `.env` file (in this directory or a parent) is a dev convenience for non-secret
    // settings such as LLM_PROVIDER. Release builds only read the real environment.
    #[cfg(debug_assertions)]
    let _ = dotenvy::dotenv();
    init_logging();
    let config = BackendConfig::from_env();

    gpui_kit::application()
        .with_assets(AppAssets)
        .run(|cx: &mut App| {
            gpui_kit::init(cx);
            ui::theme::install(cx);

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
                cx.new(|cx| ChatView::new(config, window, cx))
            })
            .expect("failed to open the main window");
            cx.activate(true);
        });
}

/// Logs go to stderr. `RUST_LOG` (e.g. `debug`, `agent_core=debug`) overrides the default.
fn init_logging() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}
