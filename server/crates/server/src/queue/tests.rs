//! The queue through its SQL: fencing, restart, retries, capabilities and the cancel trigger.
use super::store::{self, Settled, Want};
use crate::sync::MutexExt;
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
        hw: &[],
        sw: codecs,
        fallback: codecs,
        max_jobs: 1,
        local: false,
        karaoke: false,
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
        store::heartbeat(&pool, id, "w1", 1, 0.5, false, None)
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
        store::heartbeat(&pool, id, "w2", 2, 0.5, false, None)
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
    let beat = store::heartbeat(&pool, id, "w1", 1, 0.4, false, None)
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
async fn a_job_without_a_codec_is_only_leased_to_the_cpu_device(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    let id = job(&pool, None, "/m/a.mkv").await;
    let hevc = vec!["hevc".to_string()];
    let gpu = Want {
        device: "gpu0",
        hw: &hevc,
        ..want("w1", &hevc)
    };
    assert!(store::take(&pool, &gpu).await.unwrap().is_none());
    let taken = store::take(&pool, &want("w1", &hevc))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(taken.id, id);
}

#[sqlx::test(migrations = false)]
async fn a_hardware_planned_encode_stays_off_the_cpu_while_a_gpu_exists(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    let id = job(&pool, Some("hevc"), "/m/a.mkv").await;
    let hevc = vec!["hevc".to_string()];
    fn cpu<'a>(sw: &'a [String], fallback: &'a [String]) -> Want<'a> {
        Want {
            hw: &[],
            sw,
            fallback,
            ..want("w1", &[])
        }
    }
    // A registered device encodes hevc in hardware: the cpu has no fallback.
    assert!(
        store::take(&pool, &cpu(&hevc, &[]))
            .await
            .unwrap()
            .is_none()
    );
    let gpu = Want {
        device: "gpu0",
        hw: &hevc,
        sw: &[],
        fallback: &[],
        ..want("w1", &[])
    };
    assert!(store::take(&pool, &gpu).await.unwrap().is_some());
    sqlx::query(r#"UPDATE jobs SET state = 'queued', "leaseUntil" = NULL, "workerId" = NULL, "deviceId" = NULL WHERE id = $1"#)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    // Nobody has hardware: the cpu takes it, and a software plan goes to software devices only.
    let fallback = vec!["hevc".to_string()];
    assert!(
        store::take(&pool, &cpu(&hevc, &fallback))
            .await
            .unwrap()
            .is_some()
    );
}

#[sqlx::test(migrations = false)]
async fn a_job_running_off_its_leased_gpu_counts_on_the_device_it_runs_on(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    let first = job(&pool, Some("hevc"), "/m/a.mkv").await;
    job(&pool, Some("hevc"), "/m/b.mkv").await;
    let hevc = vec!["hevc".to_string()];
    let gpu = Want {
        device: "gpu0",
        hw: &hevc,
        sw: &[],
        fallback: &[],
        ..want("w1", &[])
    };
    let cpu = want("w1", &hevc);
    assert!(store::take(&pool, &gpu).await.unwrap().is_some());
    assert!(store::take(&pool, &gpu).await.unwrap().is_none());
    // The hardware encode was redone in software: the GPU is free, the CPU slot is taken.
    store::heartbeat(&pool, first, "w1", 1, 0.5, false, Some("cpu"))
        .await
        .unwrap()
        .unwrap();
    assert!(store::take(&pool, &cpu).await.unwrap().is_none());
    assert!(store::take(&pool, &gpu).await.unwrap().is_some());
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
    let hevc = vec!["hevc".to_string()];
    let kept = job(&pool, Some("hevc"), "/m/a.mkv").await;
    let lost = job(&pool, Some("hevc"), "/m/b.mkv").await;
    store::take(&pool, &want("w1", &hevc))
        .await
        .unwrap()
        .unwrap();
    store::take(
        &pool,
        &Want {
            device: "gpu",
            ..want("w1", &hevc)
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
           INSERT INTO library_folders (id, "libraryId", path) VALUES (1, 1, '/m');
           INSERT INTO media (id, title, type) VALUES (1, 'M', 'movie')"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    for sql in [
        r#"UPDATE media_files SET "relativePath" = 'b.mkv' WHERE id = $1"#,
        r#"DELETE FROM media_files WHERE id = $1"#,
    ] {
        let file: i32 = sqlx::query_scalar(
            r#"INSERT INTO media_files ("mediaId", "folderId", "relativePath", size, quality) VALUES (1, 1, 'a.mkv', 1, 'x') RETURNING id"#,
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

#[sqlx::test(migrations = false)]
async fn a_worker_without_the_library_is_not_leased_what_needs_server_paths(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    let hevc = vec!["hevc".to_string()];
    for plan in [
        json!({ "level": "metadata", "codec": null }),
        json!({ "level": "remux", "codec": null, "extraSubtitles": [{ "path": "/m/a.srt" }] }),
    ] {
        sqlx::query(
            r#"INSERT INTO jobs (kind, payload, "profileHash", "inPath", "inSize")
               VALUES ('optimize', $1, 'h', '/m/a.mkv', 1)"#,
        )
        .bind(json!({ "info": { "video": [], "audio": [], "subtitles": [] }, "plan": plan }))
        .execute(&pool)
        .await
        .unwrap();
    }
    assert!(
        store::take(&pool, &want("t1:w", &hevc))
            .await
            .unwrap()
            .is_none()
    );
    let local = Want {
        local: true,
        ..want("w", &hevc)
    };
    assert!(store::take(&pool, &local).await.unwrap().is_some());
}

#[test]
fn workers_lists_only_live_instances() {
    let q = super::Shared::default();
    let w = || super::Worker {
        principal: super::Principal::Local,
        engine_version: "1".into(),
        devices: vec![],
        features: vec![],
    };
    q.register("old".into(), w());
    q.register("new".into(), w());
    q.seen.lock_clean().insert(
        "old".into(),
        std::time::Instant::now() - super::LIVE - std::time::Duration::from_secs(1),
    );
    let keys: Vec<String> = q.workers().into_iter().map(|(k, ..)| k).collect();
    assert_eq!(keys, ["new"]);
}

#[sqlx::test(migrations = false)]
async fn a_lease_wakes_the_job_watcher(pool: PgPool) {
    use futures_util::FutureExt;
    crate::db::migrate(&pool).await.unwrap();
    let hevc = vec!["hevc".to_string()];
    job(&pool, Some("hevc"), "/m/a.mkv").await;
    let woken = super::watch::CHANGED.notified();
    tokio::pin!(woken);
    woken.as_mut().enable();
    store::take(&pool, &want("w1", &hevc))
        .await
        .unwrap()
        .unwrap();
    assert!(woken.as_mut().now_or_never().is_some());
}

async fn separate_job(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        r#"INSERT INTO jobs (kind, payload, "profileHash", priority, "inPath", "inSize")
           VALUES ('separate', '{"info":{"video":[],"audio":[],"subtitles":[]}}', 'h', -1, '/m/a.flac', 1)
           RETURNING id"#,
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrations = false)]
async fn a_separate_job_goes_only_to_a_karaoke_worker_on_its_cpu_device(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    separate_job(&pool).await;
    let on = |device: &'static str| Want {
        device,
        karaoke: true,
        ..want("w1", &[])
    };
    assert!(
        store::take(&pool, &want("w1", &[]))
            .await
            .unwrap()
            .is_none()
    );
    assert!(store::take(&pool, &on("gpu0")).await.unwrap().is_none());
    let t = store::take(&pool, &on("cpu")).await.unwrap().unwrap();
    assert_eq!((t.kind.as_str(), t.staged_path), ("separate", None));
}

#[sqlx::test(migrations = false)]
async fn a_model_failure_requeues_without_counting(pool: PgPool) {
    crate::db::migrate(&pool).await.unwrap();
    let id = separate_job(&pool).await;
    let w = Want {
        karaoke: true,
        ..want("w1", &[])
    };
    store::take(&pool, &w).await.unwrap().unwrap();
    store::fail(&pool, id, "w1", 1, &err(JobErrorClass::Model))
        .await
        .unwrap();
    let (state, failures): (String, i32) =
        sqlx::query_as("SELECT state, failures FROM jobs WHERE id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((state.as_str(), failures), ("queued", 0));
}

#[test]
fn a_touch_keeps_a_busy_worker_live() {
    let q = super::Shared::default();
    q.register(
        "w".into(),
        super::Worker {
            principal: super::Principal::Local,
            engine_version: "1".into(),
            devices: vec![],
            features: vec![],
        },
    );
    let stale = std::time::Instant::now() - super::LIVE - std::time::Duration::from_secs(1);
    q.seen.lock_clean().insert("w".into(), stale);
    assert!(q.workers().is_empty());
    q.touch("w");
    assert_eq!(q.workers().len(), 1);
}

#[sqlx::test(migrations = false)]
async fn a_state_change_without_a_wake_up_is_announced_by_the_fallback(pool: PgPool) {
    use crate::{config::Config, events::Bus, events::SseEvent, state::AppState};
    crate::db::migrate(&pool).await.unwrap();
    sqlx::query(
        r#"INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL)"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let st = AppState::new(
        pool.clone(),
        Config::from_lookup(|_| None),
        "0123456789abcdef0123456789abcdef",
    );
    let mut rx = st.hub.subscribe();
    super::watch::spawn_with_fallback(&st, std::time::Duration::from_millis(100));
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let id = job(&pool, Some("hevc"), "/m/a.mkv").await;
    sqlx::query("UPDATE jobs SET state = 'cancelled' WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let seen = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Ok(bus) = rx.recv().await
                && let Bus::Sse(SseEvent::OptimizeJobChanged { job_id, state }) = &*bus
                && (*job_id, state.as_str()) == (id, "cancelled")
            {
                return;
            }
        }
    })
    .await;
    assert!(seen.is_ok(), "the cancellation was announced");
}
