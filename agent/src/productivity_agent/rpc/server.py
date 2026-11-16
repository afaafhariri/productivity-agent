"""JSON-RPC server: the only bridge between the desktop app and the agent core."""

import asyncio
import contextlib
import json
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import BaseModel, ValidationError

import productivity_agent
from productivity_agent.core.agent import (
    DoneEvent,
    TextDeltaEvent,
    ToolCallEvent,
    ToolResultEvent,
    run_agent,
)
from productivity_agent.core.agent.loop import AgentEvent
from productivity_agent.core.json import JsonValue
from productivity_agent.core.llm import LanguageModel, LlmConfig, Message, UserMessage
from productivity_agent.core.ports import Approved, Clock, Rejected, SecretStore
from productivity_agent.core.tools import ToolRegistry, ToolRuntime
from productivity_agent.rpc import protocol
from productivity_agent.rpc.confirmation import RpcConfirmation

logger = logging.getLogger(__name__)


class LineReader(Protocol):
    async def read_line(self) -> bytes | None:
        """Next line without its newline, or None at end of input."""
        ...


class LineWriter(Protocol):
    async def write_line(self, line: str) -> None: ...


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: JsonValue = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


@dataclass(slots=True)
class _Run:
    conversation_id: str
    confirmation: RpcConfirmation
    task: asyncio.Task[None] | None = None
    finished: bool = False
    """True once a terminal event (done/error) was sent."""


@dataclass(slots=True)
class _State:
    initialized: bool = False
    conversations: dict[str, list[Message]] = field(default_factory=dict)
    runs: dict[str, _Run] = field(default_factory=dict)


