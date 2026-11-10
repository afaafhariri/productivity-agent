import json
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from pydantic import BaseModel, ValidationError

from productivity_agent.core.json import JsonValue
from productivity_agent.core.ports import (
    Clock,
    Confirmation,
    ConfirmationRequest,
    Rejected,
    SecretStore,
)
from productivity_agent.core.tools.types import (
    AgentTool,
    ToolContext,
    ToolEffect,
    ToolResult,
    ToolSpec,
)

logger = logging.getLogger(__name__)

_TOOL_NAME = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")

DEFAULT_MAX_RESULT_CHARS = 20_000
"""Backstop only: tools should paginate/truncate themselves well below this."""


class UnknownToolError(LookupError):
    pass


class ToolInputError(ValueError):
    """The model sent arguments that do not match the tool's input model."""

    def __init__(self, tool_name: str, error: ValidationError) -> None:
        super().__init__(f"Invalid input for {tool_name}: {error}")
        self.tool_name = tool_name
        self.errors = error.errors(include_url=False)


@dataclass(frozen=True, slots=True)
class ToolRuntime:
    confirmation: Confirmation
    secrets: SecretStore
    clock: Clock
    max_result_chars: int = DEFAULT_MAX_RESULT_CHARS


@dataclass(frozen=True, slots=True)
class _PreparedCall:
    input: JsonValue
    run: Callable[[ToolContext], Awaitable[ToolResult]]


@dataclass(frozen=True, slots=True)
class _Entry:
    spec: ToolSpec
    effect: ToolEffect
    prepare: Callable[[object], _PreparedCall]


def _entry[I: BaseModel](tool: AgentTool[I]) -> _Entry:
    def prepare(raw_input: object) -> _PreparedCall:
        try:
            parsed = tool.input_model.model_validate(raw_input)
        except ValidationError as error:
            raise ToolInputError(tool.name, error) from error
        return _PreparedCall(
            input=parsed.model_dump(mode="json"),
            run=lambda ctx: tool.execute(parsed, ctx),
        )

    spec = ToolSpec(
        name=tool.name,
        description=tool.description,
        input_schema=tool.input_model.model_json_schema(),
    )
    return _Entry(spec=spec, effect=tool.effect, prepare=prepare)


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, _Entry] = {}

    def register[I: BaseModel](self, tool: AgentTool[I]) -> None:
        if not _TOOL_NAME.fullmatch(tool.name):
            raise ValueError(f'Tool name must be snake_case: "{tool.name}"')
        if tool.name in self._tools:
            raise ValueError(f'Tool already registered: "{tool.name}"')
        self._tools[tool.name] = _entry(tool)

    def specs(self) -> list[ToolSpec]:
        return [entry.spec for entry in self._tools.values()]

    async def call(
        self, name: str, raw_input: object, *, tool_call_id: str, runtime: ToolRuntime
    ) -> ToolResult:
        """Validate, gate (for write tools), execute and size-bound one tool call.

        Raises UnknownToolError or ToolInputError; the agent loop reports those to the model.
        """
        entry = self._tools.get(name)
        if entry is None:
            raise UnknownToolError(name)

        prepared = entry.prepare(raw_input)

        if entry.effect == "write":
            decision = await runtime.confirmation.request(
                ConfirmationRequest(
                    tool_call_id=tool_call_id,
                    tool_name=name,
                    description=entry.spec.description,
                    input=prepared.input,
                )
            )
            if isinstance(decision, Rejected):
                logger.info(
                    "tool rejected by user", extra={"tool": name, "tool_call_id": tool_call_id}
                )
                return {
                    "status": "rejected",
                    "reason": decision.reason or "The user rejected this action.",
                }

        ctx = ToolContext(tool_call_id=tool_call_id, secrets=runtime.secrets, clock=runtime.clock)
        result = await prepared.run(ctx)
        return _bound(result, runtime.max_result_chars)


def _bound(result: ToolResult, max_chars: int) -> ToolResult:
    serialized = json.dumps(result, ensure_ascii=False)
    if len(serialized) <= max_chars:
        return result
    return {
        "truncated": True,
        "note": (
            f"Result was {len(serialized)} characters and was cut to {max_chars}. "
            "Ask for a narrower query or the next page."
        ),
        "preview": serialized[:max_chars],
    }
