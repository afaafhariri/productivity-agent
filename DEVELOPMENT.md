# Development

How to set up, run, test, and point the app at a real LLM. For what the project is and how it is laid
out, see [README.md](README.md).

## Prerequisites

| Tool | Why | Install |
|------|-----|---------|
| Rust (stable) | Builds the app (`app/`) and the agent core (`core/`) | [rustup.rs](https://rustup.rs) |
| Xcode (macOS only) | GPUI compiles Metal shaders at build time | App Store, then the commands below |

On macOS, select the full Xcode (not just the Command Line Tools) and install the Metal toolchain once:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```
```bash
xcodebuild -downloadComponent MetalToolchain
```

On Linux, GPUI needs Vulkan and Wayland/X11 development libraries; the CI workflow
(`.github/workflows/ci.yml`) lists the Debian/Ubuntu packages. Windows needs the MSVC toolchain
(Visual Studio Build Tools). CI builds and tests on macOS, Linux and Windows; the app has been run
by hand on macOS.

## First run

```bash
cargo run -p personal-productivity-agent
```

The agent runs inside the app; there's no separate backend to start. With no configuration it uses
the **mock** model, which needs no account or network:

- Type anything: it echoes back, streamed word by word. **Stop** cancels a reply.
- Mention **PRs** or **pull requests**: it calls the stub GitHub tool and shows the result.
- Mention **unread** or **inbox**: it calls the stub Gmail tool. One of the stub emails is a
  prompt-injection attempt, kept on purpose to show that tool content is treated as data.
- Ask it to **send** something: it proposes `gmail_send_draft`, a write tool. An approval card
  shows the exact arguments; nothing runs until you click **Approve**. **Reject** tells the
  model you declined. (The stub never actually sends email.)
- **Settings** (top right) shows the active provider, model and tools.

## Tests and checks

From the repository root:

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

- `core/tests/` covers the tool registry and approval gate, the agent loop, the mock models, the
  Gemini provider and GitHub tools (against local mock HTTP servers), and the agent service.
- `app/` has headless GPUI tests that drive the real core with the mock model: typing and Enter,
  Stop, approving and rejecting a write tool, the settings panel, and saving and removing keys.
  They use in-memory secrets, so they never touch your real keychain.

No test calls a real LLM or cloud API.

## Using Gemini

The agent talks to Gemini through the **Gemini API** (its REST endpoint, streamed) with an API key
from Google AI Studio. The key is stored in your OS keychain (macOS Keychain, Windows Credential
Manager, Secret Service on Linux), never in `.env`, and the app never reads it back.

1. Create a key: open [aistudio.google.com](https://aistudio.google.com), sign in, and choose
   **Get API key → Create API key**. AI Studio creates the Google Cloud project behind it for you.

   On the free tier Google may use your prompts to improve its products. This app sends it your
   PRs and mail, so turn on billing for the key's project in AI Studio before using real data. If
   you do, set a budget alert in Cloud Billing (**Billing → Budgets & alerts**) for that project.

2. Configure the provider and model. Copy the example (at the repository root) and edit it:

   ```bash
   cp .env.example .env
   ```

   ```dotenv
   LLM_PROVIDER=gemini
   LLM_MODEL_ID=<a current Gemini model ID, for example gemini-3.8-flash>
   ```

   Model IDs change often, so the code never hard-codes one. Check the current IDs in AI Studio.

3. Start the app (`cargo run -p personal-productivity-agent`), open **Settings**, paste the key
   under **Gemini API key** and choose **Save**. The status changes to "Saved in your OS keychain".
   macOS may ask whether the app can use your keychain; choose **Always Allow**. (Keys saved by the
   earlier Python version are reused; macOS asks once because the program changed.)

4. Send a message. Without a key, the reply is "Add your Gemini API key in Settings to start
   chatting." If the key is wrong, has no credit or hits a rate limit, the reply says so in plain
   words; the log (the app's stderr) has Google's own message.

To replace or remove the key, use **Replace** or **Remove** in Settings. To go back to the mock,
set `LLM_PROVIDER=mock` (or delete `.env`).

Gemini Enterprise Agent Platform (formerly Vertex AI) is no longer supported. If an old `.env`
still has `LLM_PROVIDER=vertex` or `agent_platform`, the app shows "Agent unavailable" with a
message telling you to switch to `gemini`.

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

- **More log detail:** logs go to the app's stderr. `RUST_LOG=debug cargo run -p
  personal-productivity-agent`, or `RUST_LOG=agent_core=debug` for the agent only.
- **"Agent unavailable" banner:** the configuration is invalid (for example `LLM_PROVIDER=gemini`
  without `LLM_MODEL_ID`); the banner says what to fix. Restart after changing `.env`.
- **Keep secrets out of the keychain while experimenting:** `PRODUCTIVITY_AGENT_SECRETS=memory` keeps
  the API key and GitHub token in memory only; they're forgotten when the app quits.
- **VS Code shows errors that `cargo check` doesn't:** after changes to the workspace layout, run
  **rust-analyzer: Restart server** (⌘⇧P).
- **Window not repainting:** on macOS a fully covered background window isn't redrawn until it gets
  an event. The state underneath is up to date.

## Packaging

Not set up yet. The app is a single Rust binary, so packaging means bundling it per platform
(macOS `.app`, Windows installer, Linux AppImage or package) and signing and notarising on macOS.
Until then, run from source as above.
