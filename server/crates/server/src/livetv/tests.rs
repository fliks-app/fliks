//! Live TV against a real database, a fake provider and a fake engine: the sync, the guide import, the
//! session control plane and the resolver (ports of `livetv-session.service.spec.ts` and the sync specs).
use super::{guide, session, sources, sync};
use crate::{
    app,
    config::Config,
    engine::testkit::{Fake, coded, ok, status},
    state::AppState,
};
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use fliks_engine_core::api::EngineEvent;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    io,
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";
const FEATURES: [&str; 7] = [
    "probe",
    "capabilities",
    "decide",
    "sessions",
    "serve",
    "events",
    "live",
];

// ---- a provider on a loopback port ------------------------------------------------------------

#[derive(Default)]
struct Provider {
    playlist: String,
    guide: Vec<u8>,
    gzip_guide: bool,
    /// The guide stops after this many bytes with a transport error.
    cut_guide_at: Option<usize>,
    delay_ms: u64,
    etag: Option<&'static str>,
    hits: Vec<String>,
    agents: Vec<String>,
}

type Shared = Arc<Mutex<Provider>>;

async fn serve(State(p): State<Shared>, headers: HeaderMap, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    let (delay, etag, playlist, guide, cut, gz) = {
        let mut g = p.lock().unwrap();
        g.hits
            .push(format!("{path}?{}", req.uri().query().unwrap_or_default()));
        g.agents.push(
            headers
                .get(header::USER_AGENT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned(),
        );
        (
            g.delay_ms,
            g.etag,
            g.playlist.clone(),
            g.guide.clone(),
            g.cut_guide_at,
            g.gzip_guide,
        )
    };
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    match path.as_str() {
        "/playlist.m3u" => {
            if let Some(e) = etag {
                if headers
                    .get(header::IF_NONE_MATCH)
                    .and_then(|v| v.to_str().ok())
                    == Some(e)
                {
                    return (StatusCode::NOT_MODIFIED, [(header::ETAG, e)]).into_response();
                }
                return ([(header::ETAG, e)], playlist).into_response();
            }
            playlist.into_response()
        }
        "/guide.xml" => {
            let body = if gz { gzip(&guide) } else { guide };
            match cut {
                None => body.into_response(),
                Some(n) => {
                    let head = Bytes::from(body[..n.min(body.len())].to_vec());
                    let stream =
                        futures_util::stream::iter(vec![Ok(head), Err(io::Error::other("cut"))]);
                    Response::new(Body::from_stream(stream))
                }
            }
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

fn gzip(data: &[u8]) -> Vec<u8> {
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;
    let mut e = GzEncoder::new(vec![], Compression::fast());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

async fn provider() -> (String, Shared) {
    let shared: Shared = Arc::default();
    let app = Router::new()
        .fallback(get(serve))
        .with_state(shared.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (base, shared)
}

// ---- the world ----------------------------------------------------------------------------------

struct Ctx {
    st: AppState,
    app: Router,
    fake: Fake,
    pool: PgPool,
    base: String,
    prov: Shared,
}

async fn ctx(pool: PgPool) -> Ctx {
    ctx_with(pool, |_| {}, false).await
}

/// `pre` scripts the fake before the engine connects; `consumer` runs the live TV events consumer.
async fn ctx_with(pool: PgPool, pre: impl FnOnce(&Fake), consumer: bool) -> Ctx {
    crate::db::migrate(&pool).await.unwrap();
    let fake = Fake::start().await;
    pre(&fake);
    fake.hello(Some(json!({"engineVersion": "0.3.1", "protocolVersion": 1, "features": FEATURES, "instanceId": "x"})));
    let env = [
        ("FLIKS_ENGINE_URL", fake.url.clone()),
        ("FLIKS_ENGINE_TOKEN", "tok".into()),
        ("FLIKS_NEST_URL", "http://127.0.0.1:1".into()),
        ("FLIKS_BRIDGE_TOKEN", "bridge".into()),
    ];
    let cfg = Config::from_lookup(|k| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()));
    let st = AppState::new(pool.clone(), cfg, SECRET);
    if consumer {
        session::spawn(&st);
    }
    st.engine.start(pool.clone(), 4849).await;
    let upstream = fliks_engine::gateway::Upstream::parse("http://127.0.0.1:1").unwrap();
    let app = app::router(st.clone(), upstream, None, "/nonexistent".into(), None);
    let (base, prov) = provider().await;
    Ctx {
        st,
        app,
        fake,
        pool,
        base,
        prov,
    }
}

async fn user(pool: &PgPool, name: &str, admin: bool) -> i32 {
    sqlx::query_scalar(
        r#"INSERT INTO users (username, "isAdmin", enabled) VALUES ($1, $2, true) RETURNING id"#,
    )
    .bind(name)
    .bind(admin)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// A user holding `livetv.read` only, or an administrator.
async fn viewer(c: &Ctx, name: &str, admin: bool) -> (i32, String) {
    let id = user(&c.pool, name, admin).await;
    if !admin {
        let role: i32 = sqlx::query_scalar(r#"INSERT INTO roles (name, permissions, "isDefault") VALUES ($1, '["livetv.read"]', false) RETURNING id"#)
            .bind(format!("r-{name}"))
            .fetch_one(&c.pool)
            .await
            .unwrap();
        sqlx::query(r#"UPDATE users SET "roleId" = $1 WHERE id = $2"#)
            .bind(role)
            .bind(id)
            .execute(&c.pool)
            .await
            .unwrap();
    }
    (id, c.st.jwt.sign_access(id, name).unwrap().token)
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> (u16, Value) {
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
    let res = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn source(c: &Ctx, name: &str, kind: &str, url: &str, max: i32) -> i32 {
    sqlx::query_scalar(r#"INSERT INTO livetv_sources (name, kind, url, "maxStreams") VALUES ($1, $2, $3, $4) RETURNING id"#)
        .bind(name)
        .bind(kind)
        .bind(url)
        .bind(max)
        .fetch_one(&c.pool)
        .await
        .unwrap()
}

async fn channel(pool: &PgPool, name: &str, group: &str, enabled: bool) -> i32 {
    sqlx::query_scalar(r#"INSERT INTO livetv_channels (name, "groupName", enabled) VALUES ($1, $2, $3) RETURNING id"#)
        .bind(name)
        .bind(group)
        .bind(enabled)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn stream(pool: &PgPool, channel: i32, source: i32, url: &str, priority: i32) -> i32 {
    sqlx::query_scalar(
        r#"INSERT INTO livetv_channel_streams ("channelId", "sourceId", "externalId", url, priority, "providerName") VALUES ($1, $2, $3, $4, $5, 'p') RETURNING id"#,
    )
    .bind(channel)
    .bind(source)
    .bind(format!("{url}#{priority}"))
    .bind(url)
    .bind(priority)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn count(pool: &PgPool, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn setting(pool: &PgPool, key: &str) -> Option<String> {
    sqlx::query_scalar(r#"SELECT value FROM app_settings WHERE key = $1"#)
        .bind(key)
        .fetch_optional(pool)
        .await
        .unwrap()
        .flatten()
}

const PLAYLIST: &str = "#EXTM3U max-conn=\"3\"\n\
#EXTINF:-1 tvg-id=\"one.fr\" group-title=\"News\",One HD\nhttp://h/live/u/p/101.ts\n\
#EXTINF:-1 tvg-id=\"two.fr\" group-title=\"Sport\",Two\nhttp://h/live/u/p/102.ts\n\
#EXTINF:-1 group-title=\"Films\",A Film\nhttp://h/movie/u/p/200.mp4\n\
#EXTINF:-1 group-title=\"Adult XXX\",Naughty\nhttp://h/live/u/p/103.ts\n";

// ================================================================================================
// sources and their sync

mod sources_sync {
    use super::*;

    #[sqlx::test(migrations = false)]
    async fn a_sync_creates_disabled_channels_and_a_second_one_updates_in_place(pool: PgPool) {
        let c = ctx(pool).await;
        c.prov.lock().unwrap().playlist = PLAYLIST.into();
        let id = source(&c, "S", "m3u", &format!("{}/playlist.m3u", c.base), 0).await;
        let r = sync::sync(&c.st, id).await.unwrap();
        assert_eq!(
            (r.ok, r.added, r.updated, r.removed, r.channel_count),
            (true, 3, 0, 0, 3)
        );
        let (enabled, n): (i64, i64) =
            sqlx::query_as("SELECT count(*) FILTER (WHERE enabled), count(*) FROM livetv_channels")
                .fetch_one(&c.pool)
                .await
                .unwrap();
        assert_eq!(
            (enabled, n),
            (0, 3),
            "an unreviewed playlist never floods the lineup"
        );
        let row: (i32, bool, String) =
            sqlx::query_as(r#"SELECT "maxStreams", "maxStreamsIsManual", "lastSyncStatus" FROM livetv_sources WHERE id = $1"#).bind(id).fetch_one(&c.pool).await.unwrap();
        assert_eq!(
            row,
            (3, false, "ok".into()),
            "the header's max-conn lifts an unset limit"
        );
        let r = sync::sync(&c.st, id).await.unwrap();
        assert_eq!((r.added, r.updated, r.removed), (0, 3, 0));
        assert_eq!(count(&c.pool, "livetv_channels").await, 3);
    }

    #[sqlx::test(migrations = false)]
    async fn a_manual_limit_survives_the_headers_max_conn(pool: PgPool) {
        let c = ctx(pool).await;
        c.prov.lock().unwrap().playlist = PLAYLIST.into();
        let id = source(&c, "S", "m3u", &format!("{}/playlist.m3u", c.base), 1).await;
        sqlx::query(r#"UPDATE livetv_sources SET "maxStreamsIsManual" = true WHERE id = $1"#)
            .bind(id)
            .execute(&c.pool)
            .await
            .unwrap();
        sync::sync(&c.st, id).await.unwrap();
        let max: i32 =
            sqlx::query_scalar(r#"SELECT "maxStreams" FROM livetv_sources WHERE id = $1"#)
                .bind(id)
                .fetch_one(&c.pool)
                .await
                .unwrap();
        assert_eq!(max, 1);
    }

    #[sqlx::test(migrations = false)]
    async fn an_unchanged_etag_is_not_modified_and_leaves_the_lineup(pool: PgPool) {
        let c = ctx(pool).await;
        {
            let mut p = c.prov.lock().unwrap();
            p.playlist = PLAYLIST.into();
            p.etag = Some("\"v1\"");
        }
        let id = source(&c, "S", "m3u", &format!("{}/playlist.m3u", c.base), 0).await;
        sync::sync(&c.st, id).await.unwrap();
        let r = sync::sync(&c.st, id).await.unwrap();
        assert_eq!((r.ok, r.added, r.updated, r.channel_count), (true, 0, 0, 3));
        let etag: Option<String> =
            sqlx::query_scalar(r#"SELECT "playlistEtag" FROM livetv_sources WHERE id = $1"#)
                .bind(id)
                .fetch_one(&c.pool)
                .await
                .unwrap();
        assert_eq!(etag.as_deref(), Some("\"v1\""));
        assert_eq!(c.prov.lock().unwrap().hits.len(), 2);
    }

    #[sqlx::test(migrations = false)]
    async fn a_response_that_lost_most_of_the_lineup_is_refused(pool: PgPool) {
        let c = ctx(pool).await;
        c.prov.lock().unwrap().playlist = PLAYLIST.into();
        let id = source(&c, "S", "m3u", &format!("{}/playlist.m3u", c.base), 0).await;
        sync::sync(&c.st, id).await.unwrap();
        c.prov.lock().unwrap().playlist =
            "#EXTM3U\n#EXTINF:-1,One HD\nhttp://h/live/u/p/101.ts\n".into();
        let r = sync::sync(&c.st, id).await.unwrap();
        assert!(!r.ok && r.channel_count == 3);
        assert!(
            r.error
                .as_deref()
                .unwrap()
                .starts_with("refresh returned 1 live entries against 3 known")
        );
        assert_eq!(count(&c.pool, "livetv_channel_streams").await, 3);
        let status: String =
            sqlx::query_scalar(r#"SELECT "lastSyncStatus" FROM livetv_sources WHERE id = $1"#)
                .bind(id)
                .fetch_one(&c.pool)
                .await
                .unwrap();
        assert_eq!(status, "error");
    }

    #[sqlx::test(migrations = false)]
    async fn a_failed_fetch_records_the_error_without_the_url(pool: PgPool) {
        let c = ctx(pool).await;
        let id = source(
            &c,
            "S",
            "m3u",
            &format!("{}/missing.m3u?password=secret", c.base),
            0,
        )
        .await;
        let r = sync::sync(&c.st, id).await.unwrap();
        assert_eq!(
            r.error.as_deref(),
            Some("Request failed with status code 404")
        );
        let err: Option<String> =
            sqlx::query_scalar(r#"SELECT "lastSyncError" FROM livetv_sources WHERE id = $1"#)
                .bind(id)
                .fetch_one(&c.pool)
                .await
                .unwrap();
        assert!(!err.unwrap().contains("secret"));
    }

    #[sqlx::test(migrations = false)]
    async fn streams_unseen_for_the_window_go_with_their_empty_channels(pool: PgPool) {
        let c = ctx(pool).await;
        c.prov.lock().unwrap().playlist = PLAYLIST.into();
        let id = source(&c, "S", "m3u", &format!("{}/playlist.m3u", c.base), 0).await;
        let old = channel(&c.pool, "Gone", "News", true).await;
        let s = stream(&c.pool, old, id, "http://h/old", 0).await;
        sqlx::query(r#"UPDATE livetv_channel_streams SET "lastSeenAt" = now() - interval '8 days' WHERE id = $1"#).bind(s).execute(&c.pool).await.unwrap();
        let recent = channel(&c.pool, "Recent", "News", true).await;
        stream(&c.pool, recent, id, "http://h/recent", 0).await;
        sqlx::query(r#"UPDATE livetv_channel_streams SET "lastSeenAt" = now() - interval '1 day' WHERE "channelId" = $1"#).bind(recent).execute(&c.pool).await.unwrap();
        let r = sync::sync(&c.st, id).await.unwrap();
        assert_eq!(r.removed, 1);
        let names: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM livetv_channels WHERE name IN ('Gone', 'Recent') ORDER BY name",
        )
        .fetch_all(&c.pool)
        .await
        .unwrap();
        assert_eq!(names, ["Recent"]);
    }

    #[sqlx::test(migrations = false)]
    async fn an_entry_folds_onto_the_first_same_named_channel_of_another_source(pool: PgPool) {
        let c = ctx(pool).await;
        c.prov.lock().unwrap().playlist = PLAYLIST.into();
        let other = source(&c, "Other", "m3u", "http://h/x", 0).await;
        let ch = channel(&c.pool, "Two", "Sport", true).await;
        stream(&c.pool, ch, other, "http://h/two", 0).await;
        let id = source(&c, "S", "m3u", &format!("{}/playlist.m3u", c.base), 0).await;
        let r = sync::sync(&c.st, id).await.unwrap();
        assert_eq!(r.added, 3);
        assert_eq!(
            count(&c.pool, "livetv_channels").await,
            3,
            "Two joined its channel"
        );
        let prio: i32 = sqlx::query_scalar(r#"SELECT priority FROM livetv_channel_streams WHERE "sourceId" = $1 AND "channelId" = $2"#)
            .bind(id)
            .bind(ch)
            .fetch_one(&c.pool)
            .await
            .unwrap();
        assert_eq!(prio, 1);
    }

    #[sqlx::test(migrations = false)]
    async fn the_adult_guard_restricts_a_new_adult_group_and_notifies_the_bridge(pool: PgPool) {
        let c = ctx(pool).await;
        c.prov.lock().unwrap().playlist = PLAYLIST.into();
        let id = source(&c, "S", "m3u", &format!("{}/playlist.m3u", c.base), 0).await;
        sync::sync(&c.st, id).await.unwrap();
        assert_eq!(
            setting(&c.pool, "livetv_restricted_groups")
                .await
                .as_deref(),
            Some(r#"["Adult XXX"]"#)
        );
        assert_eq!(
            setting(&c.pool, "livetv_restricted_groups_exempt")
                .await
                .as_deref(),
            Some("[]")
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_group_no_source_carries_any_more_lapses_after_its_grace_and_loses_its_grants(
        pool: PgPool,
    ) {
        let c = ctx(pool).await;
        c.prov.lock().unwrap().playlist = PLAYLIST.into();
        let id = source(&c, "S", "m3u", &format!("{}/playlist.m3u", c.base), 0).await;
        sqlx::query(r#"INSERT INTO app_settings (key, value) VALUES ('livetv_restricted_groups', '["Vanished"]'), ('livetv_stale_stream_days', '0')"#)
            .execute(&c.pool)
            .await
            .unwrap();
        let u = user(&c.pool, "grantee", false).await;
        sqlx::query(
            r#"INSERT INTO livetv_group_access ("userId", "groupName") VALUES ($1, 'Vanished')"#,
        )
        .bind(u)
        .execute(&c.pool)
        .await
        .unwrap();
        sync::sync(&c.st, id).await.unwrap();
        assert_eq!(
            count(&c.pool, "livetv_group_access").await,
            1,
            "marked absent, not yet expired"
        );
        sync::sync(&c.st, id).await.unwrap();
        assert_eq!(count(&c.pool, "livetv_group_access").await, 0);
        let restricted = setting(&c.pool, "livetv_restricted_groups").await.unwrap();
        assert!(!restricted.contains("Vanished"), "{restricted}");
    }

    #[sqlx::test(migrations = false)]
    async fn two_syncs_of_one_source_do_not_overlap(pool: PgPool) {
        let c = ctx(pool).await;
        {
            let mut p = c.prov.lock().unwrap();
            p.playlist = PLAYLIST.into();
            p.delay_ms = 400;
        }
        let id = source(&c, "S", "m3u", &format!("{}/playlist.m3u", c.base), 0).await;
        let st = c.st.clone();
        let first = tokio::spawn(async move { sync::sync(&st, id).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(matches!(
            sync::sync(&c.st, id).await,
            Err(sync::SyncError::Running)
        ));
        assert!(first.await.unwrap().unwrap().ok);
        assert!(
            sync::sync(&c.st, id).await.is_ok(),
            "the claim is released with the sync"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn an_xtream_sync_dedupes_ids_and_stores_no_guide_url(pool: PgPool) {
        let c = ctx(pool).await;
        let api = Router::new().route(
            "/player_api.php",
            get(|req: Request| async move {
                let q = req.uri().query().unwrap_or_default().to_owned();
                if q.contains("get_live_categories") {
                    axum::Json(json!([{"category_id": "1", "category_name": "News"}]))
                } else if q.contains("get_live_streams") {
                    axum::Json(json!([
                        {"stream_id": 1, "name": "One", "category_id": "1"},
                        {"stream_id": 1, "name": "One again", "category_id": "1"},
                        {"stream_id": 2, "name": "Two", "category_id": "1", "direct_source": "http://cdn/two.m3u8"}
                    ]))
                } else {
                    axum::Json(json!({"user_info": {"auth": 1, "status": "Active", "exp_date": "4102444800", "max_connections": "2", "allowed_output_formats": ["m3u8"]}}))
                }
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, api).await.unwrap() });
        let id = source(&c, "X", "xtream", &base, 0).await;
        sqlx::query("UPDATE livetv_sources SET username = 'u', password = 'p' WHERE id = $1")
            .bind(id)
            .execute(&c.pool)
            .await
            .unwrap();
        let r = sync::sync(&c.st, id).await.unwrap();
        assert_eq!((r.ok, r.added), (true, 2));
        let urls: Vec<String> =
            sqlx::query_scalar("SELECT url FROM livetv_channel_streams ORDER BY id")
                .fetch_all(&c.pool)
                .await
                .unwrap();
        assert_eq!(
            urls,
            [
                format!("{base}/live/u/p/1.m3u8"),
                "http://cdn/two.m3u8".to_owned()
            ]
        );
        let (guide, max, status): (Value, i32, Option<String>) =
            sqlx::query_as(r#"SELECT "guideUrls", "maxStreams", "accountStatus" FROM livetv_sources WHERE id = $1"#).bind(id).fetch_one(&c.pool).await.unwrap();
        assert_eq!(
            (guide, max, status.as_deref()),
            (json!([]), 2, Some("Active"))
        );
    }

    #[sqlx::test(migrations = false)]
    async fn the_probe_reads_a_lineup_and_suggests_the_panel_behind_an_uploaded_file(pool: PgPool) {
        let c = ctx(pool).await;
        c.prov.lock().unwrap().playlist = PLAYLIST.into();
        let mut suggestion = None;
        let url = format!("{}/playlist.m3u", c.base);
        let who: sources::Who = (None, None, None, None, None);
        let v = sources::probe(
            &c.st,
            "m3u",
            &url,
            who,
            (None, Some("^films$".into())),
            &mut suggestion,
            false,
        )
        .await
        .unwrap();
        assert_eq!(
            (
                v["ok"].clone(),
                v["channelCount"].clone(),
                v["onDemandCount"].clone()
            ),
            (json!(true), json!(3), json!(1))
        );
        assert_eq!(v["maxConnections"], 3);
        assert!(v["playlistUrlFromFile"].is_null() && suggestion.is_none());
        let bad = sources::probe(
            &c.st,
            "m3u",
            &url,
            (None, None, None, None, None),
            (Some("(".into()), None),
            &mut suggestion,
            false,
        )
        .await;
        assert!(
            bad.unwrap_err()
                .starts_with("includeGroupsPattern is not a valid regular expression:")
        );
    }

    #[sqlx::test(migrations = false)]
    async fn the_probe_refuses_a_loopback_provider_through_the_route(pool: PgPool) {
        let c = ctx(pool).await;
        let (_, admin) = viewer(&c, "boss", true).await;
        let body = json!({"kind": "m3u", "url": format!("{}/playlist.m3u", c.base)});
        let (s, b) = call(
            &c.app,
            "POST",
            "/api/livetv/admin/sources/test",
            &admin,
            Some(body),
        )
        .await;
        assert_eq!(s, 201);
        assert_eq!(b["ok"], false);
        assert!(
            b["error"]
                .as_str()
                .unwrap()
                .starts_with("Refused: \"127.0.0.1\" resolves to an internal address"),
            "{b}"
        );
        assert_eq!(c.prov.lock().unwrap().hits.len(), 0, "nothing was fetched");
    }

    #[sqlx::test(migrations = false)]
    async fn the_probe_password_falls_back_to_the_stored_one_for_the_same_kind_and_url(
        pool: PgPool,
    ) {
        let c = ctx(pool).await;
        let id = source(&c, "X", "xtream", "http://panel", 0).await;
        sqlx::query("UPDATE livetv_sources SET password = 'stored' WHERE id = $1")
            .bind(id)
            .execute(&c.pool)
            .await
            .unwrap();
        let get = |kind: &'static str, url: &'static str, given: Option<&'static str>| {
            let pool = c.pool.clone();
            async move {
                super::sources::test_password(
                    &pool,
                    Some(i64::from(id)),
                    kind,
                    url,
                    &given.map(String::from),
                )
                .await
                .unwrap()
            }
        };
        assert_eq!(
            get("xtream", "http://panel", None).await.as_deref(),
            Some("stored")
        );
        assert_eq!(
            get("xtream", "http://panel", Some("")).await.as_deref(),
            Some("stored")
        );
        assert_eq!(
            get("xtream", "http://panel", Some("typed"))
                .await
                .as_deref(),
            Some("typed")
        );
        assert_eq!(get("m3u", "http://panel", None).await, None);
        assert_eq!(
            get("xtream", "http://other", Some("x")).await.as_deref(),
            Some("x")
        );
    }

    fn multipart(field: &str, name: &str, content: &[u8]) -> (String, Vec<u8>) {
        let boundary = "xBOUNDARYx";
        let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{name}\"\r\nContent-Type: audio/mpegurl\r\n\r\n").into_bytes();
        body.extend_from_slice(content);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        (format!("multipart/form-data; boundary={boundary}"), body)
    }

    async fn upload(c: &Ctx, token: &str, field: &str, name: &str, content: &[u8]) -> (u16, Value) {
        let (ct, body) = multipart(field, name, content);
        let req = Request::builder()
            .method("POST")
            .uri("/api/livetv/admin/sources/playlist")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", ct)
            .body(Body::from(body))
            .unwrap();
        let res = c.app.clone().oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[sqlx::test(migrations = false)]
    async fn an_uploaded_playlist_is_stored_checked_synced_and_removed_with_its_source(
        pool: PgPool,
    ) {
        let c = ctx(pool).await;
        let (_, admin) = viewer(&c, "boss", true).await;
        let (s, b) = upload(&c, &admin, "file", "My List (1).m3u", PLAYLIST.as_bytes()).await;
        assert_eq!(s, 201, "{b}");
        let loc = b["location"].as_str().unwrap().to_owned();
        assert!(
            loc.contains("/livetv/playlists/My-List-1-") && loc.ends_with(".m3u"),
            "{loc}"
        );
        assert!(tokio::fs::metadata(&loc).await.is_ok());
        for (field, name, body, msg) in [
            (
                "file",
                "x.txt",
                &b"hello"[..],
                "That file is not an extended M3U playlist",
            ),
            ("file", "x.m3u", &b""[..], "No playlist uploaded"),
            (
                "other",
                "x.m3u",
                PLAYLIST.as_bytes(),
                "Unexpected field - other",
            ),
        ] {
            let (s, b) = upload(&c, &admin, field, name, body).await;
            assert_eq!(
                (s, b["message"].as_str()),
                (400, Some(msg)),
                "{field} {name}"
            );
        }
        let (s, created) = call(
            &c.app,
            "POST",
            "/api/livetv/admin/sources",
            &admin,
            Some(json!({"name": "U", "kind": "m3u", "url": loc})),
        )
        .await;
        assert_eq!(s, 201, "{created}");
        let id = created["id"].as_i64().unwrap() as i32;
        let r = sync::sync(&c.st, id).await.unwrap();
        assert_eq!((r.ok, r.added), (true, 3));
        let again = sync::sync(&c.st, id).await.unwrap();
        assert_eq!(
            (again.ok, again.updated),
            (true, 0),
            "an untouched file is not modified"
        );
        let (s, _) = call(
            &c.app,
            "DELETE",
            &format!("/api/livetv/admin/sources/{id}"),
            &admin,
            None,
        )
        .await;
        assert_eq!(s, 200);
        assert!(
            tokio::fs::metadata(&loc).await.is_err(),
            "the file goes with its source"
        );
        assert_eq!(
            count(&c.pool, "livetv_channels").await,
            0,
            "so do the channels it alone fed"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_typed_file_path_is_never_read(pool: PgPool) {
        let c = ctx(pool).await;
        let id = source(&c, "S", "m3u", "/etc/passwd", 0).await;
        let r = sync::sync(&c.st, id).await.unwrap();
        assert_eq!(r.error.as_deref(), Some("Not an uploaded playlist"));
    }
}

// ================================================================================================
// the guide

mod guide_import {
    use super::*;

    const FEED: &str = r#"<tv>
<channel id="one.fr"><display-name>One</display-name></channel>
<channel id="two.fr"><display-name>Two</display-name></channel>
<programme start="{A}" stop="{B}" channel="one.fr"><title>Now One</title></programme>
<programme start="{B}" stop="{C}" channel="one.fr"><title>Later One</title></programme>
<programme start="{A}" stop="{B}" channel="two.fr"><title>Now Two</title></programme>
</tv>"#;

    fn stamp(offset_minutes: i64) -> String {
        (chrono::Utc::now() + chrono::Duration::minutes(offset_minutes))
            .format("%Y%m%d%H%M%S +0000")
            .to_string()
    }

    fn feed() -> Vec<u8> {
        FEED.replace("{A}", &stamp(-30))
            .replace("{B}", &stamp(60))
            .replace("{C}", &stamp(180))
            .into_bytes()
    }

    async fn guide_source(c: &Ctx, name: &str, path: &str) -> i32 {
        sqlx::query_scalar(r#"INSERT INTO livetv_guide_sources (name, kind, url) VALUES ($1, 'xmltv', $2) RETURNING id"#)
            .bind(name)
            .bind(format!("{}{path}", c.base))
            .fetch_one(&c.pool)
            .await
            .unwrap()
    }

    async fn lineup(c: &Ctx) {
        for (name, guide) in [("One", "one.fr"), ("Two", "two.fr")] {
            let id = channel(&c.pool, name, "News", true).await;
            sqlx::query(r#"UPDATE livetv_channels SET "guideChannelId" = $1, "guideMatchKind" = 'id' WHERE id = $2"#).bind(guide).bind(id).execute(&c.pool).await.unwrap();
        }
    }

    async fn titles(pool: &PgPool, source: i32) -> Vec<String> {
        sqlx::query_scalar(
            r#"SELECT title FROM livetv_programs WHERE "guideSourceId" = $1 ORDER BY title"#,
        )
        .bind(source)
        .fetch_all(pool)
        .await
        .unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn a_sync_stores_the_wanted_programmes_and_matches_the_lineup(pool: PgPool) {
        let c = ctx(pool).await;
        lineup(&c).await;
        let extra = channel(&c.pool, "Unwanted", "News", false).await;
        c.prov.lock().unwrap().guide = feed();
        let g = guide_source(&c, "A", "/guide.xml").await;
        let r = guide::sync(&c.st, g).await.unwrap();
        assert_eq!((r.ok, r.program_count, r.channels_touched), (true, 3, 2));
        assert_eq!(
            titles(&c.pool, g).await,
            ["Later One", "Now One", "Now Two"]
        );
        let feed_channels: i64 = sqlx::query_scalar(
            r#"SELECT count(*) FROM livetv_guide_channels WHERE "guideSourceId" = $1"#,
        )
        .bind(g)
        .fetch_one(&c.pool)
        .await
        .unwrap();
        assert_eq!(feed_channels, 2);
        let kind: Option<String> =
            sqlx::query_scalar(r#"SELECT "guideMatchKind" FROM livetv_channels WHERE id = $1"#)
                .bind(extra)
                .fetch_one(&c.pool)
                .await
                .unwrap();
        assert!(kind.is_none());
    }

    #[sqlx::test(migrations = false)]
    async fn a_resync_replaces_its_own_rows_and_leaves_a_sibling_alone(pool: PgPool) {
        let c = ctx(pool).await;
        lineup(&c).await;
        c.prov.lock().unwrap().guide = feed();
        let a = guide_source(&c, "A", "/guide.xml").await;
        let b = guide_source(&c, "B", "/guide.xml").await;
        guide::sync(&c.st, a).await.unwrap();
        guide::sync(&c.st, b).await.unwrap();
        guide::sync(&c.st, a).await.unwrap();
        assert_eq!(
            (
                titles(&c.pool, a).await.len(),
                titles(&c.pool, b).await.len()
            ),
            (3, 3)
        );
        assert_eq!(count(&c.pool, "livetv_programs").await, 6);
    }

    #[sqlx::test(migrations = false)]
    async fn a_feed_that_breaks_midway_keeps_the_previous_programmes(pool: PgPool) {
        let c = ctx(pool).await;
        lineup(&c).await;
        let ok_feed = feed();
        c.prov.lock().unwrap().guide = ok_feed.clone();
        let g = guide_source(&c, "A", "/guide.xml").await;
        guide::sync(&c.st, g).await.unwrap();
        {
            let mut p = c.prov.lock().unwrap();
            p.guide = ok_feed.clone();
            p.cut_guide_at = Some(ok_feed.len() - 40);
        }
        let r = guide::sync(&c.st, g).await.unwrap();
        assert!(!r.ok && r.error.is_some(), "{r:?}");
        assert_eq!(
            titles(&c.pool, g).await,
            ["Later One", "Now One", "Now Two"],
            "the transaction rolled back"
        );
        let (status, count): (String, i32) = sqlx::query_as(
            r#"SELECT "lastSyncStatus", "programCount" FROM livetv_guide_sources WHERE id = $1"#,
        )
        .bind(g)
        .fetch_one(&c.pool)
        .await
        .unwrap();
        assert_eq!((status.as_str(), count), ("error", 3));
    }

    #[sqlx::test(migrations = false)]
    async fn a_gzip_feed_reads_like_a_plain_one(pool: PgPool) {
        let c = ctx(pool).await;
        lineup(&c).await;
        {
            let mut p = c.prov.lock().unwrap();
            p.guide = feed();
            p.gzip_guide = true;
        }
        let g = guide_source(&c, "Z", "/guide.xml").await;
        let r = guide::sync(&c.st, g).await.unwrap();
        assert_eq!((r.ok, r.program_count), (true, 3));
    }

    #[sqlx::test(migrations = false)]
    async fn an_empty_feed_is_an_error_and_a_channel_only_one_is_not(pool: PgPool) {
        let c = ctx(pool).await;
        lineup(&c).await;
        c.prov.lock().unwrap().guide = b"<tv></tv>".to_vec();
        let g = guide_source(&c, "E", "/guide.xml").await;
        let r = guide::sync(&c.st, g).await.unwrap();
        assert_eq!(r.error.as_deref(), Some("empty guide feed"));
        c.prov.lock().unwrap().guide =
            br#"<tv><channel id="one.fr"><display-name>One</display-name></channel></tv>"#.to_vec();
        let r = guide::sync(&c.st, g).await.unwrap();
        assert_eq!((r.ok, r.program_count), (true, 0));
    }

    #[sqlx::test(migrations = false)]
    async fn a_disabled_channels_programmes_are_never_stored(pool: PgPool) {
        let c = ctx(pool).await;
        lineup(&c).await;
        sqlx::query("UPDATE livetv_channels SET enabled = false WHERE name = 'Two'")
            .execute(&c.pool)
            .await
            .unwrap();
        c.prov.lock().unwrap().guide = feed();
        let g = guide_source(&c, "A", "/guide.xml").await;
        guide::sync(&c.st, g).await.unwrap();
        assert_eq!(titles(&c.pool, g).await, ["Later One", "Now One"]);
    }

    #[sqlx::test(migrations = false)]
    async fn the_shift_applies_after_the_window_test(pool: PgPool) {
        let c = ctx(pool).await;
        lineup(&c).await;
        sqlx::query(r#"UPDATE livetv_channels SET "guideShiftMinutes" = 60 WHERE name = 'One'"#)
            .execute(&c.pool)
            .await
            .unwrap();
        c.prov.lock().unwrap().guide = feed();
        let g = guide_source(&c, "A", "/guide.xml").await;
        guide::sync(&c.st, g).await.unwrap();
        let mins: f64 = sqlx::query_scalar(
            r#"SELECT (extract(epoch FROM ("endsAt" - "startsAt")) / 60)::float8 FROM livetv_programs WHERE title = 'Now One'"#,
        )
        .fetch_one(&c.pool)
        .await
        .unwrap();
        assert_eq!(mins.round(), 90.0);
        let shifted: bool = sqlx::query_scalar(r#"SELECT "startsAt" > now() + interval '20 minutes' FROM livetv_programs WHERE title = 'Now One'"#).fetch_one(&c.pool).await.unwrap();
        assert!(shifted);
    }

    #[sqlx::test(migrations = false)]
    async fn a_second_sync_while_one_runs_is_refused(pool: PgPool) {
        let c = ctx(pool).await;
        {
            let mut p = c.prov.lock().unwrap();
            p.guide = feed();
            p.delay_ms = 400;
        }
        let g = guide_source(&c, "A", "/guide.xml").await;
        let st = c.st.clone();
        let first = tokio::spawn(async move { guide::sync(&st, g).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(matches!(
            guide::sync(&c.st, g).await,
            Err(sync::SyncError::Running)
        ));
        assert!(first.await.unwrap().unwrap().ok);
    }

    #[sqlx::test(migrations = false)]
    async fn a_kind_source_feed_uses_the_parents_guide_and_agent(pool: PgPool) {
        let c = ctx(pool).await;
        lineup(&c).await;
        c.prov.lock().unwrap().guide = feed();
        let parent = source(&c, "P", "m3u", "http://h/x", 0).await;
        sqlx::query(r#"UPDATE livetv_sources SET "guideUrls" = $2, "userAgent" = 'ParentAgent/1' WHERE id = $1"#)
            .bind(parent)
            .bind(json!([format!("{}/guide.xml", c.base)]))
            .execute(&c.pool)
            .await
            .unwrap();
        let g: i32 = sqlx::query_scalar(r#"INSERT INTO livetv_guide_sources (name, kind, "sourceId") VALUES ('K', 'source', $1) RETURNING id"#)
            .bind(parent)
            .fetch_one(&c.pool)
            .await
            .unwrap();
        let r = guide::sync(&c.st, g).await.unwrap();
        assert!(r.ok, "{r:?}");
        assert_eq!(
            c.prov.lock().unwrap().agents.last().map(String::as_str),
            Some("ParentAgent/1")
        );
        let none: i32 = sqlx::query_scalar(
            r#"INSERT INTO livetv_guide_sources (name, kind) VALUES ('N', 'source') RETURNING id"#,
        )
        .fetch_one(&c.pool)
        .await
        .unwrap();
        let r = guide::sync(&c.st, none).await.unwrap();
        assert_eq!(
            r.error.as_deref(),
            Some("Guide source has no parent Live TV source")
        );
    }

    #[sqlx::test(migrations = false)]
    async fn prune_removes_both_sides_of_the_window(pool: PgPool) {
        let c = ctx(pool).await;
        let g: i32 = sqlx::query_scalar(
            r#"INSERT INTO livetv_guide_sources (name, kind) VALUES ('P', 'xmltv') RETURNING id"#,
        )
        .fetch_one(&c.pool)
        .await
        .unwrap();
        for (title, from, to) in [
            ("past", "-5 days", "-4 days"),
            ("now", "-1 hour", "1 hour"),
            ("future", "10 days", "11 days"),
        ] {
            sqlx::query(r#"INSERT INTO livetv_programs ("guideSourceId", "guideChannelId", "startsAt", "endsAt", title) VALUES ($1, 'x', now() + $2::interval, now() + $3::interval, $4)"#)
                .bind(g)
                .bind(from)
                .bind(to)
                .bind(title)
                .execute(&c.pool)
                .await
                .unwrap();
        }
        assert_eq!(guide::prune(&c.pool).await.unwrap(), 2);
        assert_eq!(titles(&c.pool, g).await, ["now"]);
    }
}

// ================================================================================================
// sessions over a fake engine

mod sessions {
    use super::*;
    use session::{Caps, Who};

    /// The engine echoes the request's token unless the open joined a running session.
    const SELF: &str = "$capacityToken";

    fn token_of(w: &World, n: usize) -> String {
        w.c.fake.seen("POST", "/v1/live")[n].body["capacityToken"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn open_answer(sid: &str, token: &str, mode: &str) -> Value {
        json!({"sessionId": sid, "playPath": format!("/api/livetv/sessions/{sid}/index.m3u8"), "mode": mode, "upstream": 0,
               "capacityToken": token, "dvrWindowSeconds": 900.0, "segmentSeconds": 2.0, "qoePipeline": {}})
    }

    fn snapshot(sid: &str, channel: i32, owner: i32, token: &str, url: &str, mode: &str) -> Value {
        json!({"sessionId": sid, "channelId": channel.to_string(), "ownerId": owner.to_string(),
               "tags": {"channelName": "A", "username": "u", "device": "ua"}, "mode": mode, "capacityToken": token,
               "upstream": 0, "upstreamUrl": url, "upstreamPriority": 0, "openedAtMs": 1.0, "lastSeenMs": 1.0,
               "container": "fmp4", "viewersOnUpstream": 1, "restarts": 0})
    }

    struct World {
        c: Ctx,
        who: Who,
        a: i32,
        b: i32,
        s1: i32,
        src1: i32,
    }

    /// Channels A and B on one source with a limit of one connection; the owner is a `livetv.read` user.
    async fn world(pool: PgPool) -> World {
        let c = ctx(pool).await;
        let (uid, _) = viewer(&c, "owner", false).await;
        let src1 = source(&c, "S1", "m3u", "http://h/x", 1).await;
        let a = channel(&c.pool, "A", "Live", true).await;
        let b = channel(&c.pool, "B", "Live", true).await;
        let s1 = stream(&c.pool, a, src1, "http://h/a.ts", 0).await;
        stream(&c.pool, b, src1, "http://h/b.ts", 0).await;
        World {
            c,
            who: Who {
                id: uid,
                username: "owner".into(),
            },
            a,
            b,
            s1,
            src1,
        }
    }

    async fn open(
        w: &World,
        channel: i32,
        name: &str,
    ) -> Result<session::Opened, session::PlayError> {
        let streams = session::load_streams(&w.c.pool, channel, true)
            .await
            .unwrap();
        session::open(
            &w.c.st,
            channel,
            name,
            streams,
            &w.who,
            Caps::default(),
            Some("ua".into()),
        )
        .await
    }

    fn err_body(e: session::PlayError) -> (u16, Value) {
        match e {
            session::PlayError::Object(s, v) => (s.as_u16(), v),
            session::PlayError::App(a) => {
                let r = a.into_response();
                (r.status().as_u16(), Value::Null)
            }
        }
    }

    #[sqlx::test(migrations = false)]
    async fn an_open_sends_the_sorted_upstreams_with_the_sources_headers_and_registers_the_viewer(
        pool: PgPool,
    ) {
        let w = world(pool).await;
        let c = &w.c;
        stream(&c.pool, w.a, w.src1, "http://h/a2.ts", 0).await;
        sqlx::query(r#"UPDATE livetv_sources SET "userAgent" = 'SrcAgent/1', referer = 'http://ref/' WHERE id = $1"#).bind(w.src1).execute(&c.pool).await.unwrap();
        sqlx::query(r#"UPDATE livetv_channel_streams SET "userAgent" = 'EntryAgent/1', "probedVideoCodec" = 'h264' WHERE url = 'http://h/a2.ts'"#).execute(&c.pool).await.unwrap();
        sqlx::query(r#"UPDATE livetv_channel_streams SET "lastError" = 'boom' WHERE id = $1"#)
            .bind(w.s1)
            .execute(&c.pool)
            .await
            .unwrap();
        c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("sid-1", SELF, "remux"))],
        );
        let o = open(&w, w.a, "A")
            .await
            .unwrap_or_else(|e| panic!("{:?}", err_body(e)));
        assert_eq!(
            (o.session_id.as_str(), o.mode),
            ("sid-1", fliks_engine_core::api::LiveMode::Remux)
        );
        let sent = &c.fake.seen("POST", "/v1/live")[0].body;
        assert_eq!(sent["channelId"], w.a.to_string());
        assert_eq!(sent["ownerId"], w.who.id.to_string());
        assert_eq!(sent["atCapacity"], false);
        assert_eq!(
            sent["tags"],
            json!({"channelName": "A", "username": "owner", "device": "ua"})
        );
        let ups = sent["upstreams"].as_array().unwrap();
        assert_eq!(
            ups[0]["url"], "http://h/a2.ts",
            "a stream with an error sorts after a clean one"
        );
        assert_eq!(
            ups[0]["headers"],
            json!({"User-Agent": "EntryAgent/1", "Referer": "http://ref/"}),
            "the entry's agent wins (C140)"
        );
        assert_eq!(ups[0]["probedVideoCodec"], "h264");
        assert_eq!(
            ups[1]["headers"],
            json!({"User-Agent": "SrcAgent/1", "Referer": "http://ref/"})
        );
        let (viewers, holds) = session::peek(&c.st);
        assert_eq!((viewers, holds.len()), (vec!["sid-1".to_owned()], 1));
        assert!(
            c.st.hub
                .activity()
                .list(1, 10)
                .data
                .iter()
                .any(|r| r.entry.id.starts_with("livetv:"))
        );
    }

    #[sqlx::test(migrations = false)]
    async fn an_open_dropped_mid_call_gives_its_hold_back(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        c.fake.script(
            "POST",
            "/v1/live",
            vec![crate::engine::testkit::slow(
                2000,
                ok(open_answer("sid-1", SELF, "remux")),
            )],
        );
        let dropped = tokio::time::timeout(Duration::from_millis(300), open(&w, w.a, "A")).await;
        assert!(dropped.is_err(), "the open is still waiting for the engine");
        assert!(
            session::peek(&c.st).1.is_empty(),
            "the pending hold went with the cancelled request"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn the_default_agent_goes_out_when_nobody_sets_one(pool: PgPool) {
        let w = world(pool).await;
        w.c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("sid-1", SELF, "remux"))],
        );
        open(&w, w.b, "B").await.map_err(err_body).unwrap();
        let sent = &w.c.fake.seen("POST", "/v1/live")[0].body;
        assert_eq!(
            sent["upstreams"][0]["headers"],
            json!({"User-Agent": "VLC/3.0.20 LibVLC/3.0.20"})
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_second_open_at_the_limit_is_flagged_and_an_engine_409_becomes_the_body(
        pool: PgPool,
    ) {
        let w = world(pool).await;
        let c = &w.c;
        c.fake.script(
            "POST",
            "/v1/live",
            vec![
                ok(open_answer("sid-1", SELF, "remux")),
                coded(409, "live_at_capacity"),
            ],
        );
        open(&w, w.a, "A").await.map_err(err_body).unwrap();
        let (s, body) = open(&w, w.b, "B")
            .await
            .map(|_| ())
            .map_err(err_body)
            .unwrap_err();
        assert_eq!(
            (s, body),
            (
                409,
                json!({"code": "livetv_source_at_capacity", "sourceName": "S1", "limit": 1})
            )
        );
        let sent = c.fake.seen("POST", "/v1/live");
        assert_eq!(sent[1].body["atCapacity"], true);
        assert_eq!(sent[1].body["upstreams"][0]["atCapacity"], true);
        let (_, holds) = session::peek(&c.st);
        assert_eq!(holds.len(), 1, "the refused open gave its hold back");
    }

    #[sqlx::test(migrations = false)]
    async fn each_upstream_carries_its_own_sources_verdict(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        let free = source(c, "S2", "m3u", "http://h/y", 0).await;
        let both = channel(&c.pool, "C", "Live", true).await;
        stream(&c.pool, both, free, "http://h/c0.ts", 0).await;
        stream(&c.pool, both, w.src1, "http://h/c1.ts", 1).await;
        c.fake.script(
            "POST",
            "/v1/live",
            vec![
                ok(open_answer("sid-1", SELF, "remux")),
                ok(open_answer("sid-2", SELF, "remux")),
            ],
        );
        open(&w, w.a, "A").await.map_err(err_body).unwrap();
        open(&w, both, "C").await.map_err(err_body).unwrap();
        let sent = &c.fake.seen("POST", "/v1/live")[1].body;
        assert_eq!(sent["atCapacity"], false);
        let flags: Vec<_> = sent["upstreams"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u["atCapacity"].as_bool().unwrap_or(false))
            .collect();
        assert_eq!(flags, [false, true]);
        let (_, holds) = session::peek(&c.st);
        let t = token_of(&w, 1);
        let hold = holds.iter().find(|h| h.0 == t).unwrap();
        assert_eq!(hold.1, free, "the hold sits on the first unvetoed source");
    }

    #[sqlx::test(migrations = false)]
    async fn an_open_that_joined_a_running_session_frees_its_hold_at_once(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("sid-1", SELF, "remux"))],
        );
        open(&w, w.a, "A").await.map_err(err_body).unwrap();
        let t1 = token_of(&w, 0);
        c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("sid-2", &t1, "remux"))],
        );
        open(&w, w.a, "A").await.map_err(err_body).unwrap();
        let (viewers, holds) = session::peek(&c.st);
        assert_eq!((viewers.len(), holds.len()), (2, 1));
        assert_eq!(holds[0].0, t1);
        // The joined open took no capacity: a release of the shared hold starts one grace, not two.
        session::on_event(
            &c.st,
            &EngineEvent::LiveReleased {
                capacity_token: t1,
                reason: "idle".into(),
            },
        )
        .await;
        assert!(session::peek(&c.st).1.is_empty());
    }

    #[sqlx::test(migrations = false)]
    async fn a_dead_channel_is_unavailable_counted_and_its_slot_graced(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        c.fake.script(
            "POST",
            "/v1/live",
            vec![
                coded(503, "live_unavailable"),
                coded(409, "live_at_capacity"),
            ],
        );
        let (s, body) = open(&w, w.a, "A")
            .await
            .map(|_| ())
            .map_err(err_body)
            .unwrap_err();
        assert_eq!(
            (s, body),
            (
                503,
                json!({"code": "livetv_channel_unavailable", "channelName": "A"})
            )
        );
        let (failures, at): (i32, Option<chrono::DateTime<chrono::Utc>>) = sqlx::query_as(
            r#"SELECT "consecutiveFailures", "lastErrorAt" FROM livetv_channels WHERE id = $1"#,
        )
        .bind(w.a)
        .fetch_one(&c.pool)
        .await
        .unwrap();
        assert_eq!(failures, 1);
        assert!(at.is_some());
        // The provider counts the connection that never came up for the grace: B on the same source is refused.
        let (s, body) = open(&w, w.b, "B")
            .await
            .map(|_| ())
            .map_err(err_body)
            .unwrap_err();
        assert_eq!(
            (s, body["code"].clone()),
            (409, json!("livetv_source_at_capacity"))
        );
        assert_eq!(c.fake.seen("POST", "/v1/live").len(), 2);
    }

    #[sqlx::test(migrations = false)]
    async fn an_expired_account_is_named_and_any_other_refusal_is_a_502(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        sqlx::query(r#"UPDATE livetv_sources SET "accountStatus" = 'Expired' WHERE id = $1"#)
            .bind(w.src1)
            .execute(&c.pool)
            .await
            .unwrap();
        c.fake
            .script("POST", "/v1/live", vec![coded(503, "live_unavailable")]);
        let (s, body) = open(&w, w.a, "A")
            .await
            .map(|_| ())
            .map_err(err_body)
            .unwrap_err();
        assert_eq!(
            (s, body),
            (
                503,
                json!({"code": "livetv_account_expired", "channelName": "A", "sourceName": "S1"})
            )
        );
        sqlx::query(r#"UPDATE livetv_sources SET "accountStatus" = NULL WHERE id = $1"#)
            .bind(w.src1)
            .execute(&c.pool)
            .await
            .unwrap();
        c.fake.script("POST", "/v1/live", vec![status(400)]);
        let (s, _) = open(&w, w.b, "B")
            .await
            .map(|_| ())
            .map_err(err_body)
            .unwrap_err();
        assert_eq!(s, 502);
        assert!(
            session::peek(&c.st).1.iter().all(|h| !h.2),
            "no hold stays pending"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_channel_without_a_stream_on_an_enabled_source_is_unavailable_without_an_engine_call(
        pool: PgPool,
    ) {
        let w = world(pool).await;
        let c = &w.c;
        sqlx::query("UPDATE livetv_sources SET enabled = false WHERE id = $1")
            .bind(w.src1)
            .execute(&c.pool)
            .await
            .unwrap();
        let streams = session::load_streams(&c.pool, w.a, true).await.unwrap();
        assert!(streams.is_empty());
        let e = session::open(&c.st, w.a, "A", streams, &w.who, Caps::default(), None)
            .await
            .map(|_| ())
            .map_err(err_body)
            .unwrap_err();
        assert_eq!(e.0, 503);
        assert!(c.fake.seen("POST", "/v1/live").is_empty());
    }

    async fn opened(w: &World) -> (String, String) {
        w.c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("sid-1", SELF, "remux"))],
        );
        open(w, w.a, "A").await.map_err(err_body).unwrap();
        ("sid-1".into(), token_of(w, 0))
    }

    fn attempt(token: &str, url: &str, error: Option<&str>) -> EngineEvent {
        serde_json::from_value(json!({"type": "LiveAttempt", "capacityToken": token, "upstream": 0, "upstreamUrl": url,
            "upstreamPriority": 0, "error": error, "probe": {"videoCodec": "h264", "container": "mpegts"}}))
        .unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn an_attempt_moves_the_hold_to_the_feeding_source_and_patches_the_stream(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        let other = source(c, "S2", "m3u", "http://h/y", 0).await;
        stream(&c.pool, w.a, other, "http://h/a-backup.ts", 1).await;
        let (_, token) = opened(&w).await;
        session::on_event(&c.st, &serde_json::from_value(json!({"type": "LiveAttempt", "capacityToken": token, "upstream": 1,
            "upstreamUrl": "http://h/a-backup.ts", "upstreamPriority": 1, "error": null, "probe": {"videoCodec": "h264", "container": "mpegts"}})).unwrap()).await;
        let (_, holds) = session::peek(&c.st);
        assert_eq!(
            holds.iter().find(|h| h.0 == token).map(|h| h.1),
            Some(other)
        );
        let row: (Option<String>, Option<String>, bool) = sqlx::query_as(
            r#"SELECT "probedVideoCodec", "probedContainer", "lastOkAt" IS NOT NULL FROM livetv_channel_streams WHERE url = 'http://h/a-backup.ts'"#,
        )
        .fetch_one(&c.pool)
        .await
        .unwrap();
        assert_eq!(row, (Some("h264".into()), Some("mpegts".into()), true));
    }

    #[sqlx::test(migrations = false)]
    async fn a_failed_attempt_records_the_error_and_starts_the_grace_only_for_the_feeding_upstream(
        pool: PgPool,
    ) {
        let w = world(pool).await;
        let c = &w.c;
        let (_, t1) = opened(&w).await;
        session::on_event(
            &c.st,
            &attempt(&t1, "http://h/a.ts", Some("connection reset")),
        )
        .await;
        let err: Option<String> =
            sqlx::query_scalar("SELECT \"lastError\" FROM livetv_channel_streams WHERE id = $1")
                .bind(w.s1)
                .fetch_one(&c.pool)
                .await
                .unwrap();
        assert_eq!(err.as_deref(), Some("connection reset"));
        // Not feeding yet: no grace, so B (same source, limit 1) still counts only the hold.
        session::on_event(&c.st, &attempt(&t1, "http://h/a.ts", None)).await;
        session::on_event(&c.st, &attempt(&t1, "http://h/a.ts", Some("stalled"))).await;
        let (_, holds) = session::peek(&c.st);
        assert_eq!(holds.len(), 1);
        sqlx::query(r#"UPDATE livetv_sources SET "accountStatus" = 'Expired' WHERE id = $1"#)
            .bind(w.src1)
            .execute(&c.pool)
            .await
            .unwrap();
        // A fresh open reloads the source, so the expired account is read on the next failure.
        c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("sid-9", SELF, "remux"))],
        );
        open(&w, w.b, "B").await.map_err(err_body).unwrap();
        let t9 = token_of(&w, 1);
        session::on_event(&c.st, &attempt(&t9, "http://h/b.ts", Some("denied"))).await;
        let err: Option<String> = sqlx::query_scalar(
            "SELECT \"lastError\" FROM livetv_channel_streams WHERE url = 'http://h/b.ts'",
        )
        .fetch_one(&c.pool)
        .await
        .unwrap();
        assert_eq!(err.as_deref(), Some("account expired"));
    }

    #[sqlx::test(migrations = false)]
    async fn the_next_open_sends_the_probe_the_last_attempt_learned(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        let (_, t1) = opened(&w).await;
        let first = &c.fake.seen("POST", "/v1/live")[0].body["upstreams"][0];
        assert!(first.get("probedVideoCodec").is_none_or(Value::is_null));
        let ev = serde_json::from_value(
            json!({"type": "LiveAttempt", "capacityToken": t1, "upstream": 0,
            "upstreamUrl": "http://h/a.ts", "upstreamPriority": 0,
            "probe": {"videoCodec": "h264", "audioCodec": "aac", "container": "mpegts"}}),
        )
        .unwrap();
        session::on_event(&c.st, &ev).await;
        c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("sid-2", SELF, "remux"))],
        );
        open(&w, w.a, "A").await.map_err(err_body).unwrap();
        let up = &c.fake.seen("POST", "/v1/live")[1].body["upstreams"][0];
        assert_eq!(
            (
                up["probedVideoCodec"].clone(),
                up["probedAudioCodec"].clone(),
                up["probedContainer"].clone()
            ),
            (json!("h264"), json!("aac"), json!("mpegts"))
        );
    }

    #[sqlx::test(migrations = false)]
    async fn released_frees_the_token_and_counts_a_failure_only_when_failed(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        let (_, token) = opened(&w).await;
        session::on_event(
            &c.st,
            &EngineEvent::LiveReleased {
                capacity_token: token.clone(),
                reason: "idle".into(),
            },
        )
        .await;
        assert!(session::peek(&c.st).1.is_empty());
        let failures = |channel: i32| {
            let pool = c.pool.clone();
            async move {
                sqlx::query_scalar::<_, i32>(
                    r#"SELECT "consecutiveFailures" FROM livetv_channels WHERE id = $1"#,
                )
                .bind(channel)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };
        assert_eq!(failures(w.a).await, 0);
        c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("sid-2", SELF, "remux"))],
        );
        open(&w, w.a, "A").await.map_err(err_body).unwrap();
        let t2 = token_of(&w, 1);
        session::on_event(
            &c.st,
            &EngineEvent::LiveReleased {
                capacity_token: t2.clone(),
                reason: "failed".into(),
            },
        )
        .await;
        assert_eq!(failures(w.a).await, 1);
        session::on_event(
            &c.st,
            &EngineEvent::LiveReleased {
                capacity_token: t2,
                reason: "failed".into(),
            },
        )
        .await;
        assert_eq!(failures(w.a).await, 1, "an unknown token is nothing");
    }

    #[sqlx::test(migrations = false)]
    async fn a_released_slot_counts_for_the_grace_then_is_free(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        sqlx::query(
            "INSERT INTO app_settings (key, value) VALUES ('livetv_slot_release_seconds', '1')",
        )
        .execute(&c.pool)
        .await
        .unwrap();
        let (_, token) = opened(&w).await;
        session::on_event(
            &c.st,
            &EngineEvent::LiveReleased {
                capacity_token: token,
                reason: "idle".into(),
            },
        )
        .await;
        c.fake.script(
            "POST",
            "/v1/live",
            vec![
                coded(409, "live_at_capacity"),
                ok(open_answer("sid-2", SELF, "remux")),
            ],
        );
        let (s, _) = open(&w, w.b, "B")
            .await
            .map(|_| ())
            .map_err(err_body)
            .unwrap_err();
        assert_eq!(s, 409, "the closed upstream still counts");
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(open(&w, w.b, "B").await.is_ok());
        assert_eq!(
            c.fake.seen("POST", "/v1/live").last().unwrap().body["atCapacity"],
            false
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_session_that_ends_drops_its_viewer_and_the_activity_row(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        let (sid, _) = opened(&w).await;
        assert!(session::peek(&c.st).0.contains(&sid));
        let ended: EngineEvent = serde_json::from_value(
            json!({"type": "SessionEnded", "sessionId": sid, "reason": "stopped"}),
        )
        .unwrap();
        session::on_event(&c.st, &ended).await;
        assert!(session::peek(&c.st).0.is_empty());
        assert!(
            c.st.hub
                .activity()
                .list(1, 10)
                .data
                .iter()
                .all(|r| !r.entry.id.starts_with("livetv:"))
        );
        session::on_event(&c.st, &ended).await;
    }

    #[sqlx::test(migrations = false)]
    async fn a_served_segment_reaches_qoe_for_a_known_viewer_only(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        sqlx::query("INSERT INTO app_settings (key, value) VALUES ('qoe_enabled', 'true')")
            .execute(&c.pool)
            .await
            .unwrap();
        c.st.qoe.reload_enabled().await;
        let (sid, _) = opened(&w).await;
        let served = |sid: &str| -> EngineEvent {
            serde_json::from_value(json!({"type": "SegmentServed", "sessionId": sid, "track": "video", "rung": "r", "index": 1,
                "waitedMs": 120.0, "cacheHit": false, "cmcdRaw": "bl=5000"}))
            .unwrap()
        };
        session::on_event(&c.st, &served(&sid)).await;
        session::on_event(&c.st, &served("stranger")).await;
        assert!(c.st.qoe.live_summary(&sid).is_some());
        assert!(c.st.qoe.live_summary("stranger").is_none());
    }

    #[sqlx::test(migrations = false)]
    async fn running_transcodes_are_counted_per_hold(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("s1", SELF, "transcode"))],
        );
        open(&w, w.a, "A").await.map_err(err_body).unwrap();
        let t1 = token_of(&w, 0);
        c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("s2", &t1, "transcode"))],
        );
        open(&w, w.a, "A").await.map_err(err_body).unwrap();
        let (_, holds) = session::peek(&c.st);
        let transcodes = holds
            .iter()
            .filter(|h| h.3 == Some(fliks_engine_core::api::LiveMode::Transcode))
            .count();
        assert_eq!(transcodes, 1, "viewers of one session share its encoder");
    }

    #[sqlx::test(migrations = false)]
    async fn a_resync_rebuilds_viewers_and_holds_and_drops_what_the_engine_lost(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        let (stale, _) = opened(&w).await;
        c.fake.script(
            "GET",
            "/v1/live",
            vec![ok(json!([snapshot(
                "sid-r",
                w.b,
                w.who.id,
                "tr",
                "http://h/b.ts",
                "remux"
            )]))],
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
        session::resync(&c.st).await.unwrap();
        let (viewers, holds) = session::peek(&c.st);
        assert_eq!(viewers, vec!["sid-r".to_owned()], "{stale} is gone");
        assert_eq!(holds.len(), 1);
        assert_eq!(
            (holds[0].0.as_str(), holds[0].1, holds[0].2),
            ("tr", w.src1, false)
        );
        // Capacity follows the rebuilt hold: A on the same source is flagged as at capacity.
        c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("sid-n", SELF, "remux"))],
        );
        open(&w, w.a, "A").await.map_err(err_body).unwrap();
        assert_eq!(
            c.fake.seen("POST", "/v1/live").last().unwrap().body["atCapacity"],
            true
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_failed_listing_leaves_the_state_alone(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        opened(&w).await;
        c.fake.script("GET", "/v1/live", vec![status(500)]);
        assert!(session::resync(&c.st).await.is_err());
        assert_eq!(session::peek(&c.st).0.len(), 1);
    }

    #[sqlx::test(migrations = false)]
    async fn the_consumer_resyncs_on_connect_and_follows_the_events(pool: PgPool) {
        let c = ctx_with(
            pool,
            |f| {
                f.script(
                    "GET",
                    "/v1/live",
                    vec![ok(json!([snapshot(
                        "sid-r",
                        1,
                        1,
                        "tr",
                        "http://h/b.ts",
                        "remux"
                    )]))],
                );
                f.script("GET", "/v1/sessions", vec![ok(json!([]))]);
                f.connections(vec![crate::engine::testkit::Conn::Hold(vec![])]);
            },
            true,
        )
        .await;
        for _ in 0..50 {
            if !session::peek(&c.st).0.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(session::peek(&c.st).0, vec!["sid-r".to_owned()]);
        c.fake.push_frames(
            "data: {\"type\":\"SessionEnded\",\"sessionId\":\"sid-r\",\"reason\":\"stopped\"}\n\n",
        );
        for _ in 0..50 {
            if session::peek(&c.st).0.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(session::peek(&c.st).0.is_empty());
    }

    #[sqlx::test(migrations = false)]
    async fn leave_asks_the_engine_and_only_the_owner_or_an_admin_may(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        let (owner, owner_tok) = viewer(c, "owner2", false).await;
        let (_, other_tok) = viewer(c, "other", false).await;
        let (_, admin_tok) = viewer(c, "boss", true).await;
        let who = Who {
            id: owner,
            username: "owner2".into(),
        };
        c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("sid-1", SELF, "remux"))],
        );
        let streams = session::load_streams(&c.pool, w.a, true).await.unwrap();
        session::open(&c.st, w.a, "A", streams, &who, Caps::default(), None)
            .await
            .map_err(err_body)
            .unwrap();
        c.fake
            .script("DELETE", "/v1/sessions/sid-1", vec![status(204)]);
        let uri = "/api/livetv/sessions/sid-1";
        let (s, b) = call(&c.app, "DELETE", uri, &other_tok, None).await;
        assert_eq!((s, b["message"].as_str()), (403, Some("Not your session")));
        assert!(c.fake.seen("DELETE", "/v1/sessions/sid-1").is_empty());
        let (s, b) = call(&c.app, "DELETE", uri, &owner_tok, None).await;
        assert_eq!((s, b), (200, json!({"ok": true})));
        assert_eq!(c.fake.seen("DELETE", "/v1/sessions/sid-1").len(), 1);
        assert!(session::peek(&c.st).0.is_empty());
        // Unknown to the host: the engine decides whose it is; a sid it does not know is nobody's.
        c.fake.script("GET", "/v1/live/ghost", vec![status(404)]);
        let (s, b) = call(
            &c.app,
            "DELETE",
            "/api/livetv/sessions/ghost",
            &owner_tok,
            None,
        )
        .await;
        assert_eq!((s, b), (200, json!({"ok": true})));
        assert!(
            c.fake.seen("DELETE", "/v1/sessions/ghost").is_empty(),
            "this route never ends an on-demand session"
        );
        c.fake.script(
            "GET",
            "/v1/live/theirs",
            vec![ok(snapshot(
                "theirs",
                w.a,
                owner,
                "tt",
                "http://h/a.ts",
                "remux",
            ))],
        );
        let (s, _) = call(
            &c.app,
            "DELETE",
            "/api/livetv/sessions/theirs",
            &other_tok,
            None,
        )
        .await;
        assert_eq!(s, 403);
        c.fake
            .script("DELETE", "/v1/sessions/theirs", vec![status(204)]);
        let (s, _) = call(
            &c.app,
            "DELETE",
            "/api/livetv/sessions/theirs",
            &admin_tok,
            None,
        )
        .await;
        assert_eq!(s, 200);
    }

    #[sqlx::test(migrations = false)]
    async fn the_heartbeat_needs_the_viewer_and_its_owner(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        let (owner, owner_tok) = viewer(c, "owner2", false).await;
        let (_, other_tok) = viewer(c, "other", false).await;
        let who = Who {
            id: owner,
            username: "owner2".into(),
        };
        c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("sid-1", SELF, "remux"))],
        );
        let streams = session::load_streams(&c.pool, w.a, true).await.unwrap();
        session::open(&c.st, w.a, "A", streams, &who, Caps::default(), None)
            .await
            .map_err(err_body)
            .unwrap();
        let uri = "/api/livetv/sessions/sid-1/state";
        let (s, b) = call(
            &c.app,
            "PUT",
            "/api/livetv/sessions/nope/state",
            &owner_tok,
            Some(json!({})),
        )
        .await;
        assert_eq!(
            (s, b["message"].as_str()),
            (404, Some("Live TV session not found"))
        );
        let (s, b) = call(&c.app, "PUT", uri, &other_tok, Some(json!({}))).await;
        assert_eq!((s, b["message"].as_str()), (403, Some("Not your session")));
        let (s, b) = call(
            &c.app,
            "PUT",
            uri,
            &owner_tok,
            Some(json!({"state": "paused", "qoe": {"nonsense": 1}})),
        )
        .await;
        assert_eq!((s, b), (200, json!({"ok": true})));
        let (s, _) = call(&c.app, "PUT", uri, &owner_tok, None).await;
        assert_eq!(s, 200);
    }

    #[sqlx::test(migrations = false)]
    async fn the_play_route_answers_the_contract_with_a_stream_token_in_the_url(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        let (_, tok) = viewer(c, "someone", false).await;
        c.fake.script(
            "POST",
            "/v1/live",
            vec![ok(open_answer("sid-1", SELF, "remux"))],
        );
        let (s, b) = call(
            &c.app,
            "POST",
            &format!("/api/livetv/channels/{}/play", w.a),
            &tok,
            Some(json!({})),
        )
        .await;
        assert_eq!(s, 201, "{b}");
        let url = b["url"].as_str().unwrap();
        assert!(
            url.starts_with("/api/livetv/sessions/sid-1/index.m3u8?token="),
            "{url}"
        );
        let mut b2 = b.clone();
        b2["url"] = json!("");
        assert_eq!(
            b2,
            json!({"sessionId": "sid-1", "channelId": w.a, "channelName": "A", "url": "", "mode": "remux", "isLive": true,
                   "dvrWindowSeconds": 900, "segmentSeconds": 2})
        );
        for (body, status) in [
            (json!({"directPlay": "x"}), 400),
            (json!({"maxBitrateBps": 0}), 400),
            (json!({"extra": 1}), 400),
        ] {
            let (s, _) = call(
                &c.app,
                "POST",
                &format!("/api/livetv/channels/{}/play", w.a),
                &tok,
                Some(body),
            )
            .await;
            assert_eq!(s, status);
        }
        let (s, _) = call(
            &c.app,
            "POST",
            "/api/livetv/channels/9999/play",
            &tok,
            Some(json!({})),
        )
        .await;
        assert_eq!(s, 404);
        c.fake.script("POST", "/v1/live", vec![]);
    }

    #[sqlx::test(migrations = false)]
    async fn a_grant_change_ends_the_viewers_that_lost_access_and_keeps_the_others(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        let (uid, _) = viewer(c, "grantee", false).await;
        let (_, admin) = viewer(c, "boss", true).await;
        sqlx::query("INSERT INTO app_settings (key, value) VALUES ('livetv_restricted_groups', '[\"Adult\"]')").execute(&c.pool).await.unwrap();
        let r = channel(&c.pool, "R", "Adult", true).await;
        stream(&c.pool, r, w.src1, "http://h/r.ts", 0).await;
        sqlx::query(
            r#"INSERT INTO livetv_group_access ("userId", "groupName") VALUES ($1, 'Adult')"#,
        )
        .bind(uid)
        .execute(&c.pool)
        .await
        .unwrap();
        let who = Who {
            id: uid,
            username: "grantee".into(),
        };
        c.fake.script(
            "POST",
            "/v1/live",
            vec![
                ok(open_answer("sid-r", SELF, "remux")),
                ok(open_answer("sid-a", SELF, "remux")),
            ],
        );
        for (ch, name) in [(r, "R"), (w.a, "A")] {
            let streams = session::load_streams(&c.pool, ch, true).await.unwrap();
            session::open(&c.st, ch, name, streams, &who, Caps::default(), None)
                .await
                .map_err(err_body)
                .unwrap();
        }
        c.fake
            .script("DELETE", "/v1/sessions/sid-r", vec![status(204)]);
        let (s, b) = call(
            &c.app,
            "PUT",
            &format!("/api/livetv/admin/access/users/{uid}"),
            &admin,
            Some(json!({"groups": []})),
        )
        .await;
        assert_eq!((s, b), (200, json!({"groups": [], "ignored": []})));
        let ended = c.fake.seen("DELETE", "/v1/sessions/sid-r");
        assert_eq!(ended.len(), 1);
        assert_eq!(ended[0].query, "reason=revoked");
        assert_eq!(
            session::peek(&c.st).0,
            vec!["sid-a".to_owned()],
            "the open channel stays, the restricted one went"
        );
        assert!(c.fake.seen("DELETE", "/v1/sessions/sid-a").is_empty());
    }

    // The resolver's `live` purpose.
    async fn resolve(c: &Ctx, sid: &str, user_id: i32, perms: &[&str]) -> Result<bool, u16> {
        let perms: Vec<String> = perms.iter().map(|p| (*p).to_owned()).collect();
        session::resolve_live(&c.st, sid, user_id, &perms)
            .await
            .map_err(|e| e.status().as_u16())
    }

    #[sqlx::test(migrations = false)]
    async fn the_resolver_allows_the_owner_while_the_channel_stays_playable(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        let (sid, _) = opened(&w).await;
        assert_eq!(resolve(c, &sid, w.who.id, &["livetv.read"]).await, Ok(true));
        sqlx::query("UPDATE livetv_channels SET enabled = false WHERE id = $1")
            .bind(w.a)
            .execute(&c.pool)
            .await
            .unwrap();
        assert_eq!(
            resolve(c, &sid, w.who.id, &["livetv.read"]).await,
            Ok(false),
            "a disabled channel ends the viewer at its next request"
        );
        sqlx::query("UPDATE livetv_channels SET enabled = true WHERE id = $1")
            .bind(w.a)
            .execute(&c.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE livetv_sources SET enabled = false WHERE id = $1")
            .bind(w.src1)
            .execute(&c.pool)
            .await
            .unwrap();
        assert_eq!(
            resolve(c, &sid, w.who.id, &["livetv.read"]).await,
            Ok(false),
            "so does a disabled source (C136)"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_credential_that_is_not_the_owners_is_never_a_denial_of_the_owner(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        let (sid, _) = opened(&w).await;
        sqlx::query("INSERT INTO app_settings (key, value) VALUES ('livetv_restricted_groups', '[\"Live\"]')").execute(&c.pool).await.unwrap();
        let (stranger, _) = viewer(c, "stranger", false).await;
        assert_eq!(
            resolve(c, &sid, stranger, &["livetv.read"]).await,
            Ok(true),
            "the engine answers 403 itself (F75)"
        );
        assert_eq!(
            resolve(c, &sid, w.who.id, &["livetv.read"]).await,
            Ok(false),
            "the owner lost the group"
        );
        assert_eq!(
            resolve(c, &sid, w.who.id, &["settings.access"]).await,
            Ok(true),
            "an administrator is never filtered"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn an_unknown_sid_is_asked_of_the_engine_and_a_404_is_the_denial(pool: PgPool) {
        let w = world(pool).await;
        let c = &w.c;
        c.fake.script(
            "GET",
            "/v1/live/racing",
            vec![ok(snapshot(
                "racing",
                w.a,
                w.who.id,
                "tr",
                "http://h/a.ts",
                "remux",
            ))],
        );
        assert_eq!(
            resolve(c, "racing", w.who.id, &["livetv.read"]).await,
            Ok(true)
        );
        assert!(
            session::peek(&c.st).0.contains(&"racing".to_owned()),
            "the viewer is rebuilt from the snapshot"
        );
        c.fake.script("GET", "/v1/live/nobody", vec![status(404)]);
        assert_eq!(
            resolve(c, "nobody", w.who.id, &["livetv.read"]).await,
            Ok(false)
        );
        c.fake.script("GET", "/v1/live/boom", vec![status(500)]);
        assert_eq!(
            resolve(c, "boom", w.who.id, &["livetv.read"]).await,
            Err(502),
            "an engine fault is not a denial"
        );
    }
}
