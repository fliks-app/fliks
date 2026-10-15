use super::{Kind, Qoe, SessionRef, playbacks, routes, store, until_next};
use crate::{config::Config, events::event::PlayState, state::AppState};
use axum::{body::Body, http::Request};
use chrono::NaiveDateTime;
use fliks_domain::qoe::{parse_events, parse_sample};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

fn sref(sid: &str, user: Option<i32>) -> SessionRef {
    SessionRef {
        session_id: sid.into(),
        user_id: user,
        media_file_id: None,
        media_title: Some("t".into()),
        started_at: super::now_ms(),
        last_beat: super::now_ms(),
        device_label: Some("dev".into()),
        system_name: None,
        app_version: None,
        kind: Kind::Directplay,
        quality: None,
        transcode_reasons: json!([]),
        state: PlayState::Playing,
        attributed_user_id: None,
    }
}

async fn qoe(pool: &PgPool) -> Qoe {
    crate::db::migrate(pool).await.unwrap();
    let q = Qoe::new(pool.clone());
    q.reload_enabled().await;
    q
}

fn sample(playback: &str, stalls: u32) -> Value {
    json!({"engine": "shaka", "stallCount": stalls, "stallMs": stalls * 500, "playbackId": playback,
           "droppedFrames": 0, "decodedFrames": 1000, "bufferAheadS": 20, "bandwidthBps": 9e6})
}

async fn rows(pool: &PgPool) -> Vec<store::QoeRow> {
    sqlx::query_as!(
        store::QoeRow,
        r#"SELECT * FROM playback_qoe_sessions ORDER BY "sessionId""#
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrations = false)]
async fn nothing_is_stored_before_a_sample_or_event_and_a_flush_upserts(pool: PgPool) {
    let q = qoe(&pool).await;
    let s = sref("a", Some(1));
    q.register(&s);
    q.flush("a").await;
    assert!(rows(&pool).await.is_empty());
    q.record_sample(&s, &parse_sample(&sample("p", 0)).unwrap());
    q.flush("a").await;
    q.flush("a").await;
    let r = rows(&pool).await;
    assert_eq!(
        (r.len(), r[0].playbackId.as_deref(), r[0].engine.as_deref()),
        (1, Some("p"), Some("shaka"))
    );
    assert_eq!(r[0].playMethod.as_deref(), Some("directplay"));
}

