# productivity-agent (backend)

Python backend for the desktop app: the agent loop, tool registry and integrations.
The GPUI app in `../app` runs it as a child process and talks to it over stdio.

```bash
uv sync               # create .venv and install deps
uv run pytest         # tests
uv run ruff check     # lint
uv run ruff format    # format
uv run mypy           # type-check (strict)
uv run productivity-agent --version
```

## Running the server by hand

`productivity-agent` speaks JSON-RPC 2.0 on stdin/stdout (one JSON message per line) and logs to
stderr. It exits when stdin closes. Config is read from env; copy `.env.example` to `.env`:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol_version":1}}' \
  '{"jsonrpc":"2.0","id":2,"method":"run.start","params":{"conversation_id":"c","text":"hi"}}' \
  | (cat; sleep 1) | uv run --env-file .env productivity-agent
```

Methods: `initialize`, `run.start`, `run.cancel`, `confirmation.respond`. The server sends
`run.event` notifications (`text_delta`, `tool_call`, `tool_result`, `confirmation_request`,
`done`, `error`). See `src/productivity_agent/rpc/protocol.py`.
