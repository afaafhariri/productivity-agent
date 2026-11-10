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
            return MockModel.echo()
        case "vertex":
            raise NotImplementedError("The Vertex provider is not implemented yet.")
