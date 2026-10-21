//! Confinement, discovery, reconcile, carry-over and the engine jobs end to end.
use super::{routes::*, *};
use crate::{
    engine::testkit::ok,
    subtitles::{files as sfiles, sidecars},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;

const VIDEO: &str = "Movie.2020.1080p.BluRay.x264-GRP.mkv";

pub(super) async fn row(
    c: &Ctx,
    lang: &str,
    provider: &str,
    path: Option<&str>,
    codec: Option<&str>,
    stream: Option<i32>,
) -> i32 {
    sqlx::query_scalar(
        r#"INSERT INTO subtitle_files ("mediaId", "mediaFileId", language, "providerType", "filePath", status, codec, "streamIndex", score)
           VALUES ($1, $2, $3, $4::text::subtitle_files_providertype_enum, $5, $6::text::subtitle_files_status_enum, $7, $8, 100) RETURNING id"#,
    )
    .bind(c.media)
    .bind(c.file)
    .bind(lang)
    .bind(provider)
    .bind(path)
    .bind(if provider == "embedded" { "embedded" } else { "downloaded" })
    .bind(codec)
    .bind(stream)
    .fetch_one(&c.pool)
    .await
    .unwrap()
}

pub(super) async fn until<F: std::future::Future<Output = bool>>(
    what: &str,
    mut f: impl FnMut() -> F,
) {
    for _ in 0..400 {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("never: {what}");
}

pub(super) fn job_snapshot(
    id: &str,
    kind: &str,
    state: &str,
    result: Value,
    error: Option<&str>,
) -> Value {
    let mut v = json!({"jobId": id, "kind": kind, "mediaFileId": 1, "priority": "high", "state": state, "pct": 100, "createdMs": 1});
    if !result.is_null() {
        v["result"] = result;
    }
    if let Some(e) = error {
        v["error"] = json!(e);
    }
    v
}

pub(super) fn script_job(c: &Ctx, id: &str, snap: Value) {
    c.fake
        .script("POST", "/v1/jobs", vec![ok(json!({"jobId": id}))]);
    c.fake
        .script("GET", &format!("/v1/jobs/{id}"), vec![ok(snap)]);
}

#[sqlx::test]
async fn sidecar_writes_never_leave_the_media_directory(pool: PgPool) {
    let c = ctx(pool).await;
    let media = sfiles::load_media(&c.pool, c.media).await.unwrap().unwrap();
    let dirs = media.dirs(sfiles::NO_ROOT_ADD).unwrap();
    // A symlinked subdirectory redirects nothing.
    let outside = c.root.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, c.dir.join("link")).unwrap();
    std::fs::write(c.dir.join("link").join("v.mkv"), b"x").unwrap();
    assert!(
        dirs.write_sidecar("link/v.mkv", "en", ".srt", b"x")
            .is_err()
    );
    assert!(
        std::fs::read_dir(&outside)
            .unwrap()
            .flatten()
            .all(|e| e.file_name() == "v.mkv")
    );
    // `..` in a stored path.
    assert!(dirs.resolve("../outside/x.srt").is_none());
    assert!(dirs.rewrite("../outside/x.srt", b"x").is_err());
    // A symlinked sidecar is refused for rewrite and unlink; the target stays.
    std::fs::write(outside.join("t.srt"), b"orig").unwrap();
    std::os::unix::fs::symlink(outside.join("t.srt"), c.dir.join("a.srt")).unwrap();
    assert!(dirs.rewrite("a.srt", b"new").is_err());
    assert!(dirs.unlink("a.srt").is_err());
    assert_eq!(std::fs::read(outside.join("t.srt")).unwrap(), b"orig");
    // A dangling symlink at the target name is skipped over, never written through.
    std::os::unix::fs::symlink(
        outside.join("nothing.srt"),
        c.dir.join("Movie.2020.1080p.BluRay.x264-GRP.en.srt"),
    )
    .unwrap();
    let rel = dirs.write_sidecar(VIDEO, "en", ".srt", b"ok").unwrap();
    assert_eq!(rel, "Movie.2020.1080p.BluRay.x264-GRP.en-1.srt");
    assert!(!outside.join("nothing.srt").exists());
    // A missing video directory is not recreated.
    assert!(
        dirs.write_sidecar("gone/v.mkv", "en", ".srt", b"x")
            .is_err()
    );
    assert!(!c.dir.join("gone").exists());
    // The `-N` loop is bounded.
    for n in 1..100 {
        std::fs::write(
            c.dir
                .join(format!("Movie.2020.1080p.BluRay.x264-GRP.de-{n}.srt")),
            b"x",
        )
        .unwrap();
    }
    std::fs::write(c.dir.join("Movie.2020.1080p.BluRay.x264-GRP.de.srt"), b"x").unwrap();
    assert!(dirs.write_sidecar(VIDEO, "de", ".srt", b"x").is_err());
    // A bad suffix never becomes a name.
    assert!(dirs.write_sidecar(VIDEO, "x/../y", ".srt", b"x").is_err());
}

#[sqlx::test]
async fn discovery_reconcile_carry_over_and_delete(pool: PgPool) {
    let c = ctx(pool).await;
    let stem = "Movie.2020.1080p.BluRay.x264-GRP";
    std::fs::write(c.dir.join(format!("{stem}.fr.srt")), SRT).unwrap();
    std::fs::write(c.dir.join(format!("{stem}.en.forced.srt")), SRT).unwrap();
    std::fs::write(c.dir.join("Other.srt"), SRT).unwrap();
    std::fs::write(c.dir.join(format!("{stem}.sup")), b"PGS").unwrap();
    std::fs::create_dir_all(c.dir.join(format!("{stem}.de.srt"))).unwrap();
    std::os::unix::fs::symlink("/etc/hostname", c.dir.join(format!("{stem}.es.srt"))).unwrap();
    // `Other.srt` matches the lone video of an own-folder media; symlinks and directories are skipped.
    let n = sidecars::discover_external(&c.st, c.media).await;
    let rows: Vec<(String, bool, String, Option<String>)> = sqlx::query_as(r#"SELECT language, forced, "filePath", codec FROM subtitle_files WHERE "mediaId" = $1 ORDER BY "filePath""#).bind(c.media).fetch_all(&c.pool).await.unwrap();
    assert_eq!(n, rows.len());
    let paths: Vec<_> = rows.iter().map(|r| r.2.as_str()).collect();
    assert!(
        paths.contains(&format!("{stem}.fr.srt").as_str())
            && paths.contains(&format!("{stem}.en.forced.srt").as_str())
            && paths.contains(&format!("{stem}.sup").as_str())
    );
    assert!(
        !paths
            .iter()
            .any(|p| p.ends_with(".es.srt") || p.ends_with(".de.srt")),
        "{paths:?}"
    );
    assert_eq!(
        sidecars::discover_external(&c.st, c.media).await,
        0,
        "idempotent"
    );
    // Reconcile drops a row whose file is gone and collapses duplicates, never a file.
    std::fs::remove_file(c.dir.join(format!("{stem}.fr.srt"))).unwrap();
    let dup = row(
        &c,
        "en",
        "disk",
        Some(&format!("{stem}.en.forced.srt")),
        None,
        None,
    )
    .await;
    let (missing, dupes) = sidecars::reconcile_after_rescan(&c.st, c.media).await;
    assert_eq!((missing, dupes), (1, 1));
    let alive: i64 = sqlx::query_scalar("SELECT count(*) FROM subtitle_files WHERE id = $1")
        .bind(dup)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(alive, 1, "the higher id of equal rows wins");
    assert!(c.dir.join(format!("{stem}.en.forced.srt")).exists());
    // Carry-over renames after the new video and drops the hash flag.
    let new_file: i32 = sqlx::query_scalar(r#"INSERT INTO media_files ("relativePath", size, quality, "mediaId") VALUES ('New.Movie.mkv', 1, '1080p', $1) RETURNING id"#).bind(c.media).fetch_one(&c.pool).await.unwrap();
    sqlx::query(r#"UPDATE subtitle_files SET "hashMatched" = true WHERE id = $1"#)
        .bind(dup)
        .execute(&c.pool)
        .await
        .unwrap();
    let moved = sidecars::carry_over(&c.st, c.media, c.file, new_file).await;
    assert!(moved.contains(&dup), "{moved:?}");
    assert!(
        c.dir.join("New.Movie.en.forced.srt").exists()
            && !c.dir.join(format!("{stem}.en.forced.srt")).exists()
    );
    let (path, file, hm): (String, i32, bool) = sqlx::query_as(
        r#"SELECT "filePath", "mediaFileId", "hashMatched" FROM subtitle_files WHERE id = $1"#,
    )
    .bind(dup)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(
        (path.as_str(), file, hm),
        ("New.Movie.en.forced.srt", new_file, false)
    );
    // Deleting with the video unlinks the sidecars, except a file another video lists.
    sidecars::delete_files_on_disk(&c.st, c.media, new_file).await;
    assert!(!c.dir.join("New.Movie.en.forced.srt").exists());
    // A shared sidecar survives the delete of one row.
    std::fs::write(c.dir.join("shared.srt"), SRT).unwrap();
    let a = row(&c, "en", "disk", Some("shared.srt"), None, None).await;
    row(&c, "fr", "disk", Some("shared.srt"), None, None).await;
    sidecars::delete_subtitle(&c.st, a).await.unwrap();
    assert!(c.dir.join("shared.srt").exists());
    let emb = row(&c, "en", "embedded", None, Some("subrip"), Some(1)).await;
    assert!(sidecars::delete_subtitle(&c.st, emb).await.is_err());
}

#[sqlx::test]
async fn embedded_tracks_follow_the_probe_and_keep_rows_when_it_fails(pool: PgPool) {
    let c = ctx(pool).await;
    let info = |tracks: Value| json!({"ok": true, "info": {"video": [], "audio": [], "subtitles": tracks}});
    let track = |i: i32, lang: &str, codec: &str, img: bool| json!({"streamIndex": i, "codec": codec, "language": lang, "forced": false, "hearingImpaired": false, "isImageBased": img});
    c.fake.script(
        "POST",
        "/v1/probe",
        vec![ok(info(json!([
            track(2, "fre", "subrip", false),
            track(3, "eng", "hdmv_pgs_subtitle", true)
        ])))],
    );
    let ids = crate::subtitles::embedded::detect_and_store(&c.st, c.media, c.file, None).await;
    assert_eq!(ids.len(), 2);
    let langs: Vec<String> = sqlx::query_scalar(
        r#"SELECT language FROM subtitle_files WHERE "mediaFileId" = $1 ORDER BY "streamIndex""#,
    )
    .bind(c.file)
    .fetch_all(&c.pool)
    .await
    .unwrap();
    assert_eq!(langs, ["fr", "en"]);
    c.fake.script(
        "POST",
        "/v1/probe",
        vec![ok(json!({"ok": false, "error": "bad"}))],
    );
    assert!(
        crate::subtitles::embedded::detect_and_store(&c.st, c.media, c.file, None)
            .await
            .is_empty()
    );
    let n: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM subtitle_files WHERE "mediaFileId" = $1"#)
            .bind(c.file)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(n, 2, "a failed probe wipes nothing");
    c.fake
        .script("POST", "/v1/probe", vec![ok(info(json!([])))]);
    crate::subtitles::embedded::detect_and_store(&c.st, c.media, c.file, None).await;
    let n: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM subtitle_files WHERE "mediaFileId" = $1"#)
            .bind(c.file)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(n, 0, "an empty successful probe retires the tracks");
}

#[sqlx::test]
async fn a_sync_job_runs_end_to_end_and_a_failure_is_recorded(pool: PgPool) {
    let c = ctx(pool).await;
    let stored = "Movie.2020.1080p.BluRay.x264-GRP.en.srt";
    std::fs::write(c.dir.join(stored), SRT).unwrap();
    let id = row(&c, "en", "disk", Some(stored), None, None).await;
    let shifted = "1\n00:00:05,000 --> 00:00:06,000\nHello there.\n";
    script_job(
        &c,
        "j1",
        job_snapshot(
            "j1",
            "SubtitleSync",
            "done",
            json!({"type": "SubtitleSync", "subtitle": {"format": "srt", "text": shifted}}),
            None,
        ),
    );
    let uri = format!("/api/media/{}/subtitles/{id}/sync", c.media);
    let (s, item) = call(
        &c,
        "POST",
        &uri,
        &c.admin,
        Some(json!({"maxOffsetSeconds": 30})),
    )
    .await;
    assert_eq!(
        (s, item["status"].clone(), item["subtitleId"].clone()),
        (201, json!("running"), json!(id)),
        "{item}"
    );
    assert_eq!(item["subject"]["title"], "Movie");
    until("sync completed", || async {
        c.st.subtitles
            .sync
            .snapshot()
            .iter()
            .any(|i| i["status"] == "completed")
    })
    .await;
    assert_eq!(
        std::fs::read_to_string(c.dir.join(stored)).unwrap(),
        shifted
    );
    let (synced, status, locked): (bool, String, bool) =
        sqlx::query_as("SELECT synced, status::text, locked FROM subtitle_files WHERE id = $1")
            .bind(id)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!((synced, status.as_str(), locked), (true, "synced", true));
    let sent = &c.fake.seen("POST", "/v1/jobs")[0].body;
    assert_eq!(
        (
            sent["kind"]["type"].clone(),
            sent["kind"]["reference"]["type"].clone(),
            sent["kind"]["maxOffsetSeconds"].clone(),
            sent["priority"].clone()
        ),
        (
            json!("SubtitleSync"),
            json!("auto"),
            json!(30.0),
            json!("high")
        )
    );
    assert_eq!(sent["kind"]["subtitle"]["text"], SRT);
    let (_, q) = call(&c, "GET", "/api/media/sync-queue", &c.admin, None).await;
    assert_eq!(q[0]["status"], "completed");
    assert!(q[0]["completedAt"].is_i64());

    // A failed job records the failure on the row and the queue item.
    script_job(
        &c,
        "j2",
        job_snapshot(
            "j2",
            "SubtitleSync",
            "failed",
            Value::Null,
            Some("no speech"),
        ),
    );
    let (s, _) = call(&c, "POST", &uri, &c.admin, Some(json!({}))).await;
    assert_eq!(s, 201);
    until("sync failed", || async {
        c.st.subtitles
            .sync
            .snapshot()
            .iter()
            .any(|i| i["status"] == "failed")
    })
    .await;
    let (failed, msg): (bool, Option<String>) =
        sqlx::query_as(r#"SELECT "syncFailed", "errorMessage" FROM subtitle_files WHERE id = $1"#)
            .bind(id)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert!(failed && msg.unwrap().contains("no speech"));
    let q = c.st.subtitles.sync.snapshot();
    assert!(q.iter().any(|i| {
        i["error"]
            .as_str()
            .is_some_and(|e| e.starts_with("Sync failed: "))
    }));

    // A reference outside the media directory fails before any job.
    let before = c.fake.seen("POST", "/v1/jobs").len();
    call(
        &c,
        "POST",
        &uri,
        &c.admin,
        Some(json!({"reference": "/etc/hostname"})),
    )
    .await;
    until("reference refused", || async {
        c.st.subtitles.sync.snapshot().iter().any(|i| {
            i["error"]
                .as_str()
                .is_some_and(|e| e.starts_with("Invalid reference subtitle path"))
        })
    })
    .await;
    assert_eq!(c.fake.seen("POST", "/v1/jobs").len(), before);
    // Validation: embedded rows and bad options.
    let emb = row(&c, "en", "embedded", None, Some("subrip"), Some(1)).await;
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("/api/media/{}/subtitles/{emb}/sync", c.media),
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
            "POST",
            &uri,
            &c.admin,
            Some(json!({"maxOffsetSeconds": -1}))
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(&c, "POST", &uri, &c.reader, Some(json!({}))).await.0,
        403
    );
}

#[sqlx::test]
async fn an_ocr_job_runs_end_to_end_and_a_failed_run_stays_failed(pool: PgPool) {
    let c = ctx(pool).await;
    let img = row(
        &c,
        "en",
        "embedded",
        None,
        Some("hdmv_pgs_subtitle"),
        Some(2),
    )
    .await;
    let text = row(&c, "en", "embedded", None, Some("subrip"), Some(3)).await;
    let dvb = row(&c, "en", "embedded", None, Some("dvb_subtitle"), Some(4)).await;
    let uri = |id: i32| format!("/api/media/{}/subtitles/{id}/ocr", c.media);
    assert_eq!(
        call(&c, "POST", &uri(text), &c.admin, Some(json!({})))
            .await
            .1["message"],
        "Subtitle is not image-based"
    );
    assert_eq!(
        call(&c, "POST", &uri(dvb), &c.admin, Some(json!({})))
            .await
            .1["message"],
        "OCR is not available for \"dvb_subtitle\" subtitles"
    );
    script_job(
        &c,
        "o1",
        job_snapshot(
            "o1",
            "SubtitleOcr",
            "done",
            json!({"type": "SubtitleOcr", "srt": SRT}),
            None,
        ),
    );
    let (s, ph) = call(
        &c,
        "POST",
        &uri(img),
        &c.admin,
        Some(json!({"language": "fra"})),
    )
    .await;
    assert_eq!(
        (
            s,
            ph["status"].clone(),
            ph["providerType"].clone(),
            ph["language"].clone()
        ),
        (201, json!("processing"), json!("ocr"), json!("fr")),
        "{ph}"
    );
    assert!(ph["relativePath"].is_null() && ph["sourceStreamIndex"] == 2);
    let pid = ph["id"].as_i64().unwrap() as i32;
    until("ocr done", || async {
        let s: String = sqlx::query_scalar("SELECT status::text FROM subtitle_files WHERE id = $1")
            .bind(pid)
            .fetch_one(&c.pool)
            .await
            .unwrap();
        s == "downloaded"
    })
    .await;
    let path: String = sqlx::query_scalar(r#"SELECT "filePath" FROM subtitle_files WHERE id = $1"#)
        .bind(pid)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(path, "Movie.2020.1080p.BluRay.x264-GRP.fr.ocr.srt");
    assert_eq!(
        std::fs::read_to_string(c.dir.join(&path))
            .unwrap()
            .trim_end(),
        SRT.trim_end()
    );
    let sent = &c.fake.seen("POST", "/v1/jobs")[0].body;
    assert_eq!(
        (
            sent["kind"]["streamIndex"].clone(),
            sent["kind"]["language"].clone()
        ),
        (json!(2), json!("fr"))
    );
    // A failed run keeps its FAILED row with the error.
    script_job(
        &c,
        "o2",
        job_snapshot(
            "o2",
            "SubtitleOcr",
            "failed",
            Value::Null,
            Some("tesseract died"),
        ),
    );
    let (_, ph) = call(&c, "POST", &uri(img), &c.admin, Some(json!({}))).await;
    let pid = ph["id"].as_i64().unwrap() as i32;
    until("ocr failed", || async {
        let s: String = sqlx::query_scalar("SELECT status::text FROM subtitle_files WHERE id = $1")
            .bind(pid)
            .fetch_one(&c.pool)
            .await
            .unwrap();
        s == "failed"
    })
    .await;
    let msg: String =
        sqlx::query_scalar(r#"SELECT "errorMessage" FROM subtitle_files WHERE id = $1"#)
            .bind(pid)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert!(msg.starts_with("Error: engine job failed: "), "{msg}");
    // A restart fails what was still running.
    sqlx::query(
        r#"UPDATE subtitle_files SET status = 'processing', "errorMessage" = NULL WHERE id = $1"#,
    )
    .bind(pid)
    .execute(&c.pool)
    .await
    .unwrap();
    crate::subtitles::sweep(&c.pool).await.unwrap();
    let msg: String =
        sqlx::query_scalar(r#"SELECT "errorMessage" FROM subtitle_files WHERE id = $1"#)
            .bind(pid)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(msg, "activity.subtitle_error_interrupted");
}

#[sqlx::test]
async fn a_root_level_movie_works_and_a_folder_symlinked_out_of_the_library_does_not(pool: PgPool) {
    let c = ctx(pool).await;
    // A movie with no folder lives in the library root.
    std::fs::write(c.root.join("Flat.mkv"), b"v").unwrap();
    sqlx::query(r#"UPDATE media SET "folderName" = NULL WHERE id = $1"#)
        .bind(c.media)
        .execute(&c.pool)
        .await
        .unwrap();
    let media = sfiles::load_media(&c.pool, c.media).await.unwrap().unwrap();
    let dirs = media.dirs(sfiles::NO_ROOT_ADD).unwrap();
    assert_eq!(
        dirs.write_sidecar("Flat.mkv", "en", ".srt", b"x").unwrap(),
        "Flat.en.srt"
    );
    // A folder name that is a symlink to outside the library is refused.
    let outside = std::env::temp_dir().join(format!("fliks-s6-out-{}", std::process::id()));
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, c.root.join("Linked")).unwrap();
    sqlx::query(r#"UPDATE media SET "folderName" = 'Linked' WHERE id = $1"#)
        .bind(c.media)
        .execute(&c.pool)
        .await
        .unwrap();
    let media = sfiles::load_media(&c.pool, c.media).await.unwrap().unwrap();
    assert!(media.dirs(sfiles::NO_ROOT_ADD).is_err());
    std::fs::remove_dir_all(&outside).unwrap();
}

#[sqlx::test]
async fn concurrent_sidecar_writes_take_distinct_names(pool: PgPool) {
    let c = ctx(pool).await;
    let media = sfiles::load_media(&c.pool, c.media).await.unwrap().unwrap();
    let dirs = std::sync::Arc::new(media.dirs(sfiles::NO_ROOT_ADD).unwrap());
    let names: Vec<String> = std::thread::scope(|s| {
        let hs: Vec<_> = (0..8)
            .map(|_| {
                let d = dirs.clone();
                s.spawn(move || d.write_sidecar(VIDEO, "en", ".srt", b"x").unwrap())
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut sorted = names.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), 8, "{names:?}");
}

const ASS: &str = "[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello there.\n";

#[sqlx::test]
async fn post_processing_refuses_image_formats_and_a_convert_onto_an_existing_srt(pool: PgPool) {
    let c = ctx(pool).await;
    let uri = |id: i32| format!("/api/media/{}/subtitles/{id}/post-process", c.media);
    for ext in ["sup", "sub"] {
        let name = format!("Movie.2020.1080p.BluRay.x264-GRP.en.{ext}");
        std::fs::write(c.dir.join(&name), b"x").unwrap();
        let id = row(&c, "en", "disk", Some(&name), None, None).await;
        let (s, v) = call(
            &c,
            "POST",
            &uri(id),
            &c.admin,
            Some(json!({"action": "removeHiTags"})),
        )
        .await;
        assert_eq!(
            (s, v["message"].as_str()),
            (
                400,
                Some(format!("Cannot post-process a .{ext} subtitle").as_str())
            )
        );
    }
    std::fs::write(c.dir.join("Movie.2020.1080p.BluRay.x264-GRP.fr.ass"), ASS).unwrap();
    std::fs::write(c.dir.join("Movie.2020.1080p.BluRay.x264-GRP.fr.srt"), SRT).unwrap();
    let id = row(
        &c,
        "fr",
        "disk",
        Some("Movie.2020.1080p.BluRay.x264-GRP.fr.ass"),
        None,
        None,
    )
    .await;
    let (s, v) = call(
        &c,
        "POST",
        &uri(id),
        &c.admin,
        Some(json!({"action": "convertToSrt"})),
    )
    .await;
    assert_eq!(
        (s, v["message"].as_str()),
        (409, Some("Target subtitle already exists"))
    );
    assert!(
        c.dir
            .join("Movie.2020.1080p.BluRay.x264-GRP.fr.ass")
            .exists()
    );
    // Without the clash the conversion renames to `.srt`.
    std::fs::remove_file(c.dir.join("Movie.2020.1080p.BluRay.x264-GRP.fr.srt")).unwrap();
    let (s, v) = call(
        &c,
        "POST",
        &uri(id),
        &c.admin,
        Some(json!({"action": "convertToSrt"})),
    )
    .await;
    assert_eq!(s, 201, "{v}");
    assert!(
        c.dir
            .join("Movie.2020.1080p.BluRay.x264-GRP.fr.srt")
            .exists()
    );
    // An `.srt` target is its own source: no clash check, the rewrite goes through.
    let (s, _) = call(
        &c,
        "POST",
        &uri(id),
        &c.admin,
        Some(json!({"action": "convertToSrt"})),
    )
    .await;
    assert_eq!(s, 201);
}

#[sqlx::test]
async fn one_ocr_run_per_source_track_even_when_requested_twice_at_once(pool: PgPool) {
    let c = ctx(pool).await;
    let img = row(
        &c,
        "en",
        "embedded",
        None,
        Some("hdmv_pgs_subtitle"),
        Some(2),
    )
    .await;
    c.fake
        .script("POST", "/v1/jobs", vec![ok(json!({"jobId": "o1"}))]);
    c.fake.script(
        "GET",
        "/v1/jobs/o1",
        vec![crate::engine::testkit::slow(
            300,
            ok(job_snapshot(
                "o1",
                "SubtitleOcr",
                "done",
                json!({"type": "SubtitleOcr", "srt": SRT}),
                None,
            )),
        )],
    );
    let uri = format!("/api/media/{}/subtitles/{img}/ocr", c.media);
    let (a, b) = tokio::join!(
        call(&c, "POST", &uri, &c.admin, Some(json!({}))),
        call(&c, "POST", &uri, &c.admin, Some(json!({})))
    );
    let mut codes = [a.0, b.0];
    codes.sort();
    assert_eq!(codes, [201, 409], "{a:?} {b:?}");
    // A placeholder deleted while its run is in flight leaves no row and no file behind.
    until("the first run finished", || async {
        sqlx::query_scalar::<_, i64>(r#"SELECT count(*) FROM subtitle_files WHERE "providerType" = 'ocr' AND status = 'downloaded'"#)
            .fetch_one(&c.pool)
            .await
            .unwrap()
            == 1
    })
    .await;
    sqlx::query(r#"DELETE FROM subtitle_files WHERE "providerType" = 'ocr'"#)
        .execute(&c.pool)
        .await
        .unwrap();
    std::fs::remove_file(c.dir.join("Movie.2020.1080p.BluRay.x264-GRP.en.ocr.srt")).unwrap();
    c.fake
        .script("POST", "/v1/jobs", vec![ok(json!({"jobId": "o2"}))]);
    c.fake.script(
        "GET",
        "/v1/jobs/o2",
        vec![crate::engine::testkit::slow(
            400,
            ok(job_snapshot(
                "o2",
                "SubtitleOcr",
                "done",
                json!({"type": "SubtitleOcr", "srt": SRT}),
                None,
            )),
        )],
    );
    let (s, ph) = call(&c, "POST", &uri, &c.admin, Some(json!({}))).await;
    assert_eq!(s, 201);
    sqlx::query("DELETE FROM subtitle_files WHERE id = $1")
        .bind(ph["id"].as_i64().unwrap() as i32)
        .execute(&c.pool)
        .await
        .unwrap();
    until("the engine answered", || async {
        !c.fake.seen("GET", "/v1/jobs/o2").is_empty()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let n: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM subtitle_files WHERE "providerType" = 'ocr'"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(n, 0);
    assert!(
        !c.dir
            .join("Movie.2020.1080p.BluRay.x264-GRP.en.ocr.srt")
            .exists()
    );
}

#[sqlx::test]
async fn a_rescan_and_a_file_delete_reach_the_subtitle_hooks(pool: PgPool) {
    let c = ctx(pool).await;
    // The disk has a French sidecar the database lacks; the database has an English one the disk lacks.
    std::fs::write(c.dir.join("Movie.2020.1080p.BluRay.x264-GRP.fr.srt"), SRT).unwrap();
    row(
        &c,
        "en",
        "disk",
        Some("Movie.2020.1080p.BluRay.x264-GRP.en.srt"),
        None,
        None,
    )
    .await;
    c.fake.script(
        "POST",
        "/v1/probe",
        vec![ok(
            json!({"ok": true, "info": {"video": [], "audio": [], "subtitles": []}}),
        )],
    );
    let guard = c.st.ingest.media.lock(c.media).await;
    let counts = crate::ingest::rescan::rescan_files(&c.st, &guard, c.media)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(counts.subtitle_removed_missing, 1);
    let langs: Vec<String> =
        sqlx::query_scalar(r#"SELECT language FROM subtitle_files WHERE "mediaFileId" = $1"#)
            .bind(c.file)
            .fetch_all(&c.pool)
            .await
            .unwrap();
    assert_eq!(langs, ["fr"]);
    // Deleting the video from disk unlinks its tracked sidecars.
    let (s, _) = call(
        &c,
        "DELETE",
        &format!("/api/media/{}/files/{}?deleteOnDisk=true", c.media, c.file),
        &c.admin,
        None,
    )
    .await;
    assert_eq!(s, 200);
    assert!(
        !c.dir
            .join("Movie.2020.1080p.BluRay.x264-GRP.fr.srt")
            .exists()
    );
}

#[sqlx::test]
async fn the_sync_queue_dedupes_live_items_and_runs_each_with_its_own_options(pool: PgPool) {
    let c = ctx(pool).await;
    let mut ids = vec![];
    for n in ["a", "b", "c"] {
        let stored = format!("Movie.2020.1080p.BluRay.x264-GRP.{n}.srt");
        std::fs::write(c.dir.join(&stored), SRT).unwrap();
        ids.push(row(&c, "en", "disk", Some(&stored), None, None).await);
    }
    let done = |j: &str| {
        job_snapshot(
            j,
            "SubtitleSync",
            "done",
            json!({"type": "SubtitleSync", "subtitle": {"format": "srt", "text": SRT}}),
            None,
        )
    };
    c.fake.script(
        "POST",
        "/v1/jobs",
        ["j1", "j2", "j3"].map(|j| ok(json!({"jobId": j}))).to_vec(),
    );
    for (j, delay) in [("j1", 400), ("j2", 400), ("j3", 0)] {
        c.fake.script(
            "GET",
            &format!("/v1/jobs/{j}"),
            vec![crate::engine::testkit::slow(delay, ok(done(j)))],
        );
    }
    let enqueue = |id: i32, opts: Value| {
        let uri = format!("/api/media/{}/subtitles/{id}/sync", c.media);
        let (c, admin) = (&c, c.admin.clone());
        async move { call(c, "POST", &uri, &admin, Some(opts)).await.1 }
    };
    let first = enqueue(ids[0], json!({"maxOffsetSeconds": 30})).await;
    let again = enqueue(ids[0], json!({"maxOffsetSeconds": 99})).await;
    assert_eq!((first["status"].clone(), again), (json!("running"), first));
    assert_eq!(
        enqueue(ids[1], json!({"maxOffsetSeconds": 30})).await["status"],
        "running"
    );
    // The third waits for a slot and keeps its own options, whoever frees the slot.
    let third = enqueue(ids[2], json!({"maxOffsetSeconds": 10})).await;
    assert_eq!(third["status"], "queued");
    until("all synced", || async {
        c.st.subtitles
            .sync
            .snapshot()
            .iter()
            .filter(|i| i["status"] == "completed")
            .count()
            == 3
    })
    .await;
    // The queue item shape (parity `subtitles-provider-sync-queue-shape`).
    let first = c.st.subtitles.sync.snapshot().remove(0);
    let mut keys: Vec<&String> = first.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "completedAt",
            "queuedAt",
            "startedAt",
            "status",
            "subject",
            "subtitleId"
        ]
    );
    let sent: Vec<Value> = c
        .fake
        .seen("POST", "/v1/jobs")
        .iter()
        .map(|s| s.body["kind"]["maxOffsetSeconds"].clone())
        .collect();
    assert_eq!(sent, [json!(30.0), json!(30.0), json!(10.0)]);
}

#[sqlx::test]
async fn cancelling_a_sync_drops_a_queued_item_and_settles_a_running_one(pool: PgPool) {
    let c = ctx(pool).await;
    let mut ids = vec![];
    for n in ["a", "b", "c"] {
        let stored = format!("Movie.2020.1080p.BluRay.x264-GRP.{n}.srt");
        std::fs::write(c.dir.join(&stored), SRT).unwrap();
        ids.push(row(&c, "en", "disk", Some(&stored), None, None).await);
    }
    c.fake.script(
        "POST",
        "/v1/jobs",
        ["j1", "j2"].map(|j| ok(json!({"jobId": j}))).to_vec(),
    );
    for j in ["j1", "j2"] {
        let gone = job_snapshot(
            j,
            "SubtitleSync",
            "cancelled",
            Value::Null,
            Some("cancelled"),
        );
        c.fake.script(
            "GET",
            &format!("/v1/jobs/{j}"),
            vec![crate::engine::testkit::slow(300, ok(gone))],
        );
    }
    for j in ["j1", "j2"] {
        c.fake
            .script("DELETE", &format!("/v1/jobs/{j}"), vec![ok(json!({}))]);
    }
    let uri = |id: i32| format!("/api/media/{}/subtitles/{id}/sync", c.media);
    for id in &ids {
        call(&c, "POST", &uri(*id), &c.admin, Some(json!({}))).await;
    }
    let status = |id: i32| {
        c.st.subtitles
            .sync
            .snapshot()
            .into_iter()
            .find(|i| i["subtitleId"] == id)
            .map(|i| i["status"].clone())
    };
    assert_eq!(status(ids[2]), Some(json!("queued")));
    // The queued item is dropped; the running one asks the engine to cancel its job.
    assert_eq!(
        call(&c, "DELETE", &uri(ids[2]), &c.admin, None).await.0,
        204
    );
    assert_eq!(status(ids[2]), None);
    assert_eq!(
        call(&c, "DELETE", &uri(ids[0]), &c.admin, None).await.0,
        204
    );
    until("slot settled", || async { status(ids[0]).is_none() }).await;
    // The two running items race for their job ids: whichever holds the cancelled one is deleted.
    let deletes = ["j1", "j2"].map(|j| c.fake.seen("DELETE", &format!("/v1/jobs/{j}")).len());
    assert_eq!(deletes.iter().sum::<usize>(), 1);
    // Nothing is written back and no failure is recorded; the lock stays like after a failure.
    let (synced, failed, locked): (bool, bool, bool) =
        sqlx::query_as(r#"SELECT synced, "syncFailed", locked FROM subtitle_files WHERE id = $1"#)
            .bind(ids[0])
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!((synced, failed, locked), (false, false, true));
    assert_eq!(
        std::fs::read_to_string(c.dir.join("Movie.2020.1080p.BluRay.x264-GRP.a.srt")).unwrap(),
        SRT
    );
}
