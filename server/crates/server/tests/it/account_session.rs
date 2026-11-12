//! The account session over HTTP (`docs/spec/session.md`): two devices of one account, SSE included.
use crate::session;
use axum::{Router, body::Body, http::Request};
use fliks_engine_core::api::SessionKind;
use fliks_server::{
    account_session, config::Config, events, playback, presence::LiveSession, remote,
    state::AppState,
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    st: AppState,
    pool: PgPool,
    token: String,
    user: i32,
    media: i32,
    file: i32,
}

async fn ctx(pool: PgPool, sync: bool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    sqlx::raw_sql(
        r#"INSERT INTO libraries (name) VALUES ('fixture');
           INSERT INTO library_folders ("libraryId", path) SELECT id, '/fixture' FROM libraries"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let user: i32 = sqlx::query_scalar(
        r#"INSERT INTO users (username, "isAdmin", "sessionSync") VALUES ('u', true, $1) RETURNING id"#,
    )
    .bind(sync)
    .fetch_one(&pool)
    .await
    .unwrap();
    let media: i32 = sqlx::query_scalar(
        r#"INSERT INTO media (title, type, "libraryId") VALUES ('placeholder', 'movie', (SELECT min(id) FROM libraries)) RETURNING id"#,
    )
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
    sqlx::query(
        r#"WITH e AS (INSERT INTO editions ("mediaId", family) VALUES ($1, 'video') RETURNING id),
                i AS (INSERT INTO items ("mediaId", "editionId") SELECT $1, id FROM e RETURNING id)
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") SELECT i.id, $2, $1, 0 FROM i"#,
    )
    .bind(media)
    .bind(file)
    .execute(&pool)
    .await
    .unwrap();
    let app = Router::new()
        .merge(playback::router())
        .merge(account_session::router())
        .merge(remote::router())
        .merge(events::router())
        .with_state(st.clone());
    Ctx {
        token: session::token(&st, user, "u").await,
        app,
        st,
        pool,
        user,
        media,
        file,
    }
}

