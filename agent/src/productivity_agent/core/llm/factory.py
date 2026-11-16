import os
from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel, ConfigDict

from productivity_agent.core.llm.mock import MockModel
from productivity_agent.core.llm.types import LanguageModel


class LlmConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    provider: Literal["mock", "vertex"] = "mock"
    model_id: str | None = None
    project: str | None = None
    location: str | None = None

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
        case "vertex":
            return _vertex(config)


def _vertex(config: LlmConfig) -> LanguageModel:
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
        raise ValueError(f"LLM_PROVIDER=vertex needs {', '.join(missing)} to be set")

    # Imported lazily: the SDK is large and the mock provider never needs it.
    from google import genai

    from productivity_agent.core.llm.vertex import VertexModel

    client = genai.Client(vertexai=True, project=config.project, location=config.location)
    return VertexModel(client.aio, config.model_id)
