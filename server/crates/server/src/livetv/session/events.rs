//! The engine side of the live sessions: events, the resync after a restart, holds and viewers.
use super::*;

pub(super) fn sync_transcodes(st: &AppState) {
    let n = Live::transcodes(&st.livetv.live.lock());
    st.qoe.set_live_transcodes(n);
}

/// The viewer as a QoE session (kind `live`, the channel as its title).
pub(super) fn qoe_ref(st: &AppState, sid: &str) -> Option<SessionRef> {
    let g = st.livetv.live.lock();
    let v = g.viewers.get(sid)?;
    Some(SessionRef {
        session_id: sid.to_owned(),
        user_id: v.user_id,
        media_file_id: None,
        media_title: Some(v.channel_name.clone()),
        started_at: v.started_at,
        last_beat: now_ms(),
        device_label: v.device.clone(),
        system_name: None,
        app_version: None,
        kind: Kind::Live,
        quality: None,
        transcode_reasons: json!([]),
        state: crate::events::event::PlayState::Playing,
        attributed_user_id: None,
    })
}

/// `livetv:<token>` in the activity registry: gone with the last viewer of the token.
pub(super) fn report_activity(st: &AppState, token: &str) {
    let mine: Vec<Viewer> = {
        let g = st.livetv.live.lock();
        let mut v: Vec<Viewer> = g
            .viewers
            .values()
            .filter(|v| v.capacity_token == token)
            .cloned()
            .collect();
        v.sort_by(|a, b| a.started_at.total_cmp(&b.started_at));
        v
    };
    let id = format!("livetv:{token}");
    match mine.first() {
        None => st.hub.activity().remove(&id),
        Some(first) => st.hub.activity().upsert_running(
            &id,
            "livetv.viewing",
            Some(Subject {
                title: first.channel_name.clone(),
                media_id: None,
                media_type: None,
                season_number: None,
                episode_number: None,
                episode_title: None,
                episode_id: None,
            }),
            Some(Num(mine.len() as f64)),
            None,
            None,
        ),
    }
}

/// Drops the viewer; `settle` waits for the QoE tracker to be finalised (the leave route).
pub(super) async fn drop_viewer(st: &AppState, sid: &str, settle: bool) {
    let gone = st.livetv.live.lock().viewers.remove(sid);
    let Some(v) = gone else { return };
    if settle {
        st.qoe.end_session(sid).await;
    } else {
        st.qoe.session_ended(sid);
    }
    report_activity(st, &v.capacity_token);
}

/// `LiveReleased` and the internal release: the hold is gone, its provider connection lingers for the grace.
pub(super) async fn release(st: &AppState, token: &str, reason: &str) {
    let hold = {
        let mut g = st.livetv.live.lock();
        let Some(h) = g.holds.remove(token) else {
            return;
        };
        g.releases.record(h.source_id, Instant::now(), 3600.0);
        h
    };
    sync_transcodes(st);
    st.hub.activity().remove(&format!("livetv:{token}"));
    if reason != "failed" {
        return;
    }
    let done = sqlx::query(
        r#"UPDATE livetv_channels SET "lastErrorAt" = now(), "consecutiveFailures" = "consecutiveFailures" + 1 WHERE id = $1"#,
    )
    .bind(hold.channel_id)
    .execute(&st.db)
    .await;
    if let Err(e) = done {
        tracing::warn!(
            "Live TV channel #{} failure not counted: {e}",
            hold.channel_id
        );
    }
    tracing::warn!(
        "Live TV channel #{} ended: every stream failed",
        hold.channel_id
    );
}

/// One upstream attempt of a session: its health, its probe, and where the hold sits (rule 23).
pub(super) async fn attempt(st: &AppState, ev: &EngineEvent) {
    let EngineEvent::LiveAttempt {
        capacity_token,
        upstream,
        upstream_url,
        upstream_priority,
        error,
        probe,
    } = ev
    else {
        return;
    };
    let mut refresh = false;
    let (stream_id, expired) = {
        let mut g = st.livetv.live.lock();
        let Some(hold) = g.holds.get_mut(capacity_token) else {
            return;
        };
        let Some(stream) = stream_at(hold, upstream_url, *upstream_priority).cloned() else {
            return;
        };
        let expired = account_state(
            stream.source.expires_at,
            stream.source.account_status.as_deref(),
            Utc::now(),
        ) == AccountState::Expired;
        if error.is_none() {
            hold.source_id = stream.source.id;
            hold.fed = Some(*upstream);
            refresh = !hold.pending;
        }
        let fed_failed = error.is_some() && hold.fed == Some(*upstream);
        if fed_failed {
            hold.fed = None;
        }
        if fed_failed {
            g.releases.record(stream.source.id, Instant::now(), 3600.0);
        }
        (stream.id, expired)
    };
    if refresh {
        let st = st.clone();
        tokio::spawn(async move { refresh_modes(&st).await });
    }
    let probe = probe.clone().unwrap_or_default();
    let non_empty = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
    let last_error = error.as_ref().map(|e| {
        if expired {
            "account expired".to_owned()
        } else {
            e.clone()
        }
    });
    let done = sqlx::query(
        r#"UPDATE livetv_channel_streams SET
             "probedVideoCodec" = COALESCE($2, "probedVideoCodec"), "probedAudioCodec" = COALESCE($3, "probedAudioCodec"),
             "probedContainer" = COALESCE($4, "probedContainer"),
             "lastOkAt" = CASE WHEN $5::text IS NULL THEN now() ELSE "lastOkAt" END, "lastError" = $5
           WHERE id = $1"#,
    )
    .bind(stream_id)
    .bind(non_empty(&probe.video_codec))
    .bind(non_empty(&probe.audio_codec))
    .bind(non_empty(&probe.container))
    .bind(last_error)
    .execute(&st.db)
    .await;
    if let Err(e) = done {
        tracing::warn!("live attempt: {e}");
    }
    sync_transcodes(st);
}

