//! Spawns the backend process and speaks JSON-RPC to it.
//!
//! Two background threads do the blocking I/O: one writes request lines to the child's
//! stdin, one reads its stdout. Responses resolve the matching request future; `run.event`
//! notifications go to an event channel the UI drains. The child's stderr (its logs) is
//! inherited so it shows up in the app's own stderr.

use std::collections::HashMap;
use std::fmt;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow};
use futures::channel::{mpsc, oneshot};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::protocol::{
    Ack, ConfirmationRespondParams, InitializeParams, InitializeResult, PROTOCOL_VERSION,
    RunCancelParams, RunEventParams, RunStartParams, RunStartResult,
};

/// How to start the backend.
#[derive(Debug, Clone)]
pub struct BackendCommand {
    pub program: String,
    pub args: Vec<String>,
    /// Extra environment variables for the backend (on top of the app's own).
    pub envs: Vec<(String, String)>,
}

impl BackendCommand {
    /// Dev setup: `uv run --project <agent dir> [--env-file <agent dir>/.env] productivity-agent`.
    ///
    /// The agent directory is `PRODUCTIVITY_AGENT_DIR` if set, else `../agent` next to this
    /// crate. Packaged builds will start a bundled runtime instead.
    pub fn dev() -> Self {
        let dir = std::env::var_os("PRODUCTIVITY_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../agent"));
        let mut args = vec!["run".into(), "--project".into(), path_arg(&dir)];
        let env_file = dir.join(".env");
        if env_file.is_file() {
            args.extend(["--env-file".into(), path_arg(&env_file)]);
        }
        args.push("productivity-agent".into());
        Self {
            program: "uv".into(),
            args,
            envs: Vec::new(),
        }
    }
}

fn path_arg(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

/// A JSON-RPC error returned by the backend.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "backend error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

/// Something the backend pushed without being asked.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerEvent {
    Run(RunEventParams),
    /// stdout closed: the backend exited or crashed. No more events will arrive.
    Exited,
}

type Waiter = oneshot::Sender<Result<Value, RpcError>>;

/// Requests waiting for a response. `exited` and `waiters` share one lock so a request can
/// never register after the reader has given up on the backend.
#[derive(Default)]
struct PendingState {
    exited: bool,
    waiters: HashMap<u64, Waiter>,
}

type Pending = Arc<Mutex<PendingState>>;

pub struct BackendClient {
    outgoing: Mutex<Option<std_mpsc::Sender<String>>>,
    pending: Pending,
    next_id: AtomicU64,
    child: Mutex<Child>,
}

impl BackendClient {
    /// Starts the backend. Call `initialize` before anything else.
    pub fn spawn(command: &BackendCommand) -> Result<(Self, mpsc::UnboundedReceiver<ServerEvent>)> {
        let mut child = Command::new(&command.program)
            .args(&command.args)
            .envs(command.envs.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("failed to start backend: {}", command.program))?;
        let stdin = child.stdin.take().context("backend stdin missing")?;
        let stdout = child.stdout.take().context("backend stdout missing")?;

        let pending: Pending = Arc::default();
        let (events_tx, events_rx) = mpsc::unbounded();
        let (outgoing_tx, outgoing_rx) = std_mpsc::channel::<String>();

        thread::Builder::new()
            .name("backend-writer".into())
            .spawn(move || write_loop(stdin, outgoing_rx))?;
        let reader_pending = pending.clone();
        thread::Builder::new()
            .name("backend-reader".into())
            .spawn(move || read_loop(stdout, reader_pending, events_tx))?;

        let client = Self {
            outgoing: Mutex::new(Some(outgoing_tx)),
            pending,
            next_id: AtomicU64::new(1),
            child: Mutex::new(child),
        };
        Ok((client, events_rx))
    }

