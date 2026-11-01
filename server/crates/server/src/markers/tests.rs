//! Markers through the real router, a fake engine and a throwaway database.
use super::{detect, *};
use crate::{
    app,
    config::Config,
    engine::testkit::{Fake, RUNTIME, hello_body, ok},
    events::{Bus, SseEvent, Subject},
};
use axum::{body::Body, extract::Request};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: axum::Router,
    st: AppState,
    pool: PgPool,
    fake: Fake,
    admin: String,
    reader: String,
    /// Episode ids of season 1 (library 1), the episode of season 2 (library 2) and of a library-less series.
    eps: [i32; 3],
    other_ep: i32,
    orphan_ep: i32,
    season: i32,
    other_season: i32,
    series: i32,
}

async fn one(pool: &PgPool, sql: &str) -> i32 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn episode(pool: &PgPool, season: i32, n: i32, file: &str) -> i32 {
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO items ("number", "groupId", "mediaId", "editionId")
           SELECT $1, g.id, g."mediaId", ed.id FROM item_groups g
           JOIN editions ed ON ed."mediaId" = g."mediaId" WHERE g.id = $2 RETURNING items.id"#,
    )
    .bind(n)
    .bind(season)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"WITH f AS (
             INSERT INTO media_files ("relativePath", size, quality, "streamInfo", "mediaId")
             VALUES ($1, 1, '720p', '{"durationSeconds": 1500}', (SELECT "mediaId" FROM item_groups WHERE id = $2))
             RETURNING id, "mediaId")
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId") SELECT $3, id, "mediaId" FROM f"#,
    )
    .bind(file)
    .bind(season)
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
    id
}

fn snapshot(id: &str) -> Value {
    json!({"jobId": id, "kind": "Fingerprint", "mediaFileId": 1, "priority": "high", "state": "done",
           "pct": 100, "createdMs": 1, "result": {"type": "Fingerprint",
           "fingerprint": {"hashes": [1, 2, 3], "durationSeconds": 10.0, "baseOffsetSec": 0}}})
}

