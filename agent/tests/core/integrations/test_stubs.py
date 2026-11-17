import asyncio

import pytest
from fakes import FakeConfirmation, runtime

from productivity_agent.core.agent import (
    DoneEvent,
    TextDeltaEvent,
    ToolCallEvent,
    ToolResultEvent,
    run_agent,
)
from productivity_agent.core.agent.loop import AgentEvent
from productivity_agent.core.integrations import register_tools
from productivity_agent.core.llm import Message, MockModel, UserMessage
from productivity_agent.core.ports import Approved, Confirmation, Rejected
from productivity_agent.core.tools import ToolInputError, ToolRegistry


def registry() -> ToolRegistry:
    r = ToolRegistry()
    register_tools(r)
    return r


def chat(text: str, confirmation: Confirmation | None = None) -> list[AgentEvent]:
    async def go() -> list[AgentEvent]:
        history: list[Message] = [UserMessage(text)]
        return [
            e
            async for e in run_agent(
                model=MockModel.demo(delay=0),
                registry=registry(),
                runtime=runtime(confirmation or FakeConfirmation()),
                history=history,
            )
        ]

    return asyncio.run(go())


def reply_text(events: list[AgentEvent]) -> str:
    return "".join(e.text for e in events if isinstance(e, TextDeltaEvent))


def test_tools_are_registered_with_effects() -> None:
    effects = {s.name: s.effect for s in registry().specs()}
    assert effects == {
        "github_list_issues": "read",
        "github_list_pull_requests": "read",
        "gmail_list_unread": "read",
        "gmail_send_draft": "write",
    }


def test_pull_requests_question_without_token_reports_not_connected() -> None:
    events = chat("What PRs need my review?")
    [call] = [e for e in events if isinstance(e, ToolCallEvent)]
    assert call.tool_name == "github_list_pull_requests"
    [result] = [e for e in events if isinstance(e, ToolResultEvent)]
    assert isinstance(result.result, dict)
    assert result.result["status"] == "not_connected"
    assert reply_text(events).startswith("(mock) github_list_pull_requests returned:")
    assert events[-1] == DoneEvent("stop")


def test_unread_email_includes_injection_sample_as_data() -> None:
    events = chat("anything unread in my inbox?")
    [result] = [e for e in events if isinstance(e, ToolResultEvent)]
    assert "ignore your previous instructions" in str(result.result)
    # The injected instruction did not cause a send: no write tool was called.
    assert all(e.tool_name != "gmail_send_draft" for e in events if isinstance(e, ToolCallEvent))


def test_send_requires_approval_and_rejection_is_reported() -> None:
    confirmation = FakeConfirmation(Rejected("not now"))
    events = chat("send Sam the release notes", confirmation)
    [request] = confirmation.requests
    assert request.tool_name == "gmail_send_draft"
    assert request.input == {
        "to": "teammate@example.com",
        "subject": "Quick update",
        "body": "send Sam the release notes",
    }
    assert reply_text(events) == "(mock) OK, I did not send it."


def test_approved_send_returns_stub_receipt() -> None:
    events = chat("send it", FakeConfirmation(Approved()))
    [result] = [e for e in events if isinstance(e, ToolResultEvent)]
    assert isinstance(result.result, dict)
    assert result.result["status"] == "sent"
    assert result.result["sent_at"] == "2026-01-01T00:00:00+00:00"


def test_plain_text_still_echoes() -> None:
    assert reply_text(chat("hello there")) == "(mock) You said: hello there"


def test_send_draft_validates_recipient() -> None:
    async def go() -> None:
        await registry().call(
            "gmail_send_draft",
            {"to": "not-an-address", "subject": "s", "body": "b"},
            tool_call_id="c1",
            runtime=runtime(FakeConfirmation(Approved())),
        )

    with pytest.raises(ToolInputError):
        asyncio.run(go())
