"""GeminiModel against a fake google-genai client: no network, no credentials."""

import asyncio
from collections.abc import AsyncIterator

import pytest
from google import genai
from google.genai import types

from productivity_agent.core.llm import (
    GEMINI_API_KEY,
    AssistantMessage,
    Finish,
    LlmConfig,
    Message,
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
from productivity_agent.core.llm.gemini import GeminiModel, to_contents
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
    assert seen == {"api_key": "test-key", "enterprise": False}