    /// Sends a request and waits for its result.
    pub async fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
    ) -> Result<R> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.exited {
                return Err(anyhow!("backend is not running"));
            }
            pending.waiters.insert(id, tx);
        }

        let line = serde_json::to_string(
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
        )?;
        let sent = self
            .outgoing
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|out| out.send(line).is_ok());
        if !sent {
            self.pending.lock().unwrap().waiters.remove(&id);
            return Err(anyhow!("backend is not running"));
        }

        let result = rx
            .await
            .map_err(|_| anyhow!("backend exited before answering {method}"))??;
        serde_json::from_value(result).with_context(|| format!("unexpected {method} result"))
    }

    pub async fn initialize(&self) -> Result<InitializeResult> {
        let params = InitializeParams {
            protocol_version: PROTOCOL_VERSION,
            client_name: env!("CARGO_PKG_NAME"),
        };
        self.request("initialize", params).await
    }

    pub async fn start_run(&self, conversation_id: &str, text: &str) -> Result<String> {
        let params = RunStartParams {
            conversation_id,
            text,
        };
        let result: RunStartResult = self.request("run.start", params).await?;
        Ok(result.run_id)
    }

    pub async fn cancel_run(&self, run_id: &str) -> Result<()> {
        let _: Ack = self
            .request("run.cancel", RunCancelParams { run_id })
            .await?;
        Ok(())
    }

    pub async fn respond_confirmation(
        &self,
        run_id: &str,
        tool_call_id: &str,
        approved: bool,
        reason: Option<&str>,
    ) -> Result<()> {
        let params = ConfirmationRespondParams {
            run_id,
            tool_call_id,
            approved,
            reason,
        };
        let _: Ack = self.request("confirmation.respond", params).await?;
        Ok(())
    }
}

impl Drop for BackendClient {
    /// Closing stdin is the shutdown signal; the backend cancels its runs and exits.
    fn drop(&mut self) {
        self.outgoing.lock().unwrap().take();
        let mut child = self.child.lock().unwrap();
        for _ in 0..50 {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn write_loop(mut stdin: ChildStdin, outgoing: std_mpsc::Receiver<String>) {
    for line in outgoing {
        if writeln!(stdin, "{line}")
            .and_then(|()| stdin.flush())
            .is_err()
        {
            break;
        }
    }
    // Dropping stdin here closes the pipe: EOF for the backend.
}

fn read_loop(stdout: ChildStdout, pending: Pending, events: mpsc::UnboundedSender<ServerEvent>) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(message) => dispatch(message, &pending, &events),
            Err(error) => eprintln!("backend sent invalid JSON ({error}): {line}"),
        }
    }
    // Fail every request still waiting (and any later one), then tell the UI.
    {
        let mut pending = pending.lock().unwrap();
        pending.exited = true;
        pending.waiters.clear();
    }
    let _ = events.unbounded_send(ServerEvent::Exited);
}

fn dispatch(message: Value, pending: &Pending, events: &mpsc::UnboundedSender<ServerEvent>) {
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        let Some(waiter) = pending.lock().unwrap().waiters.remove(&id) else {
            return;
        };
        let outcome = match (message.get("result"), message.get("error")) {
            (Some(result), None) => Ok(result.clone()),
            (_, Some(error)) => Err(RpcError {
                code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
                    .to_owned(),
                data: error.get("data").cloned(),
            }),
            (None, None) => return,
        };
        let _ = waiter.send(outcome);
        return;
    }

    if message.get("method").and_then(Value::as_str) == Some("run.event") {
        match message
            .get("params")
            .cloned()
            .map(serde_json::from_value::<RunEventParams>)
        {
            Some(Ok(params)) => {
                let _ = events.unbounded_send(ServerEvent::Run(params));
            }
            Some(Err(error)) => eprintln!("backend sent an unknown run.event: {error}"),
            None => eprintln!("backend sent run.event without params"),
        }
    } else if message.get("id").is_none() && message.get("error").is_some() {
        // Errors for lines the backend could not parse carry `id: null`.
        eprintln!("backend reported a protocol error: {message}");
    }
}

