"""Minimal read-only GitHub REST client: the issue/PR search endpoint, nothing else.

Everything GitHub returns is untrusted: it is validated with Pydantic, clipped, and reduced
to a few fields before it reaches the model. The token is only ever put in the
Authorization header; it is never logged or returned.
"""

import logging
from dataclasses import dataclass
from typing import Final

import httpx2
from pydantic import BaseModel, ValidationError

from productivity_agent.core.json import JsonValue

logger = logging.getLogger(__name__)

GITHUB_TOKEN: Final = "github_token"  # noqa: S105 (a key name, not a secret)
"""SecretStore key for the user's fine-grained personal access token."""

API_URL: Final = "https://api.github.com"
API_VERSION: Final = "2022-11-28"
TIMEOUT_SECONDS: Final = 15.0
MAX_TITLE_CHARS: Final = 200
MAX_LABELS: Final = 5


class GitHubError(Exception):
    """A failure explained in plain words. `code` and the message go to the model."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class SearchPage:
    total: int
    """Matches on GitHub, which can be more than `items`."""
    incomplete: bool
    """GitHub timed out part of the search; `items` may be missing some matches."""
    items: list[JsonValue]


class _User(BaseModel):
    login: str


class _Label(BaseModel):
    name: str


class _Item(BaseModel):
    number: int
    title: str
    html_url: str
    repository_url: str
    state: str
    updated_at: str
    user: _User | None = None
    labels: list[_Label] = []
    comments: int = 0
    draft: bool | None = None


class _SearchResponse(BaseModel):
    total_count: int
    incomplete_results: bool = False
    items: list[_Item]


@dataclass(frozen=True, slots=True)
class GitHubApi:
    """`transport` is for tests (e.g. `httpx2.MockTransport`); None uses the network."""

    base_url: str = API_URL
    transport: httpx2.AsyncBaseTransport | None = None

    async def search_issues(self, token: str, query: str, limit: int) -> SearchPage:
        """Runs a GitHub issue search (`is:pr` / `is:issue` in `query`), newest update first."""
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "productivity-agent",
            "X-GitHub-Api-Version": API_VERSION,
        }
        params: dict[str, str | int] = {
            "q": query,
            "sort": "updated",
            "order": "desc",
            "per_page": limit,
        }
        try:
            async with httpx2.AsyncClient(
                base_url=self.base_url,
                headers=headers,
                timeout=TIMEOUT_SECONDS,
                transport=self.transport,
            ) as client:
                response = await client.get("/search/issues", params=params)
        except httpx2.TimeoutException as error:
            logger.warning("GitHub request timed out: %s", type(error).__name__)
            raise GitHubError("timeout", "GitHub took too long to answer. Try again.") from error
        except httpx2.TransportError as error:
            logger.warning("GitHub request failed: %s", type(error).__name__)
            raise GitHubError(
                "network", "Couldn't reach GitHub. Check the internet connection."
            ) from error

        _raise_for_status(response)
        try:
            data = _SearchResponse.model_validate_json(response.content)
        except ValidationError as error:
            logger.warning("unexpected GitHub search response: %s", error.error_count())
            raise GitHubError(
                "unexpected_response", "GitHub sent a response this app doesn't understand."
            ) from error

        return SearchPage(
            total=data.total_count,
            incomplete=data.incomplete_results,
            items=[_summarise(item) for item in data.items[:limit]],
        )


def _raise_for_status(response: httpx2.Response) -> None:
    status = response.status_code
    if status < 400:
        return
    logger.warning("GitHub returned %s: %s", status, _github_message(response))
    rate_limited = status == 429 or (
        status == 403 and response.headers.get("x-ratelimit-remaining") == "0"
    )
    if rate_limited:
        raise GitHubError(
            "rate_limited", "GitHub's rate limit was reached. Try again in a few minutes."
        )
    match status:
        case 401:
            raise GitHubError(
                "unauthorized",
                "GitHub rejected the token. It may be expired or revoked; "
                "add a new one in Settings.",
            )
        case 403:
            raise GitHubError(
                "forbidden",
                "The GitHub token isn't allowed to do this. Check its repository access "
                "and that it has read access to pull requests and issues.",
            )
        case 422:
            raise GitHubError(
                "invalid_query",
                "GitHub couldn't run that search. The repository may not exist, or the "
                "token can't access it.",
            )
        case _ if status >= 500:
            raise GitHubError("unavailable", "GitHub is having problems. Try again later.")
        case _:
            raise GitHubError("http_error", f"GitHub returned an unexpected error ({status}).")


def _github_message(response: httpx2.Response) -> str:
    """GitHub's own error text, for the log only (it never contains the token)."""
    try:
        body = response.json()
    except ValueError:
        return "(no JSON body)"
    message = body.get("message") if isinstance(body, dict) else None
    return str(message)[:300] if message else "(no message)"


def _summarise(item: _Item) -> JsonValue:
    # repository_url is https://api.github.com/repos/{owner}/{name}
    owner, _, name = item.repository_url.rstrip("/").rpartition("/repos/")[2].partition("/")
    summary: dict[str, JsonValue] = {
        "repo": f"{owner}/{name}",
        "number": item.number,
        "title": _clip(item.title, MAX_TITLE_CHARS),
        "author": item.user.login if item.user else None,
        "url": item.html_url,
        "state": item.state,
        "updated_at": item.updated_at,
        "comments": item.comments,
        "labels": [_clip(label.name, 50) for label in item.labels[:MAX_LABELS]],
    }
    if item.draft is not None:
        summary["draft"] = item.draft
    return summary


def _clip(text: str, max_chars: int) -> str:
    return text if len(text) <= max_chars else text[: max_chars - 1] + "…"
