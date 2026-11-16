"""GeminiModel against a fake google-genai client: no network, no credentials."""

import asyncio
import socket
from collections.abc import AsyncIterator

import httpx2
import pytest
from google import genai
from google.genai import errors, types

from productivity_agent.core.llm import (
    GEMINI_API_KEY,
    AssistantMessage,
    Finish,
    LlmConfig,
    Message,
    ModelError,
    ModelPart,
    ModelRequest,
    ModelUnavailableError,
    ProviderState,
    TextDelta,
    ToolCall,
    ToolCallPart,
    ToolResultMessage,
    UserMessage,
    create_model,
)
from productivity_agent.core.llm.gemini import GeminiModel, api_error_message, to_contents
from productivity_agent.core.tools.types import ToolSpec
from productivity_agent.host.adapters import InMemorySecretStore


class FakeModels:
    def __init__(self, chunks: list[types.GenerateContentResponse]) -> None:
        self.chunks = chunks
        self.calls: list[dict[str, object]] = []

    async def generate_content_stream(
        self, *, model: str, contents: list[types.Content], config: types.GenerateContentConfig
    ) -> AsyncIterator[types.GenerateContentResponse]:
        self.calls.append({"model": model, "contents": contents, "config": config})

        async def gen() -> AsyncIterator[types.GenerateContentResponse]:
            for chunk in self.chunks:
                yield chunk

        return gen()


class FakeClient:
    def __init__(self, chunks: list[types.GenerateContentResponse]) -> None:
        self.models = FakeModels(chunks)


def chunk(
    *parts: types.Part, finish: types.FinishReason | None = None
) -> types.GenerateContentResponse:
    return types.GenerateContentResponse(
        candidates=[
            types.Candidate(
                content=types.Content(role="model", parts=list(parts)), finish_reason=finish
            )
        ]
    )


def collect(model: GeminiModel, request: ModelRequest) -> list[ModelPart]:
    async def go() -> list[ModelPart]:
        return [p async for p in model.stream(request)]

    return asyncio.run(go())


SPEC = ToolSpec(
    name="github_list_pull_requests",
    description="Lists PRs.",
    input_schema={"type": "object", "properties": {"limit": {"type": "integer"}}},
    effect="read",
)


def test_streams_text_and_sends_config() -> None:
    client = FakeClient(
        [
            chunk(types.Part(text="Hel")),
            chunk(types.Part(text="lo"), finish=types.FinishReason.STOP),
        ]
    )
    model = GeminiModel(client, "some-gemini-model")
    parts = collect(
        model, ModelRequest(system="be brief", messages=[UserMessage("hi")], tools=[SPEC])
    )

    assert parts[:2] == [TextDelta("Hel"), TextDelta("lo")]
    assert isinstance(parts[2], ProviderState)
    assert parts[3] == Finish("stop")

    [call] = client.models.calls
    assert call["model"] == "some-gemini-model"
    config = call["config"]
    assert isinstance(config, types.GenerateContentConfig)
    assert config.system_instruction == "be brief"
    assert config.automatic_function_calling is not None
    assert config.automatic_function_calling.disable is True
    assert config.tools is not None
    [tool] = config.tools
    assert isinstance(tool, types.Tool)
    [declaration] = tool.function_declarations or []
    assert declaration.name == "github_list_pull_requests"
    assert declaration.parameters_json_schema == SPEC.input_schema


def test_function_call_keeps_thought_signature_for_next_turn() -> None:
    call_part = types.Part(
        function_call=types.FunctionCall(id="fc-1", name="github_list_pull_requests", args={}),
        thought_signature=b"opaque-signature",
    )
    client = FakeClient([chunk(types.Part(text="thinking", thought=True)), chunk(call_part)])
    parts = collect(
        GeminiModel(client, "m"), ModelRequest(system="", messages=[UserMessage("PRs?")])
    )

    assert parts[0] == ToolCallPart(ToolCall("fc-1", "github_list_pull_requests", {}))
    assert parts[-1] == Finish("tool_calls")
    state = next(p for p in parts if isinstance(p, ProviderState))

    history: list[Message] = [
        UserMessage("PRs?"),
        AssistantMessage(
            "", (ToolCall("fc-1", "github_list_pull_requests", {}),), provider_state=state.value
        ),
        ToolResultMessage("fc-1", "github_list_pull_requests", {"untrusted_content": []}),
    ]
    contents = to_contents(history)
    assert contents[1] is state.value
    assert contents[1].parts is not None
    assert contents[1].parts[1].thought_signature == b"opaque-signature"
    response = contents[2].parts[0].function_response if contents[2].parts else None
    assert response is not None
    assert (response.id, response.name) == ("fc-1", "github_list_pull_requests")
    assert response.response == {"output": {"untrusted_content": []}}


