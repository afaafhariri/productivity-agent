# Personal Productivity Agent

[![CI](https://github.com/afaafhariri/productivity-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/afaafhariri/productivity-agent/actions/workflows/ci.yml)

A local-first, cross-platform desktop agent for developers. It chats with you, reasons with an LLM,
and calls tools that read from (and, only with your explicit approval, act on) GitHub, Google
Workspace, Slack and cloud consoles.

## Layout

One TypeScript codebase: an [Electron](https://www.electronjs.org) app built with
[electron-vite](https://electron-vite.org), React and Tailwind CSS.

| Folder          | What                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`     | The agent: tool-calling loop ([AI SDK](https://ai-sdk.dev)), Gemini, Claude and mock models, tool registry with the approval gate, integrations, service |
| `src/main/`     | Electron main process: window and hardening, validated IPC handlers, encrypted secret storage                                                            |
| `src/preload/`  | The only bridge to the UI: a small typed `window.agent` API                                                                                              |
| `src/renderer/` | The UI: chat, tool cards, inline approval cards, settings, agent panel                                                                                   |
| `src/shared/`   | The IPC contract shared by main, preload and renderer                                                                                                    |

The agent core doesn't import Electron (a lint rule enforces it), so it could later run behind
another front end unchanged. The UI is sandboxed and can only reach the agent through
`window.agent`. Credentials are encrypted with your OS keychain and only ever sent to the service
they belong to.

Setup, running with the offline demo model, Gemini or Claude, tests and troubleshooting are in
[DEVELOPMENT.md](DEVELOPMENT.md).

## Prerequisites

- Node.js 22.12 or later (npm comes with it)

## Commands

From the repository root:

```bash
npm install          # also downloads Electron
npm run dev          # the app, with hot reload
npm test             # core, main-process and UI tests (no network)
npm run lint
npm run typecheck
npx prettier --check .
```

### Environment variables (dev)

| Variable                     | Effect                                                 |
| ---------------------------- | ------------------------------------------------------ |
| `LLM_PROVIDER`               | `mock` (default, offline demo), `gemini` or `claude`   |
| `LLM_MODEL_ID`               | Model ID; required with `gemini` and `claude`          |
| `PRODUCTIVITY_AGENT_SECRETS` | `memory` keeps keys in memory only, nothing is written |
| `LOG_LEVEL`                  | `debug` for more detail on stderr                      |

`npm run dev` also reads a `.env` file at the repository root (see `.env.example`).
