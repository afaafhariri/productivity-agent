"""Stub of the Phase 1 GitHub integration: fixed, realistic data and no network."""

from typing import Literal

from pydantic import BaseModel, Field

from productivity_agent.core.json import JsonValue
from productivity_agent.core.tools import AgentTool, ToolContext

_PULL_REQUESTS: list[dict[str, JsonValue]] = [
    {
        "repo": "acme/payments-api",
        "number": 482,
        "title": "Retry idempotent charge requests on 503",
        "author": "mchen",
        "url": "https://github.com/acme/payments-api/pull/482",
        "updated_at": "2026-11-15T16:02:00Z",
        "review_requested": True,
        "checks": "passing",
    },
    {
        "repo": "acme/web",
        "number": 1290,
        "title": "Migrate settings page to the new form components",
        "author": "rpatel",
        "url": "https://github.com/acme/web/pull/1290",
        "updated_at": "2026-11-15T11:40:00Z",
        "review_requested": True,
        "checks": "failing",
    },
    {
        "repo": "acme/infra",
        "number": 77,
        "title": "Bump Postgres to 17.2 in staging",
        "author": "you",
        "url": "https://github.com/acme/infra/pull/77",
        "updated_at": "2026-11-14T09:15:00Z",
        "review_requested": False,
        "checks": "pending",
    },
]


class ListPullRequestsInput(BaseModel):
    filter: Literal["review_requested", "authored", "all"] = Field(
        default="review_requested",
        description="review_requested = waiting on the user's review; authored = opened by them.",
    )
    limit: int = Field(default=10, ge=1, le=50)


async def _list_pull_requests(args: ListPullRequestsInput, ctx: ToolContext) -> JsonValue:
    match args.filter:
        case "review_requested":
            prs = [p for p in _PULL_REQUESTS if p["review_requested"]]
        case "authored":
            prs = [p for p in _PULL_REQUESTS if p["author"] == "you"]
        case "all":
            prs = list(_PULL_REQUESTS)
    page: list[JsonValue] = list(prs[: args.limit])
    return {"pull_requests": page, "total": len(prs), "source": "stub"}


github_list_pull_requests = AgentTool(
    name="github_list_pull_requests",
    description=(
        "List the user's open GitHub pull requests: ones waiting on their review "
        "(default), ones they authored, or all. Returns repo, number, title, author, "
        "url, last update time and CI status."
    ),
    input_model=ListPullRequestsInput,
    effect="read",
    execute=_list_pull_requests,
)
