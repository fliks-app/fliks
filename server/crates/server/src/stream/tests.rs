//! Playback-info and the control plane through the real router, a fake engine and a throwaway DB.
use super::{
    info::{defers_open, parse_query},
    preroll::Item,
    *,
};
use crate::{
    app,
    config::Config,
    engine::testkit::{Fake, RUNTIME, coded, hello_body, ok, status},
};
use axum::{body::Body, extract::Request};
use fliks_engine_core::api::OpenSessionResponse;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{fs, path::PathBuf};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";
const GOLDEN: &str =
    include_str!("../../../../fixtures/playback-info/engine-playback.recorded.json");

struct Ctx {
    app: axum::Router,
    st: AppState,
    pool: PgPool,
    fake: Fake,
    dir: PathBuf,
    token: String,
    file: i32,
    media: i32,
    user: i32,
}

impl Drop for Ctx {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn golden() -> (Value, Value) {
    let v: Value = serde_json::from_str(GOLDEN).unwrap();
    (v["engine"].clone(), v["host"].clone())
}

fn stream_info() -> Value {
    json!({
        "formatName": "matroska,webm", "formatStartSeconds": 0, "durationSeconds": 10.023,
        "video": [{"streamIndex": 0, "codec": "h264", "width": 1280, "height": 720, "frameRate": "24",
                    "startTimeSeconds": 0, "firstFrameSeconds": 0}],
        "audio": [{"streamIndex": 1, "codec": "aac", "channels": 2, "language": "und"}],
        "subtitles": [{"streamIndex": 3, "codec": "subrip", "language": "eng", "forced": false,
                        "hearingImpaired": false, "isImageBased": false}],
    })
}

async fn ctx(pool: PgPool, engine: bool) -> Ctx {
    ctx_with(pool, engine, &RUNTIME).await
}

async fn ctx_with(pool: PgPool, engine: bool, features: &[&str]) -> Ctx {
    crate::db::migrate(&pool).await.unwrap();
    let fake = Fake::start().await;
    fake.hello(Some(hello_body(features, "x")));
    let (open, _) = golden();
    fake.script("POST", "/v1/sessions", vec![ok(open)]);
    fake.script(
        "DELETE",
        &format!("/v1/sessions/{}", golden().0["sessionId"].as_str().unwrap()),
        vec![status(204)],
    );
    let env = [
        ("FLIKS_ENGINE_URL", fake.url.clone()),
        ("FLIKS_ENGINE_TOKEN", "tok".into()),
    ];
    let cfg = Config::from_lookup(|k| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()));
    let st = AppState::new(pool.clone(), cfg, SECRET);
    if engine {
        st.engine.start(pool.clone(), 4849).await;
    }
    let app = app::router(st.clone(), None, "/nonexistent".into(), None);
    let dir = std::env::temp_dir().join(format!(
        "fliks-stream-test-{}",
        crate::config::random_hex(6)
    ));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("clip.mkv"), b"x").unwrap();
    let user: i32 = sqlx::query_scalar(
        r#"INSERT INTO users (username, "isAdmin") VALUES ('admin', true) RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let lib: i32 =
        sqlx::query_scalar(r#"INSERT INTO libraries (name, "path") VALUES ('L', $1) RETURNING id"#)
            .bind(dir.to_string_lossy().as_ref())
            .fetch_one(&pool)
            .await
            .unwrap();
    let media: i32 = sqlx::query_scalar(
        r#"INSERT INTO media (title, "type", "libraryId") VALUES ('Clip', 'movie', $1) RETURNING id"#,
    )
    .bind(lib)
    .fetch_one(&pool)
    .await
    .unwrap();
    let file: i32 = sqlx::query_scalar(
        r#"INSERT INTO media_files ("relativePath", size, quality, "streamInfo", "mediaId")
           VALUES ('clip.mkv', 1, '720p', $1, $2) RETURNING id"#,
    )
    .bind(stream_info())
    .bind(media)
    .fetch_one(&pool)
    .await
    .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    crate::media::items::create_shell(
        &mut conn,
        media,
        fliks_domain::media::kind::MediaKind::Movie,
    )
    .await
    .unwrap();
    drop(conn);
    let link = crate::media::items::Link {
        file,
        owner: None,
        last: None,
    };
    crate::media::items::attach(&pool, media, &[link])
        .await
        .unwrap();
    let token = st.jwt.sign_access(user, "admin").unwrap().token;
    Ctx {
        app,
        st,
        pool,
        fake,
        dir,
        token,
        file,
        media,
        user,
    }
}

async fn call(c: &Ctx, method: &str, uri: &str, token: &str, body: Option<Value>) -> (u16, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("user-agent", "livecheck/1.0")
        .header("x-fliks-sse-connection", "conn-9");
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

fn device() -> Value {
    json!({"directPlayProfiles": [], "deviceType": "desktop", "deviceName": "live-check",
           "systemName": "Linux", "supportsAbr": true, "futureField": {"x": 1}})
}

async fn info(c: &Ctx, query: &str) -> (u16, Value) {
    let uri = format!("/api/stream/{}/playback-info{query}", c.file);
    call(c, "POST", &uri, &c.token, Some(device())).await
}

#[test]
fn the_query_follows_the_controller() {
    let p = |q: &[(&str, &str)]| {
        parse_query(
            &q.iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<Vec<_>>(),
        )
    };
    let r = p(&[
        ("token", "a b"),
        ("sid", "s1"),
        ("token", "x"),
        ("download", "1"),
        ("burnInSubtitleId", "7x"),
    ])
    .unwrap();
    assert_eq!(r.token_param, "?token=a%20b&sid=s1");
    assert_eq!(
        (r.download, r.burn_in_subtitle_id, r.start_at),
        (true, Some(7), None)
    );
    let r = p(&[
        ("token", ""),
        ("download", "true"),
        ("startAt", "0"),
        ("burnInSubtitleId", ""),
    ])
    .unwrap();
    assert_eq!(
        (
            r.token_param.as_str(),
            r.download,
            r.start_at,
            r.burn_in_subtitle_id
        ),
        ("", false, Some(0.0), None)
    );
    assert_eq!(p(&[("startAt", "12.5s")]).unwrap().start_at, Some(12.5));
    for bad in ["abc", "", "Infinity"] {
        assert!(p(&[("startAt", bad)]).is_err(), "{bad:?}");
    }
}

#[test]
fn pre_roll_first_defers_only_a_start_from_zero() {
    let query = |v: &str| parse_query(&[("preRollFirst".into(), v.into())]).unwrap();
    assert!(query("1").pre_roll_first);
    assert!(!query("true").pre_roll_first);
    assert!(!parse_query(&[]).unwrap().pre_roll_first);
    let item = Item {
        media_file_id: 9,
        label_key: None,
        skippable: None,
    };
    let items = Some(vec![item]);
    assert_eq!(defers_open(Some(&items), 0.0), items.as_ref());
    assert_eq!(
        defers_open(Some(&items), 120.0),
        None,
        "a resume plays no pre-roll"
    );
    assert_eq!(defers_open(Some(&None), 0.0), None, "nothing to play first");
    assert_eq!(defers_open(None, 0.0), None, "not asked for");
}

#[sqlx::test(migrations = false)]
async fn pre_roll_first_without_a_pre_roll_opens_the_session_once(pool: PgPool) {
    let c = ctx(pool, true).await;
    let (status, body) = info(&c, "?preRollFirst=1").await;
    assert_eq!(status, 201);
    assert!(body.get("deferred").is_none());
    assert_eq!(body["sessionId"], golden().0["sessionId"]);
    assert_eq!(c.fake.seen("POST", "/v1/sessions").len(), 1);
}

#[sqlx::test(migrations = false)]
async fn the_recorded_engine_answer_gives_the_recorded_body(pool: PgPool) {
    let c = ctx(pool, true).await;
    let (status, mut body) = info(&c, "?token=tok&startQuality=360p").await;
    assert_eq!(status, 201);
    // `trackMarkers` and `startAtSeconds` are additive: the recorded body predates them.
    let track = body["audioTracks"][0].as_object_mut().unwrap();
    assert_eq!(track.remove("trackMarkers"), Some(json!([])));
    assert_eq!(
        body.as_object_mut().unwrap().remove("startAtSeconds"),
        Some(json!(0.0))
    );
    assert_eq!(body, golden().1);
    let req = &c.fake.seen("POST", "/v1/sessions")[0].body;
    assert_eq!(req["decide"]["media"]["ext"], ".mkv");
    assert_eq!(req["decide"]["media"]["contentType"], "video/x-matroska");
    assert_eq!(req["decide"]["selection"]["tokenParam"], "?token=tok");
    assert_eq!(req["decide"]["selection"]["requestedQuality"], "360p");
    assert_eq!(req["decide"]["selection"]["burnInIsText"], false);
    assert!(req["decide"]["device"].get("futureField").is_none());
    assert_eq!(
        (
            req["ownerId"].as_str(),
            req["startAtS"].as_f64(),
            req["pinned"].as_bool()
        ),
        (Some("1"), Some(0.0), Some(false))
    );
    assert_eq!(req["client"]["userAgent"], "livecheck/1.0");
    assert_eq!(
        req["tags"],
        json!({"username": "admin", "mediaTitle": "Clip", "mediaType": "movie", "sseConnectionId": "conn-9"})
    );
    assert!(req["sourceVersion"].as_str().unwrap().starts_with("1-"));
    let live =
        c.st.presence
            .peek(golden().0["sessionId"].as_str().unwrap())
            .unwrap();
    assert_eq!(
        (live.user_id, live.quality.as_deref(), live.kind),
        (
            Some(c.user),
            Some("360p"),
            fliks_engine_core::api::SessionKind::Transcode
        )
    );
    assert_eq!(
        live.profile_hash.as_deref(),
        golden().0["profileHash"].as_str()
    );
    let own: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM playback_states WHERE "userId" = $1"#)
            .bind(c.user)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(own, 1, "history row ensured");
}

#[sqlx::test(migrations = false)]
async fn a_non_numeric_start_at_is_a_400(pool: PgPool) {
    let c = ctx(pool, true).await;
    let (status, body) = info(&c, "?startAt=abc").await;
    assert_eq!((status, body["error"].as_str()), (400, Some("Bad Request")));
    assert!(c.fake.seen("POST", "/v1/sessions").is_empty());
}

#[sqlx::test(migrations = false)]
async fn resume_download_and_explicit_start(pool: PgPool) {
    let c = ctx(pool, true).await;
    sqlx::query(
        r#"INSERT INTO playback_states ("userId", "itemId", "positionSeconds", completed)
           SELECT $1, id, 120, false FROM items WHERE "mediaId" = $2"#,
    )
    .bind(c.user)
    .bind(c.media)
    .execute(&c.pool)
    .await
    .unwrap();
    for (query, want, pinned) in [
        ("", 120.0, false),
        ("?startAt=0", 0.0, false),
        ("?download=1", 120.0, true),
    ] {
        info(&c, query).await;
        let req = c.fake.seen("POST", "/v1/sessions").pop().unwrap().body;
        assert_eq!(
            (req["startAtS"].as_f64(), req["pinned"].as_bool()),
            (Some(want), Some(pinned)),
            "{query}"
        );
    }
    sqlx::query(r#"UPDATE playback_states SET "lastPlayedAt" = '2000-01-01'"#)
        .execute(&c.pool)
        .await
        .unwrap();
    info(&c, "?download=1").await;
    let at: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar(r#"SELECT "lastPlayedAt" FROM playback_states"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(
        at.format("%Y").to_string(),
        "2000",
        "a download never touches history"
    );
    info(&c, "").await;
    let (at, file): (chrono::DateTime<chrono::Utc>, Option<i32>) =
        sqlx::query_as(r#"SELECT "lastPlayedAt", "mediaFileId" FROM playback_states"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_ne!(at.format("%Y").to_string(), "2000");
    assert_eq!(file, Some(c.file), "the opened file is the row's");
}

#[sqlx::test(migrations = false)]
async fn open_errors_map_to_400_and_503(pool: PgPool) {
    let c = ctx(pool, true).await;
    c.fake.script("POST", "/v1/sessions", vec![status(400)]);
    let (s, b) = info(&c, "").await;
    assert_eq!(
        (s, b["message"].as_str()),
        (400, Some("POST /v1/sessions -> 400"))
    );
    c.fake.script("POST", "/v1/sessions", vec![coded(500, "x")]);
    let (s, b) = info(&c, "").await;
    assert_eq!(
        (s, b["message"].as_str()),
        (503, Some("The streaming engine is unavailable"))
    );
    assert_eq!(c.st.presence.size(), 0);
}

#[sqlx::test(migrations = false)]
async fn without_the_engine_playback_is_a_503_before_anything_else(pool: PgPool) {
    let c = ctx(pool, false).await;
    let (s, b) = call(
        &c,
        "POST",
        "/api/stream/99999/playback-info",
        &c.token,
        Some(device()),
    )
    .await;
    assert_eq!(
        (s, b["message"].as_str()),
        (
            503,
            Some("Playback needs the streaming engine, which is not running")
        )
    );
}

#[sqlx::test(migrations = false)]
async fn unknown_and_unreadable_files_are_404s(pool: PgPool) {
    let c = ctx(pool, true).await;
    let (s, b) = call(
        &c,
        "POST",
        "/api/stream/99999/playback-info",
        &c.token,
        Some(device()),
    )
    .await;
    assert_eq!(
        (s, b["message"].as_str()),
        (404, Some("MediaFile #99999 not found"))
    );
    fs::remove_file(c.dir.join("clip.mkv")).unwrap();
    let (s, b) = info(&c, "").await;
    assert_eq!(s, 404);
    assert!(
        b["message"]
            .as_str()
            .unwrap()
            .starts_with("File not found on disk: ")
    );
    let (s, _) = call(
        &c,
        "POST",
        "/api/stream/abc/playback-info",
        &c.token,
        Some(device()),
    )
    .await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn audio_tracks_carry_the_title_and_the_track_markers(pool: PgPool) {
    let c = ctx(pool, true).await;
    let mut info_json = stream_info();
    info_json["audio"] = json!([
        {"streamIndex": 1, "codec": "eac3", "channels": 6, "language": "eng",
         "profile": "Dolby Digital Plus + Dolby Atmos", "audioDescription": true},
        {"streamIndex": 2, "codec": "aac", "channels": 2, "language": "eng",
         "title": "Commentary by the director"},
    ]);
    sqlx::query(r#"UPDATE media_files SET "streamInfo" = $1"#)
        .bind(&info_json)
        .execute(&c.pool)
        .await
        .unwrap();
    let mut open = golden().0;
    let track = open["decision"]["response"]["audioTracks"][0].clone();
    let mut second = track.clone();
    second["index"] = json!(1);
    open["decision"]["response"]["audioTracks"] = json!([track, second]);
    c.fake.script("POST", "/v1/sessions", vec![ok(open)]);
    let (s, b) = info(&c, "").await;
    assert_eq!(s, 201);
    assert_eq!(
        b["audioTracks"][0]["trackMarkers"],
        json!(["audioDescription", "atmos"])
    );
    assert!(b["audioTracks"][0].get("title").is_none());
    assert_eq!(b["audioTracks"][1]["trackMarkers"], json!(["commentary"]));
    assert_eq!(b["audioTracks"][1]["title"], "Commentary by the director");
}

#[sqlx::test(migrations = false)]
async fn markers_edl_and_a_failing_markers_query(pool: PgPool) {
    let c = ctx(pool, true).await;
    let mut open = golden().0;
    open["playbackClockOffsetS"] = json!(2);
    c.fake.script("POST", "/v1/sessions", vec![ok(open)]);
    fs::write(c.dir.join("clip.edl"), "5 10 0\n").unwrap();
    let edition: i32 = sqlx::query_scalar(
        r#"INSERT INTO editions ("mediaId", family) VALUES ($1, 'video') RETURNING id"#,
    )
    .bind(c.media)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    let season: i32 = sqlx::query_scalar(
        r#"INSERT INTO item_groups ("number", "mediaId") VALUES (1, $1) RETURNING id"#,
    )
    .bind(c.media)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    let ep: i32 = sqlx::query_scalar(
        r#"INSERT INTO items ("number", "groupId", "mediaId", "editionId") VALUES (1, $1, $2, $3) RETURNING id"#,
    )
    .bind(season)
    .bind(c.media)
    .bind(edition)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"WITH gone AS (DELETE FROM item_parts)
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId")
           SELECT $1, id, "mediaId" FROM media_files"#,
    )
    .bind(ep)
    .execute(&c.pool)
    .await
    .unwrap();
    sqlx::query(r#"INSERT INTO item_markers ("kind", "startSeconds", "endSeconds", "itemId") VALUES ('intro', 1, 8, $1)"#)
        .bind(ep).execute(&c.pool).await.unwrap();
    let (s, b) = info(&c, "").await;
    assert_eq!(s, 201);
    assert_eq!(
        b["markers"],
        json!({"intro": {"startSeconds": 1.0, "endSeconds": 8.0}})
    );
    assert_eq!(
        b["edl"],
        json!([{"start": 7.0, "end": 12.0, "action": "cut"}])
    );
    let (_, e) = call(
        &c,
        "GET",
        &format!("/api/stream/{}/edl", c.file),
        &c.token,
        None,
    )
    .await;
    assert_eq!(
        e,
        json!({"ranges": [{"start": 5.0, "end": 10.0, "action": "cut"}]})
    );
    sqlx::query("DROP TABLE item_markers")
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, b) = info(&c, "").await;
    assert_eq!(s, 201);
    assert!(b.get("markers").is_none());
}

#[sqlx::test(migrations = false)]
async fn chapters_come_from_the_item_markers_in_order(pool: PgPool) {
    let c = ctx(pool, true).await;
    assert!(info(&c, "").await.1.get("chapters").is_none());
    let mut blob = stream_info();
    blob["chapters"] = json!([
        {"startSeconds": 5.0, "endSeconds": 9.0, "title": "Second"},
        {"startSeconds": 0.0, "endSeconds": 5.0},
    ]);
    sqlx::query(r#"UPDATE media_files SET "streamInfo" = $1 WHERE id = $2"#)
        .bind(blob)
        .bind(c.file)
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, b) = info(&c, "").await;
    assert_eq!(s, 201);
    assert_eq!(
        b["chapters"],
        json!([
            {"startSeconds": 0.0, "endSeconds": 5.0},
            {"startSeconds": 5.0, "endSeconds": 9.0, "title": "Second"},
        ])
    );
}

#[sqlx::test(migrations = false)]
async fn a_stored_scan_goes_to_the_engine_and_restores_the_clock_break(pool: PgPool) {
    let c = ctx(pool, true).await;
    let m = fs::metadata(c.dir.join("clip.mkv")).unwrap();
    let d = m
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    let mtime = d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6;
    let scan = json!({"keyframes": [{"pts": 0.0, "dts": 0.0}], "end": 10.0, "breakSeconds": 4.5, "audioConfigChanges": {}});
    sqlx::query(r#"INSERT INTO media_file_scans ("mediaFileId", size, "mtimeMs", scan) VALUES ($1, 1, $2, $3)"#)
        .bind(c.file).bind(mtime).bind(scan).execute(&c.pool).await.unwrap();
    info(&c, "").await;
    let req = &c.fake.seen("POST", "/v1/sessions")[0].body;
    assert_eq!(req["decide"]["scan"]["end"], 10.0);
    assert_eq!(req["decide"]["info"]["timestampBreakSeconds"], 4.5);
    let stored: Value = sqlx::query_scalar(r#"SELECT "streamInfo" FROM media_files WHERE id = $1"#)
        .bind(c.file)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(stored["timestampBreakSeconds"], 4.5);
}

#[sqlx::test(migrations = false)]
async fn the_scan_a_remux_open_ran_is_kept_without_a_job(pool: PgPool) {
    let c = ctx(pool, true).await;
    let (mut open, _) = golden();
    open["hints"]["scanMissing"] = json!(true);
    open["scan"] =
        json!({"keyframes": [{"pts": 0.0, "dts": 0.0}], "end": 10.0, "audioConfigChanges": {}});
    c.fake.script("POST", "/v1/sessions", vec![ok(open)]);
    info(&c, "").await;
    let stored = || async {
        sqlx::query_scalar::<_, Value>(
            r#"SELECT scan FROM media_file_scans WHERE "mediaFileId" = $1"#,
        )
        .bind(c.file)
        .fetch_optional(&c.pool)
        .await
        .unwrap()
    };
    let mut scan = None;
    for _ in 0..50 {
        scan = stored().await;
        if scan.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(scan.map(|s| s["end"].clone()), Some(json!(10.0)));
    assert!(c.fake.seen("POST", "/v1/jobs").is_empty(), "no second scan");
}

#[sqlx::test(migrations = false)]
async fn a_missing_scan_is_run_and_stored(pool: PgPool) {
    let c = ctx(pool, true).await;
    let scan = json!({"type": "Scan", "scan": {"keyframes": [], "end": 10.0, "breakSeconds": 3.0, "audioConfigChanges": {}}});
    c.fake
        .script("POST", "/v1/jobs", vec![ok(json!({"jobId": "j1"}))]);
    c.fake.script("GET", "/v1/jobs/j1", vec![ok(json!({
        "jobId": "j1", "kind": "Scan", "mediaFileId": c.file, "priority": "high", "state": "done",
        "pct": 100, "createdMs": 1, "result": scan,
    }))]);
    let f = resolve_file(&c.st, None, i64::from(c.file)).await.unwrap();
    scan::schedule_if_needed(
        &c.st,
        c.file,
        &f.absolute,
        f.info,
        fliks_engine_core::api::JobPriority::High,
    )
    .await;
    let n: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM media_file_scans WHERE "mediaFileId" = $1"#)
            .bind(c.file)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(n, 1);
    let stored: Value = sqlx::query_scalar(r#"SELECT "streamInfo" FROM media_files WHERE id = $1"#)
        .bind(c.file)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(stored["timestampBreakSeconds"], 3.0);
}

#[sqlx::test(migrations = false)]
async fn session_stop_checks_the_owner(pool: PgPool) {
    let c = ctx(pool, true).await;
    let other: i32 =
        sqlx::query_scalar(r#"INSERT INTO users (username) VALUES ('other') RETURNING id"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    let other_token = c.st.jwt.sign_access(other, "other").unwrap().token;
    let sid = golden().0["sessionId"].as_str().unwrap().to_owned();
    let uri = format!("/api/stream/sessions/{sid}");
    info(&c, "").await;
    let (s, b) = call(&c, "DELETE", &uri, &other_token, None).await;
    assert_eq!((s, b["message"].as_str()), (403, Some("Not your session")));
    assert_eq!(c.st.presence.size(), 1);
    let (s, _) = call(&c, "DELETE", &uri, &c.token, None).await;
    assert_eq!(s, 204);
    assert_eq!(c.st.presence.size(), 0);
    assert_eq!(
        c.fake
            .seen("DELETE", &uri.replace("/api/stream", "/v1"))
            .len(),
        1
    );
    let (s, _) = call(
        &c,
        "DELETE",
        "/api/stream/sessions/unknown",
        &other_token,
        None,
    )
    .await;
    assert_eq!(s, 204);
    let (s, _) = call(&c, "DELETE", &uri, &other_token, None).await;
    assert_eq!(s, 204);
}

#[sqlx::test(migrations = false)]
async fn the_admin_streams_name_the_episode_the_session_plays(pool: PgPool) {
    let c = ctx(pool, true).await;
    let sid = golden().0["sessionId"].as_str().unwrap().to_owned();
    let snap = json!({
        "sessionId": sid, "ownerId": c.user.to_string(), "mediaFileId": c.file, "kind": "transcode", "quality": "360p",
        "client": {}, "tags": {}, "openedAtMs": 1.0, "lastBeatMs": 5000.0, "positionS": 0, "state": "playing",
        "pinned": false, "configRevision": 1, "decision": golden().0["decision"],
    });
    c.fake
        .script("GET", "/v1/sessions", vec![ok(json!([snap]))]);
    sqlx::query(
        r#"WITH g AS (INSERT INTO item_groups ("number", "mediaId") VALUES (1, $1) RETURNING id),
                e AS (INSERT INTO items ("number", "groupId", "mediaId", "editionId")
                      SELECT n, g.id, $1, (SELECT id FROM editions WHERE "mediaId" = $1)
                      FROM g, generate_series(1, 2) n RETURNING id),
                gone AS (DELETE FROM item_parts)
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId") SELECT e.id, $2, $1 FROM e"#,
    )
    .bind(c.media)
    .bind(c.file)
    .execute(&c.pool)
    .await
    .unwrap();
    let (first, second): (i32, i32) =
        sqlx::query_as(r#"SELECT min(id), max(id) FROM items WHERE "groupId" IS NOT NULL"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    info(&c, "").await;
    let episode = |rows: &Value| {
        (
            rows[0]["episodeId"].clone(),
            rows[0]["episodeLabel"].clone(),
        )
    };
    let (_, rows) = call(&c, "GET", "/api/system/streams", &c.token, None).await;
    assert_eq!(
        episode(&rows),
        (json!(first), json!("S1:E1")),
        "the file's owner"
    );
    c.st.presence.heartbeat(
        &sid,
        &crate::presence::Beat {
            item_id: Some(second),
            ..Default::default()
        },
    );
    let (_, rows) = call(&c, "GET", "/api/system/streams", &c.token, None).await;
    assert_eq!(
        episode(&rows),
        (json!(second), json!("S1:E2")),
        "the played one"
    );
}

#[sqlx::test(migrations = false)]
async fn the_admin_streams_list_command_and_cache(pool: PgPool) {
    let c = ctx(pool, true).await;
    let sid = golden().0["sessionId"].as_str().unwrap().to_owned();
    let snap = json!({
        "sessionId": sid, "ownerId": c.user.to_string(), "mediaFileId": c.file, "kind": "transcode", "quality": "360p",
        "client": {}, "tags": {}, "openedAtMs": 1.0, "lastBeatMs": 5000.0, "positionS": 0, "state": "playing",
        "pinned": false, "configRevision": 1, "decision": golden().0["decision"],
    });
    c.fake
        .script("GET", "/v1/sessions", vec![ok(json!([snap]))]);
    let (s, b) = call(
        &c,
        "POST",
        "/api/system/streams/nope/command",
        &c.token,
        Some(json!({"action": "pause"})),
    )
    .await;
    assert_eq!((s, b["message"].as_str()), (400, Some("Session not found")));
    info(&c, "").await;
    let (s, rows) = call(&c, "GET", "/api/system/streams", &c.token, None).await;
    assert_eq!(s, 200);
    let r = &rows[0];
    assert_eq!(
        (
            r["mode"].as_str(),
            r["quality"].as_str(),
            r["mediaTitle"].as_str()
        ),
        (Some("transcode"), Some("360p"), Some("Clip"))
    );
    assert_eq!(
        (
            r["videoCodec"].as_str(),
            r["videoResolution"].as_str(),
            r["container"].as_str()
        ),
        (Some("H264"), Some("360p"), Some("mkv"))
    );
    assert_eq!(
        (
            r["outputBitrate"].as_u64(),
            r["audioMode"].as_str(),
            r["lastActivity"].as_str()
        ),
        (
            Some(1_000_000),
            Some("copy"),
            Some("1970-01-01T00:00:05.000Z")
        )
    );
    assert_eq!(
        r["videoReasons"],
        json!(["Reduced-quality rung selected (360p)"])
    );
    assert_eq!(
        r["containerReasons"],
        json!(["Container \"mkv\" not supported"])
    );
    let (s, b) = call(
        &c,
        "POST",
        &format!("/api/system/streams/{sid}/command"),
        &c.token,
        Some(json!({"action": "stop"})),
    )
    .await;
    assert_eq!((s, b), (201, json!({"ok": true})));
    assert_eq!(c.st.presence.size(), 0);
    c.fake.script("GET", "/v1/cache", vec![ok(json!({"usedBytes": 30, "entries": [
        {"ownerId": "1", "mediaFileId": 7, "profileHash": "a", "bytes": 10, "lastAccessMs": 1, "live": false},
        {"ownerId": "2", "mediaFileId": 7, "profileHash": "b", "bytes": 20, "lastAccessMs": 1, "live": false},
        {"ownerId": "1", "mediaFileId": 8, "profileHash": "c", "bytes": 5, "lastAccessMs": 1, "live": true}]}))]);
    c.fake
        .script("DELETE", "/v1/cache", vec![ok(json!({"removed": 1}))]);
    let (_, b) = call(&c, "GET", "/api/system/transcode-cache", &c.token, None).await;
    assert_eq!(b, json!({"entries": 3, "bytes": 30.0}));
    let (_, b) = call(
        &c,
        "DELETE",
        "/api/system/transcode-cache/7?userId=1x",
        &c.token,
        None,
    )
    .await;
    assert_eq!(b, json!({"ok": true, "entries": 1, "bytes": 10.0}));
    assert_eq!(
        c.fake.seen("DELETE", "/v1/cache")[0].query,
        "mediaFileId=7&ownerId=1"
    );
    let (_, b) = call(&c, "DELETE", "/api/system/transcode-cache", &c.token, None).await;
    assert_eq!(b, json!({"ok": true, "entries": 2, "bytes": 30.0}));
}

#[sqlx::test(migrations = false)]
async fn the_system_routes_need_settings_permissions(pool: PgPool) {
    let c = ctx(pool, true).await;
    let plain: i32 =
        sqlx::query_scalar(r#"INSERT INTO users (username) VALUES ('plain') RETURNING id"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    let t = c.st.jwt.sign_access(plain, "plain").unwrap().token;
    for (m, u) in [
        ("GET", "/api/system/streams"),
        ("GET", "/api/system/transcode-cache"),
        ("DELETE", "/api/system/transcode-cache"),
        ("DELETE", "/api/system/transcode-cache/1"),
        ("POST", "/api/system/streams/x/command"),
    ] {
        assert_eq!(call(&c, m, u, &t, None).await.0, 403, "{m} {u}");
    }
}

#[sqlx::test(migrations = false)]
async fn info_routes_report_the_engine_hardware(pool: PgPool) {
    let c = ctx(pool, true).await;
    let get = |u: &'static str| {
        let c = &c;
        async move { call(c, "GET", u, &c.token, None).await.1 }
    };
    assert_eq!(
        get("/api/stream/info/hw-accel").await,
        json!({"hwAccel": "none"})
    );
    assert_eq!(
        get("/api/stream/info/tonemap-algos").await,
        json!({"available": ["auto"]})
    );
    assert_eq!(
        get("/api/stream/info/gpus").await,
        json!({"gpus": [], "defaultNode": "/dev/dri/renderD128"})
    );
    let e = get("/api/stream/info/effective-settings").await;
    assert_eq!(
        (
            e["cacheMaxGb"].as_f64(),
            e["cacheTtlHours"].as_f64(),
            e["tonemapAlgo"].as_str(),
            e["ffmpegSlots"].clone()
        ),
        (Some(20.0), Some(4.0), Some("auto"), Value::Null)
    );
    assert_eq!(e["pauseCapability"], "none");
    c.fake.script("GET", "/v1/capabilities", vec![ok(json!({
        "hwAccel": "vaapi", "encoders": [], "decoders": [], "tonemapAlgos": ["auto", "vaapi"],
        "gpus": [{"renderNode": "/dev/dri/renderD128", "name": "Intel"}], "defaultGpu": "/dev/dri/renderD128",
        "platform": "linux", "pauseCapability": "signal", "hostCaps": {}}))]);
    hardware::apply(&c.st, &Default::default(), true);
    for _ in 0..50 {
        if c.st.stream.hardware.hw_accel() != "none" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(
        get("/api/stream/info/hw-accel").await,
        json!({"hwAccel": "vaapi"})
    );
    assert_eq!(
        get("/api/stream/info/gpus").await["gpus"],
        json!([{"renderNode": "/dev/dri/renderD128", "label": "Intel", "kind": "unknown"}])
    );
    c.fake.script(
        "POST",
        "/v1/estimate-sizes",
        vec![ok(
            json!([{"key": "original", "label": "Original", "estimatedSize": 1.0}]),
        )],
    );
    let q = get_uri(&c, &format!("/api/stream/info/qualities/{}", c.file)).await;
    assert_eq!(q[0]["key"], "original");
}

async fn get_uri(c: &Ctx, u: &str) -> Value {
    call(c, "GET", u, &c.token, None).await.1
}

#[test]
fn the_golden_decision_reads_as_an_engine_answer() {
    serde_json::from_value::<OpenSessionResponse>(golden().0).unwrap();
}

#[sqlx::test(migrations = false)]
async fn replaces_reaches_the_engine(pool: PgPool) {
    let c = ctx(pool, true).await;
    info(&c, "?token=tok&replaces=abc").await;
    assert_eq!(
        c.fake.seen("POST", "/v1/sessions")[0].body["replaces"],
        "abc"
    );
}
