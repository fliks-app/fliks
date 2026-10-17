use super::{Kind, Qoe, SessionRef, playbacks, routes, store, until_next};
use crate::events::event::PlayState;
use chrono::NaiveDateTime;
use fliks_domain::qoe::{parse_events, parse_sample};
use serde_json::{Value, json};
use sqlx::PgPool;

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

#[test]
fn query_numbers_follow_js_number() {
    let n = |s| routes::int(Some(s));
    assert_eq!(
        (n("5"), n(" 7 "), n("1e3"), n("-2.9"), n("0x10")),
        (Some(5), Some(7), Some(1000), Some(-2), Some(16))
    );
    assert_eq!((n("abc"), n("Infinity"), n("1,5")), (None, None, None));
    assert_eq!(
        (n("0X1f"), n("0B11"), n("0x+1"), n("0x")),
        (Some(31), Some(3), None, None)
    );
    assert_eq!((routes::int(Some("")), routes::int(None)), (None, None));
}

#[test]
fn devices_are_repeated_values_and_a_lone_empty_one_is_no_filter() {
    let q = |v: &[&str]| -> Vec<(String, String)> {
        v.iter().map(|d| ("device".into(), (*d).into())).collect()
    };
    assert!(routes::devices(&q(&[""])).is_empty());
    assert_eq!(routes::devices(&q(&["", "a,b"])), ["", "a,b"]);
    assert_eq!(
        routes::devices(&q(&[&"é".repeat(512), &"😀".repeat(257)])).len(),
        1
    );
}

#[test]
fn the_purge_waits_for_the_coming_0400() {
    let at = |s| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap();
    assert_eq!(until_next(at("2026-01-01 03:00:00")).as_secs(), 3600);
    assert_eq!(until_next(at("2026-01-01 04:00:00")).as_secs(), 86400);
}
