import asyncio
from collections.abc import AsyncIterator, Callable, Sequence

from productivity_agent.core.llm.types import (
    Finish,
    ModelPart,
    ModelRequest,
    TextDelta,
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

    async def stream(self, request: ModelRequest) -> AsyncIterator[ModelPart]:
        self.requests.append(request)
        for part in self._respond(request):
            if self._delay:
                await asyncio.sleep(self._delay)
            yield part
