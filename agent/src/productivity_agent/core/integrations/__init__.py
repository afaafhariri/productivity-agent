"""One package per external service. Phase 0 ships stubs with realistic fake data."""

from productivity_agent.core.integrations.github.stub import github_list_pull_requests
from productivity_agent.core.integrations.google.gmail_stub import (
    gmail_list_unread,
    gmail_send_draft,
)
from productivity_agent.core.tools import ToolRegistry


def register_stub_tools(registry: ToolRegistry) -> None:
    """Registers the Phase 0 stub tools. No network, no credentials."""
    registry.register(github_list_pull_requests)
    registry.register(gmail_list_unread)
    registry.register(gmail_send_draft)
