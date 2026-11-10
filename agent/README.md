# productivity-agent (backend)

Python backend for the desktop app: the agent loop, tool registry and integrations.
The GPUI app in `../app` runs it as a child process and talks to it over stdio.

```bash
uv sync               # create .venv and install deps
uv run pytest         # tests
uv run ruff check     # lint
uv run ruff format    # format
uv run mypy           # type-check (strict)
uv run productivity-agent
```
