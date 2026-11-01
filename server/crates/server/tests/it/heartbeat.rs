//! `PUT /api/playback/media/{mediaId}/state` (`docs/spec/heartbeat.md`): debounce, forced writes,
//! response shapes, failure isolation, presence and the `remote.state` fan-out.
use axum::{Router, body::Body, http::Request};
use fliks_engine_core::api::SessionKind;
use fliks_server::{
    config::Config,
    events::{Identity, SseEvent},
    playback,
    presence::LiveSession,
    state::AppState,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

/// The engine answers by sid; every path it is asked is recorded.
async fn fake_engine() -> (String, Arc<Mutex<Vec<String>>>) {
    use axum::{http::StatusCode, response::IntoResponse};
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = seen.clone();
    let app = Router::new().fallback(move |req: Request<Body>| {
        let log = log.clone();
        async move {
            let (method, path) = (req.method().to_string(), req.uri().path().to_owned());
            log.lock().unwrap().push(format!("{method} {path}"));
            let ok = |v: Value| axum::Json(v).into_response();
            match (method.as_str(), path.as_str()) {
                ("GET", "/v1/hello") => ok(json!({"engineVersion": "0.2.0", "protocolVersion": 1, "instanceId": "x",
                    "features": ["probe", "capabilities", "decide", "sessions", "serve", "events"]})),
                ("GET", "/v1/config") => ok(json!({"revision": 1})),
                ("PUT", "/v1/config") => ok(json!({})),
                ("POST", p) if p.ends_with("/gone/heartbeat") => ok(json!({"sessionLost": true})),
                ("POST", p) if p.ends_with("/foreign/heartbeat") => StatusCode::FORBIDDEN.into_response(),
                ("POST", p) if p.ends_with("/boom/heartbeat") => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                ("POST", p) if p.ends_with("/heartbeat") => ok(json!({"sessionLost": false})),
                _ => StatusCode::NOT_FOUND.into_response(),
            }
        }
    });
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (url, seen)
}

const SECRET: &str = "0123456789abcdef0123456789abcdef";

/// Gives a movie its edition and item, and the file as a part of it.
async fn give_item(pool: &PgPool, media: i32, file: i32) {
    sqlx::query(
        r#"WITH e AS (INSERT INTO editions ("mediaId", family) VALUES ($1, 'video') RETURNING id),
                i AS (INSERT INTO items ("mediaId", "editionId") SELECT $1, id FROM e RETURNING id)
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") SELECT i.id, $2, $1, 0 FROM i"#,
    )
    .bind(media)
    .bind(file)
    .execute(pool)
    .await
    .unwrap();
}

struct Ctx {
    app: Router,
    st: AppState,
    pool: PgPool,
    token: String,
    user: i32,
    media: i32,
    file: i32,
}

async fn ctx(pool: PgPool) -> Ctx {
    ctx_with(pool, None).await
}

async fn ctx_with(pool: PgPool, engine: Option<&str>) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    sqlx::raw_sql(
        r#"INSERT INTO libraries (name) VALUES ('fixture');
           INSERT INTO library_folders ("libraryId", path) SELECT id, '/fixture' FROM libraries"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let cfg = Config::from_lookup(|k| match k {
        "FLIKS_ENGINE_URL" => engine.map(Into::into),
        "FLIKS_ENGINE_TOKEN" => engine.map(|_| "tok".into()),
        _ => None,
    });
    let st = AppState::new(pool.clone(), cfg, SECRET);
    if engine.is_some() {
        st.engine.start(pool.clone(), 4849).await;
        assert!(st.engine.runtime());
    }
    let user: i32 = sqlx::query_scalar(
        r#"INSERT INTO users (username, "isAdmin") VALUES ('u', true) RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let media: i32 =
        sqlx::query_scalar(r#"INSERT INTO media (title, type) VALUES ('m', 'movie') RETURNING id"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    let file: i32 = sqlx::query_scalar(
        r#"INSERT INTO media_files ("relativePath", size, quality, "mediaId", "folderId") VALUES ('x', 1, 'q', $1, (SELECT min(id) FROM library_folders)) RETURNING id"#,
    )
    .bind(media)
    .fetch_one(&pool)
    .await
    .unwrap();
    give_item(&pool, media, file).await;
    Ctx {
        token: st.jwt.sign_access(user, "u").unwrap().token,
        app: playback::router().with_state(st.clone()),
        st,
        pool,
        user,
        media,
        file,
    }
}

impl Ctx {
    /// Status and raw body text (empty for a body-less answer).
    async fn put(&self, media: i32, body: Value) -> (u16, String) {
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/api/playback/media/{media}/state"))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    async fn beat(&self, extra: Value) -> (u16, Value) {
        let mut b =
            json!({"durationSeconds": 3600, "mediaFileId": self.file, "positionSeconds": 100});
        b.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (s, t) = self.put(self.media, b).await;
        (s, serde_json::from_str(&t).unwrap_or(Value::Null))
    }