impl Ctx {
    async fn call(&self, method: &str, uri: &str, body: Option<Value>) -> (u16, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {}", self.token));
        let body = match body {
            Some(b) => {
                req = req.header("content-type", "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        let res = self
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

    /// An SSE stream for the target `device`, and the id of its connection.
    async fn device(&self, device: &str) -> (axum::body::BodyDataStream, String) {
        let req = Request::builder()
            .uri(format!(
                "/api/system/events?device={}",
                device.replace('#', "%23")
            ))
            .header("authorization", format!("Bearer {}", self.token))
            .body(Body::empty())
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let conn = self
            .st
            .hub
            .list_for_user(self.user)
            .into_iter()
            .find(|t| t.identity.target_id.as_deref() == Some(device))
            .unwrap()
            .connection_id;
        (res.into_body().into_data_stream(), conn)
    }

    fn presence(&self, sid: &str, conn: &str) {
        self.st.presence.create(LiveSession {
            session_id: sid.into(),
            user_id: Some(self.user),
            username: None,
            media_file_id: self.file as u32,
            media_title: Some("placeholder".into()),
            media_type: Some("movie".into()),
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
            sse_connection_id: Some(conn.into()),
            owner: None,
            started_at: 0.0,
            last_beat: fliks_server::presence::now_ms(),
            position: 0.0,
            state: events::event::PlayState::Playing,
            episode_label: None,
            item_id: None,
            supports_volume: Some(true),
            subtitle_id: None,
            audio_track_index: None,
            subtitle_track_index: None,
            volume: None,
            muted: None,
            playback_rate: 1.0,
            audio_plan: None,
            source_fps: None,
            bitrate_by_quality: None,
            hdr_ladder: false,
            transcode_reasons: vec![],
            client_tonemap: false,
        });
    }

    async fn beat(&self, sid: &str, position: f64, extra: Value) -> (u16, Value) {
        let mut b = json!({"sessionId": sid, "durationSeconds": 3600,
                           "mediaFileId": self.file, "positionSeconds": position});
        b.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        self.call(
            "PUT",
            &format!("/api/playback/media/{}/state", self.media),
            Some(b),
        )
        .await
    }

    async fn stored_position(&self) -> f64 {
        sqlx::query_scalar(r#"SELECT "positionSeconds" FROM playback_states WHERE "userId" = $1"#)
            .bind(self.user)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

/// Every event the stream has queued, by type.
async fn drain(s: &mut axum::body::BodyDataStream) -> Vec<Value> {
    let mut out = vec![];
    while let Ok(Some(Ok(chunk))) = tokio::time::timeout(Duration::from_millis(200), s.next()).await
    {
        for line in String::from_utf8_lossy(&chunk).lines() {
            if let Some(v) = line
                .strip_prefix("data: ")
                .and_then(|d| serde_json::from_str::<Value>(d).ok())
            {
                out.push(v);
            }
        }
    }
    out
}

fn of<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["type"] == kind).collect()
}

#[sqlx::test(migrations = false)]
async fn a_second_device_takes_the_session_and_the_first_is_told_once(pool: PgPool) {
    let c = ctx(pool, true).await;
    let (mut a, conn_a) = c.device("A#t").await;
    let (mut b, conn_b) = c.device("B#t").await;
    drain(&mut a).await;
    drain(&mut b).await;
    c.presence("s1", &conn_a);
    c.presence("s2", &conn_b);

    let (status, body) = c.beat("s1", 100.0, json!({})).await;
    assert_eq!((status, body.get("superseded")), (200, None));
    let (_, mine) = c.call("GET", "/api/session", None).await;
    assert_eq!(mine["epoch"], 1);
    assert_eq!(mine["owner"]["targetId"], "A#t");
    assert_eq!(mine["item"]["title"], "placeholder");
    assert_eq!(
        (mine["state"].as_str(), mine["playing"].as_bool()),
        (Some("playing"), Some(true))
    );

    c.beat("s2", 150.0, json!({})).await;
    let (_, taken) = c.call("GET", "/api/session", None).await;
    assert_eq!(
        (taken["epoch"].clone(), taken["owner"]["targetId"].clone()),
        (json!(2), json!("B#t"))
    );

    let (on_a, on_b) = (drain(&mut a).await, drain(&mut b).await);
    let told = of(&on_a, "session.superseded");
    assert_eq!(told.len(), 1, "the previous owner only: {on_a:?}");
    assert_eq!(
        (told[0]["sessionId"].clone(), told[0]["epoch"].clone()),
        (json!("s1"), json!(2))
    );
    assert_eq!(told[0]["silent"], false, "a plain takeover is announced");
    assert!(of(&on_b, "session.superseded").is_empty());
    for stream in [&on_a, &on_b] {
        assert!(!of(stream, "session.changed").is_empty(), "{stream:?}");
    }

    let (status, late) = c.beat("s1", 900.0, json!({})).await;
    assert_eq!((status, late), (200, json!({"superseded": true})));
    assert_eq!(
        c.stored_position().await,
        150.0,
        "the superseded beat writes nothing"
    );
}

#[sqlx::test(migrations = false)]
async fn a_preloaded_or_replayed_session_claims_nothing(pool: PgPool) {
    let c = ctx(pool, true).await;
    let (_a, conn_a) = c.device("A#t").await;
    c.presence("s1", &conn_a);
    let (_, none) = c.call("GET", "/api/session", None).await;
    assert_eq!(none, Value::Null, "preload opens a session and never beats");
    let past = chrono::Utc::now().timestamp_millis() - 60_000;
    c.beat("s1", 10.0, json!({"playedAt": past})).await;
    let (_, none) = c.call("GET", "/api/session", None).await;
    assert_eq!(none, Value::Null, "an offline replay never claims");
}

#[sqlx::test(migrations = false)]
async fn the_option_off_changes_nothing_and_a_parked_session_can_be_dismissed(pool: PgPool) {
    let off = ctx(pool.clone(), false).await;
    let (_a, conn) = off.device("A#t").await;
    off.presence("s1", &conn);
    off.beat("s1", 10.0, json!({})).await;
    assert_eq!(off.call("GET", "/api/session", None).await.1, Value::Null);

    sqlx::query(r#"UPDATE users SET "sessionSync" = true"#)
        .execute(&pool)
        .await
        .unwrap();
    off.presence("s2", &conn);
    off.beat("s2", 20.0, json!({})).await;
    assert_eq!(
        off.call("GET", "/api/session", None).await.1["state"],
        "playing"
    );
    assert_eq!(off.call("DELETE", "/api/session", None).await.0, 409);
    off.st.account_sessions.ended(&off.st, "s2").await;
    assert_eq!(
        off.call("GET", "/api/session", None).await.1["state"],
        "parked"
    );
    assert_eq!(off.call("DELETE", "/api/session", None).await.0, 204);
    assert_eq!(off.call("GET", "/api/session", None).await.1, Value::Null);
    assert_eq!(off.call("DELETE", "/api/session", None).await.0, 204);
}

#[sqlx::test(migrations = false)]
async fn a_transfer_loads_the_session_on_the_target_only_and_changes_nothing(pool: PgPool) {
    let c = ctx(pool, true).await;
    let (mut a, conn_a) = c.device("A#t").await;
    let (mut b, _) = c.device("B#t").await;
    let to = |t: &str| Some(json!({ "toTargetId": t }));
    assert_eq!(
        c.call("POST", "/api/session/transfer", to("B#t")).await,
        (
            404,
            json!({"error": "Not Found", "message": "session.error_no_session", "statusCode": 404})
        )
    );
    c.presence("s1", &conn_a);
    c.beat("s1", 100.0, json!({"state": "paused"})).await;
    drain(&mut a).await;
    drain(&mut b).await;

    assert_eq!(
        c.call("POST", "/api/session/transfer", to("A#t")).await.0,
        400
    );
    assert_eq!(
        c.call("POST", "/api/session/transfer", to("nope")).await.0,
        404
    );
    let (status, ack) = c.call("POST", "/api/session/transfer", to("B#t")).await;
    assert_eq!(status, 202);
    assert!(ack["cmdId"].is_string());

    let (on_a, on_b) = (drain(&mut a).await, drain(&mut b).await);
    assert!(of(&on_a, "remote.command").is_empty(), "{on_a:?}");
    let load = of(&on_b, "remote.command");
    assert_eq!(load.len(), 1, "{on_b:?}");
    let load = load[0];
    assert_eq!(load["action"], "load");
    assert_eq!(
        (load["mediaId"].as_i64(), load["mediaFileId"].as_i64()),
        (Some(i64::from(c.media)), Some(i64::from(c.file)))
    );
    assert_eq!(
        (load["positionSeconds"].as_f64(), load["paused"].as_bool()),
        (Some(100.0), Some(true))
    );
    assert!(load["episodeId"].is_null() && load["queue"].is_null());
    let (_, still) = c.call("GET", "/api/session", None).await;
    assert_eq!(
        (still["epoch"].clone(), still["owner"]["targetId"].clone()),
        (json!(1), json!("A#t"))
    );
    assert_eq!(still["item"]["mediaId"], c.media);
    assert!(still["item"]["episodeId"].is_null());
}

#[sqlx::test(migrations = false)]
async fn a_beat_that_says_handoff_supersedes_silently(pool: PgPool) {
    let c = ctx(pool, true).await;
    let (mut a, conn_a) = c.device("A#t").await;
    let (_b, conn_b) = c.device("B#t").await;
    c.presence("s1", &conn_a);
    c.presence("s2", &conn_b);
    c.beat("s1", 100.0, json!({})).await;
    drain(&mut a).await;

    c.beat("s2", 150.0, json!({"handoff": true})).await;
    let on_a = drain(&mut a).await;
    let told = of(&on_a, "session.superseded");
    assert_eq!(told.len(), 1, "{on_a:?}");
    assert_eq!(told[0]["silent"], true);
    let (_, late) = c.beat("s1", 900.0, json!({})).await;
    assert_eq!(
        late,
        json!({"superseded": true}),
        "the beat answer is unchanged"
    );
}

#[sqlx::test(migrations = false)]
async fn a_transfer_makes_the_targets_first_claim_silent_once(pool: PgPool) {
    let c = ctx(pool, true).await;
    let (mut a, conn_a) = c.device("A#t").await;
    let (mut b, conn_b) = c.device("B#t").await;
    c.presence("s1", &conn_a);
    c.presence("s2", &conn_b);
    c.presence("s3", &conn_a);
    c.beat("s1", 100.0, json!({})).await;
    let to_b = Some(json!({ "toTargetId": "B#t" }));
    assert_eq!(c.call("POST", "/api/session/transfer", to_b).await.0, 202);
    drain(&mut a).await;
    drain(&mut b).await;

    c.beat("s2", 100.0, json!({})).await;
    let on_a = drain(&mut a).await;
    assert_eq!(
        of(&on_a, "session.superseded")[0]["silent"],
        true,
        "{on_a:?}"
    );

    // The record was consumed: A taking it back is a plain takeover.
    c.beat("s3", 200.0, json!({})).await;
    let on_b = drain(&mut b).await;
    assert_eq!(
        of(&on_b, "session.superseded")[0]["silent"],
        false,
        "{on_b:?}"
    );
}
