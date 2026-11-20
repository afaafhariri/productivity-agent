//! The agent, running in-process: agent-core's service on its own Tokio runtime.
//!
//! The UI calls the async methods here from GPUI tasks; the work runs on the Tokio runtime
//! (HTTP needs it) and results come back through executor-agnostic futures. Run events arrive
//! on the receiver returned by `Backend::start`.

mod keychain;
pub mod protocol;

use std::sync::Arc;

use agent_core::integrations::github::GitHubApi;
use agent_core::integrations::register_tools;
use agent_core::llm::config::LlmConfig;
use agent_core::ports::{Decision, MemorySecretStore, SecretStore, SystemClock};
use agent_core::service::{AgentService, RunEventParams, SecretName, ServiceDeps, Settings};
use agent_core::tools::ToolRegistry;
use anyhow::{Context as _, Result};
use futures::channel::mpsc::UnboundedReceiver;

use self::keychain::KeychainSecretStore;

/// Where secrets live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretsMode {
    /// The OS credential store (macOS Keychain, Windows Credential Manager, Secret Service).
    Keychain,
    /// Forgotten on exit. Tests and `PRODUCTIVITY_AGENT_SECRETS=memory`.
    Memory,
}

#[derive(Debug, Clone)]
pub struct BackendConfig {
    pub llm: LlmConfig,
    pub secrets: SecretsMode,
}

impl BackendConfig {
    /// Reads `LLM_PROVIDER`, `LLM_MODEL_ID` and `PRODUCTIVITY_AGENT_SECRETS`.
    pub fn from_env() -> Result<Self> {
        let llm = LlmConfig::from_env(|name| std::env::var(name).ok())?;
        let secrets = match std::env::var("PRODUCTIVITY_AGENT_SECRETS").as_deref() {
            Ok("memory") => SecretsMode::Memory,
            _ => SecretsMode::Keychain,
        };
        Ok(Self { llm, secrets })
    }

    /// The offline demo model with in-memory secrets. For tests.
    #[cfg(test)]
    pub fn mock_in_memory() -> Self {
        Self {
            llm: LlmConfig::default(),
            secrets: SecretsMode::Memory,
        }
    }
}

pub struct Backend {
    service: AgentService,
    runtime: Option<tokio::runtime::Runtime>,
}

impl Backend {
    pub fn start(config: BackendConfig) -> Result<(Arc<Self>, UnboundedReceiver<RunEventParams>)> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("agent")
            .enable_all()
            .build()
            .context("couldn't start the agent runtime")?;

        let secrets: Arc<dyn SecretStore> = match config.secrets {
            SecretsMode::Keychain => Arc::new(KeychainSecretStore::default()),
            SecretsMode::Memory => {
                tracing::warn!("secrets are kept in memory only");
                Arc::new(MemorySecretStore::default())
            }
        };
        let mut registry = ToolRegistry::default();
        // reqwest clients must be created inside the runtime that drives them.
        let github = runtime.block_on(async { GitHubApi::default() });
        register_tools(&mut registry, github).context("couldn't register the tools")?;

        tracing::info!(provider = config.llm.provider.as_str(), secrets = ?config.secrets, "starting the agent");
        let (service, events) = AgentService::new(
            ServiceDeps {
                config: config.llm,
                registry,
                secrets,
                clock: Arc::new(SystemClock),
                model: None,
            },
            runtime.handle().clone(),
        );
        Ok((
            Arc::new(Self {
                service,
                runtime: Some(runtime),
            }),
            events,
        ))
    }

    pub fn version() -> &'static str {
        agent_core::VERSION
    }

    fn runtime(&self) -> &tokio::runtime::Runtime {
        self.runtime.as_ref().expect("runtime lives until drop")
    }

    pub async fn settings(&self) -> Result<Settings> {
        let service = self.service.clone();
        Ok(self
            .runtime()
            .spawn(async move { service.settings().await })
            .await??)
    }

    /// Write-only: the value goes to the secret store and is never handed back.
    pub async fn set_secret(&self, name: SecretName, value: String) -> Result<()> {
        let service = self.service.clone();
        Ok(self
            .runtime()
            .spawn(async move { service.set_secret(name, &value).await })
            .await??)
    }

    pub async fn delete_secret(&self, name: SecretName) -> Result<()> {
        let service = self.service.clone();
        Ok(self
            .runtime()
            .spawn(async move { service.delete_secret(name).await })
            .await??)
    }

    pub async fn start_run(&self, conversation_id: &str, text: &str) -> Result<String> {
        Ok(self.service.start_run(conversation_id, text)?)
    }

    pub async fn cancel_run(&self, run_id: &str) -> Result<()> {
        Ok(self.service.cancel_run(run_id)?)
    }

    pub async fn respond_confirmation(
        &self,
        run_id: &str,
        tool_call_id: &str,
        approved: bool,
        reason: Option<&str>,
    ) -> Result<()> {
        let decision = if approved {
            Decision::Approved
        } else {
            Decision::Rejected {
                reason: reason.map(str::to_owned),
            }
        };
        Ok(self
            .service
            .respond_confirmation(run_id, tool_call_id, decision)?)
    }
}

impl Drop for Backend {
    /// Stops every run (a pending approval is never executed), then the runtime.
    fn drop(&mut self) {
        self.service.cancel_all();
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}
