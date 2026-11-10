"""The agent loop: model turn → tool calls → tool results → next turn, until the model stops."""

import asyncio
import logging
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Literal

from pydantic_core import ErrorDetails

from productivity_agent.core.agent.prompt import SYSTEM_PROMPT
from productivity_agent.core.json import JsonValue
from productivity_agent.core.llm.types import (
    AssistantMessage,
    LanguageModel,
    Message,
    ModelRequest,
    TextDelta,
    ToolCall,
    ToolCallPart,
    ToolResultMessage,
)
from productivity_agent.core.tools.registry import (
    ToolInputError,
    ToolRegistry,
    ToolRuntime,
    UnknownToolError,
)

logger = logging.getLogger(__name__)

DEFAULT_MAX_STEPS = 8


@dataclass(frozen=True, slots=True)
class TextDeltaEvent:
    text: str


@dataclass(frozen=True, slots=True)
class ToolCallEvent:
    tool_call_id: str
    tool_name: str
    input: JsonValue


@dataclass(frozen=True, slots=True)
class ToolResultEvent:
    tool_call_id: str
    tool_name: str
    result: JsonValue


@dataclass(frozen=True, slots=True)
class DoneEvent:
    reason: Literal["stop", "max_steps"]


type AgentEvent = TextDeltaEvent | ToolCallEvent | ToolResultEvent | DoneEvent


def wrap_untrusted(tool_name: str, result: JsonValue) -> JsonValue:
    """Delimits tool output so the model treats it as data (see SYSTEM_PROMPT)."""
    return {"tool": tool_name, "untrusted_content": result}


async def run_agent(
    *,
    model: LanguageModel,
    registry: ToolRegistry,
    runtime: ToolRuntime,
    history: list[Message],
    system: str = SYSTEM_PROMPT,
    max_steps: int = DEFAULT_MAX_STEPS,
) -> AsyncIterator[AgentEvent]:
    """Runs until the model answers without tool calls or `max_steps` turns have run.

    Appends every assistant message and tool result to `history`, so the caller keeps the
    conversation. Cancelling the consuming task stops the run, including a pending approval.
    """
    tools = registry.specs()
    for _ in range(max_steps):
        text_parts: list[str] = []
        calls: list[ToolCall] = []
        async for part in model.stream(
            ModelRequest(system=system, messages=tuple(history), tools=tools)
        ):
            match part:
                case TextDelta(text=text):
                    text_parts.append(text)
                    yield TextDeltaEvent(text)
                case ToolCallPart(call=call):
                    calls.append(call)
                case _:
                    pass

        history.append(AssistantMessage(text="".join(text_parts), tool_calls=tuple(calls)))
        if not calls:
            yield DoneEvent("stop")
            return

        answered: set[str] = set()
        try:
            for call in calls:
                yield ToolCallEvent(call.id, call.name, call.arguments)
                result = await _call_tool(registry, runtime, call)
                history.append(
                    ToolResultMessage(call.id, call.name, content=wrap_untrusted(call.name, result))
                )
                answered.add(call.id)
                yield ToolResultEvent(call.id, call.name, result)
        except asyncio.CancelledError, GeneratorExit:
            # Keep history valid for the next run: every tool call needs a result.
            for call in calls:
                if call.id not in answered:
                    cancelled: JsonValue = {
                        "status": "cancelled",
                        "reason": "The user stopped the run.",
                    }
                    history.append(ToolResultMessage(call.id, call.name, content=cancelled))
            raise

    yield DoneEvent("max_steps")


async def _call_tool(registry: ToolRegistry, runtime: ToolRuntime, call: ToolCall) -> JsonValue:
    """Errors become results the model can react to; they never crash the run."""
    try:
        return await registry.call(call.name, call.arguments, tool_call_id=call.id, runtime=runtime)
    except UnknownToolError:
        return {
            "status": "error",
            "error": "unknown_tool",
            "message": f"No tool named {call.name}.",
        }
    except ToolInputError as error:
        return {"status": "error", "error": "invalid_input", "details": _errors_json(error.errors)}
    except Exception:
        logger.exception("tool failed", extra={"tool": call.name, "tool_call_id": call.id})
        return {"status": "error", "error": "tool_failed", "message": "The tool failed to run."}


def _errors_json(errors: Sequence[ErrorDetails]) -> JsonValue:
    return [{"loc": ".".join(str(p) for p in e["loc"]), "msg": e["msg"]} for e in errors]
