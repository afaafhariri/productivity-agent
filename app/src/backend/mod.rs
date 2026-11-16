//! Talks to the Python backend (`../agent`) over its stdin/stdout.

pub mod client;
pub mod protocol;

pub use client::{BackendClient, BackendCommand, RpcError, ServerEvent};
