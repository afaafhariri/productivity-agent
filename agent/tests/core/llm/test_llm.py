import asyncio

import pytest
from pydantic import ValidationError

from productivity_agent.core.llm import (
    Finish,
    LlmConfig,
    MockModel,
    ModelPart,
    ModelRequest,
    TextDelta,
    UserMessage,
    create_model,
)


def collect(model: MockModel, request: ModelRequest) -> list[ModelPart]:
    async def run() -> list[ModelPart]:
        return [part async for part in model.stream(request)]

    return asyncio.run(run())


def test_config_defaults_to_mock_when_unset_or_empty() -> None:
    assert LlmConfig.from_env({}).provider == "mock"
    assert LlmConfig.from_env({"LLM_PROVIDER": ""}).provider == "mock"


def test_config_reads_vertex_settings() -> None:
    config = LlmConfig.from_env(
        {
            "LLM_PROVIDER": "vertex",
            "LLM_MODEL_ID": "some-model",
            "GOOGLE_CLOUD_PROJECT": "proj",
            "GOOGLE_CLOUD_LOCATION": "europe-west1",
        }
    )
    assert config == LlmConfig(
        provider="vertex", model_id="some-model", project="proj", location="europe-west1"
    )


def test_config_rejects_unknown_provider() -> None:
    with pytest.raises(ValidationError):
        LlmConfig.from_env({"LLM_PROVIDER": "gateway"})


def test_factory_builds_mock_by_default() -> None:
    assert isinstance(create_model(LlmConfig()), MockModel)


def test_echo_streams_word_by_word() -> None:
    parts = collect(
        MockModel.echo(delay=0), ModelRequest(system="", messages=[UserMessage("hi there")])
    )
    assert parts[-1] == Finish()
    deltas = [p.text for p in parts if isinstance(p, TextDelta)]
    assert len(deltas) > 1
    assert "".join(deltas) == "(mock) You said: hi there"


def test_scripted_plays_turns_in_order_then_fails() -> None:
    model = MockModel.scripted([[TextDelta("a"), Finish()], [TextDelta("b"), Finish()]])
    request = ModelRequest(system="", messages=[])
    assert collect(model, request)[0] == TextDelta("a")
    assert collect(model, request)[0] == TextDelta("b")
    with pytest.raises(RuntimeError, match="exhausted"):
        collect(model, request)