    fn live(&self, sid: &str, conn: Option<&str>) -> LiveSession {
        LiveSession {
            session_id: sid.into(),
            user_id: Some(self.user),
            username: None,
            media_file_id: self.file as u32,
            media_title: Some("M".into()),
            media_type: None,
            poster_url: None,
            fanart_url: None,
            profile_hash: None,
            quality: None,
            qualities: None,
            attributed_user_id: None,
            autoplay_blocked: false,
            has_next: false,
            kind: SessionKind::Directplay,
            device_label: None,
            system_name: None,
            app_version: None,
            sse_connection_id: conn.map(Into::into),
            started_at: 0.0,
            last_beat: 0.0,
            position: 0.0,
            state: fliks_server::events::event::PlayState::Playing,
            episode_label: None,
            item_id: None,
            supports_volume: Some(true),
            subtitle_id: None,
            audio_track_index: None,
            subtitle_track_index: None,
            volume: None,
            muted: None,
            audio_plan: None,
            source_fps: None,
            bitrate_by_quality: None,
            hdr_ladder: false,
            transcode_reasons: vec![],
            client_tonemap: false,
        }
    }
}

#[sqlx::test(migrations = false)]
async fn without_a_session_the_first_beat_writes_and_the_next_is_empty(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, b) = c.beat(json!({})).await;
    assert_eq!(s, 200);
    let st = &b["state"];
    assert_eq!(
        (
            st["positionSeconds"].clone(),
            st["mediaFile"].clone(),
            st["user"].clone()
        ),
        (json!(100.0), json!({"id": c.file}), json!({"id": c.user})),
        "new row shape"
    );
    assert!(b.get("sessionLost").is_none());
    assert_eq!(
        c.put(
            c.media,
            json!({"positionSeconds": 110, "mediaFileId": c.file})
        )
        .await,
        (200, String::new())
    );
    let (_, b) = c.beat(json!({"positionSeconds": 200})).await;
    assert_eq!(b["state"]["positionSeconds"], json!(200.0), "seek flushes");
    assert!(b["state"].get("user").is_none(), "existing row shape");
}

#[sqlx::test(migrations = false)]
async fn completion_zone_writes_every_beat_and_cleans_auto_playlists(pool: PgPool) {
    let c = ctx(pool).await;
    let pl: i32 = sqlx::query_scalar(
        r#"INSERT INTO playlists (name, "ownerId", "autoRemoveWatched") VALUES ('p', $1, true) RETURNING id"#,
    )
    .bind(c.user)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO playlist_items ("playlistId", "itemId", position) VALUES ($1, item_of($2, NULL), 0)"#,
    )
    .bind(pl)
    .bind(c.media)
    .execute(&c.pool)
    .await
    .unwrap();
    for pos in [3500, 3501] {
        let (_, b) = c.beat(json!({"positionSeconds": pos})).await;
        assert_eq!(b["state"]["completed"], json!(true), "{pos}");
    }
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM playlist_items")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
    let plays = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM playback_history")
            .fetch_one(&c.pool)
            .await
            .unwrap()
    };
    assert_eq!(plays().await, 1, "completion appends once");
    c.beat(json!({"positionSeconds": 100})).await;
    c.beat(json!({"positionSeconds": 3500})).await;
    assert_eq!(plays().await, 2, "a re-watch appends again");
}

#[sqlx::test(migrations = false)]
async fn a_failed_write_keeps_the_debounce_entry(pool: PgPool) {
    let c = ctx(pool).await;
    let missing = json!({"durationSeconds": 3600, "positionSeconds": 100});
    let (s, t) = c.put(c.media, missing.clone()).await;
    assert_eq!(s, 400);
    assert!(t.contains("mediaId and mediaFileId are required"));
    assert_eq!(
        c.put(c.media, missing).await,
        (200, String::new()),
        "entry survived the 400"
    );
    let (s, b) = c
        .beat(json!({"mediaFileId": 99_999, "positionSeconds": 500}))
        .await;
    assert_eq!(
        (s, b),
        (200, json!({"state": null})),
        "FK violation swallowed"
    );
    assert_eq!(
        c.beat(json!({"positionSeconds": 505})).await,
        (200, Value::Null)
    );
}

#[sqlx::test(migrations = false)]
async fn an_unknown_session_is_lost_with_and_without_a_write(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, b) = c.beat(json!({"sessionId": "nosuch"})).await;
    assert_eq!(b["sessionLost"], json!(true));
    assert!(b["state"].is_object());
    let (_, b) = c
        .beat(json!({"sessionId": "nosuch", "positionSeconds": 105}))
        .await;
    assert_eq!(b, json!({"sessionLost": true}));
}

