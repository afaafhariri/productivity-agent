from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

from productivity_agent.core.json import JsonValue
from productivity_agent.core.ports import Clock, SecretStore

type ToolResult = JsonValue
"""Structured, JSON-serialisable tool output. Never a pre-formatted string for the user."""

type ToolEffect = Literal["read", "write"]


@dataclass(frozen=True, slots=True)
class ToolContext:
    """What a tool may use while executing. Built per call by the registry."""

    tool_call_id: str
    secrets: SecretStore
    clock: Clock


@dataclass(frozen=True, slots=True)
class AgentTool[I: BaseModel]:
    name: str
    """snake_case, e.g. github_list_pull_requests"""
    description: str
    """Written for the LLM: when to use it, what it returns."""
    input_model: type[I]
    effect: ToolEffect
    """`write` = changes state outside the app; always gated by the Confirmation port."""
    execute: Callable[[I, ToolContext], Awaitable[ToolResult]]


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """What the LLM sees for a tool."""

    name: str
    description: str
    input_schema: dict[str, JsonValue]
