//! GitHub tools against a local mock server: no network, no real token.

use std::sync::Arc;

use agent_core::integrations::github::{GITHUB_TOKEN, GitHubApi, search_query};
use agent_core::integrations::register_tools;
use agent_core::ports::{MemorySecretStore, SecretStore};
use agent_core::testing::{FakeConfirmation, runtime};
use agent_core::tools::{CallError, ToolRegistry, ToolRuntime};
use serde_json::{Value, json};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn setup(token: Option<&str>) -> (MockServer, ToolRegistry, ToolRuntime) {
    let server = MockServer::start().await;
    let mut registry = ToolRegistry::default();
    register_tools(&mut registry, GitHubApi::new(server.uri())).unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    if let Some(token) = token {
        secrets.set(GITHUB_TOKEN, token).await.unwrap();
    }
    let mut rt = runtime(FakeConfirmation::unexpected());
    rt.secrets = secrets;
    (server, registry, rt)
}

fn item(number: u64, title: &str) -> Value {
    json!({
        "number": number,
        "title": title,
        "html_url": format!("https://github.com/acme/web/pull/{number}"),
        "repository_url": "https://api.github.com/repos/acme/web",
        "state": "open",
        "updated_at": "2026-11-15T16:02:00Z",
        "user": {"login": "mchen"},
        "labels": [{"name": "bug"}, {"name": "ui"}],
        "comments": 3,
        "draft": false,
        "extra_field_github_adds": {"ignored": true},
    })
}

#[tokio::test]
async fn lists_review_requests_with_a_safe_query_and_trimmed_fields() {
    let (server, registry, rt) = setup(Some("ghp_test")).await;
    Mock::given(method("GET"))
        .and(path("/search/issues"))
        .and(query_param(
            "q",
            "is:pr is:open archived:false review-requested:@me repo:acme/web",
        ))
        .and(query_param("per_page", "2"))
        .and(query_param("sort", "updated"))
        .and(header("authorization", "Bearer ghp_test"))
        .and(header("x-github-api-version", "2022-11-28"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "total_count": 7,
            "incomplete_results": true,
            "items": [item(482, &"x".repeat(300)), item(483, "Second"), item(484, "Over limit")],
        })))
        .expect(1)
        .mount(&server)
        .await;

    let result = registry
        .call(
            "github_list_pull_requests",
            json!({"repo": "acme/web", "limit": 2}),
            "c1",
            &rt,
        )
        .await
        .unwrap();
    assert_eq!(result["total"], 7);
    assert!(result["note"].as_str().unwrap().contains("partial"));
    let prs = result["pull_requests"].as_array().unwrap();
    assert_eq!(prs.len(), 2);
    assert_eq!(prs[0]["repo"], "acme/web");
    assert_eq!(prs[0]["author"], "mchen");
    assert_eq!(prs[0]["labels"], json!(["bug", "ui"]));
    assert_eq!(prs[0]["title"].as_str().unwrap().chars().count(), 200);
    assert!(prs[0].get("extra_field_github_adds").is_none());
}

#[tokio::test]
async fn issues_use_their_own_qualifiers() {
    assert_eq!(
        search_query("issue", "mentions:@me", None),
        "is:issue is:open archived:false mentions:@me"
    );
    let (server, registry, rt) = setup(Some("t")).await;
    Mock::given(method("GET"))
        .and(query_param(
            "q",
            "is:issue is:open archived:false assignee:@me",
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"total_count": 1, "items": [item(1, "Bug")]})),
        )
        .expect(1)
        .mount(&server)
        .await;
    let result = registry
        .call("github_list_issues", json!({}), "c1", &rt)
        .await
        .unwrap();
    assert_eq!(result["issues"][0]["number"], 1);
}

#[tokio::test]
async fn without_a_token_says_not_connected_and_makes_no_request() {
    let (server, registry, rt) = setup(None).await;
    let result = registry
        .call("github_list_pull_requests", json!({}), "c1", &rt)
        .await
        .unwrap();
    assert_eq!(result["status"], "not_connected");
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn smuggled_search_qualifiers_are_rejected() {
    let (server, registry, rt) = setup(Some("t")).await;
    for repo in ["acme/web is:closed", "acme", "a/b/c", "-acme/web"] {
        let error = registry
            .call(
                "github_list_pull_requests",
                json!({"repo": repo}),
                "c1",
                &rt,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, CallError::InvalidInput { .. }), "{repo}");
    }
    let error = registry
        .call("github_list_pull_requests", json!({"limit": 31}), "c1", &rt)
        .await
        .unwrap_err();
    assert!(matches!(error, CallError::InvalidInput { .. }));
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn http_failures_become_plain_error_results() {
    let cases: [(u16, Option<&str>, &str); 6] = [
        (401, None, "unauthorized"),
        (403, Some("0"), "rate_limited"),
        (403, Some("10"), "forbidden"),
        (422, None, "invalid_query"),
        (429, None, "rate_limited"),
        (502, None, "unavailable"),
    ];
    for (status, remaining, code) in cases {
        let (server, registry, rt) = setup(Some("ghp_secret")).await;
        let mut response =
            ResponseTemplate::new(status).set_body_json(json!({"message": "GitHub's own words"}));
        if let Some(remaining) = remaining {
            response = response.insert_header("x-ratelimit-remaining", remaining);
        }
        Mock::given(method("GET"))
            .respond_with(response)
            .mount(&server)
            .await;
        let result = registry
            .call("github_list_pull_requests", json!({}), "c1", &rt)
            .await
            .unwrap();
        assert_eq!(result["status"], "error");
        assert_eq!(result["error"], code, "status {status}");
        let text = result.to_string();
        assert!(!text.contains("ghp_secret") && !text.contains("GitHub's own words"));
    }
}

#[tokio::test]
async fn garbage_response_is_reported_not_passed_on() {
    let (server, registry, rt) = setup(Some("t")).await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>not json</html>"))
        .mount(&server)
        .await;
    let result = registry
        .call("github_list_pull_requests", json!({}), "c1", &rt)
        .await
        .unwrap();
    assert_eq!(result["error"], "unexpected_response");
}