#[sqlx::test(migrations = false)]
async fn presence_beats_update_emit_every_time_and_a_state_change_flushes(pool: PgPool) {
    let c = ctx(pool).await;
    let conn = c.st.hub.connect(
        c.user,
        Identity {
            target_id: Some("dev#tab".into()),
            ..Default::default()
        },
    );
    c.st.presence.create(c.live("s1", Some(&conn.id)));
    let seen: Arc<Mutex<Vec<SseEvent>>> = Arc::default();
    let sink = seen.clone();
    c.st.hub
        .register_household_fan_out(move |ev, _| sink.lock().unwrap().push(ev.clone()));
    let beat = |mut extra: Value| {
        extra["sessionId"] = "s1".into();
        c.beat(extra)
    };
    let (_, b) = beat(json!({"state": "playing", "episodeId": null, "volume": 0.5})).await;
    assert!(b["state"].is_object(), "first beat after boot writes: {b}");
    assert!(b.get("sessionLost").is_none());
    assert_eq!(
        beat(json!({"positionSeconds": 110, "state": "playing"}))
            .await
            .1,
        Value::Null
    );
    let (_, b) = beat(json!({"positionSeconds": 111, "state": "paused"})).await;
    assert!(b["state"].is_object(), "state change forces a write");
    let live = c.st.presence.peek("s1").unwrap();
    assert_eq!((live.position, live.volume), (111.0, Some(0.5)));
    let events = seen.lock().unwrap();
    assert_eq!(events.len(), 3, "remote.state on every beat");
    let SseEvent::RemoteState {
        target_id,
        position_seconds,
        volume,
        ..
    } = &events[2]
    else {
        panic!("not remote.state")
    };
    assert_eq!(
        (target_id.as_str(), position_seconds.0, volume.map(|v| v.0)),
        ("dev#tab", 111.0, Some(0.5))
    );
}

#[sqlx::test(migrations = false)]
async fn an_unknown_state_is_kept_verbatim_and_absent_body_fields_stay_absent(pool: PgPool) {
    let c = ctx(pool).await;
    let conn = c.st.hub.connect(
        c.user,
        Identity {
            target_id: Some("dev#tab".into()),
            ..Default::default()
        },
    );
    c.st.presence.create(c.live("s1", Some(&conn.id)));
    let seen: Arc<Mutex<Vec<SseEvent>>> = Arc::default();
    let sink = seen.clone();
    c.st.hub
        .register_household_fan_out(move |ev, _| sink.lock().unwrap().push(ev.clone()));
    let body = json!({"sessionId": "s1", "positionSeconds": 5, "state": "seeking"});
    let (status, _) = c.put(c.media, body).await;
    assert_eq!(
        status, 400,
        "the flush still needs mediaFileId, after the emit"
    );
    let live = c.st.presence.peek("s1").unwrap();
    assert_eq!(
        live.state,
        fliks_server::events::event::PlayState::Other("seeking".into())
    );
    let ev = serde_json::to_value(&seen.lock().unwrap()[0]).unwrap();
    assert_eq!(ev["state"], "seeking");
    assert!(
        ev.get("mediaFileId").is_none() && ev.get("durationSeconds").is_none(),
        "{ev}"
    );
}

