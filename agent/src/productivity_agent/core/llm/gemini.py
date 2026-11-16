"""Gemini through the `google-genai` SDK (the Gemini API, authenticated with an API key).

The factory builds the client; this module only adapts its streaming API to `LanguageModel`.
"""

import asyncio
import contextlib
import logging
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Sequence
from typing import Literal, Protocol

import httpx2
from google.genai import errors, types

from productivity_agent.core.json import JsonValue
from productivity_agent.core.llm.types import (
    AssistantMessage,
    Finish,
    Message,
    ModelError,
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

logger = logging.getLogger(__name__)

_GENERATED_ID_PREFIX = "gen-"

IDLE_TIMEOUT_SECONDS = 90.0
"""How long to wait for Gemini's first or next chunk. Generous, because a thinking model can
be silent for a while before its first chunk."""


class _AsyncModels(Protocol):
    async def generate_content_stream(
        self, *, model: str, contents: list[types.Content], config: types.GenerateContentConfig
    ) -> AsyncIterator[types.GenerateContentResponse]: ...


class _AsyncClient(Protocol):
    @property
    def models(self) -> _AsyncModels: ...


class GeminiModel:
    """Adapts google-genai streaming with manual function calling to `LanguageModel`.

    Automatic function calling is disabled: the agent loop runs tools itself so every
    write goes through the confirmation gate.
    """

    def __init__(
        self, client: _AsyncClient, model_id: str, *, idle_timeout: float = IDLE_TIMEOUT_SECONDS
    ) -> None:
        self._client = client
        self._model_id = model_id
        self._idle_timeout = idle_timeout

    async def stream(self, request: ModelRequest) -> AsyncIterator[ModelPart]:
        config = types.GenerateContentConfig(
            system_instruction=request.system,
            tools=_tools(request.tools),
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )
        parts: list[types.Part] = []
        saw_call = False
        finish: types.FinishReason | None = None
        try:
            chunks = self._chunks(to_contents(request.messages), config)
            async with contextlib.aclosing(chunks):
                async for chunk in chunks:
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
        except errors.APIError as error:
            # Google's error bodies carry no credentials; log them for diagnosis.
            logger.warning("Gemini API error %s %s: %s", error.code, error.status, error.message)
            raise ModelError(api_error_message(error, self._model_id)) from error
        except httpx2.TransportError as error:
            # No credentials in these: the key travels in a header, never in the URL.
            logger.warning("Gemini connection error: %s: %s", type(error).__name__, error)
            raise ModelError(connection_error_message(error)) from error
        except TimeoutError as error:
            logger.warning("Gemini sent nothing for %gs; giving up", self._idle_timeout)
            raise ModelError(
                f"Gemini didn't respond for {self._idle_timeout:g} seconds. It may be busy; "
                "try again in a moment."
            ) from error

        yield ProviderState(types.Content(role="model", parts=parts))
        yield Finish(_finish_reason(finish, saw_call))

    async def _chunks(
        self, contents: list[types.Content], config: types.GenerateContentConfig
    ) -> AsyncGenerator[types.GenerateContentResponse]:
        """The response chunks; raises TimeoutError if Gemini goes quiet for `idle_timeout`.

        The SDK has no timeout by default, so a stalled connection would otherwise hang the
        run forever. Only the waits for Gemini are timed, never the caller's time between
        chunks.
        """
        async with asyncio.timeout(self._idle_timeout):
            stream = await self._client.models.generate_content_stream(
                model=self._model_id, contents=contents, config=config
            )
        iterator = aiter(stream)
        try:
            while True:
                try:
                    async with asyncio.timeout(self._idle_timeout):
                        chunk = await anext(iterator)
                except StopAsyncIteration:
                    return
                yield chunk
        finally:
            aclose = getattr(iterator, "aclose", None)
            if aclose is not None:
                await aclose()  # Releases the HTTP connection.


def api_error_message(error: errors.APIError, model_id: str) -> str:
    """A message the user can act on, built only from the status code and our own config."""
    code = error.code
    if code == 400 and "api key" in (error.message or "").lower():
        code = 401  # Gemini reports a malformed or unknown key as 400 INVALID_ARGUMENT.
    match code:
        case 401 | 403:
            return (
                "Gemini didn't accept your API key. Check it in Settings, or create a new one "
                "in Google AI Studio."
            )
        case 402:
            return (
                "Your Gemini API credits are used up. Top up your project's prepaid balance in "
                "Google AI Studio, then try again."
            )
        case 404:
            return (
                f"Gemini doesn't have a model called '{model_id}'. Set LLM_MODEL_ID in "
                "agent/.env to a current model and restart the app."
            )
        case 429:
            return (
                "Gemini's rate limit or quota was reached. Wait a moment and try again, or "
                "check your project's limits in Google AI Studio."
            )
        case _ if code >= 500:
            return f"Gemini is having problems right now (error {code}). Try again in a moment."
        case _:
            return f"Gemini rejected the request (error {code})."


def connection_error_message(error: httpx2.TransportError) -> str:
    """Raised by the SDK's HTTP library (after its retries) when the network fails."""
    if isinstance(error, httpx2.ConnectError | httpx2.ConnectTimeout):
        return "Couldn't reach Gemini. Check your internet connection and try again."
    return "The connection to Gemini was interrupted. Check your internet connection and try again."


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
