import asyncio
import itertools
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import pytest
from fakes import FixedClock, NoSecrets
from pydantic import BaseModel

from productivity_agent.core.json import JsonValue
from productivity_agent.core.llm import (
    Finish,
    LanguageModel,
    LlmConfig,
    MockModel,
    TextDelta,
    ToolCall,
    ToolCallPart,
)
from productivity_agent.core.tools import AgentTool, ToolContext, ToolRegistry
from productivity_agent.rpc import protocol
from productivity_agent.rpc.server import RpcServer

TIMEOUT = 2.0


class Pipe:
    """In-memory stand-in for stdin/stdout."""

    def __init__(self) -> None:
        self.inbound: asyncio.Queue[bytes | None] = asyncio.Queue()
        self.outbound: asyncio.Queue[str] = asyncio.Queue()

    async def read_line(self) -> bytes | None:
        return await self.inbound.get()

    async def write_line(self, line: str) -> None:
        await self.outbound.put(line)


class Client:
    def __init__(self, pipe: Pipe) -> None:
        self.pipe = pipe
        self._ids = itertools.count(1)

    def send_raw(self, line: bytes) -> None:
        self.pipe.inbound.put_nowait(line)

    def send(self, method: str, params: dict[str, JsonValue] | None = None) -> int:
        request_id = next(self._ids)
        message: dict[str, JsonValue] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self.send_raw(json.dumps(message).encode())
        return request_id

    async def recv(self) -> dict[str, Any]:
        line = await asyncio.wait_for(self.pipe.outbound.get(), TIMEOUT)
        assert "\n" not in line
        message: dict[str, Any] = json.loads(line)
        assert message["jsonrpc"] == "2.0"
        return message

    async def call(self, method: str, params: dict[str, JsonValue] | None = None) -> dict[str, Any]:
        """Sends a request and returns its response (events in between are not expected)."""
        request_id = self.send(method, params)
        response = await self.recv()
        assert response["id"] == request_id
        return response

    async def initialize(self) -> None:
        response = await self.call("initialize", {"protocol_version": protocol.PROTOCOL_VERSION})
        assert response["result"]["protocol_version"] == protocol.PROTOCOL_VERSION

    async def events_until_done(self, run_id: str) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        while True:
            message = await self.recv()
            assert message["method"] == "run.event"
            assert message["params"]["run_id"] == run_id
            events.append(message["params"]["event"])
            if events[-1]["type"] in ("done", "error"):
                return events


class SendInput(BaseModel):
    to: str


sent: list[str] = []


async def send_email(args: SendInput, ctx: ToolContext) -> JsonValue:
    sent.append(args.to)
    return {"sent": True}


def make_registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(AgentTool("email_send", "Sends an email.", SendInput, "write", send_email))
    return registry


def send_then_reply() -> MockModel:
    return MockModel.scripted(
        [
            [ToolCallPart(ToolCall("c1", "email_send", {"to": "a@example.com"})), Finish()],
            [TextDelta("Done."), Finish()],
        ]
    )


type Scenario = Callable[[Client], Awaitable[None]]


def run_scenario(scenario: Scenario, model: LanguageModel | None = None) -> None:
    async def main() -> None:
        pipe = Pipe()
        ids = (f"run{i}" for i in itertools.count(1))
        server = RpcServer(
            writer=pipe,
            model=model or MockModel.echo(delay=0),
            llm_config=LlmConfig(),
            registry=make_registry(),
            secrets=NoSecrets(),
            clock=FixedClock(),
            new_id=lambda: next(ids),
        )
        serving = asyncio.create_task(server.serve(pipe))
        try:
            await scenario(Client(pipe))
        finally:
            pipe.inbound.put_nowait(None)  # EOF
            await asyncio.wait_for(serving, TIMEOUT)

    asyncio.run(main())


