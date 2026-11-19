//! Commit, recovery, restore and trash against a throwaway DB, a fake engine and real files.
use super::{
    commit::{self, End},
    recover, swap, trash,
};
use crate::{
    config::Config,
    engine::testkit::{Fake, RUNTIME, hello_body, ok},
    state::AppState,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{fs, path::PathBuf};

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct W {
    st: AppState,
    fake: Fake,
    dir: PathBuf,
    file: i32,
    job: i64,
    src: PathBuf,
}

impl Drop for W {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn info(codec: &str, seconds: f64) -> Value {
    json!({"video": [{"streamIndex": 0, "codec": codec, "width": 1920, "height": 1080}],
        "audio": [], "subtitles": [{"streamIndex": 3, "codec": "hdmv_pgs_subtitle", "language": "eng",
        "forced": false, "hearingImpaired": false, "isImageBased": true}], "durationSeconds": seconds})
}

async fn world(pool: PgPool, extra: Value) -> W {
    crate::db::migrate(&pool).await.unwrap();
    let dir = PathBuf::from("/tmp/fliks-parity/s5-ingest/tests-commit")
        .join(crate::config::random_hex(6));
    fs::create_dir_all(dir.join("M")).unwrap();
    let fake = Fake::start().await;
    let mut features = RUNTIME.to_vec();
    features.push("revoke");
    fake.hello(Some(hello_body(&features, "x")));
    let new = info("hevc", 100.0);
    fake.script(
        "POST",
        "/v1/probe",
        vec![ok(json!({"ok": true, "info": new}))],
    );
    fake.script("GET", "/v1/sessions", vec![ok(json!([]))]);
    fake.script("POST", "/v1/invalidate", vec![ok(json!({}))]);
    fake.script("POST", "/v1/revoke", vec![ok(json!({}))]);
    let env = [
        ("FLIKS_ENGINE_URL", fake.url.clone()),
        ("FLIKS_ENGINE_TOKEN", "tok".into()),
    ];
    let cfg = Config::from_lookup(|k| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()));
    let st = AppState::new(pool.clone(), cfg, SECRET);
    st.engine.start_with(Some(pool.clone()), 4849).await;
    let src = dir.join("M/a.h264.mkv");
    fs::write(&src, b"original bytes").unwrap();
    let staged = dir.join("M/.fliks-opt-1-1.tmp");
    fs::write(&staged, b"new").unwrap();
    let m = fs::metadata(&src).unwrap();
    let mtime = crate::ingest::rescan::mtime_ms(&m);
    let id = swap::ident(&src).unwrap();
    let lib: i32 = sqlx::query_scalar(
        r#"WITH l AS (INSERT INTO libraries (name, "mediaTypes", "allowRename") VALUES ('L', '["movie"]'::jsonb, true) RETURNING id),
           f AS (INSERT INTO library_folders ("libraryId", path) SELECT id, $1 FROM l) SELECT id FROM l"#,
    )
    .bind(dir.to_string_lossy().as_ref())
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
    let file: i32 = sqlx::query_scalar(
        r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId", "mtimeMs", "streamInfo", "osdbHash")
           SELECT $1, 'M/a.h264.mkv', $2, 'x', df."folderId", $3, $4, 'deadbeef00000000'
           FROM library_default_folders df WHERE df."libraryId" = $5 RETURNING id"#,
    )
    .bind(media)
    .bind(m.len() as i64)
    .bind(mtime)
    .bind(info("h264", 100.0))
    .bind(lib)
    .fetch_one(&pool)
    .await
    .unwrap();
    let job: i64 = sqlx::query_scalar(
        r#"INSERT INTO jobs (id, kind, "mediaFileId", payload, "profileHash", state, "inPath", "inSize", "inMtimeMs",
             "inDev", "inIno", "stagedPath", "outSize", result)
           VALUES (1, 'optimize', $1, $2, 'h', 'staged', $3, $4, $5, $6, $7, $8, 3, $9) RETURNING id"#,
    )
    .bind(file)
    .bind(json!({"info": info("h264", 100.0), "plan": {"level": "remux", "container": "mkv", "rename": true, "extraSubtitles": extra}}))
    .bind(dunce::canonicalize(&src).unwrap().to_string_lossy().as_ref())
    .bind(m.len() as i64)
    .bind(mtime)
    .bind(id.dev as i64)
    .bind(id.ino as i64)
    .bind(staged.to_string_lossy().as_ref())
    .bind(info("hevc", 100.0))
    .fetch_one(&pool)
    .await
    .unwrap();
    W {
        st,
        fake,
        dir,
        file,
        job,
        src,
    }
}

