"""Gemini on Gemini Enterprise Agent Platform through the `google-genai` SDK.

Auth: Application Default Credentials. The client is created with `enterprise=True` (see factory).
"""

import uuid
from collections.abc import AsyncIterator, Sequence
from typing import Literal, Protocol

from google.genai import types

from productivity_agent.core.json import JsonValue
from productivity_agent.core.llm.types import (
    AssistantMessage,
    Finish,
    Message,
    ModelPart,
    ModelRequest,
    ProviderState,
    TextDelta,
    ToolCall,
    ToolCallPart,
    ToolResultMessage,
    UserMessage,
)
from productivity_agent.core.tools.types import ToolSpec

_GENERATED_ID_PREFIX = "gen-"


class _AsyncModels(Protocol):
    async def generate_content_stream(
        self, *, model: str, contents: list[types.Content], config: types.GenerateContentConfig
    ) -> AsyncIterator[types.GenerateContentResponse]: ...


class _AsyncClient(Protocol):
    @property
    def models(self) -> _AsyncModels: ...


class AgentPlatformModel:
    """Adapts google-genai streaming with manual function calling to `LanguageModel`.

    Automatic function calling is disabled: the agent loop runs tools itself so every
    write goes through the confirmation gate.
    """

    def __init__(self, client: _AsyncClient, model_id: str) -> None:
        self._client = client
        self._model_id = model_id

    async def stream(self, request: ModelRequest) -> AsyncIterator[ModelPart]:
        config = types.GenerateContentConfig(
            system_instruction=request.system,
            tools=_tools(request.tools),
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )
        stream = await self._client.models.generate_content_stream(
            model=self._model_id, contents=to_contents(request.messages), config=config
        )

        parts: list[types.Part] = []
        saw_call = False
        finish: types.FinishReason | None = None
        async for chunk in stream:
            candidate = chunk.candidates[0] if chunk.candidates else None
            if candidate is None:
                continue
            finish = candidate.finish_reason or finish
            for part in (candidate.content.parts if candidate.content else None) or []:
                parts.append(part)
                if part.thought:
                    continue  # Thought summaries are not shown to the user.
                if part.text:
                    yield TextDelta(part.text)
                if part.function_call:
                    saw_call = True
                    yield ToolCallPart(_tool_call(part.function_call))

        yield ProviderState(types.Content(role="model", parts=parts))
        yield Finish(_finish_reason(finish, saw_call))


def to_contents(messages: Sequence[Message]) -> list[types.Content]:
    """Converts history to Gemini contents. Consecutive tool results share one turn."""
    contents: list[types.Content] = []
    for message in messages:
        match message:
            case UserMessage(text=text):
                contents.append(types.Content(role="user", parts=[types.Part(text=text)]))
            case AssistantMessage(provider_state=types.Content() as raw):
                contents.append(raw)  # Verbatim, so thought signatures survive.
            case AssistantMessage(text=text, tool_calls=calls):
                parts = [types.Part(text=text)] if text else []
                parts += [
                    types.Part(
                        function_call=types.FunctionCall(
                            id=_provider_id(c.id), name=c.name, args=_args(c.arguments)
                        )
                    )
                    for c in calls
                ]
                contents.append(types.Content(role="model", parts=parts))
            case ToolResultMessage(tool_call_id=call_id, tool_name=name, content=content):
                part = types.Part(
                    function_response=types.FunctionResponse(
                        id=_provider_id(call_id), name=name, response={"output": content}
                    )
                )
                last = contents[-1] if contents else None
                if last is not None and last.role == "user" and _all_responses(last):
                    (last.parts or []).append(part)
                else:
                    contents.append(types.Content(role="user", parts=[part]))
    return contents


def _tools(specs: Sequence[ToolSpec]) -> types.ToolListUnion | None:
    if not specs:
        return None
    declarations = [
        types.FunctionDeclaration(
            name=s.name, description=s.description, parameters_json_schema=s.input_schema
        )
        for s in specs
    ]
    return [types.Tool(function_declarations=declarations)]


def _tool_call(call: types.FunctionCall) -> ToolCall:
    call_id = call.id or f"{_GENERATED_ID_PREFIX}{uuid.uuid4().hex}"
    arguments: JsonValue = dict(call.args or {})
    return ToolCall(id=call_id, name=call.name or "", arguments=arguments)


def _provider_id(call_id: str) -> str | None:
    """Ids we generated were never seen by Gemini, so don't send them back."""
    return None if call_id.startswith(_GENERATED_ID_PREFIX) else call_id


def _args(arguments: JsonValue) -> dict[str, JsonValue]:
    return arguments if isinstance(arguments, dict) else {}


def _all_responses(content: types.Content) -> bool:
    return bool(content.parts) and all(p.function_response for p in content.parts or [])


def _finish_reason(
    reason: types.FinishReason | None, saw_call: bool
) -> Literal["stop", "tool_calls", "length", "other"]:
    if saw_call:
        return "tool_calls"
    if reason in (None, types.FinishReason.STOP):
        return "stop"
    if reason == types.FinishReason.MAX_TOKENS:
        return "length"
    return "other"
