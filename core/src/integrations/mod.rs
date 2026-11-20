//! One module per external service. GitHub is real (read-only); Gmail is still a stub.

pub mod github;
pub mod gmail_stub;

use crate::tools::{RegistryError, ToolRegistry};

/// Registers every tool. GitHub tools need a token in the secret store to reach the network;
/// without one they answer "not connected". Pass `github` to point them elsewhere in tests.
pub fn register_tools(
    registry: &mut ToolRegistry,
    github: github::GitHubApi,
) -> Result<(), RegistryError> {
    for tool in github::tools(github) {
        registry.register(tool)?;
    }
    registry.register(gmail_stub::list_unread())?;
    registry.register(gmail_stub::send_draft())?;
    Ok(())
}
