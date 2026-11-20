//! The tool contract. Every tool has a snake_case name, a description written for the model,
//! a typed input (JSON Schema generated from the Rust type), an effect and an async `execute`.
//!
//! `Effect::Write` tools always go through the `Confirmation` port before they run.

mod registry;

use std::future::Future;
use std::sync::Arc;

use futures::future::BoxFuture;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ports::{Clock, SecretStore};

pub use registry::{
    CallError, DEFAULT_MAX_RESULT_CHARS, RegistryError, ToolRegistry, ToolRuntime, ToolSpec,
};

/// Structured, JSON-serialisable tool output. Never a pre-formatted string for the user.
pub type ToolResult = Value;

/// A tool failure that isn't the model's fault. Logged; the model only sees "tool_failed".
pub type ToolError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    Read,
    /// Changes state outside the app; always needs the user's approval.
    Write,
}

/// What a tool may use while executing. Built per call by the registry.
#[derive(Clone)]
pub struct ToolContext {
    pub tool_call_id: String,
    pub secrets: Arc<dyn SecretStore>,
    pub clock: Arc<dyn Clock>,
}

/// A problem with one input field, reported back to the model so it can retry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldError {
    pub loc: String,
    pub msg: String,
}

impl FieldError {
    pub fn new(loc: impl Into<String>, msg: impl Into<String>) -> Self {
        Self {
            loc: loc.into(),
            msg: msg.into(),
        }
    }
}

/// A tool's input type. Unknown fields are ignored; `validate` checks what serde can't
/// (ranges, patterns).
pub trait ToolInput: DeserializeOwned + Serialize + JsonSchema + Send + 'static {
    fn validate(&self) -> Result<(), FieldError> {
        Ok(())
    }
}

type Prepare = dyn Fn(Value) -> Result<PreparedCall, Vec<FieldError>> + Send + Sync;

/// A validated call, ready to be approved (for writes) and run.
pub struct PreparedCall {
    /// The normalised arguments (defaults filled in), as the user sees them for approval.
    pub input: Value,
    run: Box<dyn FnOnce(ToolContext) -> BoxFuture<'static, Result<ToolResult, ToolError>> + Send>,
}

impl PreparedCall {
    pub async fn run(self, ctx: ToolContext) -> Result<ToolResult, ToolError> {
        (self.run)(ctx).await
    }
}

/// A tool with its input type erased, so the registry can hold tools of different types.
pub struct AgentTool {
    pub name: &'static str,
    pub description: &'static str,
    pub effect: Effect,
    pub input_schema: Value,
    prepare: Box<Prepare>,
}

impl AgentTool {
    pub fn new<I, F, Fut>(
        name: &'static str,
        description: &'static str,
        effect: Effect,
        execute: F,
    ) -> Self
    where
        I: ToolInput,
        F: Fn(I, ToolContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<ToolResult, ToolError>> + Send + 'static,
    {
        let execute = Arc::new(execute);
        let prepare = move |raw: Value| -> Result<PreparedCall, Vec<FieldError>> {
            let input: I = serde_json::from_value(raw)
                .map_err(|error| vec![FieldError::new("", error.to_string())])?;
            input.validate().map_err(|error| vec![error])?;
            let normalised = serde_json::to_value(&input)
                .map_err(|error| vec![FieldError::new("", error.to_string())])?;
            let execute = execute.clone();
            Ok(PreparedCall {
                input: normalised,
                run: Box::new(move |ctx| Box::pin(async move { execute(input, ctx).await })),
            })
        };
        Self {
            name,
            description,
            effect,
            input_schema: input_schema::<I>(),
            prepare: Box::new(prepare),
        }
    }

    pub fn prepare(&self, raw: Value) -> Result<PreparedCall, Vec<FieldError>> {
        (self.prepare)(raw)
    }
}

/// JSON Schema for a tool input, without the `$schema` key (models don't want it).
fn input_schema<I: JsonSchema>() -> Value {
    let mut schema = serde_json::to_value(schemars::schema_for!(I)).unwrap_or(Value::Null);
    if let Some(object) = schema.as_object_mut() {
        object.remove("$schema");
    }
    schema
}
