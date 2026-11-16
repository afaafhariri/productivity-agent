# Development

How to set up, run, test, and point the app at a real LLM. For what the project is and how it is laid
out, see [README.md](README.md).

## Prerequisites

| Tool | Why | Install |
|------|-----|---------|
| Rust (stable) | Builds the desktop app in `app/` | [rustup.rs](https://rustup.rs) |
| uv | Manages the backend's Python and dependencies in `agent/` | [docs.astral.sh/uv](https://docs.astral.sh/uv/) |
| Xcode (macOS only) | GPUI compiles Metal shaders at build time | App Store, then the commands below |

On macOS, select the full Xcode (not just the Command Line Tools) and install the Metal toolchain once:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```
```bash
xcodebuild -downloadComponent MetalToolchain
```

On Linux, GPUI needs Vulkan and Wayland/X11 development libraries; Zed's Linux build docs list the
packages per distribution. Windows needs the MSVC toolchain (Visual Studio Build Tools). The app has
been built and tested on macOS so far; Linux and Windows builds are not verified yet.

You do **not** need a system Python: uv downloads Python 3.14 for the project and keeps everything in
`agent/.venv`.

## First run

```bash
cd agent
uv sync
cd ../app
cargo run
```

The app starts the backend itself (`uv run --project ../agent productivity-agent`). With no
configuration it uses the **mock** LLM, which needs no account or network:

- Type anything: it echoes back, streamed word by word. **Stop** cancels a reply.
- Mention **PRs** or **pull requests**: it calls the stub GitHub tool and shows the result.
- Mention **unread** or **inbox**: it calls the stub Gmail tool. One of the stub emails is a
  prompt-injection attempt, kept on purpose to show that tool content is treated as data.
- Ask it to **send** something: it proposes `gmail_send_draft`, a write tool. An approval card
  shows the exact arguments; nothing runs until you click **Approve**. **Reject** tells the
  model you declined. (The stub never actually sends email.)
- **Settings** (top right) shows the active provider, model and tools.

## Tests and checks

Backend:

```bash
cd agent
uv run pytest
uv run ruff check
uv run ruff format --check
uv run mypy
```

App:

```bash
cd app
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

`cargo test` includes headless GPUI tests that start the real backend with the mock LLM and drive
the chat: typing and Enter, Stop, approving and rejecting a write tool, and the settings panel. Run
`uv sync` in `agent/` first.

No test calls a real LLM or cloud API.

## Using Gemini on Vertex AI

The backend talks to Vertex AI with the `google-genai` SDK and authenticates with Application
Default Credentials (ADC). No API key or service-account file is involved, and nothing secret goes
in `.env`.

1. Install the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) and create ADC for your
   user account:

   ```bash
   gcloud auth application-default login
   ```

2. Enable the Vertex AI API on your project, and make sure the project is linked to a billing
   account (a free-trial account works):

   ```bash
   gcloud services enable aiplatform.googleapis.com --project YOUR_PROJECT_ID
   ```

3. Configure the backend. Copy the example and fill in the four values:

   ```bash
   cp agent/.env.example agent/.env
   ```

   ```dotenv
   LLM_PROVIDER=vertex
   LLM_MODEL_ID=<a current Gemini model ID from the Vertex AI model list>
   GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
   GOOGLE_CLOUD_LOCATION=<a location where that model is available>
   ```

   Model IDs change often, so the code never hard-codes one. Pick a current Gemini model in the
   Vertex AI console (Model Garden) and check its page for supported locations.

4. Set a budget alert in Cloud Billing (**Billing → Budgets & alerts**) so a runaway loop can't
   surprise you.

5. Restart the app. **Settings** should show `vertex` and your model. If the configuration is
   incomplete, the backend logs which variables are missing and exits; the app shows "Backend
   unavailable".

To go back to the mock, set `LLM_PROVIDER=mock` (or delete `agent/.env`).

## Troubleshooting

- **See the raw protocol:** `PPA_LOG_RPC=1 cargo run` prints every JSON-RPC line between the app and
  the backend to stderr.
- **Backend logs** go to the app's stderr. Set `LOG_LEVEL=DEBUG` in `agent/.env` for more detail.
- **Run the backend by hand:** see "Running the server by hand" in [agent/README.md](agent/README.md).
- **Use a different backend checkout:** `PRODUCTIVITY_AGENT_DIR=/path/to/agent cargo run`.
- **Window not repainting:** on macOS a fully covered background window isn't redrawn until it gets
  an event. The state underneath is up to date.

## Packaging

Not set up yet. A distributable build has to bundle a Python runtime with the backend (the approach
is still an open decision) and be signed and notarised on macOS. Until then, run from source as
above.
