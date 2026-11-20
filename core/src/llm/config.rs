//! Which model to use, and building it.

use std::sync::Arc;
use std::time::Duration;

use super::gemini::GeminiModel;
use super::mock::MockModel;
use super::{LanguageModel, ModelError};
use crate::ports::SecretStore;

/// Secret store key for the user's Gemini API key (from Google AI Studio).
pub const GEMINI_API_KEY: &str = "gemini_api_key";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    /// Offline demo model: echoes, and keyword-triggers the stub tools.
    Mock,
    Gemini,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mock => "mock",
            Self::Gemini => "gemini",
        }
    }
}

/// Configuration only a restart can change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmConfig {
    pub provider: Provider,
    pub model_id: Option<String>,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider: Provider::Mock,
            model_id: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ConfigError(pub String);

impl LlmConfig {
    /// Reads `LLM_PROVIDER` (default `mock`) and `LLM_MODEL_ID`. The API key never comes from
    /// the environment.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let value = |name: &str| get(name).filter(|v| !v.trim().is_empty());
        let provider = match value("LLM_PROVIDER").as_deref().map(str::trim) {
            None | Some("mock") => Provider::Mock,
            Some("gemini") => Provider::Gemini,
            Some(removed @ ("vertex" | "agent_platform")) => {
                return Err(ConfigError(format!(
                    "LLM_PROVIDER={removed} is no longer supported (Gemini Enterprise Agent \
                     Platform was removed); use LLM_PROVIDER=gemini and add your API key in \
                     Settings"
                )));
            }
            Some(other) => {
                return Err(ConfigError(format!(
                    "Unknown LLM_PROVIDER={other}; use mock or gemini"
                )));
            }
        };
        let config = Self {
            provider,
            model_id: value("LLM_MODEL_ID").map(|v| v.trim().to_owned()),
        };
        if config.provider == Provider::Gemini && config.model_id.is_none() {
            return Err(ConfigError(
                "LLM_PROVIDER=gemini needs LLM_MODEL_ID to be set".into(),
            ));
        }
        Ok(config)
    }
}

/// Builds the configured model. A missing Gemini key is a `ModelError` the user can fix in
/// Settings; its message is shown to them.
pub async fn create_model(
    config: &LlmConfig,
    secrets: &dyn SecretStore,
) -> Result<Arc<dyn LanguageModel>, ModelError> {
    match config.provider {
        Provider::Mock => Ok(Arc::new(MockModel::demo(Duration::from_millis(30)))),
        Provider::Gemini => {
            let key = secrets.get(GEMINI_API_KEY).await.map_err(|error| {
                tracing::warn!(%error, "couldn't read the Gemini API key");
                ModelError("Couldn't read your Gemini API key from the system keychain.".into())
            })?;
            let Some(key) = key.filter(|k| !k.is_empty()) else {
                return Err(ModelError(
                    "Add your Gemini API key in Settings to start chatting.".into(),
                ));
            };
            Ok(Arc::new(GeminiModel::new(
                key,
                config.model_id.clone().unwrap_or_default(),
            )))
        }
    }
}
