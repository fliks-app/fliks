//! The in-memory log ring behind `GET /api/system/logs` (`docs/spec/system.md` rules 26-30).
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use std::{
    collections::VecDeque,
    fmt::Write as _,
    sync::{LazyLock, Mutex},
};
use tracing::{Event, Level, Subscriber, field::Visit};
use tracing_subscriber::{Layer, layer::Context};

const CAPACITY: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub timestamp: String,
    pub level: &'static str,
    pub context: String,
    pub message: String,
}

static RING: LazyLock<Mutex<VecDeque<Entry>>> = LazyLock::new(Mutex::default);

fn ring() -> std::sync::MutexGuard<'static, VecDeque<Entry>> {
    RING.lock().unwrap_or_else(|e| e.into_inner())
}

fn push(level: &'static str, context: &str, message: String) {
    let mut r = ring();
    if r.len() == CAPACITY {
        r.pop_front();
    }
    r.push_back(Entry {
        timestamp: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        level,
        context: context.to_owned(),
        message,
    });
}

/// Rule 27: filters, then newest first, then the cut (`limit <= 0` means no cut).
pub fn query(level: &str, q: &str, limit: Option<i64>) -> Vec<Entry> {
    let q = q.to_lowercase();
    let mut out: Vec<Entry> = ring()
        .iter()
        .filter(|e| level.is_empty() || e.level == level)
        .filter(|e| {
            q.is_empty()
                || e.message.to_lowercase().contains(&q)
                || e.context.to_lowercase().contains(&q)
        })
        .cloned()
        .collect();
    out.reverse();
    if let Some(n) = limit.filter(|n| *n > 0) {
        out.truncate(usize::try_from(n).unwrap_or(usize::MAX));
    }
    out
}

/// Feeds the ring from `tracing` (rule 28); install it beside the stderr writer.
pub struct RingLayer;

#[derive(Default)]
struct Fields {
    message: String,
    rest: String,
}

impl Visit for Fields {
    fn record_debug(&mut self, f: &tracing::field::Field, v: &dyn std::fmt::Debug) {
        if f.name() == "message" {
            let _ = write!(self.message, "{v:?}");
        } else {
            let _ = write!(self.rest, " {}={v:?}", f.name());
        }
    }

    fn record_str(&mut self, f: &tracing::field::Field, v: &str) {
        if f.name() == "message" {
            self.message.push_str(v);
        } else {
            let _ = write!(self.rest, " {}={v}", f.name());
        }
    }
}

impl<S: Subscriber> Layer<S> for RingLayer {
    fn on_event(&self, ev: &Event<'_>, _: Context<'_, S>) {
        let level = match *ev.metadata().level() {
            Level::ERROR => "error",
            Level::WARN => "warn",
            Level::INFO => "log",
            Level::DEBUG => "debug",
            Level::TRACE => return,
        };
        let mut f = Fields::default();
        ev.record(&mut f);
        let target = ev.metadata().target();
        let context = target.strip_prefix("fliks_server::").unwrap_or(target);
        push(level, context, f.message + &f.rest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::prelude::*;

    #[test]
    fn layer_fills_the_ring_and_query_filters_newest_first() {
        let sub = tracing_subscriber::registry().with(RingLayer);
        tracing::subscriber::with_default(sub, || {
            tracing::info!(target: "fliks_server::jobs::x", "first");
            tracing::warn!("second {}", 2);
            tracing::debug!(user = 7, "third");
            tracing::trace!("dropped");
        });
        let all = query("", "", None);
        let mine: Vec<_> = all
            .iter()
            .filter(|e| {
                e.context.starts_with("jobs::x")
                    || e.message.contains("third")
                    || e.message.starts_with("second")
            })
            .collect();
        assert_eq!(mine.len(), 3);
        assert_eq!(
            (mine[0].level, mine[0].message.as_str()),
            ("debug", "third user=7")
        );
        assert_eq!(
            (mine[1].level, mine[1].message.as_str()),
            ("warn", "second 2")
        );
        assert_eq!(
            (mine[2].level, mine[2].context.as_str()),
            ("log", "jobs::x")
        );
        assert!(query("nope", "", None).is_empty());
        assert_eq!(query("warn", "SECOND", Some(1)).len(), 1);
        assert!(query("", "", Some(0)).len() >= 3);
    }

    #[test]
    fn ring_drops_the_oldest_past_capacity() {
        for i in 0..CAPACITY + 5 {
            push("log", "t", format!("cap-{i}"));
        }
        assert_eq!(ring().len(), CAPACITY);
        assert!(query("", "cap-0", None).is_empty());
        assert_eq!(query("", &format!("cap-{}", CAPACITY + 4), None).len(), 1);
    }
}