#[sqlx::test(migrations = false)]
async fn events_are_stored_with_their_cause_and_capped_at_200(pool: PgPool) {
    let q = qoe(&pool).await;
    let s = sref("a", Some(1));
    let now = super::now_ms();
    let evs = json!(
        (0..60)
            .map(|i| json!({"type": "stall", "at": now - f64::from(i), "durationMs": 100}))
            .collect::<Vec<_>>()
    );
    for _ in 0..5 {
        q.record_events(&s, &parse_events(&evs, now, None), Some("p".into()));
    }
    q.flush("a").await;
    let n = sqlx::query_scalar!(r#"SELECT count(*) AS "n!" FROM playback_qoe_events"#)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 200);
    let data = sqlx::query_scalar!("SELECT data FROM playback_qoe_events LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(data["cause"], "unknown");
    assert!(data.get("serverLoad").is_some());
    assert_eq!(rows(&pool).await[0].stallCount, 0);
}

#[sqlx::test(migrations = false)]
async fn sessions_of_one_playback_share_a_restated_verdict(pool: PgPool) {
    let q = qoe(&pool).await;
    let (a, b) = (sref("a", Some(1)), sref("b", Some(1)));
    q.record_sample(&a, &parse_sample(&sample("p", 0)).unwrap());
    q.flush("a").await;
    let now = super::now_ms();
    let stall = json!([{"type": "stall", "at": now, "durationMs": 30000, "bufferAheadS": 0}]);
    q.record_sample(&b, &parse_sample(&sample("p", 1)).unwrap());
    q.record_events(&b, &parse_events(&stall, now, None), None);
    q.flush("b").await;
    let r = rows(&pool).await;
    assert_eq!(r[0].playbackVerdict, r[1].playbackVerdict);
    assert_ne!(r[0].playbackVerdict, "ok");
    let page = store::page(
        &pool,
        &store::PageFilter {
            floor: super::at(now - 2e9),
            since: super::at(now - 1e9),
            verdict: None,
            user_id: Some(1),
            devices: &["dev".to_owned()],
            limit: 50,
            offset: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        (page.len(), page[0].total, page[0].key.as_str()),
        (1, 1, "1:p")
    );
    let merged = playbacks::merge_playbacks(r);
    assert_eq!(merged[0].session_ids, ["a", "b"]);
    let sum = playbacks::summary(
        &store::summary_rows(&pool, super::at(now - 2e9), super::at(now - 1e9))
            .await
            .unwrap(),
    );
    assert_eq!(sum["byDevice"][0]["sessions"], 1);
    assert_eq!(sum["byDevice"][0]["stallSessions"], 1);
}

#[sqlx::test(migrations = false)]
async fn a_disabled_setting_records_nothing_and_purge_keeps_recent_rows(pool: PgPool) {
    let q = qoe(&pool).await;
    sqlx::query!(r#"INSERT INTO app_settings ("key", "value") VALUES ('qoe_enabled', 'false')"#)
        .execute(&pool)
        .await
        .unwrap();
    q.settings_changed(&["qoe_enabled".into()]).await;
    assert!(!q.enabled());
    q.record_sample(&sref("a", None), &parse_sample(&sample("p", 0)).unwrap());
    assert!(q.tracked_session("a").is_none());
    sqlx::query!(r#"UPDATE app_settings SET "value" = NULL"#)
        .execute(&pool)
        .await
        .unwrap();
    q.settings_changed(&["qoe_enabled".into()]).await;
    q.record_sample(&sref("a", None), &parse_sample(&sample("p", 0)).unwrap());
    q.flush("a").await;
    q.purge_old().await;
    assert_eq!(rows(&pool).await.len(), 1);
    sqlx::query!(r#"UPDATE playback_qoe_sessions SET "lastSeenAt" = now() - interval '31 days'"#)
        .execute(&pool)
        .await
        .unwrap();
    q.purge_old().await;
    assert!(rows(&pool).await.is_empty());
}

#[sqlx::test(migrations = false)]
async fn session_end_stamps_the_row_once_and_a_sample_revives_it(pool: PgPool) {
    let q = qoe(&pool).await;
    let s = sref("a", None);
    q.record_sample(&s, &parse_sample(&sample("p", 0)).unwrap());
    q.session_ended("a");
    q.flush("a").await;
    assert!(rows(&pool).await[0].endedAt.is_some());
    q.record_sample(&s, &parse_sample(&sample("p", 0)).unwrap());
    q.flush("a").await;
    assert!(rows(&pool).await[0].endedAt.is_none());
}

async fn bridge(st: &AppState, method: &str, uri: &str, body: Value, bearer: bool) -> (u16, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if bearer {
        req = req.header("authorization", format!("Bearer {}", st.cfg.bridge_token));
    }
    let res = routes::router()
        .with_state(st.clone())
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[sqlx::test(migrations = false)]
async fn the_live_tv_bridges_feed_the_trackers(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool, Config::from_lookup(|_| None), "secret");
    st.qoe.reload_enabled().await;
    let session = json!({"sessionId": "l1", "userId": 1, "mediaFileId": null, "mediaTitle": "ch", "startedAt": 1.0,
        "lastBeat": 2.0, "deviceLabel": "ua", "systemName": null, "appVersion": null, "kind": "live", "quality": null,
        "transcodeReasons": [], "state": "playing", "attributedUserId": null});
    let (code, _) = bridge(
        &st,
        "POST",
        "/internal/qoe/register",
        json!({"session": session}),
        false,
    )
    .await;
    assert_eq!(code, 401);
    // The engine's report has absent members; Rust maps them to the core's explicit nulls.
    let pipeline = json!({"output": {"codec": "h264"}, "encode": {"hw": true, "kind": "vaapi"}});
    let (code, _) = bridge(
        &st,
        "POST",
        "/internal/qoe/register",
        json!({"session": session, "pipeline": pipeline}),
        true,
    )
    .await;
    assert_eq!(code, 204);
    let p = st
        .qoe
        .map()
        .get("l1")
        .unwrap()
        .agg
        .pipeline()
        .cloned()
        .unwrap();
    assert_eq!(p.output.unwrap().quality, None);
    assert!(p.encode.unwrap().hw);
    let body = json!({"session": session, "state": "playing", "qoe": sample("lp", 0)});
    assert_eq!(
        bridge(&st, "POST", "/internal/qoe/live-sample", body, true)
            .await
            .0,
        204
    );
    let body = json!({"session": session, "cmcdRaw": "bl=5000,mtp=20000", "segmentDurationS": 4, "waitedMs": 50});
    assert_eq!(
        bridge(&st, "POST", "/internal/qoe/served", body, true)
            .await
            .0,
        204
    );
    assert_eq!(
        bridge(
            &st,
            "POST",
            "/internal/qoe/transcode-probe",
            json!({"count": 2}),
            true
        )
        .await
        .0,
        204
    );
    let (code, sum) = bridge(
        &st,
        "GET",
        "/internal/qoe/live-summary?sessionId=l1",
        json!({}),
        true,
    )
    .await;
    assert_eq!(
        (code, sum["playbackId"].as_str(), sum["cmcd"].as_bool()),
        (200, Some("lp"), Some(true))
    );
    assert_eq!(
        bridge(
            &st,
            "GET",
            "/internal/qoe/live-summary?sessionId=nope",
            json!({}),
            true
        )
        .await
        .0,
        404
    );
    assert_eq!(
        bridge(
            &st,
            "POST",
            "/internal/qoe/session-ended",
            json!({"sessionId": "l1"}),
            true
        )
        .await
        .0,
        204
    );
    st.qoe.flush("l1").await;
    assert!(rows(&st.db).await[0].endedAt.is_some());
}

#[test]
fn query_numbers_follow_js_number() {
    let n = |s| routes::int(Some(s));
    assert_eq!(
        (n("5"), n(" 7 "), n("1e3"), n("-2.9"), n("0x10")),
        (Some(5), Some(7), Some(1000), Some(-2), Some(16))
    );
    assert_eq!((n("abc"), n("Infinity"), n("1,5")), (None, None, None));
    assert_eq!((routes::int(Some("")), routes::int(None)), (None, None));
}

#[test]
fn the_purge_waits_for_the_coming_0400() {
    let at = |s| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap();
    assert_eq!(until_next(at("2026-01-01 03:00:00")).as_secs(), 3600);
    assert_eq!(until_next(at("2026-01-01 04:00:00")).as_secs(), 86400);
}
