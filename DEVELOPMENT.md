# Development

How to set up, run, test, and point the app at a real LLM. For what the project is and how it is laid
out, see [README.md](README.md).

## Prerequisites

Node.js 22.12 or later. Then, from the repository root:

```bash
npm install
```

This also downloads the Electron binary. CI checks and builds on macOS, Linux and Windows; the app
has been run by hand on macOS.

## First run

```bash
npm run dev
```

The agent runs inside the app's main process; there's no separate backend to start. With no
configuration it uses the **mock** model, which needs no account or network:

- Type anything: it echoes back, streamed word by word. **Stop** cancels a reply.
- Mention **PRs** or **pull requests**: it calls the GitHub tool and shows the result (without a
  token it says GitHub isn't connected).
- Mention **unread** or **inbox**: it calls the stub Gmail tool. One of the stub emails is a
  prompt-injection attempt, kept on purpose to show that tool content is treated as data.
- Ask it to **send** something: it proposes `gmail_send_draft`, a write tool. An approval card
  shows the exact arguments; nothing runs until you click **Approve**. **Reject** tells the
  model you declined. (The stub never actually sends email.)
- The panel on the right shows what the agent is doing and this session's activity.
- **Settings** (the gear in the left rail) shows the provider, model, keys and tools.

## Tests and checks

From the repository root:

```bash
npm test
npm run lint
npm run typecheck
npx prettier --check .
```

- `src/core/**/*.test.ts` covers the tool registry and approval gate, the agent loop, the mock
  models, model error messages, the GitHub tools (against a fake `fetch`) and the agent service.
- `src/main/` tests cover the IPC handlers (input validation, error mapping) and the encrypted
  secret store.
- `src/renderer/` tests render the real UI in jsdom against a fake `window.agent`: sending,
  streaming, Stop, approving and rejecting a write tool, settings and the agent panel.

No test calls a real LLM or cloud API.

## Using Gemini

The agent talks to Gemini through the **Gemini API** with an API key from Google AI Studio. The key
is encrypted with your OS keychain (Electron's `safeStorage`: macOS Keychain, Windows DPAPI, Secret
Service on Linux) and saved in the app's data folder. It never goes in `.env`, and the UI never
reads it back.

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
   LLM_MODEL_ID=<a current Gemini model ID from AI Studio>
   ```

   Model IDs change often, so the code never hard-codes one. If a model is overloaded (error 503),
   try another one.

3. Start the app (`npm run dev`), open **Settings**, paste the key under **Gemini API key** and
   choose **Save**. The status changes to "Saved". Keys saved by the earlier Rust version (in the
   keychain directly) aren't carried over; enter them again.

4. Send a message. Without a key, the reply is "Add your Gemini API key in Settings to start
   chatting." If the key is wrong, has no credit or hits a rate limit, the reply says so in plain
   words; the log (the terminal running `npm run dev`) has more detail.

To replace or remove the key, use **Replace** or **Remove** in Settings. To go back to the mock,
set `LLM_PROVIDER=mock` (or delete `.env`).

## Using GitHub

The GitHub tools (`github_list_pull_requests`, `github_list_issues`) are read-only and use a
**fine-grained personal access token**. Like the Gemini key, it is encrypted with your OS keychain
and the UI never reads it back.

1. Create the token on github.com: **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
   - **Resource owner:** your account, or an organisation. One token covers one owner. Some
     organisations have to approve a token before it works for their repositories.
   - **Repository access:** all repositories, or only the ones you want the agent to see.
   - **Permissions → Repository permissions:** **Pull requests: Read-only** and **Issues:
     Read-only**. GitHub adds Metadata: Read-only automatically. Don't add write permissions;
     nothing in the app writes to GitHub yet.
   - Pick an expiry. When it expires, the tools say the token was rejected; create a new one.
2. In the app, open **Settings**, paste the token under **GitHub token** and choose **Save**.
3. Ask something like "What PRs need my review?" or "Which issues are assigned to me?".

Without a token, the tools tell the model that GitHub isn't connected; nothing is sent. Search
results only include repositories the token can access. The mock provider's "PRs" keyword calls
the real tool too, so with a token saved you can check the GitHub side without a Gemini key.

## Troubleshooting

- **More log detail:** logs go to the terminal running `npm run dev`. Set `LOG_LEVEL=debug`.
- **"Agent unavailable" banner:** the configuration is invalid (for example `LLM_PROVIDER=gemini`
  without `LLM_MODEL_ID`); the banner says what to fix. Restart after changing `.env`.
- **Keep secrets off disk while experimenting:** `PRODUCTIVITY_AGENT_SECRETS=memory npm run dev`
  keeps the API key and GitHub token in memory only; they're forgotten when the app quits.
- **Linux: saving a key fails:** the app refuses to store secrets when no keychain (Secret
  Service, for example GNOME Keyring or KWallet) is available, rather than saving them in plain
  text.
- **`npm run dev` says Electron failed to install:** run `npm run postinstall` to download it again.

## Packaging

Not set up for releases yet. `npm run build:mac`, `build:win` and `build:linux` make unsigned local
builds with electron-builder (into `dist/`). Signing, notarising on macOS and a release workflow on
tags come later.