#[cfg(test)]
mod tests {
    //! These start the real Python backend with `uv` (mock LLM, no network).
    use super::super::protocol::{DoneReason, RunEvent};
    use super::*;
    use futures::StreamExt;
    use std::future::Future;

    const TIMEOUT: Duration = Duration::from_secs(30);

    /// Runs `future` to completion on a helper thread, failing the test on timeout.
    fn within<T: Send + 'static>(future: impl Future<Output = T> + Send + 'static) -> T {
        let (tx, rx) = std_mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(futures::executor::block_on(future));
        });
        rx.recv_timeout(TIMEOUT)
            .expect("timed out talking to the backend")
    }

    fn mock_backend() -> BackendCommand {
        let mut command = BackendCommand::dev();
        command.envs.push(("LLM_PROVIDER".into(), "mock".into()));
        command
    }

    async fn next_run_event(events: &mut mpsc::UnboundedReceiver<ServerEvent>) -> RunEventParams {
        match events.next().await {
            Some(ServerEvent::Run(params)) => params,
            other => panic!("expected a run event, got {other:?}"),
        }
    }

    #[test]
    fn handshake_and_streamed_run() {
        within(async {
            let (client, mut events) = BackendClient::spawn(&mock_backend()).unwrap();
            let info = client.initialize().await.unwrap();
            assert_eq!(info.protocol_version, PROTOCOL_VERSION);
            assert_eq!(info.server_name, "productivity-agent");

            let run_id = client.start_run("c", "hello rust").await.unwrap();
            let mut text = String::new();
            loop {
                let params = next_run_event(&mut events).await;
                assert_eq!(params.run_id, run_id);
                match params.event {
                    RunEvent::TextDelta { text: delta } => text.push_str(&delta),
                    RunEvent::Done { reason } => {
                        assert_eq!(reason, DoneReason::Stop);
                        break;
                    }
                    other => panic!("unexpected event {other:?}"),
                }
            }
            assert_eq!(text, "(mock) You said: hello rust");
        });
    }

    #[test]
    fn rpc_errors_surface_as_rpc_error() {
        within(async {
            let (client, _events) = BackendClient::spawn(&mock_backend()).unwrap();
            let before_init = client.start_run("c", "hi").await.unwrap_err();
            assert_eq!(before_init.downcast_ref::<RpcError>().unwrap().code, -32001);

            client.initialize().await.unwrap();
            let empty_text = client.start_run("c", "").await.unwrap_err();
            assert_eq!(empty_text.downcast_ref::<RpcError>().unwrap().code, -32602);
        });
    }

    #[test]
    fn cancel_ends_run_with_cancelled() {
        within(async {
            let (client, mut events) = BackendClient::spawn(&mock_backend()).unwrap();
            client.initialize().await.unwrap();
            let run_id = client
                .start_run("c", "one two three four five six seven eight")
                .await
                .unwrap();
            next_run_event(&mut events).await;
            client.cancel_run(&run_id).await.unwrap();
            loop {
                if let RunEvent::Done { reason } = next_run_event(&mut events).await.event {
                    assert_eq!(reason, DoneReason::Cancelled);
                    break;
                }
            }
        });
    }

    #[test]
    fn backend_exit_is_reported_and_fails_requests() {
        within(async {
            let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../agent");
            let command = BackendCommand {
                program: "uv".into(),
                args: vec![
                    "run".into(),
                    "--project".into(),
                    path_arg(&dir),
                    "python".into(),
                    "-c".into(),
                    "pass".into(),
                ],
                envs: Vec::new(),
            };
            let (client, mut events) = BackendClient::spawn(&command).unwrap();
            assert_eq!(events.next().await, Some(ServerEvent::Exited));
            assert!(client.initialize().await.is_err());
        });
    }
}
