use std::time::Duration;

use agent_core::llm::mock::MockModel;
use agent_core::llm::{FinishReason, LanguageModel, Message, ModelError, ModelPart, ModelRequest};
use futures::StreamExt;

fn request(messages: Vec<Message>) -> ModelRequest {
    ModelRequest {
        system: String::new(),
        messages,
        tools: vec![],
    }
}

async fn collect(model: &MockModel, req: ModelRequest) -> Vec<Result<ModelPart, ModelError>> {
    model.stream(req).collect().await
}

#[tokio::test]
async fn echo_streams_word_by_word() {
    let parts = collect(
        &MockModel::echo(Duration::ZERO),
        request(vec![Message::user("hi there")]),
    )
    .await;
    assert_eq!(
        parts.last(),
        Some(&Ok(ModelPart::Finish(FinishReason::Stop)))
    );
    let text: String = parts
        .iter()
        .filter_map(|p| match p {
            Ok(ModelPart::TextDelta(t)) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "(mock) You said: hi there");
    assert!(parts.len() > 2);
}

#[tokio::test]
async fn scripted_plays_turns_in_order_then_fails() {
    let model = MockModel::scripted(vec![
        vec![ModelPart::TextDelta("a".into())],
        vec![ModelPart::TextDelta("b".into())],
    ]);
    assert_eq!(
        collect(&model, request(vec![])).await,
        [Ok(ModelPart::TextDelta("a".into()))]
    );
    assert_eq!(
        collect(&model, request(vec![])).await,
        [Ok(ModelPart::TextDelta("b".into()))]
    );
    assert_eq!(
        collect(&model, request(vec![])).await,
        [Err(ModelError("MockModel script exhausted".into()))]
    );
}
