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
the chat: typing and Enter, Stop, approving and rejecting a write tool, the settings panel, and
saving and removing the API key. Run `uv sync` in `agent/` first. Tests run the backend with
`PRODUCTIVITY_AGENT_SECRETS=memory`, so they never touch your real keychain.

No test calls a real LLM or cloud API.

## Using Gemini

The backend talks to Gemini through the **Gemini API** (the `google-genai` SDK) with an API key
from Google AI Studio. The key is stored in your OS keychain (macOS Keychain, Windows Credential
Manager, Secret Service on Linux), never in `.env`, and the app never reads it back.

1. Create a key: open [aistudio.google.com](https://aistudio.google.com), sign in, and choose
   **Get API key → Create API key**. AI Studio creates the Google Cloud project behind it for you.

   On the free tier Google may use your prompts to improve its products. This app sends it your
   PRs and mail, so turn on billing for the key's project in AI Studio before using real data. If
   you do, set a budget alert in Cloud Billing (**Billing → Budgets & alerts**) for that project.

2. Configure the backend. Copy the example and set the provider and model:

   ```bash
   cp agent/.env.example agent/.env
   ```

   ```dotenv
   LLM_PROVIDER=gemini
   LLM_MODEL_ID=<a current Gemini model ID, for example gemini-3.8-flash>
   ```

   Model IDs change often, so the code never hard-codes one. Check the current IDs in AI Studio.

3. Start the app (`cd app && cargo run`), open **Settings**, paste the key under **Gemini API
   key** and choose **Save**. The status changes to "Saved in your OS keychain". macOS may ask
   whether Python can use your keychain; choose **Always Allow**.

4. Send a message. Without a key, the reply is "Add your Gemini API key in Settings to start
   chatting." If the key is wrong or has no quota, the run fails and the backend log (the app's
   stderr) says why.

To replace or remove the key, use **Replace** or **Remove** in Settings. To go back to the mock,
set `LLM_PROVIDER=mock` (or delete `agent/.env`).

Gemini Enterprise Agent Platform (formerly Vertex AI) is no longer supported. If an old `.env`
still has `LLM_PROVIDER=vertex` or `agent_platform`, the backend exits with a message telling you
to switch to `gemini`.

## Using GitHub

The GitHub tools (`github_list_pull_requests`, `github_list_issues`) are read-only and use a
**fine-grained personal access token**. Like the Gemini key, it lives in your OS keychain and the
app never reads it back.

1. Create the token on github.com: **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
   - **Resource owner:** your account, or an organisation. One token covers one owner. Some
     organisations have to approve a token before it works for their repositories.
   - **Repository access:** all repositories, or only the ones you want the agent to see.
   - **Permissions → Repository permissions:** **Pull requests: Read-only** and **Issues:
     Read-only**. GitHub adds Metadata: Read-only automatically. Don't add write permissions;
     nothing in the app writes to GitHub yet.
   - Pick an expiry. When it expires, the tools say the token was rejected; create a new one.
2. In the app, open **Settings**, paste the token under **GitHub** and choose **Save**.
3. Ask something like "What PRs need my review?" or "Which issues are assigned to me?".

Without a token, the tools tell the model that GitHub isn't connected; nothing is sent. Search
results only include repositories the token can access. The mock provider's "PRs" keyword calls
the real tool too, so with a token saved you can check the GitHub side without a Gemini key.

## Troubleshooting

- **See the raw protocol:** `PPA_LOG_RPC=1 cargo run` prints every JSON-RPC line between the app and
  the backend to stderr.
- **Backend logs** go to the app's stderr. Set `LOG_LEVEL=DEBUG` in `agent/.env` for more detail.
- **Run the backend by hand:** see "Running the server by hand" in [agent/README.md](agent/README.md).
- **Use a different backend checkout:** `PRODUCTIVITY_AGENT_DIR=/path/to/agent cargo run`.
- **Keep secrets out of the keychain while experimenting:** `PRODUCTIVITY_AGENT_SECRETS=memory cargo run`
  keeps the API key and GitHub token in the backend's memory only; they're forgotten when the app quits.
- **`PPA_LOG_RPC=1` and secrets:** the value sent by `secrets.set` is shown as `[redacted]`.
- **Window not repainting:** on macOS a fully covered background window isn't redrawn until it gets
  an event. The state underneath is up to date.

## Packaging

Not set up yet. A distributable build has to bundle a Python runtime with the backend (the approach
is still an open decision) and be signed and notarised on macOS. Until then, run from source as
above.