class RpcServer:
    def __init__(
        self,
        *,
        writer: LineWriter,
        model: LanguageModel,
        llm_config: LlmConfig,
        registry: ToolRegistry,
        secrets: SecretStore,
        clock: Clock,
        new_id: Callable[[], str] = lambda: uuid.uuid4().hex,
    ) -> None:
        self._writer = writer
        self._model = model
        self._llm_config = llm_config
        self._registry = registry
        self._secrets = secrets
        self._clock = clock
        self._new_id = new_id
        self._state = _State()
        self._write_lock = asyncio.Lock()
        self._background: set[asyncio.Task[None]] = set()

    async def serve(self, reader: LineReader) -> None:
        """Handles messages until end of input, then cancels any active runs."""
        try:
            while (line := await reader.read_line()) is not None:
                if line.strip():
                    await self._handle_line(line)
        finally:
            await self._cancel_all_runs()

    # --- transport ------------------------------------------------------------------------

    async def _send(self, message: dict[str, JsonValue]) -> None:
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        async with self._write_lock:
            await self._writer.write_line(line)

    async def _send_result(self, request_id: protocol.RequestId, result: BaseModel) -> None:
        await self._send(
            {"jsonrpc": "2.0", "id": request_id, "result": result.model_dump(mode="json")}
        )

    async def _send_error(self, request_id: protocol.RequestId | None, error: RpcError) -> None:
        body: dict[str, JsonValue] = {"code": error.code, "message": error.message}
        if error.data is not None:
            body["data"] = error.data
        await self._send({"jsonrpc": "2.0", "id": request_id, "error": body})

    async def _send_event(self, run_id: str, event: protocol.RunEvent) -> None:
        params = protocol.RunEventParams(run_id=run_id, event=event)
        await self._send(
            {"jsonrpc": "2.0", "method": "run.event", "params": params.model_dump(mode="json")}
        )

    async def _handle_line(self, line: bytes) -> None:
        if len(line) > protocol.MAX_LINE_BYTES:
            await self._send_error(None, RpcError(protocol.INVALID_REQUEST, "Message too large"))
            return
        try:
            raw = json.loads(line)
        except UnicodeDecodeError, json.JSONDecodeError:
            await self._send_error(None, RpcError(protocol.PARSE_ERROR, "Parse error"))
            return
        try:
            request = protocol.RpcRequest.model_validate(raw)
        except ValidationError:
            request_id = raw.get("id") if isinstance(raw, dict) else None
            valid_id = request_id if isinstance(request_id, int | str) else None
            await self._send_error(valid_id, RpcError(protocol.INVALID_REQUEST, "Invalid request"))
            return

        try:
            result = await self._dispatch(request)
        except RpcError as error:
            if request.id is not None:
                await self._send_error(request.id, error)
            return
        except Exception:
            logger.exception("request failed", extra={"method": request.method})
            if request.id is not None:
                await self._send_error(
                    request.id, RpcError(protocol.INTERNAL_ERROR, "Internal error")
                )
            return
        if request.id is not None:
            await self._send_result(request.id, result)

    # --- methods --------------------------------------------------------------------------

    async def _dispatch(self, request: protocol.RpcRequest) -> BaseModel:
        params = request.params or {}
        if request.method == "initialize":
            return self._initialize(_parse(protocol.InitializeParams, params))
        if not self._state.initialized:
            raise RpcError(protocol.NOT_INITIALIZED, "Call initialize first")
        match request.method:
            case "run.start":
                return self._run_start(_parse(protocol.RunStartParams, params))
            case "run.cancel":
                return self._run_cancel(_parse(protocol.RunCancelParams, params))
            case "settings.get":
                _parse(protocol.SettingsGetParams, params)
                return self._settings()
            case "confirmation.respond":
                return self._confirmation_respond(
                    _parse(protocol.ConfirmationRespondParams, params)
                )
            case _:
                raise RpcError(protocol.METHOD_NOT_FOUND, f"Method not found: {request.method}")

    def _initialize(self, params: protocol.InitializeParams) -> protocol.InitializeResult:
        if params.protocol_version != protocol.PROTOCOL_VERSION:
            raise RpcError(
                protocol.INVALID_PARAMS,
                "Unsupported protocol version",
                {"supported": protocol.PROTOCOL_VERSION},
            )
        self._state.initialized = True
        return protocol.InitializeResult(
            protocol_version=protocol.PROTOCOL_VERSION,
            server_name="productivity-agent",
            server_version=productivity_agent.__version__,
        )

    def _settings(self) -> protocol.SettingsResult:
        config = self._llm_config
        return protocol.SettingsResult(
            llm_provider=config.provider,
            llm_model_id=config.model_id,
            google_cloud_project=config.project,
            google_cloud_location=config.location,
            tools=[
                protocol.ToolInfo(name=s.name, description=s.description, effect=s.effect)
                for s in self._registry.specs()
            ],
        )

    def _run_start(self, params: protocol.RunStartParams) -> protocol.RunStartResult:
        if any(r.conversation_id == params.conversation_id for r in self._state.runs.values()):
            raise RpcError(
                protocol.CONVERSATION_BUSY, "A run is already active in this conversation"
            )
        run_id = self._new_id()

        async def send(event: protocol.RunEvent) -> None:
            await self._send_event(run_id, event)

        run = _Run(params.conversation_id, RpcConfirmation(send))
        history = self._state.conversations.setdefault(params.conversation_id, [])
        history.append(UserMessage(params.text))
        self._state.runs[run_id] = run
        run.task = asyncio.create_task(self._run(run_id, run, history))
        run.task.add_done_callback(lambda _: self._on_run_finished(run_id, run))
        return protocol.RunStartResult(run_id=run_id)

    def _run_cancel(self, params: protocol.RunCancelParams) -> protocol.Ack:
        run = self._state.runs.get(params.run_id)
        if run is None or run.task is None:
            raise RpcError(protocol.RUN_NOT_FOUND, "No active run with that id")
        run.task.cancel()
        return protocol.Ack()

    def _confirmation_respond(self, params: protocol.ConfirmationRespondParams) -> protocol.Ack:
        run = self._state.runs.get(params.run_id)
        if run is None:
            raise RpcError(protocol.RUN_NOT_FOUND, "No active run with that id")
        decision = Approved() if params.approved else Rejected(params.reason)
        if not run.confirmation.respond(params.tool_call_id, decision):
            raise RpcError(protocol.CONFIRMATION_NOT_FOUND, "No pending confirmation for that call")
        return protocol.Ack()

    # --- runs -----------------------------------------------------------------------------

    async def _run(self, run_id: str, run: _Run, history: list[Message]) -> None:
        runtime = ToolRuntime(
            confirmation=run.confirmation, secrets=self._secrets, clock=self._clock
        )
        terminal: protocol.RunEvent
        try:
            async for event in run_agent(
                model=self._model, registry=self._registry, runtime=runtime, history=history
            ):
                await self._send_event(run_id, _to_wire(event))
            run.finished = True
            return
        except asyncio.CancelledError:
            terminal = protocol.Done(reason="cancelled")
        except Exception:
            logger.exception("run failed", extra={"run_id": run_id})
            terminal = protocol.Error(message="The run failed. See logs.")
        await self._finish(run_id, run, terminal)

    async def _finish(self, run_id: str, run: _Run, terminal: protocol.RunEvent) -> None:
        if run.finished:
            return
        run.finished = True
        with contextlib.suppress(Exception):  # The app may already be gone.
            await self._send_event(run_id, terminal)

    def _on_run_finished(self, run_id: str, run: _Run) -> None:
        self._state.runs.pop(run_id, None)
        if not run.finished:
            # Cancelled before it started running: still tell the app the run ended.
            task = asyncio.create_task(self._finish(run_id, run, protocol.Done(reason="cancelled")))
            self._background.add(task)
            task.add_done_callback(self._background.discard)

    async def _cancel_all_runs(self) -> None:
        tasks = [r.task for r in self._state.runs.values() if r.task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(*self._background, return_exceptions=True)


def _parse[M: BaseModel](model: type[M], params: dict[str, JsonValue]) -> M:
    try:
        return model.model_validate(params)
    except ValidationError as error:
        details: JsonValue = [
            {"loc": ".".join(str(p) for p in e["loc"]), "msg": e["msg"]}
            for e in error.errors(include_url=False)
        ]
        raise RpcError(protocol.INVALID_PARAMS, "Invalid params", details) from error


def _to_wire(event: AgentEvent) -> protocol.RunEvent:
    match event:
        case TextDeltaEvent(text=text):
            return protocol.TextDelta(text=text)
        case ToolCallEvent(tool_call_id=call_id, tool_name=name, input=args):
            return protocol.ToolCall(tool_call_id=call_id, tool_name=name, input=args)
        case ToolResultEvent(tool_call_id=call_id, tool_name=name, result=result):
            return protocol.ToolResult(tool_call_id=call_id, tool_name=name, result=result)
        case DoneEvent(reason=reason):
            return protocol.Done(reason=reason)