#[sqlx::test(migrations = false)]
async fn history_goes_to_the_launcher_and_no_target_means_no_emit(pool: PgPool) {
    let c = ctx(pool).await;
    let launcher: i32 =
        sqlx::query_scalar(r#"INSERT INTO users (username) VALUES ('l') RETURNING id"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    let mut s = c.live("s2", Some("gone"));
    s.attributed_user_id = Some(launcher);
    c.st.presence.create(s);
    let seen: Arc<Mutex<usize>> = Arc::default();
    let n = seen.clone();
    c.st.hub
        .register_household_fan_out(move |_, _| *n.lock().unwrap() += 1);
    c.beat(json!({"sessionId": "s2", "state": "playing"})).await;
    let owner: i32 = sqlx::query_scalar(r#"SELECT "userId" FROM playback_states"#)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!((owner, *seen.lock().unwrap()), (launcher, 0));
}

#[sqlx::test(migrations = false)]
async fn engine_answers_decide_the_session_and_the_ownership(pool: PgPool) {
    let (url, calls) = fake_engine().await;
    let c = ctx_with(pool, Some(&url)).await;
    let heartbeats = || {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.ends_with("/heartbeat"))
            .count()
    };
    let other: i32 =
        sqlx::query_scalar(r#"INSERT INTO users (username) VALUES ('o') RETURNING id"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();

    // The engine lost it: registry untouched, history still written as the request user.
    c.st.presence.create(c.live("gone", None));
    let (_, b) = c
        .beat(json!({"sessionId": "gone", "positionSeconds": 50}))
        .await;
    assert_eq!(b["sessionLost"], json!(true));
    assert!(b["state"].is_object());
    assert_eq!(c.st.presence.peek("gone").unwrap().position, 0.0);

    // Another owner's presence is refused before the engine is asked.
    let mut s = c.live("mine", None);
    s.user_id = Some(other);
    c.st.presence.create(s);
    let before = heartbeats();
    let (s, _) = c
        .put(c.media, json!({"sessionId": "mine", "mediaFileId": c.file}))
        .await;
    assert_eq!((s, heartbeats()), (403, before));

    // The engine's own 403 is the same refusal.
    let (s, t) = c
        .put(
            c.media,
            json!({"sessionId": "foreign", "mediaFileId": c.file}),
        )
        .await;
    assert_eq!(s, 403);
    assert!(t.contains("Not your session"));

    // Alive for the engine, unknown to the registry and not restorable: not lost.
    let (s, b) = c
        .beat(json!({"sessionId": "alive", "positionSeconds": 700}))
        .await;
    assert_eq!(s, 200);
    assert!(b.get("sessionLost").is_none());

    // Engine failure: the registry answers on its own.
    c.st.presence.create(c.live("boom", None));
    c.beat(json!({"sessionId": "boom", "positionSeconds": 900}))
        .await;
    assert_eq!(c.st.presence.peek("boom").unwrap().position, 900.0);
}

#[sqlx::test(migrations = false)]
async fn a_pair_that_names_no_item_writes_nothing(pool: PgPool) {
    let c = ctx(pool).await;
    let series: i32 = sqlx::query_scalar(
        r#"INSERT INTO media (title, type) VALUES ('s', 'series') RETURNING id"#,
    )
    .fetch_one(&c.pool)
    .await
    .unwrap();
    let beat = |media: i32, episode: Option<i64>| {
        let mut b = json!({"positionSeconds": 50, "durationSeconds": 3600, "mediaFileId": c.file});
        if let Some(e) = episode {
            b["episodeId"] = json!(e);
        }
        c.put(media, b)
    };
    for (media, episode) in [
        (series, None),
        (c.media, Some(99_999)),
        (c.media, Some(5_000_000_000)),
        (999_999, None),
    ] {
        assert_eq!(
            beat(media, episode).await,
            (200, r#"{"state":null}"#.to_owned()),
            "{media} {episode:?}"
        );
    }
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM playback_states")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
}

#[sqlx::test(migrations = false)]
async fn a_file_bound_stream_token_beats_only_for_its_own_file(pool: PgPool) {
    let mut c = ctx(pool).await;
    let other_media: i32 =
        sqlx::query_scalar(r#"INSERT INTO media (title, type) VALUES ('o', 'movie') RETURNING id"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    let other_file: i32 = sqlx::query_scalar(
        r#"INSERT INTO media_files ("relativePath", size, quality, "mediaId", "folderId") VALUES ('y', 1, 'q', $1, (SELECT min(id) FROM library_folders)) RETURNING id"#,
    )
    .bind(other_media)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    give_item(&c.pool, other_media, other_file).await;
    let bound = |f: i32| {
        c.st.jwt
            .sign_stream_for(c.user, "u", f as u32)
            .unwrap()
            .token
    };
    let (own, foreign) = (bound(c.file), bound(other_file));
    let unbound = c.st.jwt.sign_stream(c.user, "u").unwrap().token;
    let body = |m: i32, f: i32| json!({"positionSeconds": 5, "mediaFileId": f, "mediaId": m});

    c.token = own.clone();
    assert_eq!(c.put(c.media, body(c.media, c.file)).await.0, 200);
    assert_eq!(
        c.put(other_media, body(other_media, other_file)).await.0,
        403,
        "other media"
    );
    assert_eq!(
        c.put(c.media, body(c.media, other_file)).await.0,
        403,
        "other file in body"
    );
    c.token = foreign;
    assert_eq!(
        c.put(c.media, body(c.media, c.file)).await.0,
        403,
        "token of another file"
    );
    c.token = unbound;
    assert_eq!(
        c.put(c.media, body(c.media, c.file)).await.0,
        401,
        "unbound stream token"
    );

    c.token = own;
    let req = |method: &str| {
        Request::builder()
            .method(method)
            .uri(format!("/api/playback/media/{}/state", c.media))
            .header("authorization", format!("Bearer {}", c.token))
            .body(Body::empty())
            .unwrap()
    };
    for m in ["GET", "DELETE"] {
        let res = c.app.clone().oneshot(req(m)).await.unwrap();
        assert!(matches!(res.status().as_u16(), 401 | 403), "{m}");
    }
}
