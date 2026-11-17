"""One package per external service. GitHub is real (read-only); Gmail is still a stub."""

from productivity_agent.core.integrations.github import GitHubApi, github_tools
from productivity_agent.core.integrations.google.gmail_stub import (
    gmail_list_unread,
    gmail_send_draft,
)
from productivity_agent.core.tools import ToolRegistry


def register_tools(registry: ToolRegistry, *, github: GitHubApi | None = None) -> None:
    """Registers every tool. GitHub tools need a token in the SecretStore to reach the network;
    without one they answer "not connected". Pass `github` to point them elsewhere in tests."""
    list_pull_requests, list_issues = github_tools(github or GitHubApi())
    registry.register(list_pull_requests)
    registry.register(list_issues)
    registry.register(gmail_list_unread)
    registry.register(gmail_send_draft)