def test_initialize_handshake_and_version_check() -> None:
    async def scenario(client: Client) -> None:
        bad = await client.call("initialize", {"protocol_version": 999})
        assert bad["error"]["code"] == protocol.INVALID_PARAMS
        assert bad["error"]["data"] == {"supported": protocol.PROTOCOL_VERSION}
        await client.initialize()

    run_scenario(scenario)


def test_methods_require_initialize() -> None:
    async def scenario(client: Client) -> None:
        response = await client.call("run.start", {"conversation_id": "c", "text": "hi"})
        assert response["error"]["code"] == protocol.NOT_INITIALIZED

    run_scenario(scenario)


@pytest.mark.parametrize(
    ("line", "code"),
    [
        (b"{not json", protocol.PARSE_ERROR),
        (b"\xff\xfe", protocol.PARSE_ERROR),
        (b'{"jsonrpc":"1.0","id":1,"method":"x"}', protocol.INVALID_REQUEST),
        (b"[1,2,3]", protocol.INVALID_REQUEST),
        (b"x" * (protocol.MAX_LINE_BYTES + 1), protocol.INVALID_REQUEST),
    ],
)
def test_malformed_input_gets_error_responses(line: bytes, code: int) -> None:
    async def scenario(client: Client) -> None:
        client.send_raw(line)
        response = await client.recv()
        assert response["error"]["code"] == code

    run_scenario(scenario)


def test_unknown_method_and_invalid_params() -> None:
    async def scenario(client: Client) -> None:
        await client.initialize()
        assert (await client.call("nope"))["error"]["code"] == protocol.METHOD_NOT_FOUND
        invalid: list[dict[str, JsonValue]] = [
            {"conversation_id": "c", "text": ""},
            {"conversation_id": "c", "text": "hi", "extra": 1},
            {"text": "hi"},
        ]
        for params in invalid:
            response = await client.call("run.start", params)
            assert response["error"]["code"] == protocol.INVALID_PARAMS

    run_scenario(scenario)


def test_run_streams_text_and_keeps_conversation() -> None:
    async def scenario(client: Client) -> None:
        await client.initialize()
        response = await client.call("run.start", {"conversation_id": "c", "text": "hello there"})
        run_id = response["result"]["run_id"]
        events = await client.events_until_done(run_id)
        text = "".join(e["text"] for e in events if e["type"] == "text_delta")
        assert text == "(mock) You said: hello there"
        assert events[-1] == {"type": "done", "reason": "stop"}

        second = await client.call("run.start", {"conversation_id": "c", "text": "again"})
        assert second["result"]["run_id"] != run_id
        await client.events_until_done(second["result"]["run_id"])

    run_scenario(scenario)


def test_cancel_stops_a_streaming_run() -> None:
    async def scenario(client: Client) -> None:
        await client.initialize()
        run_id = (await client.call("run.start", {"conversation_id": "c", "text": "a b c d e"}))[
            "result"
        ]["run_id"]
        first = await client.recv()
        assert first["params"]["event"]["type"] == "text_delta"

        cancel_id = client.send("run.cancel", {"run_id": run_id})
        messages = [await client.recv(), await client.recv()]
        ack = next(m for m in messages if m.get("id") == cancel_id)
        assert ack["result"] == {"ok": True}
        done = next(m for m in messages if m.get("method") == "run.event")
        assert done["params"]["event"] == {"type": "done", "reason": "cancelled"}

        # The conversation is free again.
        again = await client.call("run.start", {"conversation_id": "c", "text": "x"})
        await client.events_until_done(again["result"]["run_id"])

    run_scenario(scenario, MockModel.echo(delay=0.05))


def test_cancel_unknown_run() -> None:
    async def scenario(client: Client) -> None:
        await client.initialize()
        response = await client.call("run.cancel", {"run_id": "missing"})
        assert response["error"]["code"] == protocol.RUN_NOT_FOUND

    run_scenario(scenario)


