//! The in-memory log ring behind `GET /api/system/logs` (`docs/spec/system.md` rules 26-30).
use crate::sync::MutexExt;
use chrono::Utc;
use serde::Serialize;
use std::{
    collections::VecDeque,
    fmt::Write as _,
    sync::{LazyLock, Mutex},
};
use tracing::{Event, Level, Subscriber, field::Visit};
use tracing_subscriber::{Layer, layer::Context};

/// Entries kept per level (`error`, `warn`, `log`, `debug`): a flood of one level evicts only its own.
const BUDGET: [usize; 4] = [500, 500, 750, 250];

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub timestamp: String,
    pub level: &'static str,
    pub context: String,
    pub message: String,
    #[serde(skip)]
    seq: u64,
}

#[derive(Default)]
struct Ring {
    seq: u64,
    levels: [VecDeque<Entry>; 4],
}

static RING: LazyLock<Mutex<Ring>> = LazyLock::new(Mutex::default);

fn ring() -> std::sync::MutexGuard<'static, Ring> {
    RING.lock_clean()
}

fn slot(level: &str) -> usize {
    match level {
        "error" => 0,
        "warn" => 1,
        "log" => 2,
        _ => 3,
    }
}

/// A line whose context is not a `tracing` target (`plugin:<id>`, `plugins.md` rule 45).
pub fn push(level: &'static str, context: &str, message: String) {
    let mut r = ring();
    r.seq += 1;
    let seq = r.seq;
    let i = slot(level);
    let q = &mut r.levels[i];
    if q.len() == BUDGET[i] {
        q.pop_front();
    }
    q.push_back(Entry {
        timestamp: fliks_domain::js::iso(Utc::now()),
        level,
        context: context.to_owned(),
        message,
        seq,
    });
}

/// Rule 27: filters, then newest first, then the cut (`limit <= 0` means no cut).
pub fn query(level: &str, q: &str, limit: Option<i64>) -> Vec<Entry> {
    let q = q.to_lowercase();
    let mut out: Vec<Entry> = ring()
        .levels
        .iter()
        .flatten()
        .filter(|e| level.is_empty() || e.level == level)
        .filter(|e| {
            q.is_empty()
                || e.message.to_lowercase().contains(&q)
                || e.context.to_lowercase().contains(&q)
        })
        .cloned()
        .collect();
    out.sort_unstable_by_key(|e| std::cmp::Reverse(e.seq));
    if let Some(n) = limit.filter(|n| *n > 0) {
        out.truncate(usize::try_from(n).unwrap_or(usize::MAX));
    }
    out
}

/// Routes every panic, in a handler or a spawned task, through `tracing` so the ring and stderr hold it.
pub fn log_panics() {
    std::panic::set_hook(Box::new(|info| {
        let payload = info.payload();
        let text = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("non-string payload");
        let at = info.location().map(ToString::to_string).unwrap_or_default();
        let thread = std::thread::current();
        let backtrace = std::backtrace::Backtrace::capture().to_string();
        tracing::error!(
            thread = thread.name().unwrap_or("?"),
            at,
            backtrace,
            "panic: {text}"
        );
    }));
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
    fn a_panic_reaches_the_ring() {
        log_panics();
        let sub = tracing_subscriber::registry().with(RingLayer);
        tracing::subscriber::with_default(sub, || {
            let _ = std::panic::catch_unwind(|| panic!("boom-ring-test"));
        });
        let hit = query("error", "boom-ring-test", None);
        assert_eq!(hit.len(), 1);
        assert!(hit[0].message.starts_with("panic: boom-ring-test"));
    }

    #[test]
    fn a_flood_of_one_level_keeps_the_others() {
        push("error", "flood", "kept-error".into());
        push("warn", "flood", "kept-warn".into());
        for i in 0..BUDGET[2] + 5 {
            push("log", "flood", format!("cap-{i}"));
        }
        assert_eq!(query("log", "flood", None).len(), BUDGET[2]);
        assert!(query("", "cap-0", None).is_empty());
        assert_eq!(query("", &format!("cap-{}", BUDGET[2] + 4), None).len(), 1);
        assert_eq!(query("error", "kept-error", None).len(), 1);
        assert_eq!(query("warn", "kept-warn", None).len(), 1);
    }
}