def test_parallel_results_share_one_turn_and_generated_ids_stay_local() -> None:
    client = FakeClient(
        [chunk(types.Part(function_call=types.FunctionCall(name="a", args={"x": 1})))]
    )
    [call_part, *_] = collect(GeminiModel(client, "m"), ModelRequest(system="", messages=[]))
    assert isinstance(call_part, ToolCallPart)
    generated = call_part.call.id
    assert generated.startswith("gen-")

    contents = to_contents(
        [
            AssistantMessage("", (ToolCall(generated, "a", {}), ToolCall("fc-2", "b", {}))),
            ToolResultMessage(generated, "a", 1),
            ToolResultMessage("fc-2", "b", 2),
            UserMessage("thanks"),
        ]
    )
    assert [c.role for c in contents] == ["model", "user", "user"]
    responses = [p.function_response for p in contents[1].parts or []]
    assert [(r.id, r.name) for r in responses if r] == [(None, "a"), ("fc-2", "b")]


def test_max_tokens_maps_to_length() -> None:
    client = FakeClient([chunk(types.Part(text="…"), finish=types.FinishReason.MAX_TOKENS)])
    parts = collect(GeminiModel(client, "m"), ModelRequest(system="", messages=[]))
    assert parts[-1] == Finish("length")


def test_factory_needs_a_stored_api_key() -> None:
    config = LlmConfig(provider="gemini", model_id="m")
    with pytest.raises(ModelUnavailableError, match="Add your Gemini API key in Settings"):
        asyncio.run(create_model(config, InMemorySecretStore()))


