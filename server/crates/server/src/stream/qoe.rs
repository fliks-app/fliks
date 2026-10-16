//! The one consumer of the engine feed for QoE: served segments, rung and hardware changes, and the
//! running-job count behind `serverLoad.activeTranscodes` (`qoe.md` rule 35). Presence stays in `presence::feed`.
use super::system::served_rung;
use crate::{engine::Feed, qoe::SessionRef, state::AppState};
use fliks_domain::qoe::read_cmcd_raw;
use fliks_engine_core::{
    api::{EngineEvent, JobState, SessionKind, SessionSnapshot},
    session::{base_profile_hash, session_key},
};
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

/// A run of a session: the engine's key (`session_key`) with every `-remux-a<n>` variant as one `-remux`.
fn run_id(key: &str) -> String {
    let base = base_profile_hash(key);
    let tail = &key[base.len()..];
    format!(
        "{base}{}",
        if tail.starts_with("-remux") {
            "-remux"
        } else {
            tail
        }
    )
}

/// A snapshot carries no job key, only the session's primary run.
fn snapshot_run_id(s: &SessionSnapshot) -> String {
    let hash = s.profile_hash.as_deref().unwrap_or_default();
    primary_run_id(s.media_file_id, s.owner_id.as_deref(), hash, s.kind)
}

fn primary_run_id(media: u32, owner: Option<&str>, hash: &str, kind: SessionKind) -> String {
    let tail = if kind == SessionKind::Remux {
        "-remux"
    } else {
        ""
    };
    format!("{}{tail}", session_key(media, owner, hash))
}

fn resync(jobs: &Jobs, snaps: &[SessionSnapshot]) {
    let mut j = jobs.lock().unwrap_or_else(|e| e.into_inner());
    *j = snaps
        .iter()
        .filter(|s| s.job.as_ref().is_some_and(|j| j.state == JobState::Running))
        .map(snapshot_run_id)
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
                .insert(run_id(job_key));
        }
        EngineEvent::JobEnded { job_key, .. } => {
            jobs.lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&run_id(job_key));
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
    use super::{real_segment_seconds as real, *};

    #[test]
    fn segments_are_cut_on_whole_gops() {
        assert_eq!(real(3.0, Some(24.0)), 3.0);
        assert_eq!(real(3.0, Some(23.976)), 3.003);
        assert_eq!(real(6.0, None), 6.0);
    }

    #[test]
    fn a_resynced_run_ends_on_the_engines_own_job_key() {
        let jobs = |k, h| primary_run_id(7, Some("3"), h, k);
        assert_eq!(jobs(SessionKind::Remux, "h1"), run_id("7-u3-h1-remux-a0-u"));
        assert_eq!(jobs(SessionKind::Remux, "h1"), run_id("7-u3-h1-remux"));
        assert_eq!(jobs(SessionKind::Transcode, "h1~i2"), run_id("7-u3-h1~i2"));
        assert_ne!(run_id("7-u3-h1-early"), run_id("7-u3-h1"));
        assert_eq!(
            primary_run_id(7, None, "h", SessionKind::Transcode),
            run_id("7-anon-h")
        );
    }
}
