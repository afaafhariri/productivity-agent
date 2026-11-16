"""Wire format between the desktop app and this backend: JSON-RPC 2.0, one message per line.

Mirrored in Rust (serde) in app/src/backend/. Bump PROTOCOL_VERSION on breaking changes.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from productivity_agent.core.json import JsonValue

PROTOCOL_VERSION = 2
MAX_LINE_BYTES = 1_000_000

# JSON-RPC 2.0 error codes, plus application codes in the -32000..-32099 range.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
NOT_INITIALIZED = -32001
RUN_NOT_FOUND = -32002
CONVERSATION_BUSY = -32003
CONFIRMATION_NOT_FOUND = -32004


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


type RequestId = int | str


class RpcRequest(_Strict):
    jsonrpc: Literal["2.0"]
    method: Annotated[str, Field(min_length=1, max_length=64)]
    params: dict[str, JsonValue] | None = None
    id: RequestId | None = None
    """Absent for notifications, which get no response."""


# --- Client → server params and results ---------------------------------------------------

Id = Annotated[str, Field(min_length=1, max_length=128)]


class InitializeParams(_Strict):
    protocol_version: int
    client_name: Annotated[str, Field(max_length=128)] | None = None


class InitializeResult(_Strict):
    protocol_version: int
    server_name: str
    server_version: str


class RunStartParams(_Strict):
    conversation_id: Id
    text: Annotated[str, Field(min_length=1, max_length=32_000)]


class RunStartResult(_Strict):
    run_id: str


class Ack(_Strict):
    ok: Literal[True] = True


class RunCancelParams(_Strict):
    run_id: Id


class ConfirmationRespondParams(_Strict):
    run_id: Id
    tool_call_id: Id
    approved: bool
    reason: Annotated[str, Field(max_length=500)] | None = None


class SettingsGetParams(_Strict):
    pass


class ToolInfo(_Strict):
    name: str
    description: str
    effect: Literal["read", "write"]


class SettingsResult(_Strict):
    """Non-secret, read-only view of the backend's configuration."""

    llm_provider: str
    llm_model_id: str | None
    gemini_api_key_set: bool
    """Whether a Gemini API key is stored. The key itself is never sent to the app."""
    tools: list[ToolInfo]


type SecretName = Literal["gemini_api_key"]


class SecretsSetParams(_Strict):
    """Write-only: the backend stores the value in the OS keychain and never sends it back."""

    name: SecretName
    value: Annotated[SecretStr, Field(min_length=1, max_length=512)]


class SecretsDeleteParams(_Strict):
    name: SecretName


# --- Server → client events (method "run.event") ------------------------------------------


class TextDelta(_Strict):
    type: Literal["text_delta"] = "text_delta"
    text: str


class ToolCall(_Strict):
    type: Literal["tool_call"] = "tool_call"
    tool_call_id: str
    tool_name: str
    input: JsonValue


class ToolResult(_Strict):
    type: Literal["tool_result"] = "tool_result"
    tool_call_id: str
    tool_name: str
    result: JsonValue


class ConfirmationRequest(_Strict):
    type: Literal["confirmation_request"] = "confirmation_request"
    tool_call_id: str
    tool_name: str
    description: str
    input: JsonValue


class Done(_Strict):
    type: Literal["done"] = "done"
    reason: Literal["stop", "max_steps", "cancelled"]


class Error(_Strict):
    type: Literal["error"] = "error"
    message: str


type RunEvent = TextDelta | ToolCall | ToolResult | ConfirmationRequest | Done | Error


class RunEventParams(_Strict):
    run_id: str
    event: Annotated[RunEvent, Field(discriminator="type")]
