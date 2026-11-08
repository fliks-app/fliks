//! Remote workers: the resumable upload, its hash check and the grant that ends with its lease.
use super::{remote, routes::worker_router, tokens};
use crate::{config::Config, state::AppState};
use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
};
use fliks_engine_core::api::{ResolveMediaId, ResolvePurpose, ResolveRequest};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

async fn world(pool: &PgPool) -> (AppState, String, i64, std::path::PathBuf) {
    crate::db::migrate(pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let (row, token) = tokens::create(pool, "w").await.unwrap();
    let dir = std::env::temp_dir().join(format!("fliks-remote-{}", crate::config::random_hex(6)));
    std::fs::create_dir_all(&dir).unwrap();
    let staged = dir.join(".fliks-opt-1-1.tmp");
    let job: i64 = sqlx::query_scalar(
        r#"INSERT INTO jobs (kind, payload, "profileHash", state, attempt, "workerId", "leaseUntil", "stagedPath")
           VALUES ('optimize', $1, 'h', 'leased', 1, $2, now() + interval '1 minute', $3) RETURNING id"#,
    )
    .bind(json!({"info": {"video": [], "audio": [], "subtitles": []}, "plan": {"level": "remux"}}))
    .bind(format!("t{}:w", row.id))
    .bind(staged.to_string_lossy().as_ref())
    .fetch_one(pool)
    .await
    .unwrap();
    (st, token, job, staged)
}

async fn put(
    st: &AppState,
    token: &str,
    job: i64,
    offset: u64,
    body: &str,
    last: bool,
) -> (StatusCode, String) {
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/engine/jobs/{job}/output"))
        .header("authorization", format!("Bearer {token}"))
        .header("upload-offset", offset.to_string())
        .header("x-fliks-attempt", "1")
        .header("x-fliks-worker-id", "w")
        .header("upload-complete", if last { "?1" } else { "?0" })
        .body(Body::from(body.to_owned()))
        .unwrap();
    let res = worker_router()
        .with_state(st.clone())
        .oneshot(req)
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[sqlx::test(migrations = false)]
async fn an_upload_is_resumable_and_checked_against_its_hash(pool: PgPool) {
    let (st, token, job, staged) = world(&pool).await;
    assert_eq!(
        put(&st, &token, job, 0, "abcd", false).await.0,
        StatusCode::OK
    );
    let (status, body) = put(&st, &token, job, 2, "cdef", false).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body.contains(r#""receivedBytes":4"#), "{body}");
    assert_eq!(put(&st, &token, job, 4, "ef", true).await.0, StatusCode::OK);
    assert_eq!(std::fs::read(&staged).unwrap(), b"abcdef");
    let sha: String = Sha256::digest(b"abcdef")
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert!(remote::output_error(&st, job, 1, 6, &sha).await.is_none());
    assert!(remote::output_error(&st, job, 1, 6, "00").await.is_some());
    assert!(remote::output_error(&st, job, 1, 5, &sha).await.is_some());
    // Another worker's token cannot write to this lease.
    let (_, other) = tokens::create(&pool, "o").await.unwrap();
    assert_eq!(
        put(&st, &other, job, 6, "x", false).await.0,
        StatusCode::CONFLICT
    );
    let _ = std::fs::remove_dir_all(staged.parent().unwrap());
}

#[sqlx::test(migrations = false)]
async fn a_grant_ends_with_its_lease(pool: PgPool) {
    let (st, _, job, staged) = world(&pool).await;
    let token = st.queue.mint(&st.grant_key, job, 1, 7);
    let req = |file| ResolveRequest {
        media_id: ResolveMediaId::File(file),
        credential: format!("Bearer {token}"),
        purpose: ResolvePurpose::Download,
        subtitle_id: None,
        stream_index: None,
        credential_source: None,
    };
    // Bound to its file: another one is refused.
    assert!(
        !remote::grant_answer(&st, &req(8))
            .await
            .unwrap()
            .unwrap()
            .allow
    );
    // The file row does not exist here: refused too, but the credential is recognised.
    assert!(remote::grant_answer(&st, &req(7)).await.unwrap().is_some());
    sqlx::query(
        r#"UPDATE jobs SET state = 'queued', "workerId" = NULL, "leaseUntil" = NULL WHERE id = $1"#,
    )
    .bind(job)
    .execute(&pool)
    .await
    .unwrap();
    remote::sweep(&st).await;
    assert!(
        !remote::grant_answer(&st, &req(7))
            .await
            .unwrap()
            .unwrap()
            .allow
    );
    let _ = std::fs::remove_dir_all(staged.parent().unwrap());
}

#[sqlx::test(migrations = false)]
async fn a_grant_survives_a_restart_and_a_forged_one_is_refused(pool: PgPool) {
    let (st, _, job, staged) = world(&pool).await;
    let token = st.queue.mint(&st.grant_key, job, 1, 7);
    // A new process holds no grant map: the signature and the leased row carry the answer.
    let restarted = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let req = |token: &str| ResolveRequest {
        media_id: ResolveMediaId::File(7),
        credential: format!("Bearer {token}"),
        purpose: ResolvePurpose::Download,
        subtitle_id: None,
        stream_index: None,
        credential_source: None,
    };
    let mut parts: Vec<_> = token.split('.').map(str::to_owned).collect();
    let live = |t: String| {
        let st = restarted.clone();
        async move { remote::grant_answer(&st, &req(&t)).await.unwrap() }
    };
    // The file row is missing here, so a valid grant answers deny but is recognised as one.
    assert!(live(token.clone()).await.is_some());
    parts[1] = "2".into();
    let forged = parts.join(".");
    assert!(!live(forged).await.unwrap().allow);
    assert!(super::remote::parse_grant(&restarted.grant_key, &token).is_some());
    assert!(super::remote::parse_grant(b"another key", &token).is_none());
    let _ = std::fs::remove_dir_all(staged.parent().unwrap());
}

#[sqlx::test(migrations = false)]
async fn an_upload_cuts_leftovers_renews_the_lease_and_has_a_ceiling(pool: PgPool) {
    let (st, token, job, staged) = world(&pool).await;
    assert_eq!(
        put(&st, &token, job, 0, "abcd", false).await.0,
        StatusCode::OK
    );
    // Bytes a failed write left past the counted length are overwritten, not kept.
    std::fs::write(&staged, b"abcdXX").unwrap();
    sqlx::query(r#"UPDATE jobs SET "leaseUntil" = now() + interval '1 second'"#)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(put(&st, &token, job, 4, "ef", true).await.0, StatusCode::OK);
    assert_eq!(std::fs::read(&staged).unwrap(), b"abcdef");
    let left: f64 = sqlx::query_scalar(
        r#"SELECT extract(epoch FROM "leaseUntil" - now())::float8 FROM jobs WHERE id = $1"#,
    )
    .bind(job)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(left > 30.0, "{left}");
    assert_eq!(
        put(&st, &token, job, 1 << 40, "x", false).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let _ = std::fs::remove_dir_all(staged.parent().unwrap());
}

#[sqlx::test(migrations = false)]
async fn a_failed_hash_leaves_the_upload_unloaded(pool: PgPool) {
    let (st, token, job, staged) = world(&pool).await;
    // A directory cannot be hashed: the upload stays unloaded and the call fails instead of counting 0.
    std::fs::create_dir(&staged).unwrap();
    assert_eq!(
        put(&st, &token, job, 0, "ab", false).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    std::fs::remove_dir(&staged).unwrap();
    assert_eq!(put(&st, &token, job, 0, "ab", true).await.0, StatusCode::OK);
    let _ = std::fs::remove_dir_all(staged.parent().unwrap());
}

#[sqlx::test(migrations = false)]
async fn a_stale_result_does_not_touch_the_live_upload(pool: PgPool) {
    let (st, token, job, staged) = world(&pool).await;
    assert_eq!(
        put(&st, &token, job, 0, "abcd", false).await.0,
        StatusCode::OK
    );
    let req = Request::builder()
        .method(Method::POST)
        .uri(format!("/engine/jobs/{job}/result"))
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"workerId": "w", "attempt": 0, "ok": true, "outSize": 4, "outSha256": "00"})
                .to_string(),
        ))
        .unwrap();
    let res = worker_router()
        .with_state(st.clone())
        .oneshot(req)
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);
    assert_eq!(st.queue.uploads.lock().unwrap().len(), 1);
    assert!(st.queue.uploads.lock().unwrap().contains_key(&(job, 1)));
    // An output the job has no staging path for is an error, not an accepted one.
    sqlx::query(r#"UPDATE jobs SET "stagedPath" = NULL WHERE id = $1"#)
        .bind(job)
        .execute(&pool)
        .await
        .unwrap();
    assert!(remote::output_error(&st, job, 1, 4, "00").await.is_some());
    let _ = std::fs::remove_dir_all(staged.parent().unwrap());
}

#[sqlx::test(migrations = false)]
async fn a_rename_keeps_the_leases_of_a_token(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    let (row, _) = tokens::create(&pool, "w").await.unwrap();
    let patch = |v: serde_json::Value| serde_json::from_value::<tokens::Patch>(v).unwrap();
    let ended = |v| async { tokens::update(&pool, row.id, &patch(v)).await.unwrap() };
    assert_eq!(ended(json!({"name": "renamed"})).await, Some(false));
    assert_eq!(ended(json!({"pathAccess": "shared"})).await, Some(true));
    assert_eq!(ended(json!({"pathAccess": "shared"})).await, Some(false));
    assert_eq!(ended(json!({"enabled": false})).await, Some(true));
}
