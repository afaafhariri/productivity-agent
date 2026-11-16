import asyncio
import itertools
import json
import re
from collections.abc import AsyncIterator, Callable, Sequence

from productivity_agent.core.json import JsonValue
from productivity_agent.core.llm.types import (
    Finish,
    ModelPart,
    ModelRequest,
    TextDelta,
    ToolCall,
    ToolCallPart,
    ToolResultMessage,
    UserMessage,
)

type Turn = Sequence[ModelPart]


class MockModel:
    """Deterministic model with no network. Used by default in dev and in all tests.

    Each call to `stream` plays the next turn produced by `respond`.
    """

    def __init__(self, respond: Callable[[ModelRequest], Turn], delay: float = 0.0) -> None:
        self._respond = respond
        self._delay = delay
        self.requests: list[ModelRequest] = []

    @classmethod
    def scripted(cls, turns: Sequence[Turn], delay: float = 0.0) -> MockModel:
        """Plays `turns` in order, one per model call."""
        remaining = list(turns)

        def respond(_: ModelRequest) -> Turn:
            if not remaining:
                raise RuntimeError("MockModel script exhausted")
            return remaining.pop(0)

        return cls(respond, delay)

    @classmethod
    def echo(cls, delay: float = 0.03) -> MockModel:
        """Replies with the last user message, word by word, so streaming is visible."""

        def respond(request: ModelRequest) -> Turn:
            last = next(
                (m.text for m in reversed(request.messages) if isinstance(m, UserMessage)), ""
            )
            words = f"(mock) You said: {last}".split(" ")
            return [*(TextDelta(w if i == 0 else f" {w}") for i, w in enumerate(words)), Finish()]

        return cls(respond, delay)

    @classmethod
    def demo(cls, delay: float = 0.03) -> MockModel:
        """Echo, plus keyword-triggered tool calls so the tool and approval flows can be
        tried with no cloud account: mention pull requests, unread email, or sending."""
        ids = (f"mock-call-{n}" for n in itertools.count(1))

        def respond(request: ModelRequest) -> Turn:
            last = request.messages[-1] if request.messages else None
            if isinstance(last, ToolResultMessage):
                return _words(_summarize(last))
            text = last.text if isinstance(last, UserMessage) else ""
            available = {t.name for t in request.tools}
            call = _pick_tool(text, available)
            if call is None:
                return _words(f"(mock) You said: {text}")
            name, arguments = call
            return [ToolCallPart(ToolCall(next(ids), name, arguments)), Finish("tool_calls")]

        return cls(respond, delay)

    async def stream(self, request: ModelRequest) -> AsyncIterator[ModelPart]:
        self.requests.append(request)
        for part in self._respond(request):
            if self._delay:
                await asyncio.sleep(self._delay)
            yield part


def _words(text: str) -> Turn:
    words = text.split(" ")
    return [*(TextDelta(w if i == 0 else f" {w}") for i, w in enumerate(words)), Finish()]


def _has(text: str, *patterns: str) -> bool:
    return any(re.search(rf"\b{p}\b", text, re.IGNORECASE) for p in patterns)


def _pick_tool(text: str, available: set[str]) -> tuple[str, JsonValue] | None:
    if "gmail_send_draft" in available and _has(text, "send", "email (him|her|them)"):
        return "gmail_send_draft", {
            "to": "teammate@example.com",
            "subject": "Quick update",
            "body": text,
        }
    if "github_list_pull_requests" in available and _has(text, "prs?", "pull requests?"):
        return "github_list_pull_requests", {"filter": "review_requested"}
    if "gmail_list_unread" in available and _has(text, "unread", "inbox", "emails?", "mail"):
        return "gmail_list_unread", {"limit": 5}
    return None


def _summarize(message: ToolResultMessage) -> str:
    content = message.content
    result = content.get("untrusted_content") if isinstance(content, dict) else None
    if isinstance(result, dict) and result.get("status") == "rejected":
        return "(mock) OK, I did not send it."
    if isinstance(result, dict) and result.get("status") == "cancelled":
        return "(mock) Stopped."
    preview = json.dumps(result, ensure_ascii=False)
    if len(preview) > 300:
        preview = preview[:300] + "…"
    return f"(mock) {message.tool_name} returned: {preview}"