async fn ocr_row(w: &W) {
    sqlx::query(
        r#"INSERT INTO subtitle_files ("mediaId", "mediaFileId", language, "providerType", status, "sourceStreamIndex", "filePath", score)
           SELECT "mediaId", id, 'en', 'ocr', 'downloaded', 3, 'M/a.h264.en.srt', 100 FROM media_files WHERE id = $1"#,
    )
    .bind(w.file)
    .execute(&w.st.db)
    .await
    .unwrap();
}

async fn row(w: &W, sql: &str) -> Value {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT to_jsonb(t) FROM ({sql}) t"
    )))
    .fetch_one(&w.st.db)
    .await
    .unwrap()
}

async fn job(w: &W) -> Value {
    row(w, &format!("SELECT * FROM jobs WHERE id = {}", w.job)).await
}

#[sqlx::test(migrations = false)]
async fn a_commit_replaces_the_file_and_the_rows_follow(pool: PgPool) {
    let w = world(pool, json!([])).await;
    ocr_row(&w).await;
    commit::run(&w.st).await;
    let j = job(&w).await;
    assert_eq!(j["state"], "done", "{j}");
    assert!(j["result"]["trashPath"].is_string());
    // the renaming by words moved the file and kept its row
    let rel = row(&w, &format!("SELECT \"relativePath\" r, size, \"osdbHash\" h, \"streamInfo\"->'video'->0->>'codec' c FROM media_files WHERE id = {}", w.file)).await;
    assert_eq!(rel["r"], "M/a.h265.mkv");
    assert_eq!(
        (rel["size"].as_i64(), rel["h"].as_str(), rel["c"].as_str()),
        (Some(3), Some("deadbeef00000000"), Some("hevc"))
    );
    assert_eq!(fs::read(w.dir.join("M/a.h265.mkv")).unwrap(), b"new");
    let bak = j["result"]["trashPath"].as_str().unwrap();
    assert_eq!(fs::read(bak).unwrap(), b"original bytes");
    // the OCR row stays: its image track is still in the output
    let ocr = row(
        &w,
        r#"SELECT "sourceStreamIndex" s FROM subtitle_files WHERE "providerType" = 'ocr'"#,
    )
    .await;
    assert!(ocr["s"].is_number());
    // the crop is probed again and the engine told
    assert!(
        w.fake
            .seen("POST", "/v1/probe")
            .iter()
            .any(|p| p.body["crop"] == true)
    );
    assert_eq!(
        w.fake.seen("POST", "/v1/revoke")[0].body["mediaFileIds"],
        json!([w.file])
    );
}

#[sqlx::test(migrations = false)]
async fn ocr_subtitles_of_the_plan_go_with_the_commit(pool: PgPool) {
    let w = world(pool, json!([{"path": "PLACEHOLDER"}])).await;
    let srt = w.dir.join("M/a.h264.en.srt");
    fs::write(&srt, b"1").unwrap();
    sqlx::query("UPDATE jobs SET payload = jsonb_set(payload, '{plan,extraSubtitles}', $1::jsonb)")
        .bind(json!([{"path": srt}]))
        .execute(&w.st.db)
        .await
        .unwrap();
    ocr_row(&w).await;
    commit::run(&w.st).await;
    assert_eq!(job(&w).await["state"], "done");
    assert_eq!(
        row(
            &w,
            "SELECT count(*) n FROM subtitle_files WHERE \"providerType\" = 'ocr'"
        )
        .await["n"],
        0
    );
    assert!(!srt.exists());
    let trashed = w
        .dir
        .join(".fliks-trash")
        .join(format!("{}.ocr-1.srt", w.job));
    assert_eq!(
        fs::read(&trashed).unwrap(),
        b"1",
        "the SRT is trashed, not deleted"
    );
    recover::restore(&w.st, w.job).await.unwrap();
    assert!(
        srt.exists() && !trashed.exists(),
        "a restore brings it back"
    );
    assert_eq!(
        row(
            &w,
            "SELECT count(*) n FROM subtitle_files WHERE \"providerType\" = 'ocr'"
        )
        .await["n"],
        1,
        "and its row"
    );
}

