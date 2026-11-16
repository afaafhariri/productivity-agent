import asyncio

import pytest
from fakes import NoSecrets
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


def test_config_reads_gemini_settings() -> None:
    config = LlmConfig.from_env({"LLM_PROVIDER": "gemini", "LLM_MODEL_ID": "some-model"})
    assert config == LlmConfig(provider="gemini", model_id="some-model")


def test_config_never_reads_an_api_key_from_env() -> None:
    env = {"LLM_PROVIDER": "gemini", "GEMINI_API_KEY": "k", "GOOGLE_API_KEY": "k"}
    assert LlmConfig.from_env(env) == LlmConfig(provider="gemini")


@pytest.mark.parametrize("removed", ["vertex", "agent_platform"])
def test_config_explains_removed_providers(removed: str) -> None:
    with pytest.raises(ValidationError, match="use LLM_PROVIDER=gemini"):
        LlmConfig.from_env({"LLM_PROVIDER": removed})


def test_gemini_config_needs_a_model_id() -> None:
    with pytest.raises(ValueError, match="LLM_MODEL_ID"):
        LlmConfig(provider="gemini").check()
    LlmConfig(provider="gemini", model_id="m").check()
    LlmConfig().check()


def test_config_rejects_unknown_provider() -> None:
    with pytest.raises(ValidationError):
        LlmConfig.from_env({"LLM_PROVIDER": "gateway"})


def test_factory_builds_mock_by_default() -> None:
    assert isinstance(asyncio.run(create_model(LlmConfig(), NoSecrets())), MockModel)


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
