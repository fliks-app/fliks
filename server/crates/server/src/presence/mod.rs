//! Presence (`docs/spec/presence.md`): the host's in-memory mirror of the engine's on-demand sessions.
//! No TTL and no GC, the engine owns expiry; readers filter stale entries ([`ttl_ms`], [`streams`]).
mod feed;
mod session;

pub use feed::spawn;
pub use session::{Beat, Facts, LiveSession, Tags, kind_of, to_tags};

use crate::{engine::Engine, events::event::Num, state::AppState};
use fliks_engine_core::api::{SessionKind, SessionSnapshot};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

/// Epoch milliseconds, the unit of every presence clock.
pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// `liveSessionTtlMs`, read lazily from `STREAM_LIVE_SESSION_TTL_MS` (positive integer, else 30 000).
pub fn ttl_ms() -> f64 {
    f64::from(crate::engine::lifetime(|k| std::env::var(k).ok()).live_session_ttl_ms)
}

/// Keyed by the engine's sid; cheap to clone, every clone shares the map.
#[derive(Clone, Default)]
pub struct Presence(Arc<Mutex<HashMap<String, LiveSession>>>);

impl Presence {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, LiveSession>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// playback-info: always overwrites the entry with the same sid.
    pub fn create(&self, s: LiveSession) -> LiveSession {
        self.map().insert(s.session_id.clone(), s.clone());
        s
    }

    /// Presence of a session this process did not open: inserts only when the sid is unknown and
    /// returns the entry now in the registry.
    pub fn restore(&self, s: &SessionSnapshot) -> LiveSession {
        self.map()
            .entry(s.session_id.clone())
            .or_insert_with(|| LiveSession::from_snapshot(s))
            .clone()
    }

    /// Lazy restore for the heartbeat path (rule 18): when the engine did not lose the session and
    /// [`peek`](Self::peek) is `None`, asks the engine for the sid and restores it. `None` = engine 404.
    pub async fn restore_sid(
        &self,
        engine: &Engine,
        sid: &str,
    ) -> Result<Option<LiveSession>, crate::engine::EngineError> {
        Ok(engine.get_session(sid).await?.map(|s| self.restore(&s)))
    }

    /// Applies a client heartbeat; `None` for an unknown sid (the client re-issues playback-info).
    pub fn heartbeat(&self, sid: &str, beat: &Beat) -> Option<LiveSession> {
        let mut map = self.map();
        let s = map.get_mut(sid)?;
        s.apply(beat, now_ms());
        Some(s.clone())
    }

    /// Drops the entry, returning it so the caller can tell QoE; engine calls stay with the caller.
    pub fn stop(&self, sid: &str) -> Option<LiveSession> {
        self.map().remove(sid)
    }

    pub fn peek(&self, sid: &str) -> Option<LiveSession> {
        self.map().get(sid).cloned()
    }