#[sqlx::test(migrations = false)]
async fn a_job_without_a_rename_never_renames_the_file(pool: PgPool) {
    let w = world(pool, json!([])).await;
    sqlx::query("UPDATE jobs SET payload = jsonb_set(payload, '{plan,rename}', 'false'::jsonb)")
        .execute(&w.st.db)
        .await
        .unwrap();
    commit::run(&w.st).await;
    assert_eq!(job(&w).await["state"], "done");
    assert!(w.dir.join("M/a.h264.mkv").exists());
}

#[sqlx::test(migrations = false)]
async fn a_taken_name_keeps_the_source_name_and_a_new_extension_is_skipped(pool: PgPool) {
    let w = world(pool, json!([])).await;
    fs::write(w.dir.join("M/a.h265.mkv"), b"another file").unwrap();
    commit::run(&w.st).await;
    assert_eq!(job(&w).await["state"], "done");
    assert_eq!(
        fs::read(&w.src).unwrap(),
        b"new",
        "same extension: stays in place"
    );
    assert_eq!(
        fs::read(w.dir.join("M/a.h265.mkv")).unwrap(),
        b"another file"
    );
}

#[sqlx::test(migrations = false)]
async fn a_modified_source_is_skipped_and_untouched(pool: PgPool) {
    let w = world(pool, json!([])).await;
    fs::write(&w.src, b"edited by someone else").unwrap();
    commit::run(&w.st).await;
    assert_eq!(job(&w).await["state"], "skipped");
    assert_eq!(fs::read(&w.src).unwrap(), b"edited by someone else");
}

#[sqlx::test(migrations = false)]
async fn a_player_postpones_the_commit_without_a_failure(pool: PgPool) {
    let w = world(pool, json!([])).await;
    w.fake
        .script("GET", "/v1/sessions", vec![ok(json!([{"sid": "s"}]))]);
    let j = commit::Job::from_row(
        &sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT {} FROM jobs",
            commit::COLS
        )))
        .fetch_one(&w.st.db)
        .await
        .unwrap(),
    );
    let end = commit::commit(&w.st, &j).await;
    assert!(matches!(end, End::Busy(_)), "{end:?}");
    commit::settle(&w.st, w.job, &end).await;
    let j = job(&w).await;
    assert_eq!(j["state"], "staged");
    assert_eq!(fs::read(&w.src).unwrap(), b"original bytes");
    commit::run(&w.st).await;
    assert_eq!(job(&w).await["state"], "staged", "not due yet");
}

#[sqlx::test(migrations = false)]
async fn a_download_resolve_counts_as_a_reader(pool: PgPool) {
    let w = world(pool, json!([])).await;
    w.st.queue.note_download(w.file);
    commit::run(&w.st).await;
    assert_eq!(job(&w).await["state"], "staged");
}

#[sqlx::test(migrations = false)]
async fn recovery_finishes_a_commit_that_stopped_after_the_backup(pool: PgPool) {
    let w = world(pool, json!([])).await;
    let staged = w.dir.join("M/.fliks-opt-1-1.tmp");
    let journal = swap::Journal {
        source: w.src.clone(),
        staged: staged.clone(),
        target: w.src.clone(),
        policy: super::settings::OriginalPolicy::Trash,
        source_id: swap::ident(&w.src).unwrap(),
        staged_id: swap::ident(&staged).unwrap(),
        backup: swap::backup_path(super::settings::OriginalPolicy::Trash, &w.dir, &w.src, 1),
        old: swap::old_path(&w.src, 1),
        companions: vec![],
    };
    let bak = journal.backup.clone().unwrap();
    fs::create_dir_all(bak.parent().unwrap()).unwrap();
    fs::hard_link(&w.src, &bak).unwrap();
    sqlx::query(
        r#"UPDATE jobs SET state = 'committing', result = result || jsonb_build_object('journal', $1::jsonb)"#,
    )
    .bind(json!(journal))
    .execute(&w.st.db)
    .await
    .unwrap();
    recover::recover(&w.st, 0.0).await;
    assert_eq!(job(&w).await["state"], "done");
    assert_eq!(fs::read(&w.src).unwrap(), b"new");
    assert_eq!(fs::read(&bak).unwrap(), b"original bytes");
}

