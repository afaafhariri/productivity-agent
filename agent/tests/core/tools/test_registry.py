import asyncio

import pytest
from fakes import BlockingConfirmation, FakeConfirmation, runtime
from pydantic import BaseModel

from productivity_agent.core.json import JsonValue
from productivity_agent.core.ports import Approved, ConfirmationRequest, Rejected
from productivity_agent.core.tools import (
    AgentTool,
    ToolContext,
    ToolInputError,
    ToolRegistry,
    UnknownToolError,
)


class EchoInput(BaseModel):
    text: str


class SendInput(BaseModel):
    to: str


async def echo(args: EchoInput, ctx: ToolContext) -> JsonValue:
    return {"echoed": args.text}


ECHO = AgentTool(
    name="echo_read",
    description="Echoes the input.",
    input_model=EchoInput,
    effect="read",
    execute=echo,
)


class SendTool:
    """A write tool that records whether it ran."""

    def __init__(self) -> None:
        self.calls: list[SendInput] = []
        self.tool = AgentTool(
            name="send_thing",
            description="Sends a thing.",
            input_model=SendInput,
            effect="write",
            execute=self._execute,
        )

    async def _execute(self, args: SendInput, ctx: ToolContext) -> JsonValue:
        self.calls.append(args)
        return {"sent": True}


def registry_with[I: BaseModel](tool: AgentTool[I]) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(tool)
    return registry


def test_rejects_bad_and_duplicate_names() -> None:
    registry = registry_with(ECHO)
    with pytest.raises(ValueError, match="already registered"):
        registry.register(ECHO)
    with pytest.raises(ValueError, match="snake_case"):
        registry.register(AgentTool("EchoRead", "x", EchoInput, "read", echo))


def test_specs_expose_json_schema() -> None:
    [spec] = registry_with(ECHO).specs()
    assert spec.name == "echo_read"
    assert spec.input_schema["properties"] == {"text": {"title": "Text", "type": "string"}}


def test_read_tool_runs_without_confirmation() -> None:
    confirmation = FakeConfirmation()
    result = asyncio.run(
        registry_with(ECHO).call(
            "echo_read", {"text": "hi"}, tool_call_id="c1", runtime=runtime(confirmation)
        )
    )
    assert result == {"echoed": "hi"}
    assert confirmation.requests == []


def test_write_tool_asks_with_exact_input_then_runs() -> None:
    send = SendTool()
    confirmation = FakeConfirmation(Approved())
    result = asyncio.run(
        registry_with(send.tool).call(
            "send_thing", {"to": "a@b.c"}, tool_call_id="c1", runtime=runtime(confirmation)
        )
    )
    assert result == {"sent": True}
    assert confirmation.requests == [
        ConfirmationRequest(
            tool_call_id="c1",
            tool_name="send_thing",
            description="Sends a thing.",
            input={"to": "a@b.c"},
        )
    ]
    assert send.calls == [SendInput(to="a@b.c")]


def test_rejected_write_tool_never_runs() -> None:
    send = SendTool()
    result = asyncio.run(
        registry_with(send.tool).call(
            "send_thing",
            {"to": "a@b.c"},
            tool_call_id="c1",
            runtime=runtime(FakeConfirmation(Rejected("no"))),
        )
    )
    assert result == {"status": "rejected", "reason": "no"}
    assert send.calls == []


def test_cancelled_while_awaiting_confirmation_never_runs() -> None:
    send = SendTool()
    confirmation = BlockingConfirmation()

    async def scenario() -> None:
        call = asyncio.create_task(
            registry_with(send.tool).call(
                "send_thing", {"to": "a@b.c"}, tool_call_id="c1", runtime=runtime(confirmation)
            )
        )
        await confirmation.waiting.wait()
        call.cancel()
        with pytest.raises(asyncio.CancelledError):
            await call

    asyncio.run(scenario())
    assert send.calls == []


def test_invalid_input_fails_before_confirmation() -> None:
    send = SendTool()
    confirmation = FakeConfirmation(Approved())
    with pytest.raises(ToolInputError) as raised:
        asyncio.run(
            registry_with(send.tool).call(
                "send_thing", {"to": 42}, tool_call_id="c1", runtime=runtime(confirmation)
            )
        )
    assert raised.value.tool_name == "send_thing"
    assert confirmation.requests == []
    assert send.calls == []


def test_unknown_tool() -> None:
    with pytest.raises(UnknownToolError):
        asyncio.run(
            ToolRegistry().call("nope", {}, tool_call_id="c1", runtime=runtime(FakeConfirmation()))
        )


def test_oversized_results_are_truncated() -> None:
    async def big(args: EchoInput, ctx: ToolContext) -> JsonValue:
        return {"data": "x" * 500}

    tool = AgentTool("big_read", "Big.", EchoInput, "read", big)
    result = asyncio.run(
        registry_with(tool).call(
            "big_read", {"text": ""}, tool_call_id="c1", runtime=runtime(FakeConfirmation(), 100)
        )
    )
    assert isinstance(result, dict)
    assert result["truncated"] is True
    assert isinstance(result["preview"], str)
    assert len(result["preview"]) == 100
