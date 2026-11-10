"""Provider-neutral model interface. Providers adapt their SDK to these types."""

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

from productivity_agent.core.json import JsonValue
from productivity_agent.core.tools.types import ToolSpec


@dataclass(frozen=True, slots=True)
class ToolCall:
    id: str
    name: str
    arguments: JsonValue


@dataclass(frozen=True, slots=True)
class UserMessage:
    text: str


@dataclass(frozen=True, slots=True)
class AssistantMessage:
    text: str
    tool_calls: tuple[ToolCall, ...] = ()


@dataclass(frozen=True, slots=True)
class ToolResultMessage:
    tool_call_id: str
    tool_name: str
    content: JsonValue
    """What the model sees. Untrusted tool output is wrapped by the agent loop."""


type Message = UserMessage | AssistantMessage | ToolResultMessage


@dataclass(frozen=True, slots=True)
class TextDelta:
    text: str


@dataclass(frozen=True, slots=True)
class ToolCallPart:
    call: ToolCall


@dataclass(frozen=True, slots=True)
class Finish:
    reason: Literal["stop", "tool_calls", "length", "other"] = "stop"


type ModelPart = TextDelta | ToolCallPart | Finish


@dataclass(frozen=True, slots=True)
class ModelRequest:
    system: str
    messages: Sequence[Message]
    tools: Sequence[ToolSpec] = field(default_factory=tuple)


class LanguageModel(Protocol):
    """Streams one model turn: text deltas and/or tool calls, then a Finish."""

    def stream(self, request: ModelRequest) -> AsyncIterator[ModelPart]: ...
