//! An analysis groups its per-file jobs under one `Analyze` row and names each file's version.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::IntoResponse,
};
use fliks_server::{config::Config, events::subject::for_files, ingest::rescan, state::AppState};
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::{Semaphore, mpsc};

const QUALITIES: [&str; 2] = ["HDTV-1080p", "WEBDL-1080p"];

async fn media_with_two_versions(pool: &PgPool, dir: &std::path::Path) -> (i32, Vec<i32>) {
    fliks_server::db::migrate(pool).await.unwrap();
    std::fs::create_dir_all(dir).unwrap();
    let folder: i32 = sqlx::query_scalar(
        r#"WITH l AS (INSERT INTO libraries (name) VALUES ('l') RETURNING id)
           INSERT INTO library_folders ("libraryId", path) SELECT id, $1 FROM l RETURNING id"#,
    )
    .bind(dir.to_string_lossy().as_ref())
    .fetch_one(pool)
    .await
    .unwrap();
    let media: i32 = sqlx::query_scalar(
        r#"INSERT INTO media (title, type) VALUES ('Show', 'movie') RETURNING id"#,
    )
    .fetch_one(pool)
    .await
    .unwrap();
    let info = json!({"video": [], "audio": [], "durationSeconds": 60.0, "subtitles": [
        {"streamIndex": 2, "codec": "subrip", "language": "eng", "forced": false,
         "hearingImpaired": false, "isImageBased": false}]});
    let mut files = vec![];
    for (i, q) in QUALITIES.iter().enumerate() {
        let rel = format!("f{i}.mkv");
        std::fs::write(dir.join(&rel), b"x").unwrap();
        files.push(
            sqlx::query_scalar(
                r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId", "streamInfo")
                   VALUES ($1, $2, 1, $3, $4, $5) RETURNING id"#,
            )
            .bind(media)
            .bind(rel)
            .bind(q)
            .bind(folder)
            .bind(&info)
            .fetch_one(pool)
            .await
            .unwrap(),
        );
    }
    (media, files)
}

#[sqlx::test(migrations = false)]
async fn a_file_subject_carries_its_version_quality(pool: PgPool) {
    let dir = std::env::temp_dir().join(format!("fliks-analyze-{}", std::process::id()));
    let (_, files) = media_with_two_versions(&pool, &dir).await;
    let subjects = for_files(&pool, &files).await.unwrap();
    let got: Vec<_> = files
        .iter()
        .map(|f| subjects[f].quality.as_deref())
        .collect();
    assert_eq!(got, QUALITIES.map(Some));
    std::fs::remove_dir_all(dir).unwrap();
}

/// An engine whose `POST /v1/jobs` waits for a permit; each arrival is announced on the channel.
async fn holding_engine() -> (String, Arc<Semaphore>, mpsc::UnboundedReceiver<()>) {
    let gate = Arc::new(Semaphore::new(0));
    let (tx, rx) = mpsc::unbounded_channel();
    let g = gate.clone();
    let app = Router::new().fallback(move |req: Request<Body>| {
        let (gate, tx) = (g.clone(), tx.clone());
        async move {
            match (req.method().as_str(), req.uri().path()) {
                ("GET", "/v1/hello") => axum::Json(json!({"engineVersion": "0.2.0", "protocolVersion": 1,
                    "instanceId": "x", "features": ["probe", "capabilities", "decide", "sessions", "serve", "events"]}))
                .into_response(),
                ("GET", "/v1/config") => axum::Json(json!({"revision": 1})).into_response(),
                ("PUT", "/v1/config") => axum::Json(json!({})).into_response(),
                ("POST", "/v1/jobs") => {
                    tx.send(()).unwrap();
                    gate.acquire().await.unwrap().forget();
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
                _ => StatusCode::NOT_FOUND.into_response(),
            }
        }
    });
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (url, gate, rx)
}

#[sqlx::test(migrations = false)]
async fn per_file_jobs_are_children_of_the_analyze_row_which_ends_with_them(pool: PgPool) {
    let dir = std::env::temp_dir().join(format!("fliks-analyze-grp-{}", std::process::id()));
    let (media, files) = media_with_two_versions(&pool, &dir).await;
    let (url, gate, mut arrived) = holding_engine().await;
    let cfg = Config::from_lookup(|k| match k {
        "FLIKS_ENGINE_URL" => Some(url.clone()),
        "FLIKS_ENGINE_TOKEN" => Some("tok".into()),
        _ => None,
    });
    let st = AppState::new(pool.clone(), cfg, "0123456789abcdef0123456789abcdef");
    st.engine.start(pool, 4849).await;
    let opts: rescan::Analyze =
        serde_json::from_value(json!({"sprites": true, "subtitleCache": true})).unwrap();
    let run = tokio::spawn({
        let st = st.clone();
        async move { rescan::analyze(&st, media, opts).await.unwrap() }
    });
    for _ in 0..4 {
        arrived.recv().await.unwrap();
    }
    let list = serde_json::to_value(st.hub.activity().list(1, 25)).unwrap();
    assert_eq!(list["total"], 1);
    let parent = &list["data"][0];
    assert_eq!(parent["id"], format!("Analyze:{media}"));
    assert_eq!(parent["type"], "Analyze");
    assert_eq!(parent["subject"]["title"], "Show");
    assert_eq!(
        (&parent["current"], &parent["total"]),
        (&json!(0), &json!(4))
    );
    let kids = parent["children"].as_array().unwrap();
    let mut want = Vec::new();
    for (f, q) in files.iter().zip(QUALITIES) {
        for kind in ["GenerateSprite", "SubtitleExtract"] {
            want.push((format!("{kind}:{f}"), q));
        }
    }
    for (id, q) in want {
        let c = kids
            .iter()
            .find(|c| c["id"] == id)
            .unwrap_or_else(|| panic!("{id} missing: {kids:?}"));
        assert_eq!(c["parentId"], parent["id"]);
        assert_eq!(c["subject"]["quality"], q);
    }
    assert_eq!(kids.len(), 4);
    gate.add_permits(4);
    run.await.unwrap();
    assert_eq!(st.hub.activity().list(1, 25).total, 0);
    std::fs::remove_dir_all(dir).unwrap();
}
