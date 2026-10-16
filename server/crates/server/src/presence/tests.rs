use super::feed::{apply, run};
use super::*;
use crate::{engine::Feed, events::event::PlayState};
use fliks_engine_core::api::EngineEvent;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use tokio::sync::broadcast;

fn snap_json(sid: &str, owner: Option<&str>, opened: f64, beat: f64) -> Value {
    let mut v: Value = serde_json::from_str(DECISION).unwrap();
    v["sessionId"] = sid.into();
    v["openedAtMs"] = opened.into();
    v["lastBeatMs"] = beat.into();
    if let Some(o) = owner {
        v["ownerId"] = o.into();
    }
    v
}

const DECISION: &str = r#"{
  "mediaFileId": 7, "profileHash": "h1", "kind": "transcode", "quality": "720p",
  "client": {"userAgent": "UA", "systemName": "macOS 26", "appVersion": "1.2"},
  "tags": {"username": "bob", "mediaTitle": "Dune", "mediaType": "movie",
           "sseConnectionId": "c1", "attributedUserId": "9"},
  "positionS": 12.5, "state": "paused", "pinned": false, "configRevision": 1,
  "decision": {
    "useHdrLadder": true, "videoVariant": {"codec": "h264", "bitDepth": 8, "hdr": null},
    "muxFlavour": "ts", "audioPlans": [], "transcodeTonemapping": false,
    "response": {
      "mediaFileId": 7, "playMethod": "Transcode", "playUrl": "/p", "contentType": "x",
      "transcodeReasons": [{"flag": "VideoCodecNotSupported", "message": "m"}],
      "videoCopyStream": false, "audioCopyStream": true, "outputVideoCodec": "h264",
      "outputAudioCodec": "aac", "audioPlan": {"mode": "transcode", "codec": "aac", "channels": 2},
      "outputContainer": "hls", "quality": "auto", "hwAccel": "none", "tonemapping": false,
      "clientTonemap": true, "dolbyVision": false, "qualities": [], "audioTracks": [],
      "source": {"container": "mkv", "videoCodec": "hevc", "audioCodec": "dts",
                 "frameRate": "24000/1001"}
    }
  }
}"#;

fn snap(sid: &str, owner: Option<&str>, opened: f64, beat: f64) -> SessionSnapshot {
    serde_json::from_value(snap_json(sid, owner, opened, beat)).unwrap()
}

fn resync(snaps: Vec<SessionSnapshot>) -> Feed {
    Feed::Resync(Arc::new(snaps), now_ms())
}

#[test]
fn snapshot_restores_clocks_state_and_tags_but_not_client_fields() {
    let p = Presence::default();
    let s = p.restore(&snap("a", Some("3"), 1000.0, 2000.0));
    assert_eq!((s.user_id, s.attributed_user_id), (Some(3), Some(9)));
    assert_eq!(
        (s.started_at, s.last_beat, s.position),
        (1000.0, 2000.0, 12.5)
    );
    assert_eq!(s.state, PlayState::Paused);
    assert_eq!(s.username.as_deref(), Some("bob"));
    assert_eq!(s.sse_connection_id.as_deref(), Some("c1"));
    assert_eq!(s.system_name.as_deref(), Some("macOS 26"));
    assert_eq!(s.source_fps, Some(24000.0 / 1001.0));
    assert!(s.client_tonemap && s.hdr_ladder && s.supports_volume);
    assert_eq!((s.volume, s.subtitle_id, s.qualities), (None, None, None));
    assert_eq!(p.restore(&snap("a", None, 5.0, 5.0)).started_at, 1000.0);
    assert_eq!(p.size(), 1);
}

#[test]
fn heartbeat_overwrites_present_fields_and_null_clears() {
    let p = Presence::default();
    p.restore(&snap("a", Some("3"), 1000.0, 2000.0));
    let beat = Beat {
        position: Some(99.0),
        volume: Some(Some(0.5)),
        subtitle_id: Some(Some("s1".into())),
        sse_connection_id: Some(String::new()),
        ..Default::default()
    };
    let s = p.heartbeat("a", &beat).unwrap();
    assert_eq!(
        (s.position, s.volume, s.subtitle_id.as_deref()),
        (99.0, Some(0.5), Some("s1"))
    );
    assert!(s.last_beat > 2000.0);
    assert_eq!(s.sse_connection_id.as_deref(), Some("c1"));
    let clear = Beat {
        volume: Some(None),
        sse_connection_id: Some("c2".into()),
        ..Default::default()
    };
    let s = p.heartbeat("a", &clear).unwrap();
    assert_eq!(
        (s.volume, s.sse_connection_id.as_deref()),
        (None, Some("c2"))
    );
    assert!(p.heartbeat("nope", &beat).is_none());
}

#[test]
fn stop_is_idempotent_and_returns_the_entry() {
    let p = Presence::default();
    p.restore(&snap("a", None, 1.0, 1.0));
    assert!(p.stop("a").is_some());
    assert!(p.stop("a").is_none());
}

#[test]
fn tags_drop_absent_and_empty_values() {
    let t = to_tags(&Tags {
        username: Some("bob".into()),
        media_title: Some(String::new()),
        attributed_user_id: Some(4),
        ..Default::default()
    });
    assert_eq!(
        t,
        BTreeMap::from([
            ("username".into(), "bob".into()),
            ("attributedUserId".into(), "4".into())
        ])
    );
}

