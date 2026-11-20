//! A stream fed by a background task, which is aborted when the stream is dropped (e.g. when a
//! run is stopped), so no HTTP request outlives the run that started it.

use std::pin::Pin;
use std::task::{Context, Poll};

use futures::Stream;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub struct TaskStream<T> {
    rx: mpsc::Receiver<T>,
    task: JoinHandle<()>,
}

impl<T: Send + 'static> TaskStream<T> {
    /// Runs `produce` on the current Tokio runtime; it sends items until it returns.
    pub fn spawn<F, Fut>(produce: F) -> Self
    where
        F: FnOnce(mpsc::Sender<T>) -> Fut,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel(32);
        let task = tokio::spawn(produce(tx));
        Self { rx, task }
    }
}

impl<T> Stream for TaskStream<T> {
    type Item = T;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<T>> {
        self.rx.poll_recv(cx)
    }
}

impl<T> Drop for TaskStream<T> {
    fn drop(&mut self) {
        self.task.abort();
    }
}
