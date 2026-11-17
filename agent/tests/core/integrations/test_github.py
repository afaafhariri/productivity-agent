"""GitHub tools against a fake HTTP transport: no network, no real token."""

import asyncio
import json
from collections.abc import Callable

import httpx2
import pytest
from fakes import FakeConfirmation, FixedClock

from productivity_agent.core.integrations.github import GITHUB_TOKEN, GitHubApi, github_tools
from productivity_agent.core.json import JsonValue
from productivity_agent.core.tools import ToolInputError, ToolRegistry, ToolRuntime
from productivity_agent.host.adapters import InMemorySecretStore

TOKEN = "github_pat_test_not_real"  # noqa: S105 (fake)

type Handler = Callable[[httpx2.Request], httpx2.Response]


def item(number: int = 482, **overrides: JsonValue) -> dict[str, JsonValue]:
    data: dict[str, JsonValue] = {
        "number": number,
        "title": "Retry idempotent charge requests on 503",
        "html_url": f"https://github.com/acme/payments-api/pull/{number}",
        "repository_url": "https://api.github.com/repos/acme/payments-api",
        "state": "open",
        "updated_at": "2026-11-15T16:02:00Z",
        "user": {"login": "mchen", "id": 1, "avatar_url": "https://example.com/a.png"},
        "labels": [{"name": "payments", "color": "ff0000"}],
        "comments": 3,
        "draft": False,
        "body": "Long body that must not reach the model.",
    }
    data.update(overrides)
    return data


def search_response(*items: dict[str, JsonValue], total: int | None = None) -> httpx2.Response:
    body = {"total_count": len(items) if total is None else total, "items": list(items)}
    return httpx2.Response(200, json=body)


class Recorder:
    def __init__(self, response: httpx2.Response | Exception) -> None:
        self.response = response
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def call(
    tool: str,
    args: dict[str, JsonValue],
    handler: Handler,
    token: str | None = TOKEN,
) -> JsonValue:
    async def go() -> JsonValue:
        secrets = InMemorySecretStore()
        if token:
            await secrets.set(GITHUB_TOKEN, token)
        registry = ToolRegistry()
        prs, issues = github_tools(GitHubApi(transport=httpx2.MockTransport(handler)))
        registry.register(prs)
        registry.register(issues)
        runtime = ToolRuntime(confirmation=FakeConfirmation(), secrets=secrets, clock=FixedClock())
        return await registry.call(tool, args, tool_call_id="c1", runtime=runtime)

    return asyncio.run(go())


def test_review_requests_search_sends_token_and_query() -> None:
    recorder = Recorder(search_response(item()))
    result = call("github_list_pull_requests", {}, recorder)

    [request] = recorder.requests
    assert request.url.host == "api.github.com"
    assert request.url.path == "/search/issues"
    assert request.url.params["q"] == "is:pr is:open archived:false review-requested:@me"
    assert request.url.params["sort"] == "updated"
    assert request.url.params["per_page"] == "10"
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert request.headers["x-github-api-version"] == "2022-11-28"

    assert result == {
        "pull_requests": [
            {
                "repo": "acme/payments-api",
                "number": 482,
                "title": "Retry idempotent charge requests on 503",
                "author": "mchen",
                "url": "https://github.com/acme/payments-api/pull/482",
                "state": "open",
                "updated_at": "2026-11-15T16:02:00Z",
                "comments": 3,
                "labels": ["payments"],
                "draft": False,
            }
        ],
        "total": 1,
    }
    assert TOKEN not in json.dumps(result)


@pytest.mark.parametrize(
    ("tool", "args", "query"),
    [
        (
            "github_list_pull_requests",
            {"filter": "authored", "repo": "acme/web", "limit": 5},
            "is:pr is:open archived:false author:@me repo:acme/web",
        ),
        ("github_list_issues", {}, "is:issue is:open archived:false assignee:@me"),
        (
            "github_list_issues",
            {"filter": "mentioned", "repo": "my-org/repo.name_2"},
            "is:issue is:open archived:false mentions:@me repo:my-org/repo.name_2",
        ),
    ],
)
def test_filters_map_to_search_qualifiers(
    tool: str, args: dict[str, JsonValue], query: str
) -> None:
    recorder = Recorder(search_response())
    call(tool, args, recorder)
    assert recorder.requests[0].url.params["q"] == query


def test_issues_result_key_and_total_beyond_page() -> None:
    issue = item(7, html_url="https://github.com/acme/payments-api/issues/7")
    del issue["draft"]
    result = call("github_list_issues", {"limit": 1}, Recorder(search_response(issue, total=42)))
    assert isinstance(result, dict)
    assert result["total"] == 42
    issues = result["issues"]
    assert isinstance(issues, list)
    [only] = issues
    assert isinstance(only, dict)
    assert "draft" not in only


def test_untrusted_fields_are_clipped_and_bodies_dropped() -> None:
    long = item(title="x" * 1000, labels=[{"name": f"label-{i}"} for i in range(20)])
    result = call("github_list_pull_requests", {}, Recorder(search_response(long)))
    text = json.dumps(result)
    assert "Long body" not in text
    assert "avatar_url" not in text
    assert isinstance(result, dict)
    prs = result["pull_requests"]
    assert isinstance(prs, list)
    [pr] = prs
    assert isinstance(pr, dict)
    assert len(str(pr["title"])) == 200
    assert pr["labels"] == [f"label-{i}" for i in range(5)]


def test_without_token_reports_not_connected_and_makes_no_request() -> None:
    recorder = Recorder(search_response())
    result = call("github_list_pull_requests", {}, recorder, token=None)
    assert isinstance(result, dict)
    assert result["status"] == "not_connected"
    assert recorder.requests == []


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx2.Response(401, json={"message": "Bad credentials"}), "unauthorized"),
        (httpx2.Response(403, json={"message": "Resource not accessible"}), "forbidden"),
        (
            httpx2.Response(403, headers={"x-ratelimit-remaining": "0"}, json={"message": "x"}),
            "rate_limited",
        ),
        (httpx2.Response(429), "rate_limited"),
        (httpx2.Response(422, json={"message": "Validation Failed"}), "invalid_query"),
        (httpx2.Response(502, text="Bad gateway"), "unavailable"),
        (httpx2.Response(418), "http_error"),
        (httpx2.Response(200, json={"unexpected": True}), "unexpected_response"),
        (httpx2.Response(200, text="not json"), "unexpected_response"),
    ],
)
def test_http_failures_become_plain_error_results(response: httpx2.Response, code: str) -> None:
    result = call("github_list_pull_requests", {}, Recorder(response))
    assert isinstance(result, dict)
    assert result["status"] == "error"
    assert result["error"] == code
    assert isinstance(result["message"], str)
    assert TOKEN not in json.dumps(result)


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (httpx2.ConnectError("no route"), "network"),
        (httpx2.ReadTimeout("slow"), "timeout"),
    ],
)
def test_network_failures_become_plain_error_results(error: Exception, code: str) -> None:
    result = call("github_list_pull_requests", {}, Recorder(error))
    assert isinstance(result, dict)
    assert result["error"] == code


@pytest.mark.parametrize(
    "repo",
    ["acme/web is:public", "acme", "acme/web/extra", "-acme/web", "acme/web repo:other/x"],
)
def test_repo_must_be_a_single_owner_name(repo: str) -> None:
    with pytest.raises(ToolInputError):
        call("github_list_pull_requests", {"repo": repo}, Recorder(search_response()))


def test_limit_is_bounded() -> None:
    with pytest.raises(ToolInputError):
        call("github_list_issues", {"limit": 31}, Recorder(search_response()))
