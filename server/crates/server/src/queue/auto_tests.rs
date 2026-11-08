//! New-file queueing, the review pass and verification against a throwaway DB and real files.
use super::{auto, enqueue, enqueue::Outcome, settings};
use crate::{
    config::Config, ingest::rescan::PROBE_VERSION, optimize::profile::Preset, state::AppState,
};
use serde_json::json;
use sqlx::PgPool;
use std::{fs, path::PathBuf};

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct W {
    st: AppState,
    dir: PathBuf,
    file: i32,
}

impl Drop for W {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// A library with a cleanup-only profile (`min_age_days`), one movie file whose global title is a release name.
async fn world(pool: PgPool, min_age_days: u32, new_files: bool) -> W {
    crate::db::migrate(&pool).await.unwrap();
    let dir = PathBuf::from("/tmp/fliks-parity/s6-auto").join(crate::config::random_hex(6));
    fs::create_dir_all(dir.join("M")).unwrap();
    let src = dir.join("M/a.mkv");
    fs::write(&src, b"bytes").unwrap();
    let m = fs::metadata(&src).unwrap();
    let mtime = crate::ingest::rescan::mtime_ms(&m);
    let mut doc = serde_json::to_value(Preset::CleanupOnly.document()).unwrap();
    doc["eligible"]["min_age_days"] = min_age_days.into();
    let profile: i32 = sqlx::query_scalar(
        r#"INSERT INTO optimize_profiles (name, document) VALUES ('p', $1) RETURNING id"#,
    )
    .bind(doc)
    .fetch_one(&pool)
    .await
    .unwrap();
    let lib: i32 = sqlx::query_scalar(
        r#"WITH l AS (INSERT INTO libraries (name, "mediaTypes", "optimizeProfileId", "optimizeNewFiles")
             VALUES ('L', '["movie"]'::jsonb, $2, $3) RETURNING id),
           f AS (INSERT INTO library_folders ("libraryId", path) SELECT id, $1 FROM l) SELECT id FROM l"#,
    )
    .bind(dir.to_string_lossy().as_ref())
    .bind(profile)
    .bind(new_files)
    .fetch_one(&pool)
    .await
    .unwrap();
    let media: i32 = sqlx::query_scalar(
        r#"INSERT INTO media (title, type, "libraryId", "folderName") VALUES ('M', 'movie', $1, 'M') RETURNING id"#,
    )
    .bind(lib)
    .fetch_one(&pool)
    .await
    .unwrap();
    let info = json!({"video": [{"streamIndex": 0, "codec": "hevc", "width": 1920, "height": 1080,
        "hasStatisticsTags": true}], "audio": [], "subtitles": [], "formatName": "matroska,webm",
        "tags": {"title": "Movie.2020.1080p.BluRay.x264-GRP"}, "durationSeconds": 100.0});
    let file: i32 = sqlx::query_scalar(
        r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId", "mtimeMs", "streamInfo",
             "osdbHash", "probeVersion")
           SELECT $1, 'M/a.mkv', $2, 'x', df."folderId", $3, $4, 'deadbeef00000000', $6
           FROM library_default_folders df WHERE df."libraryId" = $5 RETURNING id"#,
    )
    .bind(media)
    .bind(m.len() as i64)
    .bind(mtime)
    .bind(info)
    .bind(lib)
    .bind(PROBE_VERSION)
    .fetch_one(&pool)
    .await
    .unwrap();
    let cfg = Config::from_lookup(|_| None);
    W {
        st: AppState::new(pool, cfg, SECRET),
        dir,
        file,
    }
}

async fn not_before_days(w: &W) -> f64 {
    sqlx::query_scalar(
        r#"SELECT (EXTRACT(EPOCH FROM "notBefore" - now()) / 86400)::float8 FROM jobs WHERE "mediaFileId" = $1"#,
    )
    .bind(w.file)
    .fetch_one(&w.st.db)
    .await
    .unwrap()
}

#[sqlx::test(migrations = false)]
async fn a_new_file_waits_for_the_minimum_age(pool: PgPool) {
    let w = world(pool, 3, true).await;
    assert_eq!(
        enqueue::queue_new(&w.st, w.file).await.unwrap().outcome,
        Outcome::Queued
    );
    let d = not_before_days(&w).await;
    assert!((2.9..3.1).contains(&d), "notBefore in {d} days");
    assert!(!crate::ingest::post_import::starts_now(&w.st, w.file).await);
}

#[sqlx::test(migrations = false)]
async fn a_new_file_without_minimum_age_starts_at_once(pool: PgPool) {
    let w = world(pool, 0, true).await;
    assert_eq!(
        enqueue::queue_new(&w.st, w.file).await.unwrap().outcome,
        Outcome::Queued
    );
    assert!(crate::ingest::post_import::starts_now(&w.st, w.file).await);
}