def test_one_run_per_conversation() -> None:
    async def scenario(client: Client) -> None:
        await client.initialize()
        await client.call("run.start", {"conversation_id": "c", "text": "a b c"})
        busy = await client.call("run.start", {"conversation_id": "c", "text": "x"})
        assert busy["error"]["code"] == protocol.CONVERSATION_BUSY

    run_scenario(scenario, MockModel.echo(delay=0.05))


async def start_and_wait_for_confirmation(client: Client) -> tuple[str, dict[str, Any]]:
    await client.initialize()
    run_id = (await client.call("run.start", {"conversation_id": "c", "text": "email a"}))[
        "result"
    ]["run_id"]
    tool_call = await client.recv()
    assert tool_call["params"]["event"]["type"] == "tool_call"
    request = (await client.recv())["params"]["event"]
    return run_id, request


def test_write_tool_waits_for_approval_over_rpc() -> None:
    sent.clear()

    async def scenario(client: Client) -> None:
        run_id, request = await start_and_wait_for_confirmation(client)
        assert request == {
            "type": "confirmation_request",
            "tool_call_id": "c1",
            "tool_name": "email_send",
            "description": "Sends an email.",
            "input": {"to": "a@example.com"},
        }
        assert sent == []

        ack = await client.call(
            "confirmation.respond", {"run_id": run_id, "tool_call_id": "c1", "approved": True}
        )
        assert ack["result"] == {"ok": True}
        events = await client.events_until_done(run_id)
        assert events[0] == {
            "type": "tool_result",
            "tool_call_id": "c1",
            "tool_name": "email_send",
            "result": {"sent": True},
        }
        assert sent == ["a@example.com"]

        stale = await client.call(
            "confirmation.respond", {"run_id": run_id, "tool_call_id": "c1", "approved": True}
        )
        assert stale["error"]["code"] == protocol.RUN_NOT_FOUND

    run_scenario(scenario, send_then_reply())


def test_rejection_over_rpc_never_sends() -> None:
    sent.clear()

    async def scenario(client: Client) -> None:
        run_id, _ = await start_and_wait_for_confirmation(client)
        wrong_call = await client.call(
            "confirmation.respond", {"run_id": run_id, "tool_call_id": "zzz", "approved": True}
        )
        assert wrong_call["error"]["code"] == protocol.CONFIRMATION_NOT_FOUND

        await client.call(
            "confirmation.respond",
            {"run_id": run_id, "tool_call_id": "c1", "approved": False, "reason": "no"},
        )
        events = await client.events_until_done(run_id)
        assert events[0]["result"] == {"status": "rejected", "reason": "no"}
        assert sent == []

    run_scenario(scenario, send_then_reply())


def test_eof_while_awaiting_approval_never_sends() -> None:
    sent.clear()

    async def scenario(client: Client) -> None:
        await start_and_wait_for_confirmation(client)

    run_scenario(scenario, send_then_reply())  # run_scenario sends EOF afterwards
    assert sent == []


class FailingModel:
    async def stream(self, request: object) -> AsyncIterator[Any]:
        raise RuntimeError("provider exploded with token xyz")
        yield


def test_model_failure_becomes_generic_error_event() -> None:
    async def scenario(client: Client) -> None:
        await client.initialize()
        run_id = (await client.call("run.start", {"conversation_id": "c", "text": "hi"}))["result"][
            "run_id"
        ]
        events = await client.events_until_done(run_id)
        assert events == [{"type": "error", "message": "The run failed. See logs."}]

    run_scenario(scenario, FailingModel())


def test_settings_describe_config_and_tools_without_secrets() -> None:
    async def scenario(client: Client) -> None:
        await client.initialize()
        response = await client.call("settings.get", {})
        assert response["result"] == {
            "llm_provider": "mock",
            "llm_model_id": None,
            "google_cloud_project": None,
            "google_cloud_location": None,
            "tools": [{"name": "email_send", "description": "Sends an email.", "effect": "write"}],
        }

    run_scenario(scenario)
