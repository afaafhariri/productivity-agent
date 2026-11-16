import os
from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

from productivity_agent.core.llm.mock import MockModel
from productivity_agent.core.llm.types import LanguageModel

# Old provider names still accepted in LLM_PROVIDER, mapped to the current one.
_PROVIDER_ALIASES = {"vertex": "agent_platform"}


class LlmConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    provider: Literal["mock", "agent_platform"] = "mock"
    model_id: str | None = None
    project: str | None = None
    location: str | None = None

    @field_validator("provider", mode="before")
    @classmethod
    def _resolve_alias(cls, value: object) -> object:
        return _PROVIDER_ALIASES.get(value, value) if isinstance(value, str) else value

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> LlmConfig:
        """Reads LLM_PROVIDER, LLM_MODEL_ID, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION."""

        def get(name: str) -> str | None:
            return env.get(name) or None

        return cls.model_validate(
            {
                "provider": get("LLM_PROVIDER") or "mock",
                "model_id": get("LLM_MODEL_ID"),
                "project": get("GOOGLE_CLOUD_PROJECT"),
                "location": get("GOOGLE_CLOUD_LOCATION"),
            }
        )


def create_model(config: LlmConfig) -> LanguageModel:
    match config.provider:
        case "mock":
            return MockModel.demo()
        case "agent_platform":
            return _agent_platform(config)


def _agent_platform(config: LlmConfig) -> LanguageModel:
    missing = [
        name
        for name, value in (
            ("LLM_MODEL_ID", config.model_id),
            ("GOOGLE_CLOUD_PROJECT", config.project),
            ("GOOGLE_CLOUD_LOCATION", config.location),
        )
        if not value
    ]
    if missing or config.model_id is None:
        raise ValueError(f"LLM_PROVIDER=agent_platform needs {', '.join(missing)} to be set")

    # Imported lazily: the SDK is large and the mock provider never needs it.
    from google import genai

    from productivity_agent.core.llm.agent_platform import AgentPlatformModel

    # `enterprise=True` selects Agent Platform endpoints; `vertexai=True` is its legacy alias.
    client = genai.Client(enterprise=True, project=config.project, location=config.location)
    return AgentPlatformModel(client.aio, config.model_id)