#[sqlx::test(migrations = false)]
async fn a_library_that_does_not_optimize_new_files_queues_nothing(pool: PgPool) {
    let w = world(pool, 0, false).await;
    assert_ne!(
        enqueue::queue_new(&w.st, w.file).await.unwrap().outcome,
        Outcome::Queued
    );
    assert_eq!(auto::review_new(&w.st, 0).await.unwrap().0, 0);
}

#[sqlx::test(migrations = false)]
async fn the_review_continues_after_its_cursor(pool: PgPool) {
    let w = world(pool, 0, true).await;
    assert_eq!(auto::review_new(&w.st, w.file).await.unwrap(), (0, None));
    assert_eq!(auto::review_new(&w.st, 0).await.unwrap(), (1, None));
}

#[sqlx::test(migrations = false)]
async fn a_file_older_than_the_flag_is_never_queued_automatically(pool: PgPool) {
    let w = world(pool, 0, true).await;
    sqlx::query(r#"UPDATE libraries SET "optimizeNewFilesSince" = now() + interval '1 minute'"#)
        .execute(&w.st.db)
        .await
        .unwrap();
    assert_ne!(
        enqueue::queue_new(&w.st, w.file).await.unwrap().outcome,
        Outcome::Queued
    );
    assert_eq!(auto::review_new(&w.st, 0).await.unwrap().0, 0);
}

#[cfg(unix)]
#[sqlx::test(migrations = false)]
async fn a_hard_linked_file_is_reviewed_until_it_is_free(pool: PgPool) {
    let w = world(pool, 0, true).await;
    sqlx::query(r#"UPDATE media_files SET "createdAt" = now() - interval '90 days'"#)
        .execute(&w.st.db)
        .await
        .unwrap();
    sqlx::query(r#"UPDATE libraries SET "optimizeNewFilesSince" = now() - interval '100 days'"#)
        .execute(&w.st.db)
        .await
        .unwrap();
    let link = w.dir.join("seed.mkv");
    fs::hard_link(w.dir.join("M/a.mkv"), &link).unwrap();
    assert_eq!(
        enqueue::queue_new(&w.st, w.file).await.unwrap().outcome,
        Outcome::Shared
    );
    assert_eq!(auto::review_new(&w.st, 0).await.unwrap().0, 0);
    assert_eq!(auto::review_new(&w.st, 0).await.unwrap().0, 0);
    let markers: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM jobs WHERE state = 'skipped'"#)
        .fetch_one(&w.st.db)
        .await
        .unwrap();
    assert_eq!(markers, 1);
    fs::remove_file(link).unwrap();
    assert_eq!(auto::review_new(&w.st, 0).await.unwrap().0, 1);
    assert_eq!(auto::review_new(&w.st, 0).await.unwrap().0, 0);
}

#[sqlx::test(migrations = false)]
async fn verification_is_queued_on_demand_and_scheduled_by_interval(pool: PgPool) {
    let w = world(pool, 0, false).await;
    assert_eq!(auto::schedule_verify(&w.st).await.unwrap(), 0);
    let q = auto::queue_verify(&w.st, &[w.file], 0).await.unwrap();
    assert_eq!(q[0].outcome, Outcome::Queued);
    let kind: String = sqlx::query_scalar(r#"SELECT kind FROM jobs WHERE "mediaFileId" = $1"#)
        .bind(w.file)
        .fetch_one(&w.st.db)
        .await
        .unwrap();
    assert_eq!(kind, "verify");
    // Verified a day ago: due again after 1 day, not after 7, and nothing while a job is active.
    sqlx::query(r#"UPDATE jobs SET state = 'done', "finishedAt" = now() - interval '2 days'"#)
        .execute(&w.st.db)
        .await
        .unwrap();
    let conf = |days| settings::Settings {
        verify_interval_days: days,
        ..settings::Settings::default()
    };
    settings::save(&w.st.db, &conf(7)).await.unwrap();
    assert_eq!(auto::schedule_verify(&w.st).await.unwrap(), 0);
    settings::save(&w.st.db, &conf(1)).await.unwrap();
    assert_eq!(auto::schedule_verify(&w.st).await.unwrap(), 1);
    assert_eq!(auto::schedule_verify(&w.st).await.unwrap(), 0);
}

#[sqlx::test(migrations = false)]
async fn a_verification_does_not_hide_a_new_file_from_the_review(pool: PgPool) {
    let w = world(pool, 0, true).await;
    auto::queue_verify(&w.st, &[w.file], 0).await.unwrap();
    sqlx::query(r#"UPDATE jobs SET state = 'done', "finishedAt" = now()"#)
        .execute(&w.st.db)
        .await
        .unwrap();
    assert_eq!(auto::review_new(&w.st, 0).await.unwrap().0, 1);
}
