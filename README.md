# Personal Productivity Agent

A local-first, cross-platform desktop agent for developers. It chats with you, reasons with an LLM,
and calls tools that read from (and, only with your explicit approval, act on) GitHub, Google
Workspace, Slack and cloud consoles.

## Layout

| Folder   | What                                                                 | Stack                 |
|----------|----------------------------------------------------------------------|-----------------------|
| `app/`   | Desktop UI: chat, tool-call cards, confirmation dialogs, settings    | Rust + [GPUI](https://github.com/zed-industries/zed/tree/main/crates/gpui) |
| `agent/` | Backend: agent loop, LLM providers, tool registry, integrations      | Python 3.14 + uv      |

The app starts the backend as a child process and talks to it over stdio (JSON-RPC). Credentials and
agent logic live only in the backend; the UI never sees tokens.

## Prerequisites

- Rust (stable, via [rustup](https://rustup.rs))
- [uv](https://docs.astral.sh/uv/)
- macOS: Xcode selected (`xcode-select -p` → `/Applications/Xcode.app/...`) with the Metal toolchain
  (`xcodebuild -downloadComponent MetalToolchain`); GPUI compiles Metal shaders at build time.

## Commands

```bash
# Backend
cd agent
uv sync
uv run pytest
uv run ruff check && uv run ruff format --check
uv run mypy

# App
cd app
cargo run
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```
