//! Host-agnostic agent core: ports, the tool contract and registry (with the approval gate),
//! LLM providers, the agent loop and integrations.
//!
//! This crate must not depend on the UI crate. It's kept free of desktop concerns so it could
//! later run behind another front end (e.g. a server) unchanged.

pub mod ports;
pub mod tools;

#[cfg(feature = "testing")]
pub mod testing;
