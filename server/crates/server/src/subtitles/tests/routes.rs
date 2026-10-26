//! The subtitle routes through the real router, a provider stub, a fake engine and generated media.
use super::*;
use crate::{
    app,
    config::Config,
    engine::testkit::{Fake, RUNTIME, hello_body, ok},
    state::AppState,
    subtitles::{Bases, Shared},
};
use axum::{body::Body, extract::Request};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::path::PathBuf;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

pub struct Ctx {
    pub app: axum::Router,
    pub st: AppState,
    pub pool: PgPool,
    pub fake: Fake,
    pub stub: Stub,
    pub admin: String,
    pub reader: String,
    pub media: i32,
    pub other_media: i32,
    pub file: i32,
    pub dir: PathBuf,
    pub root: PathBuf,
}

pub async fn one(pool: &PgPool, sql: &str) -> i32 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .fetch_one(pool)
        .await
        .unwrap()
}

static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

pub async fn ctx(pool: PgPool) -> Ctx {
    crate::db::migrate(&pool).await.unwrap();
    let fake = Fake::start().await;
    let mut features = RUNTIME.to_vec();
    features.extend(["subtitle-ocr", "subtitle-sync"]);
    fake.hello(Some(hello_body(&features, "x")));
    let env = [
        ("FLIKS_ENGINE_URL", fake.url.clone()),
        ("FLIKS_ENGINE_TOKEN", "tok".into()),
    ];
    let cfg = Config::from_lookup(|k| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()));
    let stub = Stub::start().await;
    let mut st = AppState::new(pool.clone(), cfg, SECRET);
    st.subtitles = std::sync::Arc::new(Shared::new(Bases {
        opensubtitles: format!("{}/api/v1", stub.url),
        subdl_api: format!("{}/api/v1/subtitles", stub.url),
        subdl_dl: stub.url.clone(),
        gemini: stub.url.clone(),
        allow_http_link: true,
        ..Bases::default()
    }));
    st.engine.start(pool.clone(), 4849).await;
    let app = app::router(st.clone(), None, "/nonexistent".into(), None);
    let root = PathBuf::from(format!(
        "/tmp/fliks-parity/s6/t{}-{}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    let dir = root.join("Movie (2020)");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("Movie.2020.1080p.BluRay.x264-GRP.mkv"), b"video").unwrap();
    let admin = one(
        &pool,
        r#"INSERT INTO users (username, "isAdmin") VALUES ('admin', true) RETURNING id"#,
    )
    .await;
    let role = one(
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
    let lib: i32 =
        sqlx::query_scalar("INSERT INTO libraries (name, path) VALUES ('L1', $1) RETURNING id")
            .bind(root.to_string_lossy().as_ref())
            .fetch_one(&pool)
            .await
            .unwrap();
    let lib2 = one(
        &pool,
        r#"INSERT INTO libraries (name, path) VALUES ('L2', '/nowhere') RETURNING id"#,
    )
    .await;
    sqlx::query(r#"INSERT INTO library_user_access ("userId", "libraryId") VALUES ($1, $2)"#)
        .bind(reader)
        .bind(lib)
        .execute(&pool)
        .await
        .unwrap();
    let profile = one(
        &pool,
        r#"INSERT INTO language_profiles (name, "subtitleLanguages") VALUES ('p', '[{"isoCode":"en","name":"English","forced":false,"hi":false},{"isoCode":"fr","name":"French","forced":false,"hi":false}]') RETURNING id"#,
    )
    .await;
    let media: i32 = sqlx::query_scalar(
        r#"INSERT INTO media (title, "type", year, "imdbId", "tmdbId", "libraryId", "folderName", "languageProfileId")
           VALUES ('Movie', 'movie', 2020, 'tt0000001', 42, $1, 'Movie (2020)', $2) RETURNING id"#,
    )
    .bind(lib)
    .bind(profile)
    .fetch_one(&pool)
    .await
    .unwrap();
    let other_media: i32 = sqlx::query_scalar(r#"INSERT INTO media (title, "type", "libraryId") VALUES ('Other', 'movie', $1) RETURNING id"#).bind(lib2).fetch_one(&pool).await.unwrap();
    let file: i32 = sqlx::query_scalar(
        r#"INSERT INTO media_files ("relativePath", size, quality, "streamInfo", "mediaId")
           VALUES ('Movie.2020.1080p.BluRay.x264-GRP.mkv', 5, '1080p', '{"video":[],"audio":[],"subtitles":[]}', $1) RETURNING id"#,
    )
    .bind(media)
    .fetch_one(&pool)
    .await
    .unwrap();
    Ctx {
        admin: st.jwt.sign_access(admin, "admin").unwrap().token,
        reader: st.jwt.sign_access(reader, "reader").unwrap().token,
        app,
        st,
        pool,
        fake,
        stub,
        media,
        other_media,
        file,
        dir,
        root,
    }
}

impl Drop for Ctx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

pub async fn call(
    c: &Ctx,
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

/// An enabled OpenSubtitles row pointed at the stub, with a search hit and a downloadable file.
pub async fn provider(c: &Ctx, ptype: &str) -> i32 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"INSERT INTO subtitle_providers (name, "type", settings, priority) VALUES ('P', '{ptype}', '{{"apiKey":"K"}}', 1) RETURNING id"#
    )))
    .fetch_one(&c.pool)
    .await
    .unwrap()
}

pub fn script_subdl(c: &Ctx, hits: &[(&str, &str, bool)]) {
    let subs: Vec<Value> = hits
        .iter()
        .map(|(url, rel, hi)| json!({"release_name": rel, "language": "EN", "hi": hi, "url": url}))
        .collect();
    c.stub.on(
        "GET",
        "/api/v1/subtitles",
        vec![reply(
            200,
            json!({"status": true, "subtitles": subs}).to_string(),
        )],
    );
    for (url, _, _) in hits {
        c.stub.on(
            "GET",
            url,
            vec![reply(200, zip_of("x.srt", SRT.as_bytes(), true))],
        );
    }
}

fn media_dir_files(c: &Ctx) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(&c.dir)
        .unwrap()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    v.sort();
    v
}

