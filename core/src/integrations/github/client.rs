//! Minimal read-only GitHub REST client: the issue/PR search endpoint, nothing else.
//!
//! Everything GitHub returns is untrusted: it's parsed into a few fields, clipped, and only
//! then given to the model. The token only ever goes in the Authorization header; it's never
//! logged or returned.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};

/// Secret store key for the user's fine-grained personal access token.
pub const GITHUB_TOKEN: &str = "github_token";

pub const API_URL: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_TITLE_CHARS: usize = 200;
const MAX_LABELS: usize = 5;

/// A failure explained in plain words. `code` and the message go to the model.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct GitHubError {
    pub code: &'static str,
    pub message: String,
}

impl GitHubError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub struct SearchPage {
    /// Matches on GitHub, which can be more than `items`.
    pub total: u64,
    /// GitHub timed out part of the search; `items` may be missing some matches.
    pub incomplete: bool,
    pub items: Vec<Value>,
}

#[derive(Deserialize)]
struct User {
    login: String,
}

#[derive(Deserialize)]
struct Label {
    name: String,
}

#[derive(Deserialize)]
struct Item {
    number: u64,
    title: String,
    html_url: String,
    repository_url: String,
    state: String,
    updated_at: String,
    user: Option<User>,
    #[serde(default)]
    labels: Vec<Label>,
    #[serde(default)]
    comments: u64,
    draft: Option<bool>,
}

#[derive(Deserialize)]
struct SearchResponse {
    total_count: u64,
    #[serde(default)]
    incomplete_results: bool,
    items: Vec<Item>,
}

#[derive(Clone)]
pub struct GitHubApi {
    http: reqwest::Client,
    base_url: String,
}

impl Default for GitHubApi {
    fn default() -> Self {
        Self::new(API_URL)
    }
}

impl GitHubApi {
    /// `base_url` is for tests (a local mock server); use `default()` for github.com.
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(TIMEOUT)
                .user_agent("productivity-agent")
                .build()
                .expect("TLS backend is available"),
            base_url: base_url.into(),
        }
    }

    /// Runs a GitHub issue search (`is:pr` / `is:issue` in `query`), newest update first.
    pub async fn search_issues(
        &self,
        token: &str,
        query: &str,
        limit: u32,
    ) -> Result<SearchPage, GitHubError> {
        let url = format!("{}/search/issues", self.base_url.trim_end_matches('/'));
        let response = self
            .http
            .get(url)
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", API_VERSION)
            .query(&[
                ("q", query),
                ("sort", "updated"),
                ("order", "desc"),
                ("per_page", &limit.to_string()),
            ])
            .send()
            .await
            .map_err(|error| {
                tracing::warn!(timeout = error.is_timeout(), "GitHub request failed");
                if error.is_timeout() {
                    GitHubError::new("timeout", "GitHub took too long to answer. Try again.")
                } else {
                    GitHubError::new(
                        "network",
                        "Couldn't reach GitHub. Check the internet connection.",
                    )
                }
            })?;

        let status = response.status().as_u16();
        let rate_limit_left = response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = response.bytes().await.map_err(|_| {
            GitHubError::new(
                "network",
                "The connection to GitHub was interrupted. Try again.",
            )
        })?;
        if status >= 400 {
            return Err(status_error(status, rate_limit_left.as_deref(), &body));
        }

        let data: SearchResponse = serde_json::from_slice(&body).map_err(|error| {
            tracing::warn!(%error, "unexpected GitHub search response");
            GitHubError::new(
                "unexpected_response",
                "GitHub sent a response this app doesn't understand.",
            )
        })?;
        Ok(SearchPage {
            total: data.total_count,
            incomplete: data.incomplete_results,
            items: data
                .items
                .iter()
                .take(limit as usize)
                .map(summarise)
                .collect(),
        })
    }
}

fn status_error(status: u16, rate_limit_left: Option<&str>, body: &[u8]) -> GitHubError {
    // GitHub's own error text, for the log only (it never contains the token).
    let message = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|b| {
            b["message"]
                .as_str()
                .map(|m| m.chars().take(300).collect::<String>())
        })
        .unwrap_or_default();
    tracing::warn!(status, message, "GitHub returned an error");

    if status == 429 || (status == 403 && rate_limit_left == Some("0")) {
        return GitHubError::new(
            "rate_limited",
            "GitHub's rate limit was reached. Try again in a few minutes.",
        );
    }
    match status {
        401 => GitHubError::new(
            "unauthorized",
            "GitHub rejected the token. It may be expired or revoked; add a new one in Settings.",
        ),
        403 => GitHubError::new(
            "forbidden",
            "The GitHub token isn't allowed to do this. Check its repository access and that it \
             has read access to pull requests and issues.",
        ),
        422 => GitHubError::new(
            "invalid_query",
            "GitHub couldn't run that search. The repository may not exist, or the token can't \
             access it.",
        ),
        500.. => GitHubError::new("unavailable", "GitHub is having problems. Try again later."),
        _ => GitHubError::new(
            "http_error",
            format!("GitHub returned an unexpected error ({status})."),
        ),
    }
}

fn summarise(item: &Item) -> Value {
    // repository_url is https://api.github.com/repos/{owner}/{name}
    let repo = item
        .repository_url
        .trim_end_matches('/')
        .rsplit_once("/repos/")
        .map_or("", |(_, r)| r);
    let mut summary = Map::new();
    summary.insert("repo".into(), repo.into());
    summary.insert("number".into(), item.number.into());
    summary.insert("title".into(), clip(&item.title, MAX_TITLE_CHARS).into());
    summary.insert(
        "author".into(),
        item.user.as_ref().map(|u| u.login.clone()).into(),
    );
    summary.insert("url".into(), item.html_url.clone().into());
    summary.insert("state".into(), item.state.clone().into());
    summary.insert("updated_at".into(), item.updated_at.clone().into());
    summary.insert("comments".into(), item.comments.into());
    summary.insert(
        "labels".into(),
        json!(
            item.labels
                .iter()
                .take(MAX_LABELS)
                .map(|l| clip(&l.name, 50))
                .collect::<Vec<_>>()
        ),
    );
    if let Some(draft) = item.draft {
        summary.insert("draft".into(), draft.into());
    }
    Value::Object(summary)
}

fn clip(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_owned()
    } else {
        let mut clipped: String = text.chars().take(max_chars - 1).collect();
        clipped.push('…');
        clipped
    }
}
