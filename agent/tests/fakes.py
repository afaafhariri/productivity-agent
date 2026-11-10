"""Test doubles for the core ports. Importable from any test as `fakes`."""

import asyncio
from datetime import UTC, datetime

from productivity_agent.core.ports import Confirmation, ConfirmationDecision, ConfirmationRequest
from productivity_agent.core.tools import ToolRuntime


class FakeConfirmation:
    def __init__(self, decision: ConfirmationDecision | None = None) -> None:
        self.decision = decision
        self.requests: list[ConfirmationRequest] = []

    async def request(self, request: ConfirmationRequest) -> ConfirmationDecision:
        self.requests.append(request)
        if self.decision is None:
            raise AssertionError("confirmation was not expected")
        return self.decision


class BlockingConfirmation:
    """Never answers, like a user who has not clicked yet."""

    def __init__(self) -> None:
        self.waiting = asyncio.Event()

    async def request(self, request: ConfirmationRequest) -> ConfirmationDecision:
        self.waiting.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


class NoSecrets:
    async def get(self, key: str) -> str | None:
        return None

    async def set(self, key: str, value: str) -> None:
        pass

    async def delete(self, key: str) -> None:
        pass


class FixedClock:
    def now(self) -> datetime:
        return datetime(2026, 1, 1, tzinfo=UTC)


def runtime(confirmation: Confirmation, max_result_chars: int = 20_000) -> ToolRuntime:
    return ToolRuntime(
        confirmation=confirmation,
        secrets=NoSecrets(),
        clock=FixedClock(),
        max_result_chars=max_result_chars,
    )