#[sqlx::test]
async fn blacklist_history_stats_and_the_provider_crud(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, v) = call(&c, "POST", "/api/subtitles/blacklist", &c.admin, Some(json!({"providerType": "subdl", "providerFileId": "f1", "mediaId": c.media, "reason": "bad"}))).await;
    assert_eq!(s, 201);
    assert!(
        v.get("mediaId").is_none() && v["reason"] == "bad" && v["id"].as_i64().is_some(),
        "{v}"
    );
    let saved: Option<i32> =
        sqlx::query_scalar(r#"SELECT "mediaId" FROM subtitle_blacklist WHERE id = $1"#)
            .bind(v["id"].as_i64().unwrap() as i32)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(saved, Some(c.media));
    assert_eq!(
        call(
            &c,
            "POST",
            "/api/subtitles/blacklist",
            &c.admin,
            Some(json!({"providerType": "subdl", "providerFileId": "f1", "mediaId": 9999}))
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(
            &c,
            "POST",
            "/api/subtitles/blacklist",
            &c.admin,
            Some(json!({"providerType": "subdl"}))
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(
            &c,
            "POST",
            "/api/subtitles/blacklist",
            &c.reader,
            Some(json!({"providerType": "a", "providerFileId": "b"}))
        )
        .await
        .0,
        403
    );
    let (_, list) = call(
        &c,
        "GET",
        "/api/subtitles/blacklist?page=1&limit=10",
        &c.reader,
        None,
    )
    .await;
    assert_eq!(list["total"], 1);
    assert_eq!(
        call(
            &c,
            "GET",
            "/api/subtitles/blacklist?page=-1",
            &c.admin,
            None
        )
        .await
        .0,
        400
    );
    let (s, v) = call(&c, "DELETE", "/api/subtitles/blacklist", &c.admin, None).await;
    assert_eq!((s, v["deleted"].clone()), (200, json!(1)));
    assert_eq!(
        call(&c, "DELETE", "/api/subtitles/blacklist/77", &c.admin, None)
            .await
            .0,
        404
    );

    // Providers: redaction, keep-on-blank, changed type.
    let (s, v) = call(&c, "POST", "/api/subtitles/providers", &c.admin, Some(json!({"name": "OS", "type": "opensubtitles", "settings": {"username": "u", "password": "pw", "apiKey": "k"}}))).await;
    assert_eq!(s, 201);
    assert_eq!(
        v["settings"],
        json!({"username": "u", "secretsSet": ["password", "apiKey"]})
    );
    assert_eq!(
        (v["priority"].clone(), v["enabled"].clone()),
        (json!(25), json!(true))
    );
    let id = v["id"].as_i64().unwrap();
    let (_, v) = call(
        &c,
        "PUT",
        &format!("/api/subtitles/providers/{id}"),
        &c.admin,
        Some(json!({"settings": {"username": "u2", "password": ""}})),
    )
    .await;
    assert_eq!(
        v["settings"],
        json!({"username": "u2", "secretsSet": ["password", "apiKey"]})
    );
    let (_, v) = call(
        &c,
        "PUT",
        &format!("/api/subtitles/providers/{id}"),
        &c.admin,
        Some(json!({"settings": {"apiKey": null, "password": ""}})),
    )
    .await;
    assert_eq!(v["settings"]["secretsSet"], json!(["password"]));
    let (_, v) = call(
        &c,
        "PUT",
        &format!("/api/subtitles/providers/{id}"),
        &c.admin,
        Some(json!({"type": "subdl"})),
    )
    .await;
    assert_eq!(v["settings"], json!({"secretsSet": []}));
    let (s, v) = call(
        &c,
        "POST",
        "/api/subtitles/providers",
        &c.admin,
        Some(json!({"name": 3, "type": "nope", "priority": -1})),
    )
    .await;
    assert_eq!(s, 400);
    assert_eq!(v["message"].as_array().unwrap().len(), 3, "{v}");
    assert_eq!(
        call(&c, "GET", "/api/subtitles/providers/999", &c.admin, None)
            .await
            .0,
        404
    );
    assert_eq!(
        call(&c, "GET", "/api/subtitles/providers", &c.reader, None)
            .await
            .0,
        200
    );
    assert_eq!(
        call(
            &c,
            "POST",
            "/api/subtitles/providers",
            &c.reader,
            Some(json!({"name": "x", "type": "yify"}))
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("/api/subtitles/providers/{id}/test"),
            &c.reader,
            None
        )
        .await
        .0,
        403
    );
    let (s, v) = call(
        &c,
        "POST",
        "/api/subtitles/providers/test-connection",
        &c.admin,
        Some(json!({"type": "whisper"})),
    )
    .await;
    assert_eq!(
        (s, v["ok"].clone(), v["detail"].clone()),
        (
            201,
            json!(false),
            json!("Unsupported subtitle provider type: whisper")
        )
    );
    assert_eq!(
        call(
            &c,
            "GET",
            "/api/subtitles/providers/rate-limits",
            &c.reader,
            None
        )
        .await
        .1,
        json!([])
    );
    sqlx::query(r#"INSERT INTO subtitle_provider_stats ("providerId", "queryType", "responseTimeMs", "resultCount", "errorMessage") VALUES ($1, 'search', 100, 3, NULL), ($1, 'search', 300, 0, 'boom')"#).bind(id as i32).execute(&c.pool).await.unwrap();
    let (_, v) = call(
        &c,
        "GET",
        &format!("/api/subtitles/providers/{id}/stats"),
        &c.reader,
        None,
    )
    .await;
    assert_eq!(
        (
            v[0]["queries"].clone(),
            v[0]["avgResponseMs"].clone(),
            v[0]["totalResults"].clone(),
            v[0]["errors"].clone()
        ),
        (json!("2"), json!(200), json!(3), json!(1))
    );
    assert_eq!(
        call(
            &c,
            "DELETE",
            &format!("/api/subtitles/providers/{id}"),
            &c.admin,
            None
        )
        .await
        .0,
        200
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM subtitle_provider_stats")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 0, "stats cascade");
}

#[sqlx::test]
async fn search_download_list_upgrade_post_process_and_delete(pool: PgPool) {
    let c = ctx(pool).await;
    provider(&c, "subdl").await;
    script_subdl(
        &c,
        &[
            ("/subtitle/1.zip", "Movie.2020.1080p.BluRay.x264-GRP", false),
            ("/subtitle/2.zip", "Movie.2020.720p.WEB", false),
        ],
    );
    let uri = format!("/api/media/{}/subtitles", c.media);
    let (s, v) = call(
        &c,
        "GET",
        &format!("{uri}/search?language=en"),
        &c.admin,
        None,
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(v[0]["providerFileId"], "/subtitle/1.zip");
    assert!(
        v[0]["_score"]["percent"].as_i64().unwrap() > v[1]["_score"]["percent"].as_i64().unwrap(),
        "{v}"
    );
    let cand = v[0].clone();
    let (s, v) = call(
        &c,
        "POST",
        &format!("{uri}/download"),
        &c.admin,
        Some(json!({"searchResult": cand, "mediaFileId": c.file})),
    )
    .await;
    assert_eq!(s, 201, "{v}");
    let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    // Parity `subtitles-provider-download-shape`).
    let want = [
        "codec",
        "createdAt",
        "episode",
        "episodeId",
        "errorMessage",
        "forced",
        "hashMatched",
        "hearingImpaired",
        "id",
        "language",
        "locked",
        "media",
        "mediaFile",
        "mediaFileId",
        "mediaId",
        "providerFileId",
        "providerType",
        "relativePath",
        "score",
        "sourceStreamIndex",
        "status",
        "streamIndex",
        "syncFailed",
        "syncOffset",
        "synced",
        "tags",
        "translationEngine",
        "translationModel",
        "translationProviderName",
        "updatedAt",
    ];
    assert_eq!(keys, want.map(String::from));
    assert_eq!(
        (
            v["language"].clone(),
            v["status"].clone(),
            v["relativePath"].clone()
        ),
        (
            json!("en"),
            json!("downloaded"),
            json!("Movie.2020.1080p.BluRay.x264-GRP.en.srt")
        )
    );
    assert!(media_dir_files(&c).contains(&"Movie.2020.1080p.BluRay.x264-GRP.en.srt".to_owned()));
    let sid = v["id"].as_i64().unwrap();
    // A second download of the same language takes a numbered name.
    let (_, v2) = call(
        &c,
        "POST",
        &format!("{uri}/download"),
        &c.admin,
        Some(json!({"searchResult": cand, "mediaFileId": c.file})),
    )
    .await;
    assert_eq!(
        v2["relativePath"],
        "Movie.2020.1080p.BluRay.x264-GRP.en-1.srt"
    );
    let (_, list) = call(&c, "GET", &uri, &c.reader, None).await;
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert!(list[0]["mediaId"].is_i64() && list[0]["relativePath"].is_string());

    // Errors of the download.
    let bad = json!({"searchResult": {"providerFileId": "x", "language": "en", "providerType": "yify"}, "mediaFileId": c.file});
    assert_eq!(
        call(&c, "POST", &format!("{uri}/download"), &c.admin, Some(bad))
            .await
            .0,
        404
    );
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{uri}/download"),
            &c.admin,
            Some(json!({"searchResult": cand, "mediaFileId": 99999}))
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{uri}/download"),
            &c.reader,
            Some(json!({"searchResult": cand, "mediaFileId": c.file}))
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{uri}/download"),
            &c.admin,
            Some(json!({}))
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(
            &c,
            "GET",
            &format!("/api/media/{}/subtitles", c.other_media),
            &c.reader,
            None
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(
            &c,
            "DELETE",
            &format!("/api/media/{}/subtitles/{sid}", c.other_media),
            &c.admin,
            None
        )
        .await
        .0,
        404,
        "bound to its media"
    );

    // Auto: none found is 201 with no body.
    c.stub.on(
        "GET",
        "/api/v1/subtitles",
        vec![reply(
            200,
            json!({"status": true, "subtitles": []}).to_string(),
        )],
    );
    let (s, v) = call(
        &c,
        "POST",
        &format!("{uri}/auto"),
        &c.admin,
        Some(json!({"mediaFileId": c.file})),
    )
    .await;
    assert_eq!((s, v), (201, Value::Null));

    // Row edits.
    let (s, v) = call(
        &c,
        "PATCH",
        &format!("{uri}/{sid}/language"),
        &c.admin,
        Some(json!({"language": "fre"})),
    )
    .await;
    assert_eq!((s, v["language"].clone()), (200, json!("fr")));
    assert_eq!(
        call(
            &c,
            "PATCH",
            &format!("{uri}/{sid}/language"),
            &c.admin,
            Some(json!({"language": " "}))
        )
        .await
        .0,
        400
    );
    let (s, v) = call(&c, "POST", &format!("{uri}/{sid}/validate"), &c.admin, None).await;
    assert_eq!((s, v["score"].clone()), (201, json!(100)));
    let (s, v) = call(
        &c,
        "POST",
        &format!("{uri}/{sid}/post-process"),
        &c.admin,
        Some(json!({"action": "adjustTimes", "params": {"offsetMs": 1000}})),
    )
    .await;
    assert_eq!((s, v["locked"].clone()), (201, json!(true)));
    let text =
        std::fs::read_to_string(c.dir.join("Movie.2020.1080p.BluRay.x264-GRP.en.srt")).unwrap();
    assert!(text.contains("00:00:02,000 --> 00:00:03,000"), "{text}");
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{uri}/{sid}/post-process"),
            &c.admin,
            Some(json!({"action": "nope"}))
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{uri}/{sid}/post-process"),
            &c.admin,
            Some(json!({"action": "adjustTimes", "params": {"offsetMs": "x"}}))
        )
        .await
        .0,
        400
    );

    // Upgrade swaps the file; a failed download keeps the old one.
    let better = json!({"searchResult": v_cand(&cand, "/subtitle/2.zip")});
    let (s, up) = call(
        &c,
        "POST",
        &format!("{uri}/{sid}/upgrade"),
        &c.admin,
        Some(better),
    )
    .await;
    assert_eq!(
        (s, up["status"].clone(), up["locked"].clone()),
        (201, json!("upgraded"), json!(true)),
        "{up}"
    );
    let gone: i64 = sqlx::query_scalar("SELECT count(*) FROM subtitle_files WHERE id = $1")
        .bind(sid as i32)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(gone, 0);
    let new_id = up["id"].as_i64().unwrap();
    let failing = json!({"searchResult": v_cand(&cand, "/subtitle/missing.zip")});
    let (s, _) = call(
        &c,
        "POST",
        &format!("{uri}/{new_id}/upgrade"),
        &c.admin,
        Some(failing),
    )
    .await;
    assert_eq!(s, 400);
    let kept: i64 = sqlx::query_scalar("SELECT count(*) FROM subtitle_files WHERE id = $1")
        .bind(new_id as i32)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(kept, 1);

    // History and stats cover the rows; the reader sees its library only.
    let (_, h) = call(
        &c,
        "GET",
        "/api/subtitles/history?limit=500",
        &c.admin,
        None,
    )
    .await;
    assert_eq!(
        (h["limit"].clone(), h["total"].as_i64().unwrap() >= 2),
        (json!(100), true)
    );
    let (_, st) = call(&c, "GET", "/api/subtitles/stats", &c.reader, None).await;
    assert!(st["total"].as_i64().unwrap() >= 2 && st["recent"].is_array());
    assert_eq!(
        call(
            &c,
            "GET",
            "/api/subtitles/history?status=bogus",
            &c.admin,
            None
        )
        .await
        .0,
        400
    );

    // Delete unlinks the sidecar and the row.
    let before = media_dir_files(&c).len();
    assert_eq!(
        call(&c, "DELETE", &format!("{uri}/{new_id}"), &c.admin, None)
            .await
            .0,
        200
    );
    assert_eq!(media_dir_files(&c).len(), before - 1);
}

fn v_cand(c: &Value, id: &str) -> Value {
    let mut c = c.clone();
    c["providerFileId"] = json!(id);
    c
}

#[sqlx::test]
async fn upload_validates_cleans_and_names_the_file(pool: PgPool) {
    let c = ctx(pool).await;
    let uri = format!("/api/media/{}/subtitles/upload", c.media);
    let send = |name: &str, data: Vec<u8>, fields: Vec<(&'static str, String)>| {
        let mut body = vec![];
        for (k, v) in &fields {
            body.extend(
                format!("--B\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
                    .into_bytes(),
            );
        }
        body.extend(format!("--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: text/plain\r\n\r\n").into_bytes());
        body.extend(data);
        body.extend(b"\r\n--B--\r\n");
        let req = Request::builder()
            .method("POST")
            .uri(&uri)
            .header("authorization", format!("Bearer {}", c.admin))
            .header("content-type", "multipart/form-data; boundary=B")
            .body(Body::from(body))
            .unwrap();
        let app = c.app.clone();
        async move {
            let res = app.oneshot(req).await.unwrap();
            let s = res.status().as_u16();
            let b = axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap();
            (
                s,
                serde_json::from_slice::<Value>(&b).unwrap_or(Value::Null),
            )
        }
    };
    let f = |extra: Vec<(&'static str, &'static str)>| -> Vec<(&'static str, String)> {
        let mut v = vec![
            ("mediaFileId", c.file.to_string()),
            ("language", "eng".to_owned()),
        ];
        v.extend(extra.into_iter().map(|(k, x)| (k, x.to_owned())));
        v
    };
    let ad =
        format!("{SRT}\n3\n00:00:05,000 --> 00:00:06,000\nDownloaded from www.opensubtitles.org\n");
    let (s, v) = send("x.forced.srt", ad.into_bytes(), f(vec![])).await;
    assert_eq!(
        (
            s,
            v["language"].clone(),
            v["forced"].clone(),
            v["score"].clone(),
            v["providerType"].clone()
        ),
        (201, json!("en"), json!(true), json!(100), json!("disk")),
        "{v}"
    );
    assert_eq!(
        v["relativePath"],
        "Movie.2020.1080p.BluRay.x264-GRP.en.forced.srt"
    );
    let text =
        std::fs::read_to_string(c.dir.join("Movie.2020.1080p.BluRay.x264-GRP.en.forced.srt"))
            .unwrap();
    assert!(!text.contains("opensubtitles"), "the ad cue is cleaned");
    let (s, v) = send(
        "x.ass",
        b"[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,D,,0,0,0,,Hi".to_vec(),
        f(vec![("hearingImpaired", "true")]),
    )
    .await;
    assert_eq!(
        (s, v["relativePath"].clone(), v["hearingImpaired"].clone()),
        (
            201,
            json!("Movie.2020.1080p.BluRay.x264-GRP.en.hi.ass"),
            json!(true)
        )
    );
    let (s, v) = send("y.srt", SRT.as_bytes().to_vec(), f(vec![])).await;
    assert_eq!(
        (s, v["relativePath"].clone()),
        (201, json!("Movie.2020.1080p.BluRay.x264-GRP.en.srt"))
    );
    let (s, v) = send("z.srt", SRT.as_bytes().to_vec(), f(vec![])).await;
    assert_eq!(
        (s, v["relativePath"].clone()),
        (201, json!("Movie.2020.1080p.BluRay.x264-GRP.en-1.srt")),
        "a taken name is never replaced"
    );
    assert_eq!(send("x.txt", b"x".to_vec(), f(vec![])).await.0, 400);
    assert_eq!(send("x.srt", b"no cues".to_vec(), f(vec![])).await.0, 400);
    assert_eq!(
        send(
            "x.srt",
            SRT.as_bytes().to_vec(),
            vec![("language", "en".into())]
        )
        .await
        .0,
        400
    );
    let (s, v) = send("x.srt", vec![b'a'; 5 * 1024 * 1024 + 10], f(vec![])).await;
    assert_eq!(
        (s, v["message"].clone()),
        (413, json!("file_info.import_err_too_large"))
    );
    let (_, v) = send(
        "x.srt",
        SRT.as_bytes().to_vec(),
        f(vec![("language", "x/../../tmp")]),
    )
    .await;
    assert_eq!(v["message"], "Invalid subtitle language \"x/../../tmp\"");
    assert!(!c.root.parent().unwrap().join("tmp.srt").exists());
    let _ = ok(json!({}));
}

#[sqlx::test]
async fn missing_lists_uncovered_languages_and_activity_follows_library_access(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, m) = call(&c, "GET", "/api/subtitles/missing", &c.reader, None).await;
    assert_eq!(m["total"], 2);
    assert_eq!(
        (
            m["data"][0]["language"].clone(),
            m["data"][0]["mediaTitle"].clone(),
            m["data"][0]["episodeLabel"].clone()
        ),
        (json!("en"), json!("Movie"), Value::Null)
    );
    sqlx::query(r#"INSERT INTO subtitle_files ("mediaId", "mediaFileId", language, "providerType", status, score) VALUES ($1, $2, 'en', 'disk', 'downloaded', 100), ($1, $2, 'fr', 'disk', 'failed', 100)"#).bind(c.media).bind(c.file).execute(&c.pool).await.unwrap();
    let (_, m) = call(&c, "GET", "/api/subtitles/missing", &c.admin, None).await;
    assert_eq!(
        (m["total"].clone(), m["data"][0]["language"].clone()),
        (json!(1), json!("fr")),
        "a failed row never covers"
    );
    let (_, m) = call(
        &c,
        "GET",
        "/api/subtitles/missing?page=5&limit=1",
        &c.admin,
        None,
    )
    .await;
    assert_eq!(
        (m["total"].clone(), m["data"].clone()),
        (json!(0), json!([])),
        "past the end the total is 0"
    );
    // Rows of media outside the reader's libraries are not listed.
    sqlx::query(r#"INSERT INTO subtitle_files ("mediaId", language, "providerType", status, score) VALUES ($1, 'de', 'disk', 'downloaded', 100)"#).bind(c.other_media).execute(&c.pool).await.unwrap();
    let (_, h) = call(&c, "GET", "/api/subtitles/history", &c.reader, None).await;
    assert_eq!(h["total"], 2);
    let (_, h) = call(&c, "GET", "/api/subtitles/history", &c.admin, None).await;
    assert_eq!(h["total"], 3);
    assert_eq!(h["data"][0]["mediaTitle"], "Other");
    assert_eq!(
        call(&c, "GET", "/api/subtitles/health", &c.reader, None)
            .await
            .0,
        403
    );
    let (s, v) = call(&c, "GET", "/api/subtitles/health", &c.admin, None).await;
    assert_eq!((s, v), (200, json!([])));
    assert_eq!(
        call(&c, "GET", "/api/subtitles/missing", "bad", None)
            .await
            .0,
        401
    );
}