/// A remux of a non-H.264 upstream becomes a transcode: the engine's snapshot has the verdict.
pub(super) async fn refresh_modes(st: &AppState) {
    let Ok(snaps) = st.engine.list_live(None).await else {
        return;
    };
    {
        let mut g = st.livetv.live.lock();
        for s in snaps {
            if let Some(h) = g.holds.get_mut(&s.capacity_token) {
                h.mode = Some(s.mode);
            }
        }
    }
    sync_transcodes(st);
}

/// A viewer rebuilt from the engine's snapshot (a restart, or a request racing the boot resync).
pub(super) fn viewer_of(s: &LiveSnapshot) -> Viewer {
    Viewer {
        channel_id: s.channel_id.parse().unwrap_or(0),
        channel_name: s.tags.get("channelName").cloned().unwrap_or_default(),
        user_id: s.owner_id.as_deref().and_then(|o| o.parse().ok()),
        device: s.tags.get("device").cloned().filter(|d| !d.is_empty()),
        started_at: s.opened_at_ms,
        capacity_token: s.capacity_token.clone(),
    }
}

/// After every events (re)connect and at boot: viewers and holds follow what the engine still runs (rule 28).
pub async fn resync(st: &AppState) -> Result<(), EngineError> {
    let listed_at = now_ms();
    let snaps = st.engine.list_live(None).await?;
    let tokens: std::collections::HashSet<&str> =
        snaps.iter().map(|s| s.capacity_token.as_str()).collect();
    restore_holds(st, &snaps).await;
    let (added, stale): (Vec<(String, String)>, Vec<String>) = {
        let mut g = st.livetv.live.lock();
        let known: std::collections::HashSet<&str> =
            snaps.iter().map(|s| s.session_id.as_str()).collect();
        let mut added = vec![];
        for s in &snaps {
            if !g.viewers.contains_key(&s.session_id) {
                g.viewers.insert(s.session_id.clone(), viewer_of(s));
                added.push((s.session_id.clone(), s.capacity_token.clone()));
            }
        }
        let stale = g
            .viewers
            .iter()
            .filter(|(sid, v)| !known.contains(sid.as_str()) && v.started_at < listed_at)
            .map(|(sid, _)| sid.clone())
            .collect();
        (added, stale)
    };
    for (_, token) in &added {
        report_activity(st, token);
    }
    for sid in stale {
        drop_viewer(st, &sid, false).await;
    }
    let gone: Vec<String> = st
        .livetv
        .live
        .lock()
        .holds
        .iter()
        .filter(|(t, h)| !tokens.contains(t.as_str()) && !h.pending)
        .map(|(t, _)| t.clone())
        .collect();
    for token in gone {
        release(st, &token, "shutdown").await;
    }
    sync_transcodes(st);
    Ok(())
}

pub(super) async fn restore_holds(st: &AppState, snaps: &[LiveSnapshot]) {
    for s in snaps {
        let known = {
            let mut g = st.livetv.live.lock();
            match g.holds.get_mut(&s.capacity_token) {
                Some(h) => {
                    h.mode = h.mode.or(Some(s.mode));
                    true
                }
                None => false,
            }
        };
        if known {
            continue;
        }
        let channel_id: i32 = s.channel_id.parse().unwrap_or(0);
        let Ok(streams) = load_streams(&st.db, channel_id, false).await else {
            continue;
        };
        let Some(fed) = streams
            .iter()
            .find(|x| x.url == s.upstream_url && x.priority == s.upstream_priority)
            .cloned()
        else {
            continue;
        };
        let mut g = st.livetv.live.lock();
        g.holds.entry(s.capacity_token.clone()).or_insert(Hold {
            source_id: fed.source.id,
            channel_id,
            streams,
            fed: Some(s.upstream),
            pending: false,
            mode: Some(s.mode),
            owner: None,
        });
    }
}

/// Follows the engine's events for the life of the process; subscribed before the engine starts.
pub fn spawn(st: &AppState) {
    let mut rx = st.engine.subscribe();
    let st = st.clone();
    tokio::spawn(async move {
        use crate::engine::Feed;
        use tokio::sync::broadcast::error::RecvError;
        loop {
            match rx.recv().await {
                Ok(Feed::Resync(..)) => {
                    if let Err(e) = resync(&st).await {
                        tracing::warn!("live TV resync failed: {e}");
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        st.engine.resync_events();
                    }
                }
                Ok(Feed::Event(ev)) => on_event(&st, &ev).await,
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!("live TV feed lagged by {n}, resyncing");
                    st.engine.resync_events();
                }
                Err(RecvError::Closed) => return,
            }
        }
    });
}

pub(in crate::livetv) async fn on_event(st: &AppState, ev: &EngineEvent) {
    match ev {
        EngineEvent::LiveAttempt { .. } => attempt(st, ev).await,
        EngineEvent::LiveReleased {
            capacity_token,
            reason,
        } => release(st, capacity_token, reason).await,
        EngineEvent::SessionEnded { session_id, .. } => drop_viewer(st, session_id, false).await,
        EngineEvent::SegmentServed {
            session_id,
            cmcd_raw,
            waited_ms,
            ..
        } => {
            if let Some(r) = qoe_ref(st, session_id) {
                let cmcd = cmcd_raw.as_deref().and_then(read_cmcd_raw);
                st.qoe.observe_served(
                    &r,
                    cmcd.as_ref(),
                    f64::from(st.engine.livetv_segment_seconds()),
                    Some(*waited_ms),
                );
            }
        }
        _ => {}
    }
}
