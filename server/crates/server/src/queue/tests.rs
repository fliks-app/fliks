//! The queue through its SQL: fencing, restart, retries, capabilities and the cancel trigger.
use super::store::{self, Settled, Want};
use fliks_engine_core::api::{JobError, JobErrorClass};
use serde_json::json;
use sqlx::PgPool;

async fn job(pool: &PgPool, codec: Option<&str>, in_path: &str) -> i64 {
    let plan = json!({ "level": "reencode", "codec": codec });
    sqlx::query_scalar(
        r#"INSERT INTO jobs (kind, payload, "profileHash", "inPath", "inSize")
           VALUES ('optimize', $1, 'h', $2, 1) RETURNING id"#,
    )
    .bind(json!({ "info": { "video": [], "audio": [], "subtitles": [] }, "plan": plan }))
    .bind(in_path)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn want<'a>(key: &'a str, codecs: &'a [String]) -> Want<'a> {
    Want {
        key,
        device: "cpu",
        codecs,
        max_jobs: 1,
        local: false,
    }
}

fn err(class: JobErrorClass) -> JobError {
    JobError {
        class,
        message: "x".into(),
        stderr_tail: None,
    }
}

async fn state(pool: &PgPool, id: i64) -> String {
    sqlx::query_scalar("SELECT state FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrations = false)]
async fn a_stale_worker_is_fenced_out_after_its_lease_expired(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    let hevc = vec!["hevc".to_string()];
    let id = job(&pool, Some("hevc"), "/m/a.mkv").await;
    let first = store::take(&pool, &want("w1", &hevc))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.attempt, 1);
    sqlx::query(r#"UPDATE jobs SET "leaseUntil" = now() - interval '1 second'"#)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(store::expire(&pool).await.unwrap(), 1);
    let second = store::take(&pool, &want("w2", &hevc))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second.attempt, 2);
    assert!(
        store::heartbeat(&pool, id, "w1", 1, 0.5, false)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store::succeed(&pool, id, "w1", 1, 9, Some("ab"), None)
            .await
            .unwrap(),
        Settled::Stale
    );
    assert!(
        store::heartbeat(&pool, id, "w2", 2, 0.5, false)
            .await
            .unwrap()
            .is_some()
    );
}

#[sqlx::test(migrations = false)]
async fn a_restart_mid_job_keeps_the_lease(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    let id = job(&pool, None, "/m/a.mkv").await;
    store::take(&pool, &want("w1", &[])).await.unwrap().unwrap();
    sqlx::query(r#"UPDATE jobs SET "leaseUntil" = now() - interval '1 minute'"#)
        .execute(&pool)
        .await
        .unwrap();
    store::boot(&pool).await.unwrap();
    assert_eq!(store::expire(&pool).await.unwrap(), 0);
    let beat = store::heartbeat(&pool, id, "w1", 1, 0.4, false)
        .await
        .unwrap()
        .unwrap();
    assert!(!beat.cancel);
    assert_eq!(state(&pool, id).await, "leased");
}

#[sqlx::test(migrations = false)]
async fn a_device_only_takes_a_codec_it_encodes(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    job(&pool, Some("av1"), "/m/a.mkv").await;
    let hevc = vec!["hevc".to_string()];
    assert!(
        store::take(&pool, &want("w1", &hevc))
            .await
            .unwrap()
            .is_none()
    );
    let av1 = vec!["av1".to_string()];
    assert!(
        store::take(&pool, &want("w1", &av1))
            .await
            .unwrap()
            .is_some()
    );
}

#[sqlx::test(migrations = false)]
async fn engine_failures_retry_then_fail_and_busy_does_not_count(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    let id = job(&pool, None, "/m/a.mkv").await;
    for attempt in 1..=3 {
        sqlx::query(r#"UPDATE jobs SET "notBefore" = now()"#)
            .execute(&pool)
            .await
            .unwrap();
        store::take(&pool, &want("w1", &[])).await.unwrap().unwrap();
        store::fail(&pool, id, "w1", attempt, &err(JobErrorClass::Engine))
            .await
            .unwrap();
    }
    assert_eq!(state(&pool, id).await, "failed");
    let busy = job(&pool, None, "/m/b.mkv").await;
    store::take(&pool, &want("w1", &[])).await.unwrap().unwrap();
    store::fail(&pool, busy, "w1", 1, &err(JobErrorClass::Busy))
        .await
        .unwrap();
    let failures: i32 = sqlx::query_scalar("SELECT failures FROM jobs WHERE id = $1")
        .bind(busy)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!((state(&pool, busy).await.as_str(), failures), ("queued", 0));
}

#[sqlx::test(migrations = false)]
async fn hello_requeues_the_leases_the_instance_no_longer_holds(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    let kept = job(&pool, None, "/m/a.mkv").await;
    let lost = job(&pool, None, "/m/b.mkv").await;
    store::take(&pool, &want("w1", &[])).await.unwrap().unwrap();
    store::take(
        &pool,
        &Want {
            device: "gpu",
            ..want("w1", &[])
        },
    )
    .await
    .unwrap()
    .unwrap();
    let abandon = store::hello(&pool, "w1", &[(kept, 1), (999, 1)])
        .await
        .unwrap();
    assert_eq!(abandon, vec![999]);
    assert_eq!(state(&pool, kept).await, "leased");
    assert_eq!(state(&pool, lost).await, "queued");
}

#[sqlx::test(migrations = false)]
async fn moving_or_deleting_a_media_file_cancels_its_pending_job(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    sqlx::raw_sql(
        r#"INSERT INTO libraries (id, name) VALUES (1, 'L');
           INSERT INTO library_folders (id, "libraryId", path) VALUES (1, 1, '/m')"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    for sql in [
        r#"UPDATE media_files SET "relativePath" = 'b.mkv' WHERE id = $1"#,
        r#"DELETE FROM media_files WHERE id = $1"#,
    ] {
        let file: i32 = sqlx::query_scalar(
            r#"INSERT INTO media_files ("folderId", "relativePath", size, quality) VALUES (1, 'a.mkv', 1, 'x') RETURNING id"#,
        )
        .fetch_one(&pool).await.unwrap();
        let id = job(&pool, None, "/m/a.mkv").await;
        sqlx::query(r#"UPDATE jobs SET "mediaFileId" = $2 WHERE id = $1"#)
            .bind(id)
            .bind(file)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(sql).bind(file).execute(&pool).await.unwrap();
        assert_eq!(state(&pool, id).await, "cancelled");
    }
}
