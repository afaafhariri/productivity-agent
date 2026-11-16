import os
from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

from productivity_agent.core.llm.mock import MockModel
from productivity_agent.core.llm.types import LanguageModel
from productivity_agent.core.ports import SecretStore

GEMINI_API_KEY = "gemini_api_key"
"""SecretStore key for the user's Gemini API key (from Google AI Studio)."""

_REMOVED_PROVIDERS = frozenset({"vertex", "agent_platform"})


class ModelUnavailableError(Exception):
    """The model can't be created yet for a reason the user can fix. The message is shown to
    the user, so it must never contain secrets."""


class LlmConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    provider: Literal["mock", "gemini"] = "mock"
    model_id: str | None = None

    @field_validator("provider", mode="before")
    @classmethod
    def _reject_removed_providers(cls, value: object) -> object:
        if value in _REMOVED_PROVIDERS:
            raise ValueError(
                f"LLM_PROVIDER={value} is no longer supported (Gemini Enterprise Agent Platform "
                "was removed); use LLM_PROVIDER=gemini and add your API key in Settings"
            )
        return value

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> LlmConfig:
        """Reads LLM_PROVIDER and LLM_MODEL_ID. The API key is never read from the environment."""

        def get(name: str) -> str | None:
            return env.get(name) or None

        return cls.model_validate(
            {"provider": get("LLM_PROVIDER") or "mock", "model_id": get("LLM_MODEL_ID")}
        )

    def check(self) -> None:
        """Raises ValueError for configuration that only a restart can fix."""
        if self.provider == "gemini" and not self.model_id:
            raise ValueError("LLM_PROVIDER=gemini needs LLM_MODEL_ID to be set")


async def create_model(config: LlmConfig, secrets: SecretStore) -> LanguageModel:
    """Builds the configured model.

    Raises ValueError for bad configuration and ModelUnavailableError when the Gemini API key
    hasn't been added yet.
    """
    config.check()
    match config.provider:
        case "mock":
            return MockModel.demo()
        case "gemini":
            return await _gemini(config.model_id or "", secrets)


async def _gemini(model_id: str, secrets: SecretStore) -> LanguageModel:
    api_key = await secrets.get(GEMINI_API_KEY)
    if not api_key:
        raise ModelUnavailableError("Add your Gemini API key in Settings to start chatting.")

    # Imported lazily: the SDK is large and the mock provider never needs it.
    from google import genai

    from productivity_agent.core.llm.gemini import GeminiModel

    # `enterprise=False` so a stray GOOGLE_GENAI_USE_ENTERPRISE / _VERTEXAI env var can't
    # redirect the key to Agent Platform endpoints.
    client = genai.Client(api_key=api_key, enterprise=False)
    return GeminiModel(client.aio, model_id)