#[sqlx::test(migrations = false)]
async fn restore_brings_the_original_back_and_the_trash_is_purged_by_retention(pool: PgPool) {
    let w = world(pool, json!([])).await;
    commit::run(&w.st).await;
    let j = job(&w).await;
    let orig_bak = PathBuf::from(j["result"]["trashPath"].as_str().unwrap());
    recover::restore(&w.st, w.job).await.unwrap();
    assert_eq!(
        fs::read(w.dir.join("M/a.h264.mkv")).unwrap(),
        b"original bytes"
    );
    let bak = PathBuf::from(job(&w).await["result"]["trashPath"].as_str().unwrap());
    assert_ne!(bak, orig_bak, "the optimized file gets its own slot");
    assert_eq!(fs::read(&bak).unwrap(), b"new");
    assert!(recover::restore(&w.st, w.job).await.is_err(), "once");
    sqlx::query(r#"UPDATE jobs SET "finishedAt" = now() - interval '30 days'"#)
        .execute(&w.st.db)
        .await
        .unwrap();
    trash::purge(&w.st.db).await;
    assert!(!bak.exists());
    assert!(job(&w).await["result"]["trashPurgedAt"].is_string());
}

#[sqlx::test(migrations = false)]
async fn a_rename_leaves_the_files_of_a_longer_named_video_alone(pool: PgPool) {
    let w = world(pool, json!([])).await;
    for n in [
        "a.h264.en.srt",
        "a.h264.part2.mkv",
        "a.h264.part2.en.srt",
        "a.h264.txt",
    ] {
        fs::write(w.dir.join("M").join(n), b"x").unwrap();
    }
    commit::run(&w.st).await;
    assert_eq!(job(&w).await["state"], "done");
    let m = w.dir.join("M");
    assert!(m.join("a.h265.en.srt").exists() && !m.join("a.h264.en.srt").exists());
    assert!(
        m.join("a.h264.part2.en.srt").exists(),
        "belongs to the longer video"
    );
    assert!(
        m.join("a.h264.txt").exists(),
        "extension not in the companion setting"
    );
}

#[sqlx::test(migrations = false)]
async fn recovery_survives_a_changed_device_after_the_placement(pool: PgPool) {
    let w = world(pool, json!([])).await;
    let staged = w.dir.join("M/.fliks-opt-1-1.tmp");
    let policy = super::settings::OriginalPolicy::Trash;
    let mut journal = swap::Journal {
        source: w.src.clone(),
        staged: staged.clone(),
        target: w.src.clone(),
        policy,
        source_id: swap::ident(&w.src).unwrap(),
        staged_id: swap::ident(&staged).unwrap(),
        backup: swap::backup_path(policy, &w.dir, &w.src, 1),
        old: swap::old_path(&w.src, 1),
        companions: vec![],
    };
    let bak = journal.backup.clone().unwrap();
    fs::create_dir_all(bak.parent().unwrap()).unwrap();
    fs::hard_link(&w.src, &bak).unwrap();
    fs::rename(&staged, &w.src).unwrap();
    // A remount: the device and inode numbers of the journal no longer match.
    (journal.source_id.dev, journal.staged_id.dev) = (1, 1);
    (journal.source_id.ino, journal.staged_id.ino) = (1, 1);
    sqlx::query(
        r#"UPDATE jobs SET state = 'committing', result = result || jsonb_build_object('journal', $1::jsonb)"#,
    )
    .bind(json!(journal))
    .execute(&w.st.db)
    .await
    .unwrap();
    recover::recover(&w.st, 0.0).await;
    assert_eq!(job(&w).await["state"], "done");
    assert_eq!(fs::read(&w.src).unwrap(), b"new");
    assert_eq!(fs::read(&bak).unwrap(), b"original bytes");
}

#[sqlx::test(migrations = false)]
async fn a_restore_under_keep_never_writes_the_optimized_file_to_orig(pool: PgPool) {
    let w = world(pool, json!([])).await;
    let keep = super::settings::Settings {
        optimize_original: super::settings::OriginalPolicy::Keep,
        ..Default::default()
    };
    super::settings::save(&w.st.db, &keep).await.unwrap();
    commit::run(&w.st).await;
    let m = w.dir.join("M");
    let orig = m.join("a.h265.mkv.orig");
    assert_eq!(
        fs::read(&orig).unwrap(),
        b"original bytes",
        "named after the target"
    );
    recover::restore(&w.st, w.job).await.unwrap();
    assert_eq!(fs::read(m.join("a.h264.mkv")).unwrap(), b"original bytes");
    assert!(!orig.exists());
    let slot = w
        .dir
        .join(".fliks-trash")
        .join(format!("{}.optimized.bak", w.job));
    assert_eq!(fs::read(&slot).unwrap(), b"new");
    assert_eq!(
        job(&w).await["result"]["trashPath"]
            .as_str()
            .map(PathBuf::from),
        Some(slot)
    );
}

#[sqlx::test(migrations = false)]
async fn the_purge_leaves_the_original_of_an_unfinished_restore(pool: PgPool) {
    let w = world(pool, json!([])).await;
    commit::run(&w.st).await;
    let bak = PathBuf::from(job(&w).await["result"]["trashPath"].as_str().unwrap());
    sqlx::query(
        r#"UPDATE jobs SET result = result || '{"restore": {}}'::jsonb, "finishedAt" = now() - interval '30 days'"#,
    )
    .execute(&w.st.db)
    .await
    .unwrap();
    trash::purge(&w.st.db).await;
    assert!(bak.exists());
    assert!(job(&w).await["result"]["trashPurgedAt"].is_null());
}

async fn keep(w: &W) {
    let keep = super::settings::Settings {
        optimize_original: super::settings::OriginalPolicy::Keep,
        ..Default::default()
    };
    super::settings::save(&w.st.db, &keep).await.unwrap();
}

async fn journal_of(w: &W) -> swap::Journal {
    serde_json::from_value(job(w).await["result"]["journal"].clone()).unwrap()
}

/// Marks a restore, then edits the placed file so it can never start, and runs the recovery.
async fn abandoned_restore(w: &W) -> swap::Journal {
    let journal = journal_of(w).await;
    let r = swap::Restore {
        target: journal.target.clone(),
        source: journal.source.clone(),
        back: journal.backup.clone().unwrap(),
        slot: swap::optimized_slot(&w.dir.join("M"), w.job),
        optimized: journal.staged_id.clone(),
        original: journal.source_id.clone(),
        companions: vec![],
    };
    fs::write(&journal.target, b"edited elsewhere").unwrap();
    sqlx::query(r#"UPDATE jobs SET result = result || jsonb_build_object('restore', $1::jsonb)"#)
        .bind(json!(r))
        .execute(&w.st.db)
        .await
        .unwrap();
    recover::recover(&w.st, 0.0).await;
    journal
}

#[sqlx::test(migrations = false)]
async fn a_restore_that_cannot_start_ends_and_keeps_the_recorded_trash_path(pool: PgPool) {
    let w = world(pool, json!([])).await;
    commit::run(&w.st).await;
    let before = job(&w).await["result"]["trashPath"].clone();
    abandoned_restore(&w).await;
    let result = job(&w).await["result"].clone();
    assert!(result.get("restore").is_none());
    assert_eq!(result["trashPath"], before);
}

#[sqlx::test(migrations = false)]
async fn an_abandoned_restore_under_keep_never_hands_orig_to_the_purge(pool: PgPool) {
    let w = world(pool, json!([])).await;
    keep(&w).await;
    commit::run(&w.st).await;
    let journal = abandoned_restore(&w).await;
    sqlx::query(r#"UPDATE jobs SET "finishedAt" = now() - interval '30 days'"#)
        .execute(&w.st.db)
        .await
        .unwrap();
    trash::purge(&w.st.db).await;
    assert_eq!(
        fs::read(journal.backup.unwrap()).unwrap(),
        b"original bytes"
    );
}

#[sqlx::test(migrations = false)]
async fn a_kept_original_stays_restorable_after_its_ocr_trash_is_purged(pool: PgPool) {
    let w = world(pool, json!([])).await;
    keep(&w).await;
    commit::run(&w.st).await;
    let srt = w.dir.join(".fliks-trash/9.ocr-1.srt");
    fs::create_dir_all(srt.parent().unwrap()).unwrap();
    fs::write(&srt, b"srt").unwrap();
    sqlx::query(
        r#"UPDATE jobs SET result = result || jsonb_build_object('ocrTrash',
             jsonb_build_array(jsonb_build_array('/x/a.srt', $1::text))),
             "finishedAt" = now() - interval '30 days'"#,
    )
    .bind(srt.to_string_lossy())
    .execute(&w.st.db)
    .await
    .unwrap();
    trash::purge(&w.st.db).await;
    assert!(!srt.exists());
    let result = job(&w).await["result"].clone();
    assert!(result["ocrPurgedAt"].is_string() && result.get("trashPurgedAt").is_none());
    recover::restore(&w.st, w.job).await.unwrap();
    assert_eq!(
        fs::read(w.dir.join("M/a.h264.mkv")).unwrap(),
        b"original bytes"
    );
    // The slot of the restore holds the optimized file and is purged in its turn.
    let slot = w.dir.join(format!(".fliks-trash/{}.optimized.bak", w.job));
    assert!(slot.exists());
    trash::purge(&w.st.db).await;
    assert!(!slot.exists());
    assert!(job(&w).await["result"]["trashPurgedAt"].is_string());
}

#[sqlx::test(migrations = false)]
async fn a_restore_blocked_on_the_row_lock_loses_to_a_purge_that_committed_first(pool: PgPool) {
    let w = world(pool, json!([])).await;
    commit::run(&w.st).await;
    let journal = journal_of(&w).await;
    let mut tx = w.st.db.begin().await.unwrap();
    sqlx::query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE")
        .bind(w.job)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let (st, id) = (w.st.clone(), w.job);
    let restore = tokio::spawn(async move { recover::restore(&st, id).await });
    for _ in 0..100 {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'
             AND datname = current_database()",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        if waiting > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    // Only the mark: with the guard the restore loses, without it the restore would run.
    sqlx::query(r#"UPDATE jobs SET result = result || jsonb_build_object('trashPurgedAt', now())"#)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(restore.await.unwrap().is_err());
    assert!(job(&w).await["result"].get("restore").is_none());
    assert_eq!(fs::read(&journal.target).unwrap(), b"new");
    assert!(journal.backup.unwrap().exists());
}

#[sqlx::test(migrations = false)]
async fn a_user_request_takes_over_a_queued_separation_no_worker_will_take(pool: PgPool) {
    use crate::karaoke::{remote, store};
    let w = world(pool, json!([])).await;
    sqlx::query("UPDATE jobs SET state = 'done'")
        .execute(&w.st.db)
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO jobs (id, kind, "mediaFileId", payload, "profileHash", state)
           VALUES (2, 'separate', $1, '{}'::jsonb, 'h', 'queued')"#,
    )
    .bind(w.file)
    .execute(&w.st.db)
    .await
    .unwrap();
    // No eligible worker: the queued job is nobody's, and the takeover removes it.
    assert!(!remote::held_by_worker(&w.st, w.file).await.unwrap());
    assert_eq!(
        store::take_queued_separation(&w.st.db, w.file)
            .await
            .unwrap(),
        1
    );
    // A leased job is a worker's: held, and the takeover leaves it.
    sqlx::query(
        r#"INSERT INTO jobs (id, kind, "mediaFileId", payload, "profileHash", state, attempt, "workerId", "leaseUntil")
           VALUES (3, 'separate', $1, '{}'::jsonb, 'h', 'leased', 1, 'w', now() + interval '1 minute')"#,
    )
    .bind(w.file)
    .execute(&w.st.db)
    .await
    .unwrap();
    assert!(remote::held_by_worker(&w.st, w.file).await.unwrap());
    assert_eq!(
        store::take_queued_separation(&w.st.db, w.file)
            .await
            .unwrap(),
        0
    );
    assert!(
        store::worker_separating(&w.st.db, w.file, &["leased"])
            .await
            .unwrap()
    );
}

#[sqlx::test(migrations = false)]
async fn the_preview_of_one_file_explains_an_old_probe(pool: PgPool) {
    use crate::optimize::{codec::Capabilities, diff, profile::Preset, select};
    let w = world(pool, json!([])).await;
    sqlx::query(r#"UPDATE media_files SET "probeVersion" = 0"#)
        .execute(&w.st.db)
        .await
        .unwrap();
    let ctx = select::Context::load(
        &w.st.db,
        Preset::Balanced.document(),
        false,
        &Capabilities {
            encodable: vec![],
            main_decodes_av1_hw: false,
        },
    )
    .await
    .unwrap();
    let lib: i32 = sqlx::query_scalar("SELECT id FROM libraries LIMIT 1")
        .fetch_one(&w.st.db)
        .await
        .unwrap();
    let mut seen = vec![];
    select::analyze(&w.st.db, lib, Some(&[w.file]), &ctx, |c| {
        seen.push(c.outcome)
    })
    .await
    .unwrap();
    assert!(matches!(
        seen.as_slice(),
        [diff::Outcome::Excluded {
            why: diff::Excluded::ProbeOutdated
        }]
    ));
}
