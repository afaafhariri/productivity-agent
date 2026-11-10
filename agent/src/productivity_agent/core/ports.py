"""Interfaces the core needs from its host. Hosts provide the implementations.

Logging uses the standard library (`logging.getLogger(__name__)`); the host configures
handlers. Never log secrets or raw tokens.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from productivity_agent.core.json import JsonValue


class SecretStore(Protocol):
    """Encrypted key/value storage for credentials. Values never reach logs or the LLM."""

    async def get(self, key: str) -> str | None: ...
    async def set(self, key: str, value: str) -> None: ...
    async def delete(self, key: str) -> None: ...


class Clock(Protocol):
    def now(self) -> datetime: ...


@dataclass(frozen=True, slots=True)
class ConfirmationRequest:
    """What the user is asked to approve before a `write` tool runs."""

    tool_call_id: str
    tool_name: str
    description: str
    """The tool's description, so the user knows what the action does."""
    input: JsonValue
    """The exact, validated arguments the tool will be called with."""


@dataclass(frozen=True, slots=True)
class Approved:
    pass


@dataclass(frozen=True, slots=True)
class Rejected:
    reason: str | None = None


type ConfirmationDecision = Approved | Rejected


class Confirmation(Protocol):
    """Asks the user to approve or reject a state-changing action.

    If the run is cancelled while waiting, the awaiting task is cancelled and the tool
    never executes.
    """

    async def request(self, request: ConfirmationRequest) -> ConfirmationDecision: ...