def test_factory_creates_a_gemini_api_client(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    class RecordingClient:
        def __init__(self, **kwargs: object) -> None:
            seen.update(kwargs)
            self.aio = object()

    monkeypatch.setattr(genai, "Client", RecordingClient)
    secrets = InMemorySecretStore()
    asyncio.run(secrets.set(GEMINI_API_KEY, "test-key"))
    model = asyncio.run(create_model(LlmConfig(provider="gemini", model_id="m"), secrets))
    assert isinstance(model, GeminiModel)
    assert seen.keys() == {"api_key", "enterprise", "http_options"}
    assert (seen["api_key"], seen["enterprise"]) == ("test-key", False)
    http_options = seen["http_options"]
    assert isinstance(http_options, types.HttpOptions)
    retries = http_options.retry_options
    assert retries is not None
    assert retries.attempts == 3
    assert 503 in (retries.http_status_codes or [])
    assert 402 not in (retries.http_status_codes or [])  # Out of credit: retrying can't help.


def api_error(code: int, status: str, message: str = "details") -> errors.APIError:
    body = {"error": {"code": code, "status": status, "message": message}}
    return (errors.ServerError if code >= 500 else errors.ClientError)(code, body)


class FailingModels:
    """Raises when the call is made, or after streaming `chunks` if they are given."""

    def __init__(
        self, error: Exception, chunks: list[types.GenerateContentResponse] | None = None
    ) -> None:
        self.error = error
        self.chunks = chunks

    async def generate_content_stream(
        self, *, model: str, contents: list[types.Content], config: types.GenerateContentConfig
    ) -> AsyncIterator[types.GenerateContentResponse]:
        if self.chunks is None:
            raise self.error
        chunks, error = self.chunks, self.error

        async def gen() -> AsyncIterator[types.GenerateContentResponse]:
            for c in chunks:
                yield c
            raise error

        return gen()


class FailingClient:
    def __init__(self, models: FailingModels) -> None:
        self.models = models


def test_api_error_at_call_time_becomes_a_model_error() -> None:
    error = api_error(402, "RESOURCE_EXHAUSTED", "Your prepayment credits are depleted.")
    model = GeminiModel(FailingClient(FailingModels(error)), "m")
    with pytest.raises(ModelError, match="credits are used up") as raised:
        collect(model, ModelRequest(system="", messages=[]))
    assert raised.value.__cause__ is error


def test_api_error_mid_stream_keeps_the_text_already_streamed() -> None:
    models = FailingModels(api_error(503, "UNAVAILABLE"), [chunk(types.Part(text="Hel"))])
    model = GeminiModel(FailingClient(models), "m")
    seen: list[ModelPart] = []

    async def go() -> None:
        async for part in model.stream(ModelRequest(system="", messages=[])):
            seen.append(part)

    with pytest.raises(ModelError, match="error 503"):
        asyncio.run(go())
    assert seen == [TextDelta("Hel")]


@pytest.mark.parametrize(
    ("code", "status", "message", "expected"),
    [
        (400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", "API key"),
        (401, "UNAUTHENTICATED", "details", "API key"),
        (403, "PERMISSION_DENIED", "details", "API key"),
        (402, "RESOURCE_EXHAUSTED", "details", "credits are used up"),
        (404, "NOT_FOUND", "details", "model called 'gemini-x'"),
        (429, "RESOURCE_EXHAUSTED", "details", "rate limit or quota"),
        (500, "INTERNAL", "details", "having problems right now (error 500)"),
        (400, "INVALID_ARGUMENT", "Bad schema", "rejected the request (error 400)"),
    ],
)
def test_api_error_messages_tell_the_user_what_to_do(
    code: int, status: str, message: str, expected: str
) -> None:
    text = api_error_message(api_error(code, status, message), "gemini-x")
    assert expected in text
    assert message == "details" or message not in text  # Google's own text is never shown.


class StallingModels:
    """Never answers the call, or goes quiet after streaming `chunks` if they are given."""

    def __init__(self, chunks: list[types.GenerateContentResponse] | None = None) -> None:
        self.chunks = chunks
        self.closed = False

    async def generate_content_stream(
        self, *, model: str, contents: list[types.Content], config: types.GenerateContentConfig
    ) -> AsyncIterator[types.GenerateContentResponse]:
        if self.chunks is None:
            await asyncio.Event().wait()
        chunks = self.chunks or []

        async def gen() -> AsyncIterator[types.GenerateContentResponse]:
            try:
                for c in chunks:
                    yield c
                await asyncio.Event().wait()
            finally:
                self.closed = True

        return gen()


class StallingClient:
    def __init__(self, models: StallingModels) -> None:
        self.models = models


def test_no_response_at_all_times_out_with_a_model_error() -> None:
    model = GeminiModel(StallingClient(StallingModels()), "m", idle_timeout=0.05)
    with pytest.raises(ModelError, match=r"didn't respond for 0\.05 seconds"):
        collect(model, ModelRequest(system="", messages=[]))


def test_stream_going_quiet_times_out_and_closes_the_connection() -> None:
    models = StallingModels([chunk(types.Part(text="Hel"))])
    model = GeminiModel(StallingClient(models), "m", idle_timeout=0.05)
    seen: list[ModelPart] = []

    async def go() -> None:
        async for part in model.stream(ModelRequest(system="", messages=[])):
            seen.append(part)

    with pytest.raises(ModelError, match="didn't respond"):
        asyncio.run(go())
    assert seen == [TextDelta("Hel")]
    assert models.closed


def test_time_spent_by_the_caller_between_chunks_is_not_a_stall() -> None:
    client = FakeClient([chunk(types.Part(text="a")), chunk(types.Part(text="b"))])
    model = GeminiModel(client, "m", idle_timeout=0.05)

    async def slow_consumer() -> list[ModelPart]:
        parts = []
        async for part in model.stream(ModelRequest(system="", messages=[])):
            parts.append(part)
            await asyncio.sleep(0.1)  # e.g. waiting for the user to approve a tool call
        return parts

    parts = asyncio.run(slow_consumer())
    assert [p for p in parts if isinstance(p, TextDelta)] == [TextDelta("a"), TextDelta("b")]


def test_unreachable_network_becomes_a_model_error() -> None:
    error = httpx2.ConnectError("[Errno 8] nodename nor servname provided, or not known")
    model = GeminiModel(FailingClient(FailingModels(error)), "m")
    with pytest.raises(ModelError, match="Couldn't reach Gemini") as raised:
        collect(model, ModelRequest(system="", messages=[]))
    assert raised.value.__cause__ is error


def test_connection_dropped_mid_stream_keeps_the_text_already_streamed() -> None:
    models = FailingModels(httpx2.ReadError("connection reset"), [chunk(types.Part(text="Hel"))])
    model = GeminiModel(FailingClient(models), "m")
    seen: list[ModelPart] = []

    async def go() -> None:
        async for part in model.stream(ModelRequest(system="", messages=[])):
            seen.append(part)

    with pytest.raises(ModelError, match="connection to Gemini was interrupted"):
        asyncio.run(go())
    assert seen == [TextDelta("Hel")]


def closed_local_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
    return port  # Nothing listens here once the socket is closed.


def test_real_sdk_connection_failure_is_caught() -> None:
    """The real SDK and HTTP stack against a closed local port: no internet involved."""
    options = types.HttpOptions(base_url=f"http://127.0.0.1:{closed_local_port()}")
    client = genai.Client(api_key="test-key", enterprise=False, http_options=options)
    model = GeminiModel(client.aio, "m")
    with pytest.raises(ModelError, match="Couldn't reach Gemini"):
        collect(model, ModelRequest(system="", messages=[UserMessage("hi")]))
