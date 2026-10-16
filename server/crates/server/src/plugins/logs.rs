//! Plugin output: guest `log`, stdout and stderr into one ring, capped per plugin per minute.

use std::collections::{HashMap, VecDeque};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::io::AsyncWrite;
use wasmtime_wasi::cli::{IsTerminal, StdoutStream};

pub const CAP_PER_MINUTE: usize = 64 * 1024;
const RING: usize = 2000;
const TAIL: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug)]
pub struct Line {
    pub at: Instant,
    pub context: String,
    pub level: Level,
    pub text: String,
}

#[derive(Default)]
struct Window {
    start: Option<Instant>,
    bytes: usize,
    warned: bool,
}

#[derive(Default)]
pub struct Logs {
    lines: Mutex<VecDeque<Line>>,
    windows: Mutex<HashMap<String, Window>>,
    tails: Mutex<HashMap<String, String>>,
}

impl Logs {
    pub fn push(&self, plugin: &str, level: Level, text: &str) {
        let now = Instant::now();
        let context = format!("plugin:{plugin}");
        {
            let mut w = self.windows.lock().unwrap();
            let w = w.entry(plugin.to_owned()).or_default();
            if w.start.is_none_or(|s| now - s >= Duration::from_secs(60)) {
                *w = Window {
                    start: Some(now),
                    bytes: 0,
                    warned: false,
                };
            }
            if w.bytes + text.len() > CAP_PER_MINUTE {
                if !w.warned {
                    w.warned = true;
                    self.ring(Line {
                        at: now,
                        context,
                        level: Level::Warn,
                        text: "output over 64 KiB this minute, dropping".into(),
                    });
                }
                return;
            }
            w.bytes += text.len();
        }
        self.ring(Line {
            at: now,
            context,
            level,
            text: text.to_owned(),
        });
    }

    fn ring(&self, line: Line) {
        let mut l = self.lines.lock().unwrap();
        if l.len() == RING {
            l.pop_front();
        }
        l.push_back(line);
    }

    fn stderr(&self, plugin: &str, text: &str) {
        let mut t = self.tails.lock().unwrap();
        let tail = t.entry(plugin.to_owned()).or_default();
        tail.push_str(text);
        tail.push('\n');
        if tail.len() > TAIL {
            let mut cut = tail.len() - TAIL;
            while !tail.is_char_boundary(cut) {
                cut += 1;
            }
            tail.drain(..cut);
        }
    }

    pub fn tail(&self, plugin: &str) -> String {
        self.tails
            .lock()
            .unwrap()
            .get(plugin)
            .cloned()
            .unwrap_or_default()
    }

    pub fn lines(&self) -> Vec<Line> {
        self.lines.lock().unwrap().iter().cloned().collect()
    }
}

#[derive(Clone)]
pub struct Pipe {
    pub logs: Arc<Logs>,
    pub plugin: Arc<str>,
    pub stderr: bool,
}

impl Pipe {
    fn line(&self, raw: &[u8]) {
        let text = String::from_utf8_lossy(raw);
        let level = if !self.stderr {
            Level::Info
        } else if strip_tags(&text).starts_with("WARN") {
            Level::Warn
        } else {
            Level::Error
        };
        if self.stderr {
            self.logs.stderr(&self.plugin, &text);
        }
        self.logs.push(&self.plugin, level, &text);
    }
}

fn strip_tags(mut s: &str) -> &str {
    while let Some(rest) = s.strip_prefix('[') {
        match rest.find(']') {
            Some(i) => s = rest[i + 1..].trim_start(),
            None => break,
        }
    }
    s
}

impl IsTerminal for Pipe {
    fn is_terminal(&self) -> bool {
        false
    }
}

impl StdoutStream for Pipe {
    fn async_stream(&self) -> Box<dyn AsyncWrite + Send + Sync> {
        Box::new(LineWriter {
            pipe: self.clone(),
            buf: Vec::new(),
        })
    }
}

struct LineWriter {
    pipe: Pipe,
    buf: Vec<u8>,
}

impl AsyncWrite for LineWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        self.buf.extend_from_slice(data);
        while let Some(i) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            self.pipe.line(&line[..line.len() - 1]);
        }
        if self.buf.len() > TAIL {
            let line = std::mem::take(&mut self.buf);
            self.pipe.line(&line);
        }
        Poll::Ready(Ok(data.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        if !self.buf.is_empty() {
            let line = std::mem::take(&mut self.buf);
            self.pipe.line(&line);
        }
        Poll::Ready(Ok(()))
    }
}
