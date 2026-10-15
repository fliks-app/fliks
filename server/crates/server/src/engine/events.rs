//! Events consumer (`engine-glue.md` section H): follows `GET /v1/events`, resyncs from
//! `GET /v1/sessions` after every (re)connect and feeds the subscribers.
use super::{Engine, SessionFilter};
use fliks_engine_core::api::{EngineEvent, SessionSnapshot};
use serde_json::Value;
use std::sync::Arc;
use tokio::time::{Instant, sleep, timeout_at};

/// What a subscriber of [`Engine::subscribe`] reads, in order. After every (re)connect `Resync`
/// comes first (the sessions the engine holds now), then the events that follow it.
#[derive(Debug, Clone)]
pub enum Feed {
    Resync(Arc<Vec<SessionSnapshot>>),
    Event(Arc<EngineEvent>),
}

/// The `data:` payloads of SSE chunks: blocks end at a blank line (`\r?\n\r?\n`), a block's `data:`
/// lines (one leading space stripped) are joined with `\n`, blocks without any yield nothing.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = vec![];
        while let Some((end, next)) = block_end(&self.buf) {
            let block = String::from_utf8_lossy(&self.buf[..end]).into_owned();
            self.buf.drain(..next);
            let data: Vec<&str> = block
                .split('\n')
                .map(|l| l.strip_suffix('\r').unwrap_or(l))
                .filter_map(|l| l.strip_prefix("data:"))
                .map(|d| d.strip_prefix(' ').unwrap_or(d))
                .collect();
            let data = data.join("\n");
            if !data.is_empty() {
                out.push(data);
            }
        }
        out
    }
}

/// Start of the first `\r?\n\r?\n` and the index just after it.
fn block_end(b: &[u8]) -> Option<(usize, usize)> {
    (0..b.len()).find_map(|i| {
        let mut j = i;
        for _ in 0..2 {
            if b.get(j) == Some(&b'\r') {
                j += 1;
            }
            if b.get(j) != Some(&b'\n') {
                return None;
            }
            j += 1;
        }
        Some((i, j))
    })
}

/// Runs for the life of the process: follows the events whenever the adopted engine runs playback and
/// starts over (backoff and all) on every adoption.
pub(super) async fn follow(engine: Engine) {
    let mut adopted = engine.adoptions();
    loop {
        if engine.runtime() {
            tokio::select! {
                () = engine.connect_loop() => {}
                changed = adopted.changed() => if changed.is_err() { return },
            }
        } else if adopted.changed().await.is_err() {
            return;
        }
    }
}

impl Engine {
    /// One connection after another until cancelled; the pause between them is the backoff of rule 50.
    async fn connect_loop(&self) {
        let t = self.timing();
        let mut backoff = t.events_min;
        loop {
            if let Err(e) = self.connect_once(&mut backoff).await {
                tracing::warn!("engine events: {e}");
            }
            sleep(backoff).await;
            backoff = (backoff * 2).min(t.events_max);
        }
    }

    /// Subscribed before listing: an event between the two is replayed, never lost. The idle
    /// watchdog starts with the headers and restarts on every chunk, keep-alives included.
    async fn connect_once(&self, backoff: &mut std::time::Duration) -> Result<(), String> {
        let t = self.timing();
        let client = self.need().map_err(|e| e.to_string())?;
        let mut res = client
            .events()
            .await
            .map_err(|e| e.without_url().to_string())?;
        if !res.status().is_success() {
            return Err(format!("GET /v1/events -> {}", res.status().as_u16()));
        }
        let mut deadline = Instant::now() + t.events_idle;
        self.resync().await.map_err(|e| e.to_string())?;
        *backoff = t.events_min;
        let mut parser = SseParser::default();
        loop {
            let chunk = timeout_at(deadline, res.chunk())
                .await
                .map_err(|_| "no data within the idle limit".to_owned())?
                .map_err(|e| e.without_url().to_string())?;
            let Some(chunk) = chunk else { return Ok(()) };
            deadline = Instant::now() + t.events_idle;
            for data in parser.push(&chunk) {
                let value: Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
                self.handle(value);
            }
        }
    }

    /// The sessions the engine holds now go to the subscribers, then the waiting jobs are re-checked.
    async fn resync(&self) -> Result<(), super::EngineError> {
        let sessions = self.list_sessions(&SessionFilter::default()).await?;
        let _ = self.inner.feed.send(Feed::Resync(Arc::new(sessions)));
        self.resync_jobs().await;
        Ok(())
    }

    /// Unknown event types are ignored (protocol rule); the job waiters hear theirs first.
    fn handle(&self, value: Value) {
        let Ok(event) = serde_json::from_value::<EngineEvent>(value) else {
            return;
        };
        match &event {
            EngineEvent::BgJobProgress { job_id, pct } => self.job_progress(job_id, *pct),
            EngineEvent::BgJobDone {
                job_id,
                state,
                result,
                error,
            } => self.job_ended(job_id, *state, result.clone(), error.clone()),
            _ => {}
        }
        let _ = self.inner.feed.send(Feed::Event(Arc::new(event)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(chunks: &[&[u8]]) -> Vec<String> {
        let mut p = SseParser::default();
        chunks.iter().flat_map(|c| p.push(c)).collect()
    }

    #[test]
    fn sse_blocks_ignore_chunk_boundaries_and_line_endings() {
        assert_eq!(
            all(&[b"data: {\"a\":1}\n\ndata:{\"b\":2}\r\n\r\n"]),
            ["{\"a\":1}", "{\"b\":2}"]
        );
        assert_eq!(
            all(&[b"data: {\"a\"", b":1}\n", b"\ndata: x"]),
            ["{\"a\":1}"]
        );
        assert_eq!(
            all(&[b"da", b"ta: ", "é".as_bytes(), b"\r", b"\n\r\n"]),
            ["é"]
        );
    }

    #[test]
    fn sse_joins_data_lines_and_skips_blocks_without_any() {
        let got =
            all(&[b": keep-alive\n\nevent: ping\n\nevent: x\ndata: a\ndata:  b\n\ndata:\n\n"]);
        assert_eq!(got, ["a\n b"]);
    }
}