#[test]
fn resync_adds_unknown_drops_orphans_and_keeps_newer_or_listed() {
    let p = Presence::default();
    let beat = Beat {
        volume: Some(Some(0.3)),
        ..Default::default()
    };
    p.restore(&snap("kept", None, 100.0, 100.0));
    p.heartbeat("kept", &beat);
    p.restore(&snap("orphan", None, 100.0, 100.0));
    p.restore(&snap("fresh", None, 500.0, 500.0));
    let snaps = vec![
        snap("kept", None, 100.0, 100.0),
        snap("new", Some("1"), 5.0, 6.0),
    ];
    let dropped = apply(&p, &Feed::Resync(Arc::new(snaps), 400.0));
    assert_eq!(dropped, ["orphan"]);
    let mut ids: Vec<_> = p.list().into_iter().map(|s| s.session_id).collect();
    ids.sort();
    assert_eq!(ids, ["fresh", "kept", "new"]);
    assert_eq!(p.peek("kept").unwrap().volume, Some(0.3));
}

#[test]
fn events_open_and_end_sessions() {
    let p = Presence::default();
    let opened: EngineEvent = serde_json::from_value(
        json!({"type": "SessionOpened", "session": snap_json("a", None, 1.0, 1.0)}),
    )
    .unwrap();
    apply(&p, &Feed::Event(Arc::new(opened)));
    assert!(p.peek("a").is_some());
    let ended: EngineEvent = serde_json::from_value(
        json!({"type": "SessionEnded", "sessionId": "a", "reason": "expired"}),
    )
    .unwrap();
    let ended = Feed::Event(Arc::new(ended));
    assert_eq!(apply(&p, &ended), ["a"]);
    assert_eq!(p.size(), 0);
    assert!(apply(&p, &ended).is_empty());
}

#[tokio::test]
async fn a_restarted_server_rebuilds_presence_from_the_first_resync() {
    let (tx, rx) = broadcast::channel(8);
    let p = Presence::default();
    tx.send(resync(vec![
        snap("a", Some("3"), 1.0, 2.0),
        snap("b", None, 1.0, 2.0),
    ]))
    .unwrap();
    let ended = json!({"type": "SessionEnded", "sessionId": "b", "reason": "stopped"});
    tx.send(Feed::Event(Arc::new(
        serde_json::from_value(ended).unwrap(),
    )))
    .unwrap();
    drop(tx);
    run(rx, p.clone(), |_| {}, || {}).await;
    let live = p.list();
    assert_eq!(live.len(), 1);
    assert_eq!(
        (live[0].session_id.as_str(), live[0].user_id),
        ("a", Some(3))
    );
}

#[tokio::test]
async fn a_lagged_feed_asks_the_engine_to_resync() {
    let (tx, rx) = broadcast::channel(1);
    for i in 0..3 {
        tx.send(resync(vec![snap(&format!("s{i}"), None, 1.0, 1.0)]))
            .unwrap();
    }
    drop(tx);
    let lags = std::sync::atomic::AtomicU32::new(0);
    run(
        rx,
        Presence::default(),
        |_| {},
        || {
            lags.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        },
    )
    .await;
    assert_eq!(lags.into_inner(), 1);
}

#[test]
fn remote_sees_connection_bound_sessions_with_stale_now_playing_omitted() {
    let fresh = LiveSession::from_snapshot(&snap("a", None, 1000.0, 50_000.0));
    let mut stale = LiveSession::from_snapshot(&snap("b", None, 1000.0, 10_000.0));
    stale.sse_connection_id = Some("c2".into());
    let mut unbound = fresh.clone();
    unbound.sse_connection_id = None;
    let live = live_at(vec![fresh, stale, unbound], 60_000.0, 30_000.0);
    assert_eq!(live.len(), 2);
    let np = live[0].now_playing.as_ref().unwrap();
    assert_eq!(
        (live[0].connection_id.as_str(), np.media_file_id),
        ("c1", 7)
    );
    assert_eq!(live[1].system_name.as_deref(), Some("macOS 26"));
    assert!(live[1].now_playing.is_none());
}

#[test]
fn streams_follow_the_engine_list_else_the_ttl() {
    let a = LiveSession::from_snapshot(&snap("a", None, 1.0, 59_000.0));
    let b = LiveSession::from_snapshot(&snap("b", None, 1.0, 10_000.0));
    let mut eng = snap("a", None, 1.0, 58_000.0);
    eng.quality = Some("480p".into());
    let rows = select(
        vec![a.clone(), b.clone()],
        Some(vec![eng.clone()]),
        60_000.0,
        30_000.0,
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].quality(), rows[0].last_activity_ms()),
        ("480p".into(), 58_000.0)
    );
    assert_eq!(rows[0].hw_accel("vaapi"), "vaapi");
    let rows = select(vec![a, b], None, 60_000.0, 30_000.0);
    assert_eq!(
        rows.iter()
            .map(|r| r.live.session_id.as_str())
            .collect::<Vec<_>>(),
        ["a"]
    );
    assert_eq!(rows[0].quality(), "720p");
}

#[test]
fn directplay_and_remux_rows_report_original_and_no_hardware() {
    let mut s = LiveSession::from_snapshot(&snap("a", None, 1.0, 1.0));
    s.kind = SessionKind::Directplay;
    let row = Stream {
        live: s.clone(),
        engine: None,
    };
    assert_eq!(
        (row.quality(), row.hw_accel("vaapi")),
        ("original".into(), "none".into())
    );
    s.kind = SessionKind::Remux;
    assert_eq!(
        Stream {
            live: s,
            engine: None
        }
        .hw_accel("vaapi"),
        "none"
    );
}