async fn ctx(pool: PgPool, intro_detect: bool) -> Ctx {
    crate::db::migrate(&pool).await.unwrap();
    let fake = Fake::start().await;
    let mut features = RUNTIME.to_vec();
    if intro_detect {
        features.push("intro-detect");
    }
    fake.hello(Some(hello_body(&features, "x")));
    let ids: Vec<String> = (1..=24).map(|n| format!("j{n}")).collect();
    fake.script(
        "POST",
        "/v1/jobs",
        ids.iter().map(|i| ok(json!({ "jobId": i }))).collect(),
    );
    for i in &ids {
        fake.script("GET", &format!("/v1/jobs/{i}"), vec![ok(snapshot(i))]);
    }
    let env = [
        ("FLIKS_ENGINE_URL", fake.url.clone()),
        ("FLIKS_ENGINE_TOKEN", "tok".into()),
    ];
    let cfg = Config::from_lookup(|k| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()));
    let st = AppState::new(pool.clone(), cfg, SECRET);
    st.engine.start(pool.clone(), 4849).await;
    let app = app::router(st.clone(), None, "/nonexistent".into(), None);
    let admin: i32 = one(
        &pool,
        r#"INSERT INTO users (username, "isAdmin") VALUES ('admin', true) RETURNING id"#,
    )
    .await;
    let role: i32 = one(
        &pool,
        r#"INSERT INTO roles (name, permissions) VALUES ('r', '["media.read"]') RETURNING id"#,
    )
    .await;
    let reader: i32 = sqlx::query_scalar(
        r#"INSERT INTO users (username, "roleId") VALUES ('reader', $1) RETURNING id"#,
    )
    .bind(role)
    .fetch_one(&pool)
    .await
    .unwrap();
    let l1 = one(
        &pool,
        r#"INSERT INTO libraries (name, path) VALUES ('L1', '/lib1') RETURNING id"#,
    )
    .await;
    let l2 = one(
        &pool,
        r#"INSERT INTO libraries (name, path) VALUES ('L2', '/lib2') RETURNING id"#,
    )
    .await;
    sqlx::query(r#"INSERT INTO library_user_access ("userId", "libraryId") VALUES ($1, $2)"#)
        .bind(reader)
        .bind(l1)
        .execute(&pool)
        .await
        .unwrap();
    let mut media = vec![];
    for (title, lib) in [("Show", Some(l1)), ("Other", Some(l2)), ("Orphan", None)] {
        let m: i32 = sqlx::query_scalar(
            r#"INSERT INTO media (title, "type", "libraryId", "folderName") VALUES ($1, 'series', $2, $1) RETURNING id"#,
        )
        .bind(title)
        .bind(lib)
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::query(r#"INSERT INTO editions ("mediaId", family) VALUES ($1, 'video')"#)
            .bind(m)
            .execute(&pool)
            .await
            .unwrap();
        let s: i32 = sqlx::query_scalar(
            r#"INSERT INTO item_groups ("number", "mediaId") VALUES (1, $1) RETURNING id"#,
        )
        .bind(m)
        .fetch_one(&pool)
        .await
        .unwrap();
        media.push((m, s));
    }
    let season = media[0].1;
    let mut eps = [0; 3];
    for (i, e) in eps.iter_mut().enumerate() {
        *e = episode(&pool, season, i as i32 + 1, &format!("e{}.mkv", i + 1)).await;
    }
    let other_ep = episode(&pool, media[1].1, 1, "o1.mkv").await;
    let orphan_ep = episode(&pool, media[2].1, 1, "x1.mkv").await;
    Ctx {
        admin: st.jwt.sign_access(admin, "admin").unwrap().token,
        reader: st.jwt.sign_access(reader, "reader").unwrap().token,
        app,
        st,
        pool,
        fake,
        eps,
        other_ep,
        orphan_ep,
        season,
        other_season: media[1].1,
        series: media[0].0,
    }
}

async fn call(c: &Ctx, method: &str, uri: &str, token: &str, body: Option<Value>) -> (u16, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {token}"));
    let body = match body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    let res = c
        .app
        .clone()
        .oneshot(req.body(body).unwrap())
        .await
        .unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn marker_row(c: &Ctx, ep: i32, kind: &str) -> Option<(f64, f64, f64, bool)> {
    sqlx::query_as(
        r#"SELECT "startSeconds", "endSeconds", confidence, manual FROM episode_markers
           WHERE "episodeId" = $1 AND type = $2"#,
    )
    .bind(ep)
    .bind(kind)
    .fetch_optional(&c.pool)
    .await
    .unwrap()
}

async fn put_marker(c: &Ctx, ep: i32, kind: &str, start: f64, end: f64, manual: bool) {
    sqlx::query(
        r#"INSERT INTO episode_markers ("episodeId", type, "startSeconds", "endSeconds", confidence, manual)
           VALUES ($1, $2, $3, $4, 0.5, $5)"#,
    )
    .bind(ep)
    .bind(kind)
    .bind(start)
    .bind(end)
    .bind(manual)
    .execute(&c.pool)
    .await
    .unwrap();
}

async fn command_status(c: &Ctx, id: i64) -> String {
    for _ in 0..500 {
        let s: String = sqlx::query_scalar("SELECT status FROM commands WHERE id = $1")
            .bind(id as i32)
            .fetch_one(&c.pool)
            .await
            .unwrap();
        if s != "queued" && s != "running" {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("command {id} never ended");
}

fn segment(file: i32, start: f64, end: f64) -> Value {
    json!({"mediaFileId": file, "startSeconds": start, "endSeconds": end, "confidence": 0.9, "source": "pairwise"})
}

async fn file_ids(c: &Ctx) -> Vec<i32> {
    sqlx::query_scalar(r#"SELECT id FROM media_files WHERE "mediaId" = $1 ORDER BY id"#)
        .bind(c.series)
        .fetch_all(&c.pool)
        .await
        .unwrap()
}

#[test]
fn settings_fall_back_unless_finite_and_positive() {
    for v in [
        None,
        Some(""),
        Some("0"),
        Some("-5"),
        Some("abc"),
        Some("NaN"),
        Some("inf"),
    ] {
        assert_eq!(detect::positive_or(v, 10.0), 10.0, "{v:?}");
    }
    assert_eq!(detect::positive_or(Some(" 2.5 "), 10.0), 2.5);
}

#[sqlx::test(migrations = false)]
async fn segments_follow_the_persistence_rules(pool: PgPool) {
    let c = ctx(pool, true).await;
    let files = file_ids(&c).await;
    put_marker(&c, c.eps[0], "intro", 5.0, 10.0, false).await;
    put_marker(&c, c.eps[1], "intro", 1.0, 2.0, true).await;
    put_marker(&c, c.eps[2], "intro", 7.0, 9.0, false).await;
    c.fake.script(
        "POST",
        "/v1/intro-detect",
        vec![
            ok(json!({"results": [segment(files[0], 0.0, 30.0), segment(9999, 1.0, 2.0)]})),
            ok(json!({"results": []})),
        ],
    );
    let (intros, outros) = detect::run_detection_inline(&c.st, c.season, None)
        .await
        .unwrap();
    assert_eq!((intros, outros), (2, 0), "ignored segments are counted");
    let seen = c.fake.seen("POST", "/v1/intro-detect");
    let (first, second) = (&seen[0].body, &seen[1].body);
    assert_eq!(first["kind"], "intro");
    assert_eq!(first["lookupSeconds"], 600.0);
    assert_eq!(first["minSegmentSeconds"], 15.0);
    let sent: Vec<i64> = first["episodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["mediaFileId"].as_i64().unwrap())
        .collect();
    assert_eq!(
        sent,
        [i64::from(files[0]), i64::from(files[2])],
        "manual episode not sent"
    );
    assert!(first["episodes"][0]["introFingerprint"].is_object());
    assert_eq!(second["kind"], "outro");
    assert_eq!(second["episodes"].as_array().unwrap().len(), 3);
    assert!(second["episodes"][0]["outroFingerprint"].is_object());
    assert_eq!(
        marker_row(&c, c.eps[0], "intro").await,
        Some((0.0, 30.0, 0.9, false))
    );
    assert_eq!(
        marker_row(&c, c.eps[1], "intro").await,
        Some((1.0, 2.0, 0.5, true))
    );
    assert_eq!(
        marker_row(&c, c.eps[2], "intro").await,
        Some((7.0, 9.0, 0.5, false)),
        "a stale detected marker is kept"
    );
    let stamped: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM items WHERE "groupId" = $1 AND "markersScannedAt" IS NOT NULL"#,
    )
    .bind(c.season)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(stamped, 3);
}

#[sqlx::test(migrations = false)]
async fn a_marker_made_manual_meanwhile_is_not_overwritten(pool: PgPool) {
    let c = ctx(pool, true).await;
    put_marker(&c, c.eps[0], "intro", 1.0, 2.0, true).await;
    db::upsert_detected(&c.pool, c.eps[0], "intro", 0.0, 30.0, 0.9)
        .await
        .unwrap();
    assert_eq!(
        marker_row(&c, c.eps[0], "intro").await,
        Some((1.0, 2.0, 0.5, true))
    );
}

#[sqlx::test(migrations = false)]
async fn a_failed_outro_pass_still_stamps_and_the_run_completes(pool: PgPool) {
    let c = ctx(pool, true).await;
    let files = file_ids(&c).await;
    c.fake.script(
        "POST",
        "/v1/intro-detect",
        vec![
            ok(json!({"results": [segment(files[0], 0.0, 30.0)]})),
            crate::engine::testkit::status(400),
        ],
    );
    let (intros, outros) = detect::run_detection_inline(&c.st, c.season, None)
        .await
        .unwrap();
    assert_eq!((intros, outros), (1, 0));
    let stamped: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM items WHERE "groupId" = $1 AND "markersScannedAt" IS NOT NULL"#,
    )
    .bind(c.season)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(stamped, 3);
}

#[sqlx::test(migrations = false)]
async fn a_season_with_one_episode_has_no_intro_pass(pool: PgPool) {
    let c = ctx(pool, true).await;
    detect::run_detection_inline(&c.st, c.other_season, None)
        .await
        .unwrap();
    let seen = c.fake.seen("POST", "/v1/intro-detect");
    assert_eq!(seen.len(), 1, "outro only");
    assert_eq!(seen[0].body["kind"], "outro");
}

#[sqlx::test(migrations = false)]
async fn a_route_run_reports_progress_and_releases_the_season(pool: PgPool) {
    let c = ctx(pool, true).await;
    let files = file_ids(&c).await;
    c.fake.script(
        "POST",
        "/v1/intro-detect",
        vec![
            ok(json!({"results": [segment(files[0], 0.0, 30.0), segment(files[1], 0.0, 31.0)]})),
            ok(json!({"results": [segment(files[2], 1400.0, 1500.0)]})),
        ],
    );
    let mut rx = c.st.hub.subscribe();
    let (s, body) = call(
        &c,
        "POST",
        &format!("/api/markers/season/{}/detect", c.season),
        &c.admin,
        None,
    )
    .await;
    assert_eq!(s, 201);
    assert_eq!(
        (
            body["name"].clone(),
            body["status"].clone(),
            body["trigger"].clone()
        ),
        (json!("IntroDetection"), json!("queued"), json!("manual"))
    );
    assert_eq!(body["body"]["seasonNumber"], 1);
    assert!(body["startedOn"].is_null() && body["endedOn"].is_null());
    let mut names = vec![];
    let mut progress = vec![];
    while names.last().map(String::as_str) != Some("markers.season.completed") {
        let b = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("the season completes")
            .unwrap();
        if let Bus::Sse(ev) = &*b {
            match ev {
                SseEvent::TaskProgress {
                    message, subject, ..
                } => {
                    assert_eq!(subject.as_ref().unwrap().season_number, Some(1));
                    progress.push(message.clone());
                    continue;
                }
                SseEvent::MarkersSeasonCompleted {
                    intros_detected, ..
                } => {
                    assert_eq!(*intros_detected, 3);
                }
                // Debounced 250 ms: it lands mid-run only when the run is slower than that.
                SseEvent::ActivityChanged {} => continue,
                _ => {}
            }
            names.push(
                serde_json::to_value(ev).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
        }
    }
    assert_eq!(
        names,
        [
            "command.started",
            "command.completed",
            "markers.season.completed"
        ]
    );
    assert_eq!(
        command_status(&c, body["id"].as_i64().unwrap()).await,
        "completed"
    );
    assert_eq!(progress.first().unwrap(), "Fingerprinting 0/3");
    for m in [
        "Fingerprinting 3/3",
        "Detection complete: 2 intro(s)",
        "Outro fingerprinting 0/3",
        "Outro fingerprinting 3/3",
    ] {
        assert!(progress.contains(&m.to_owned()), "{m} in {progress:?}");
    }
    assert!(
        c.st.busy.marker_seasons.claim(c.season).is_some(),
        "released"
    );
    assert_eq!(c.st.hub.activity().list(1, 50).total, 0);
}

#[sqlx::test(migrations = false)]
async fn an_engine_without_the_feature_fails_the_command_and_releases(pool: PgPool) {
    let c = ctx(pool, false).await;
    let uri = format!("/api/markers/season/{}/detect", c.season);
    let (s, body) = call(&c, "POST", &uri, &c.admin, None).await;
    assert_eq!(s, 201);
    assert_eq!(
        command_status(&c, body["id"].as_i64().unwrap()).await,
        "failed"
    );
    let (s, again) = call(&c, "POST", &uri, &c.admin, None).await;
    assert_eq!(s, 201, "released after a failure");
    command_status(&c, again["id"].as_i64().unwrap()).await;
}

#[sqlx::test(migrations = false)]
async fn a_running_season_is_refused(pool: PgPool) {
    let c = ctx(pool, true).await;
    let _held = c.st.busy.marker_seasons.claim(c.season).unwrap();
    let (s, body) = call(
        &c,
        "POST",
        &format!("/api/markers/season/{}/detect", c.season),
        &c.admin,
        None,
    )
    .await;
    assert_eq!(s, 400);
    assert_eq!(
        body["message"],
        format!("Detection already running for season #{}", c.season)
    );
    c.st.hub
        .activity()
        .upsert_pending("IntroDetection:1", "IntroDetection", None, None);
    let subject = Subject {
        title: "t".into(),
        media_id: None,
        media_type: None,
        season_number: None,
        episode_number: None,
        episode_title: None,
        episode_id: None,
    };
    c.st.hub.activity().upsert_pending(
        &format!("IntroDetection:{}", c.season),
        "IntroDetection",
        Some(subject.clone()),
        None,
    );
    let out = detect::run_detection_inline(&c.st, c.season, Some(subject))
        .await
        .unwrap();
    assert_eq!(out, (0, 0));
    let rows = c.st.hub.activity().list(1, 50);
    assert!(
        rows.data
            .iter()
            .all(|r| r.entry.id != format!("IntroDetection:{}", c.season))
    );
}

#[sqlx::test(migrations = false)]
async fn detect_all_skips_specials_and_404s_an_unknown_media(pool: PgPool) {
    let c = ctx(pool, true).await;
    sqlx::query(r#"INSERT INTO item_groups ("number", "mediaId") VALUES (0, $1)"#)
        .bind(c.series)
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, body) = call(
        &c,
        "POST",
        &format!("/api/markers/series/{}/detect-all", c.series),
        &c.admin,
        None,
    )
    .await;
    assert_eq!((s, body.as_array().unwrap().len()), (201, 1));
    command_status(&c, body[0]["id"].as_i64().unwrap()).await;
    let (s, _) = call(
        &c,
        "POST",
        "/api/markers/series/9999/detect-all",
        &c.admin,
        None,
    )
    .await;
    assert_eq!(s, 404);
}

#[sqlx::test(migrations = false)]
async fn scan_list_filters(pool: PgPool) {
    let c = ctx(pool, true).await;
    let all = detect::list_seasons_for_scan(&c.st, false, None)
        .await
        .unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].media_title, "Orphan");
    sqlx::query(r#"UPDATE items SET "markersScannedAt" = now() WHERE "groupId" = $1"#)
        .bind(c.season)
        .execute(&c.pool)
        .await
        .unwrap();
    let missing = detect::list_seasons_for_scan(&c.st, true, None)
        .await
        .unwrap();
    assert_eq!(missing.len(), 2);
    let one = detect::list_seasons_for_scan(&c.st, false, Some(c.series))
        .await
        .unwrap();
    assert_eq!(one.len(), 1);
}

#[sqlx::test(migrations = false)]
async fn auto_detect_runs_only_when_the_setting_is_true_or_absent(pool: PgPool) {
    let c = ctx(pool, true).await;
    sqlx::query(
        "INSERT INTO app_settings (key, value) VALUES ('markers_auto_detect_on_import', 'yes')",
    )
    .execute(&c.pool)
    .await
    .unwrap();
    detect::auto_detect_missing(&c.st, c.series).await.unwrap();
    let n = |c: &Ctx| {
        let pool = c.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM commands")
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    assert_eq!(n(&c).await, 0);
    sqlx::query("UPDATE app_settings SET value = 'true'")
        .execute(&c.pool)
        .await
        .unwrap();
    detect::auto_detect_missing(&c.st, c.series).await.unwrap();
    assert_eq!(n(&c).await, 1);
    let trigger: String = sqlx::query_scalar("SELECT trigger FROM commands")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(trigger, "auto");
}

#[sqlx::test(migrations = false)]
async fn reads_apply_the_library_acl(pool: PgPool) {
    let c = ctx(pool, true).await;
    put_marker(&c, c.eps[0], "intro", 1.0, 2.0, true).await;
    let ep = |id: i32| format!("/api/markers/episode/{id}");
    let (s, b) = call(&c, "GET", &ep(c.eps[0]), &c.reader, None).await;
    assert_eq!((s, b.as_array().unwrap().len()), (200, 1));
    assert_eq!(b[0]["episodeId"], c.eps[0]);
    assert_eq!(b[0]["startSeconds"], 1);
    assert_eq!(
        call(&c, "GET", &ep(c.other_ep), &c.reader, None).await.0,
        404
    );
    assert_eq!(
        call(&c, "GET", &ep(c.other_ep), &c.admin, None).await.0,
        200
    );
    let (s, b) = call(&c, "GET", &ep(c.orphan_ep), &c.admin, None).await;
    assert_eq!(s, 404, "library-less media is 404 even for admins");
    assert_eq!(b["message"], format!("Episode #{} not found", c.orphan_ep));
    assert_eq!(call(&c, "GET", &ep(99999), &c.admin, None).await.0, 404);
    assert_eq!(
        call(&c, "GET", &ep(0).replace("/0", "/01"), &c.admin, None)
            .await
            .0,
        400
    );
    let se = |id: i32| format!("/api/markers/season/{id}");
    assert_eq!(call(&c, "GET", &se(c.season), &c.reader, None).await.0, 200);
    assert_eq!(
        call(&c, "GET", &se(c.other_season), &c.reader, None)
            .await
            .0,
        404
    );
    assert_eq!(
        call(&c, "GET", &se(c.other_season), &c.admin, None).await.0,
        200
    );
    let post = json!({"episodeId": c.eps[0], "type": "intro", "startSeconds": 1, "endSeconds": 2});
    assert_eq!(
        call(&c, "POST", "/api/markers", &c.reader, Some(post))
            .await
            .0,
        403
    );
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("/api/markers/season/{}/detect", c.season),
            &c.reader,
            None
        )
        .await
        .0,
        403
    );
}

#[sqlx::test(migrations = false)]
async fn writes_are_atomic_and_validated(pool: PgPool) {
    let c = ctx(pool, true).await;
    let post = |ep: i64, kind: &str, a: f64, b: f64| json!({"episodeId": ep, "type": kind, "startSeconds": a, "endSeconds": b});
    let ep = i64::from(c.eps[0]);
    let (s, first) = call(
        &c,
        "POST",
        "/api/markers",
        &c.admin,
        Some(post(ep, "intro", 5.0, 40.0)),
    )
    .await;
    assert_eq!(s, 201);
    assert_eq!(first["manual"], true);
    assert_eq!(first["confidence"], 1);
    assert_eq!(first["episodeId"], ep);
    assert!(first.get("episode").is_none());
    let (_, second) = call(
        &c,
        "POST",
        "/api/markers",
        &c.admin,
        Some(post(ep, "intro", 6.5, 41.0)),
    )
    .await;
    assert_eq!(second["id"], first["id"], "replaced in place");
    assert_eq!(second["startSeconds"], 6.5);
    let (s, b) = call(
        &c,
        "POST",
        "/api/markers",
        &c.admin,
        Some(post(99999, "intro", 1.0, 2.0)),
    )
    .await;
    assert_eq!(
        (s, b["message"].clone()),
        (404, json!("Episode #99999 not found"))
    );
    assert_eq!(marker_row(&c, c.eps[0], "intro").await.unwrap().0, 6.5);
    let (s, b) = call(
        &c,
        "POST",
        "/api/markers",
        &c.admin,
        Some(post(ep, "intro", 5.0, 5.0)),
    )
    .await;
    assert_eq!(
        (s, b["message"].clone()),
        (400, json!("endSeconds must be > startSeconds"))
    );
    let (s, b) = call(
        &c,
        "POST",
        "/api/markers",
        &c.admin,
        Some(json!({"episodeId": "x", "type": "bad", "startSeconds": -1})),
    )
    .await;
    assert_eq!(s, 400);
    assert_eq!(b["message"].as_array().unwrap().len(), 5);
    let (s, _) = call(
        &c,
        "POST",
        "/api/markers",
        &c.admin,
        Some(json!({"episodeId": ep, "type": "intro", "startSeconds": 1, "endSeconds": 2, "x": 1})),
    )
    .await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn updates_protect_the_marker_and_deletes_404(pool: PgPool) {
    let c = ctx(pool, true).await;
    put_marker(&c, c.eps[0], "outro", 100.0, 200.0, false).await;
    let id: i32 = one(&c.pool, "SELECT id FROM episode_markers").await;
    let uri = format!("/api/markers/{id}");
    let (s, b) = call(&c, "PUT", &uri, &c.admin, Some(json!({}))).await;
    assert_eq!(
        (s, b["manual"].clone(), b["confidence"].clone()),
        (200, json!(true), json!(1))
    );
    let stamp = b["updatedAt"].clone();
    let (_, again) = call(
        &c,
        "PUT",
        &uri,
        &c.admin,
        Some(json!({"startSeconds": null})),
    )
    .await;
    assert_eq!(
        again["updatedAt"], stamp,
        "nothing changed, nothing written"
    );
    let (s, b) = call(&c, "PUT", &uri, &c.admin, Some(json!({"endSeconds": 50}))).await;
    assert_eq!(
        (s, b["message"].clone()),
        (400, json!("endSeconds must be > startSeconds"))
    );
    let body = json!({"episodeId": 1, "type": null});
    let (s, b) = call(&c, "PUT", &uri, &c.admin, Some(body)).await;
    assert_eq!(
        (s, b["message"].clone()),
        (
            400,
            json!([
                "property episodeId should not exist",
                "property type should not exist"
            ])
        )
    );
    let (s, b) = call(&c, "PUT", &uri, &c.admin, Some(json!({"endSeconds": 250}))).await;
    assert_eq!((s, b["endSeconds"].clone()), (200, json!(250)));
    assert_eq!(
        call(&c, "PUT", "/api/markers/99999", &c.admin, Some(json!({})))
            .await
            .0,
        404
    );
    assert_eq!(call(&c, "DELETE", &uri, &c.admin, None).await.0, 200);
    let (s, b) = call(&c, "DELETE", &uri, &c.admin, None).await;
    assert_eq!(
        (s, b["message"].clone()),
        (404, json!(format!("Marker #{id} not found")))
    );
}
