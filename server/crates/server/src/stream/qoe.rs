//! The one consumer of the engine feed for QoE: served segments, rung and hardware changes, and the
//! running-job count behind `serverLoad.activeTranscodes` (`qoe.md` rule 35). Presence stays in `presence::feed`.
use super::system::served_rung;
use crate::{engine::Feed, qoe::SessionRef, state::AppState};
use fliks_domain::qoe::read_cmcd_raw;
use fliks_engine_core::api::{EngineEvent, JobState, SessionKind, SessionSnapshot};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::broadcast::error::RecvError;

const SEGMENT_TTL: Duration = Duration::from_secs(30);
const DEFAULT_SEGMENT_S: f64 = 3.0;

type Jobs = Arc<Mutex<HashSet<String>>>;

/// Subscribes before the engine starts, so the first `Resync` is never missed. Runs for the process.
pub fn spawn(st: &AppState) {
    let jobs = Jobs::default();
    let (probe_jobs, sessions) = (jobs.clone(), st.presence.clone());
    st.qoe.set_load_probe(move || {
        let n = probe_jobs.lock().map_or(0, |j| j.len());
        (
            u32::try_from(n).unwrap_or(u32::MAX),
            u32::try_from(sessions.size()).unwrap_or(u32::MAX),
        )
    });
    let (st, mut rx) = (st.clone(), st.engine.subscribe());
    tokio::spawn(async move {
        let mut segment = (Instant::now() - SEGMENT_TTL, DEFAULT_SEGMENT_S);
        loop {
            match rx.recv().await {
                Ok(Feed::Resync(snaps, _)) => resync(&jobs, &snaps),
                Ok(Feed::Event(ev)) => {
                    if matches!(*ev, EngineEvent::SegmentServed { .. })
                        && segment.0.elapsed() >= SEGMENT_TTL
                    {
                        segment = (Instant::now(), segment_duration(&st).await);
                    }
                    observe(&st, &jobs, &ev, segment.1);
                }
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!("qoe feed lagged by {n}, resyncing");
                    st.engine.resync_events();
                }
                Err(RecvError::Closed) => return,
            }
        }
    });
}

async fn segment_duration(st: &AppState) -> f64 {
    crate::engine::load_streaming(&st.db)
        .await
        .map_or(DEFAULT_SEGMENT_S, |s| s.segment_duration)
}

fn job_key(s: &SessionSnapshot) -> String {
    let owner = s.owner_id.as_deref().filter(|o| !o.is_empty());
    format!(
        "{}-{}-{}",
        s.media_file_id,
        owner.map_or("anon".to_owned(), |o| format!("u{o}")),
        s.profile_hash.as_deref().unwrap_or("")
    )
}

fn resync(jobs: &Jobs, snaps: &[SessionSnapshot]) {
    let mut j = jobs.lock().unwrap_or_else(|e| e.into_inner());
    *j = snaps
        .iter()
        .filter(|s| s.job.as_ref().is_some_and(|j| j.state == JobState::Running))
        .map(job_key)
        .collect();
}

/// Real length of a segment cut every `segment_duration` seconds on whole GOPs of `fps`.
pub(super) fn real_segment_seconds(segment_duration: f64, fps: Option<f64>) -> f64 {
    let Some(fps) = fps.filter(|f| *f > 0.0) else {
        return segment_duration;
    };
    let gop = (segment_duration * fps).round().max(1.0) / fps;
    (gop * 1000.0).round() / 1000.0
}

fn observe(st: &AppState, jobs: &Jobs, ev: &EngineEvent, segment_s: f64) {
    match ev {
        // A throttle-paused job still counts: the engine emits no pause event.
        EngineEvent::JobStarted { job_key, .. } => {
            jobs.lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(job_key.clone());
        }
        EngineEvent::JobEnded { job_key, .. } => {
            jobs.lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(job_key);
        }
        EngineEvent::PipelineChanged {
            session_id,
            quality,
            hw_accel,
        } => {
            let Some(live) = st.presence.peek(session_id) else {
                return;
            };
            if live.kind == SessionKind::Transcode {
                let bitrate = served_rung(
                    live.kind,
                    quality,
                    live.hdr_ladder,
                    live.bitrate_by_quality.as_ref(),
                )
                .map(|r| f64::from(r.video_bitrate_bps))
                .filter(|b| *b != 0.0);
                st.qoe.note_served_rung(session_id, quality, bitrate);
            }
            let hw = serde_json::to_value(hw_accel).ok();
            st.qoe.note_hw_accel(
                session_id,
                hw.as_ref().and_then(|v| v.as_str()).unwrap_or(""),
            );
        }
        EngineEvent::SegmentServed {
            session_id,
            waited_ms,
            cmcd_raw,
            ..
        } => {
            let Some(live) = st.presence.peek(session_id) else {
                return;
            };
            let cmcd = cmcd_raw.as_deref().and_then(read_cmcd_raw);
            st.qoe.observe_served(
                &SessionRef::from(&live),
                cmcd.as_ref(),
                real_segment_seconds(segment_s, live.source_fps),
                Some(*waited_ms),
            );
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::real_segment_seconds as real;

    #[test]
    fn segments_are_cut_on_whole_gops() {
        assert_eq!(real(3.0, Some(24.0)), 3.0);
        assert_eq!(real(3.0, Some(23.976)), 3.003);
        assert_eq!(real(6.0, None), 6.0);
    }
}
