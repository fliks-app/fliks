//! The search and upgrade passes: tick claims, manual triggers, OCR-first, burn-in, auto-sync, upgrades.
use super::{files::*, routes::*, *};
use crate::engine::testkit::ok;
use crate::sync::MutexExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Mutex;

async fn set(c: &Ctx, key: &str, value: &str) {
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2")
        .bind(key)
        .bind(value)
        .execute(&c.pool)
        .await
        .unwrap();
}

async fn only_english(c: &Ctx) {
    sqlx::query(r#"UPDATE language_profiles SET "subtitleLanguages" = '[{"isoCode":"en","name":"English","forced":false,"hi":false}]'"#)
        .execute(&c.pool)
        .await
        .unwrap();
}

fn probe(c: &Ctx, tracks: Value) {
    c.fake.script(
        "POST",
        "/v1/probe",
        vec![ok(
            json!({"ok": true, "info": {"video": [], "audio": [], "subtitles": tracks}}),
        )],
    );
}

fn pgs_track() -> Value {
    json!([{"streamIndex": 3, "codec": "hdmv_pgs_subtitle", "language": "eng", "forced": false, "hearingImpaired": false, "isImageBased": true}])
}

async fn subdl_rows(c: &Ctx) -> i64 {
    sqlx::query_scalar(r#"SELECT count(*) FROM subtitle_files WHERE "providerType" = 'subdl'"#)
        .fetch_one(&c.pool)
        .await
        .unwrap()
}

fn one_hit(c: &Ctx) {
    script_subdl(
        c,
        &[("/subtitle/1.zip", "Movie.2020.1080p.BluRay.x264-GRP", false)],
    );
}

#[sqlx::test]
async fn the_search_pass_fills_gaps_and_a_bad_min_score_keeps_the_default(pool: PgPool) {
    let c = ctx(pool).await;
    provider(&c, "subdl").await;
    one_hit(&c);
    probe(&c, json!([]));
    // C59: `abc` is not a number, so the default of 70 applies and the good match is fetched.
    set(&c, "subtitle_min_score", "abc").await;
    let got = crate::subtitles::scheduler::search_missing_for_media(&c.st, c.media, c.file).await;
    assert!(got.contains(&"en".to_owned()), "{got:?}");
    assert!(subdl_rows(&c).await >= 1);
    // Unknown media or file never errors.
    assert!(
        crate::subtitles::scheduler::search_missing_for_media(&c.st, 9999, 1)
            .await
            .is_empty()
    );
}

#[sqlx::test]
async fn a_tick_skips_a_held_claim_and_leaves_its_last_run_alone(pool: PgPool) {
    let c = ctx(pool).await;
    let last = Mutex::new((0i64, 0i64));
    let a = c.st.jobs.claim("SubtitleSearch").unwrap();
    let b = c.st.jobs.claim("SubtitleUpgrade").unwrap();
    crate::subtitles::scheduler::tick(&c.st, &last).await;
    assert_eq!(*last.lock_clean(), (0, 0));
    drop((a, b));
    crate::subtitles::scheduler::tick(&c.st, &last).await;
    let (s, u) = *last.lock_clean();
    assert!(s > 0 && u > 0);
    // The claim is released at the end of the pass.
    assert!(c.st.jobs.claim("SubtitleSearch").is_some());
}

#[sqlx::test]
async fn the_manual_command_runs_the_pass_and_is_refused_while_one_runs(pool: PgPool) {
    let c = ctx(pool).await;
    provider(&c, "subdl").await;
    one_hit(&c);
    only_english(&c).await;
    probe(&c, json!([]));
    let held = c.st.jobs.claim("SubtitleSearch").unwrap();
    let (s, v) = call(
        &c,
        "POST",
        "/api/commands",
        &c.admin,
        Some(json!({"name": "SubtitleSearch"})),
    )
    .await;
    assert_eq!(
        (s, v["message"].as_str()),
        (409, Some("Command \"SubtitleSearch\" is already running"))
    );
    drop(held);
    let (s, _) = call(
        &c,
        "POST",
        "/api/commands",
        &c.admin,
        Some(json!({"name": "SubtitleSearch"})),
    )
    .await;
    assert_eq!(s, 201);
    until("the pass downloaded", || async {
        subdl_rows(&c).await == 1
    })
    .await;
}

#[sqlx::test]
async fn an_embedded_image_track_is_ocred_before_any_download(pool: PgPool) {
    let c = ctx(pool).await;
    only_english(&c).await;
    set(&c, "subtitle_ocr_burn_in_auto", "true").await;
    provider(&c, "subdl").await;
    one_hit(&c);
    probe(&c, pgs_track());
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
    let got = crate::subtitles::scheduler::search_missing_for_media(&c.st, c.media, c.file).await;
    assert_eq!(got, ["en"]);
    until("ocr stored", || async {
        sqlx::query_scalar::<_, i64>(
            r#"SELECT count(*) FROM subtitle_files WHERE "providerType" = 'ocr' AND status = 'downloaded'"#,
        )
        .fetch_one(&c.pool)
        .await
        .unwrap()
            == 1
    })
    .await;
    assert_eq!(
        c.fake.seen("POST", "/v1/jobs")[0].body["kind"]["type"],
        "SubtitleOcr"
    );
    assert!(c.stub.seen("GET", "/api/v1/subtitles").is_empty());
}

#[sqlx::test]
async fn a_burned_in_track_covers_the_language_only_when_the_setting_is_on(pool: PgPool) {
    let c = ctx(pool).await;
    only_english(&c).await;
    provider(&c, "subdl").await;
    one_hit(&c);
    set(&c, "subtitle_burn_in_covers_language", "true").await;
    probe(&c, pgs_track());
    let got = crate::subtitles::scheduler::search_missing_for_media(&c.st, c.media, c.file).await;
    assert!(got.is_empty() && c.stub.seen("GET", "/api/v1/subtitles").is_empty());
    set(&c, "subtitle_burn_in_covers_language", "false").await;
    probe(&c, pgs_track());
    let got = crate::subtitles::scheduler::search_missing_for_media(&c.st, c.media, c.file).await;
    assert_eq!(got, ["en"]);
}

#[sqlx::test]
async fn auto_sync_runs_a_sync_job_after_the_download(pool: PgPool) {
    let c = ctx(pool).await;
    only_english(&c).await;
    provider(&c, "subdl").await;
    one_hit(&c);
    set(&c, "subtitle_auto_sync", "true").await;
    probe(&c, json!([]));
    let shifted = "1\n00:00:05,000 --> 00:00:06,000\nHello there.\n";
    script_job(
        &c,
        "s1",
        job_snapshot(
            "s1",
            "SubtitleSync",
            "done",
            json!({"type": "SubtitleSync", "subtitle": {"format": "srt", "text": shifted}}),
            None,
        ),
    );
    let got = crate::subtitles::scheduler::search_missing_for_media(&c.st, c.media, c.file).await;
    assert_eq!(got, ["en"]);
    let synced: bool =
        sqlx::query_scalar(r#"SELECT synced FROM subtitle_files WHERE "providerType" = 'subdl'"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert!(synced);
    assert_eq!(
        c.fake.seen("POST", "/v1/jobs")[0].body["kind"]["type"],
        "SubtitleSync"
    );
}

#[sqlx::test]
async fn an_upgrade_of_a_hash_matched_row_needs_a_hash_matched_candidate(pool: PgPool) {
    let c = ctx(pool).await;
    only_english(&c).await;
    provider(&c, "subdl").await;
    one_hit(&c);
    let stored = "Movie.2020.1080p.BluRay.x264-GRP.en.srt";
    std::fs::write(c.dir.join(stored), SRT).unwrap();
    let id = row(&c, "en", "subdl", Some(stored), None, None).await;
    sqlx::query(r#"UPDATE subtitle_files SET score = 10, "hashMatched" = true WHERE id = $1"#)
        .bind(id)
        .execute(&c.pool)
        .await
        .unwrap();
    crate::subtitles::scheduler::upgrade(&c.st).await.unwrap();
    let n = |status: &'static str| {
        let pool = c.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM subtitle_files WHERE status::text = $1",
            )
            .bind(status)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    assert_eq!(n("upgraded").await, 0, "no candidate matches the hash");
    sqlx::query(r#"UPDATE subtitle_files SET "hashMatched" = false WHERE id = $1"#)
        .bind(id)
        .execute(&c.pool)
        .await
        .unwrap();
    crate::subtitles::scheduler::upgrade(&c.st).await.unwrap();
    assert_eq!(n("upgraded").await, 1);
}