    /// Oldest first, so a linear scan by connection is deterministic.
    pub fn list(&self) -> Vec<LiveSession> {
        let mut all: Vec<_> = self.map().values().cloned().collect();
        all.sort_by(|a, b| {
            (a.started_at, &a.session_id)
                .partial_cmp(&(b.started_at, &b.session_id))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        all
    }

    pub fn size(&self) -> usize {
        self.map().len()
    }

    /// The engine listed `snaps`: unknown ones are restored, entries the list lacks are dropped
    /// unless opened after `listed_at`. Existing entries keep their heartbeat-fed fields.
    fn resync(&self, snaps: &[SessionSnapshot], listed_at: f64) {
        let mut map = self.map();
        for s in snaps {
            map.entry(s.session_id.clone())
                .or_insert_with(|| LiveSession::from_snapshot(s));
        }
        map.retain(|sid, s| {
            s.started_at >= listed_at || snaps.iter().any(|n| &n.session_id == sid)
        });
    }
}

/// A presence session bound to an SSE connection, for `/api/remote/targets` (`remote.md` rule 5).
#[derive(Debug)]
pub struct Live {
    pub connection_id: String,
    /// From the session even when stale.
    pub system_name: Option<String>,
    /// `None` once `now - lastBeat > liveSessionTtlMs`.
    pub now_playing: Option<NowPlaying>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub media_file_id: i64,
    pub media_title: Option<String>,
    pub media_type: Option<String>,
    pub poster_url: Option<String>,
    pub position_seconds: Num,
    pub state: crate::events::event::PlayState,
}

/// Sessions with an SSE connection id, oldest first; the swap point for `live_sessions` in remote.
pub fn live_sessions(st: &AppState) -> Vec<Live> {
    live_at(st.presence.list(), now_ms(), ttl_ms())
}

fn live_at(sessions: Vec<LiveSession>, now: f64, ttl: f64) -> Vec<Live> {
    sessions
        .into_iter()
        .filter_map(|s| {
            let connection_id = s.sse_connection_id.clone()?;
            let fresh = now - s.last_beat <= ttl;
            Some(Live {
                connection_id,
                system_name: s.system_name.clone(),
                now_playing: fresh.then(|| NowPlaying {
                    media_file_id: i64::from(s.media_file_id),
                    media_title: s.media_title,
                    media_type: s.media_type,
                    poster_url: s.poster_url,
                    position_seconds: Num(s.position),
                    state: s.state,
                }),
            })
        })
        .collect()
}

/// One row of `GET /api/system/streams`: the presence entry joined with the engine's snapshot.
#[derive(Debug)]
pub struct Stream {
    pub live: LiveSession,
    pub engine: Option<SessionSnapshot>,
}

impl Stream {
    pub fn mode(&self) -> SessionKind {
        self.live.kind
    }

    /// `original` for direct play, else the engine's rung, else the session's.
    pub fn quality(&self) -> String {
        if self.live.kind == SessionKind::Directplay {
            return "original".into();
        }
        let eng = self.engine.as_ref().and_then(|e| e.quality.clone());
        eng.or_else(|| self.live.quality.clone())
            .unwrap_or_else(|| "original".into())
    }

    /// `none` for direct play and remux, else the job's actual hardware, else the host's (`host_hw`).
    pub fn hw_accel(&self, host_hw: &str) -> String {
        if self.live.kind != SessionKind::Transcode {
            return "none".into();
        }
        let job = self.engine.as_ref().and_then(|e| e.job.as_ref());
        job.map_or_else(
            || host_hw.to_owned(),
            |j| format!("{:?}", j.actual_hw).to_lowercase(),
        )
    }

    /// Epoch ms: the engine's last beat when known, else the registry's.
    pub fn last_activity_ms(&self) -> f64 {
        self.engine
            .as_ref()
            .map_or(self.live.last_beat, |e| e.last_beat_ms)
    }
}

/// The live rows (rule 12): with the engine's list, entries it lists; without it (not running or
/// the call failed), entries beaten within the TTL.
pub async fn streams(st: &AppState) -> Vec<Stream> {
    let listed = if st.engine.runtime() {
        st.engine
            .list_sessions(&crate::engine::SessionFilter::default())
            .await
            .map_err(|e| tracing::warn!("engine sessions: {e}"))
            .ok()
    } else {
        None
    };
    select(st.presence.list(), listed, now_ms(), ttl_ms())
}

fn select(
    sessions: Vec<LiveSession>,
    listed: Option<Vec<SessionSnapshot>>,
    now: f64,
    ttl: f64,
) -> Vec<Stream> {
    let mut by_sid: Option<HashMap<_, _>> =
        listed.map(|l| l.into_iter().map(|s| (s.session_id.clone(), s)).collect());
    sessions
        .into_iter()
        .filter_map(|live| match by_sid.as_mut() {
            Some(m) => m.remove(&live.session_id).map(|e| (live, Some(e))),
            None => (live.last_beat > now - ttl).then_some((live, None)),
        })
        .map(|(live, engine)| Stream { live, engine })
        .collect()
}

#[cfg(test)]
mod tests;
