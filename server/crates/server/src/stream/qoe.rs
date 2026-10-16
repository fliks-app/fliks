//! Calls into QoE, wired by the qoe piece; nothing to do until it lands.
use crate::{presence::LiveSession, state::AppState};
use fliks_engine_core::api::QoePipeline;
use serde_json::Value;

pub fn qoe_register(_st: &AppState, _live: &LiveSession, _pipeline: Option<&QoePipeline>) {}

/// The presence entry was stopped: QoE flushes its tracker.
pub fn qoe_session_ended(_st: &AppState, _live: &LiveSession) {}

/// `QoeService.liveSummary(sid)` as the dashboard shows it; `None` when the session is not tracked.
pub fn qoe_live_summary(_st: &AppState, _sid: &str) -> Option<Value> {
    None
}
