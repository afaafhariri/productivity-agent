# Personal Productivity Agent

[![CI](https://github.com/afaafhariri/productivity-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/afaafhariri/productivity-agent/actions/workflows/ci.yml)

A local-first, cross-platform desktop agent for developers. It chats with you, reasons with an LLM,
and calls tools that read from (and, only with your explicit approval, act on) GitHub, Google
Workspace, Slack and cloud consoles.

## Layout

A Cargo workspace, all Rust:

| Folder  | What                                                                                     |
|---------|------------------------------------------------------------------------------------------|
| `app/`  | Desktop UI: chat, tool-call cards, inline approval cards, settings. [GPUI Kit](https://github.com/longbridge/gpui-kit) (GPUI + components) |
| `core/` | The agent (`agent-core`): agent loop, LLM providers, tool registry with the approval gate, integrations, service |

The app runs the agent in-process on its own async runtime and ships as one binary. The agent
core doesn't depend on the UI crate, so it could later run behind another front end unchanged.
Credentials live in the OS keychain and are only ever sent to the service they belong to.

Setup, running with the offline demo model or with Gemini (a Gemini API key, stored in your OS
keychain), tests and troubleshooting are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Prerequisites

- Rust (stable, via [rustup](https://rustup.rs))
- macOS: Xcode selected (`xcode-select -p` → `/Applications/Xcode.app/...`) with the Metal toolchain
  (`xcodebuild -downloadComponent MetalToolchain`); GPUI compiles Metal shaders at build time.
- Linux: GPUI's system libraries (see `.github/workflows/ci.yml` for the Debian/Ubuntu list).

## Commands

From the repository root:

```bash
cargo run -p personal-productivity-agent    # the app
cargo test --workspace                      # core tests + headless UI tests (no network)
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

### Environment variables (dev)

| Variable                     | Effect                                                         |
|------------------------------|----------------------------------------------------------------|
| `LLM_PROVIDER`               | `mock` (default, offline demo) or `gemini`                     |
| `LLM_MODEL_ID`               | Gemini model ID; required with `LLM_PROVIDER=gemini`           |
| `PRODUCTIVITY_AGENT_SECRETS` | `memory` keeps keys in memory only instead of the OS keychain  |
| `RUST_LOG`                   | Log detail on stderr, e.g. `debug` or `agent_core=debug`       |

Debug builds also read a `.env` file in the current directory or a parent (see `.env.example`).
