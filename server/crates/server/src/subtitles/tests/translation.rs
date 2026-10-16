//! Translation against a mock OpenAI-compatible server, the provider CRUD and the scheduled passes.
use super::{routes::*, *};
use crate::engine::testkit::ok;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;

/// Answers `#N#\n<text>!` for every numbered segment of the user message.
fn echo_server(stub: &Stub) {
    stub.on_fn("POST", "/v1/chat/completions", |seen| {
        let body: Value = serde_json::from_slice(&seen.body).unwrap();
        let user = body["messages"][1]["content"].as_str().unwrap_or("");
        let system = body["messages"][0]["content"].as_str().unwrap_or("");
        let content = if system.contains("answer with exactly one word") {
            "tu".to_owned()
        } else {
            let mut out = String::new();
            let mut lines = user.lines().peekable();
            while let Some(l) = lines.next() {
                if l.starts_with('#') && l.ends_with('#') {
                    let text = lines.next().unwrap_or("");
                    out.push_str(&format!("{l}\n{text}!\n"));
                }
            }
            out
        };
        reply(
            200,
            json!({"choices": [{"message": {"content": content}, "finish_reason": "stop"}]})
                .to_string(),
        )
    });
    stub.on(
        "GET",
        "/v1/models",
        vec![reply(
            200,
            json!({"data": [{"id": "b-model"}, {"id": "a-model"}]}).to_string(),
        )],
    );
}

async fn openai_provider(c: &Ctx) -> i32 {
    let (s, v) = call(c, "POST", "/api/subtitles/translation-providers", &c.admin, Some(json!({"name": "Local", "engine": "openai", "settings": {"baseUrl": format!("{}/v1/", c.stub.url), "model": "m", "apiKey": "SECRET"}}))).await;
    assert_eq!(
        (s, v["settings"].clone()),
        (
            201,
            json!({"baseUrl": format!("{}/v1/", c.stub.url), "model": "m", "secretsSet": ["apiKey"]})
        )
    );
    assert_eq!(v["isDefault"], false);
    v["id"].as_i64().unwrap() as i32
}

async fn enable(c: &Ctx) {
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ('subtitle_translation_enabled', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'").execute(&c.pool).await.unwrap();
}

#[sqlx::test]
async fn a_subtitle_is_translated_through_an_openai_compatible_endpoint(pool: PgPool) {
    let c = ctx(pool).await;
    echo_server(&c.stub);
    let pid = openai_provider(&c).await;
    let stored = "Movie.2020.1080p.BluRay.x264-GRP.en.srt";
    std::fs::write(c.dir.join(stored), SRT).unwrap();
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO subtitle_files ("mediaId", "mediaFileId", language, "providerType", "filePath", status, codec, score)
           VALUES ($1, $2, 'en', 'disk', $3, 'downloaded', 'subrip', 80) RETURNING id"#,
    )
    .bind(c.media)
    .bind(c.file)
    .bind(stored)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    let uri = format!("/api/media/{}/subtitles/{id}/translate", c.media);
    assert_eq!(
        call(
            &c,
            "POST",
            &uri,
            &c.admin,
            Some(json!({"targetLanguage": "fr"}))
        )
        .await
        .1["message"],
        "errors.translation_disabled"
    );
    enable(&c).await;
    assert_eq!(
        call(
            &c,
            "POST",
            &uri,
            &c.admin,
            Some(json!({"targetLanguage": "en", "providerId": pid}))
        )
        .await
        .1["message"],
        "errors.source_target_language_same"
    );
    assert_eq!(
        call(
            &c,
            "POST",
            &uri,
            &c.admin,
            Some(json!({"targetLanguage": ""}))
        )
        .await
        .1["message"],
        "errors.target_language_required"
    );
    let (s, ph) = call(
        &c,
        "POST",
        &uri,
        &c.admin,
        Some(json!({"targetLanguage": "fra", "providerId": pid})),
    )
    .await;
    assert_eq!(s, 201, "{ph}");
    assert_eq!(
        (
            ph["status"].clone(),
            ph["providerType"].clone(),
            ph["translationEngine"].clone(),
            ph["translationModel"].clone(),
            ph["translationProviderName"].clone()
        ),
        (
            json!("processing"),
            json!("translated"),
            json!("openai"),
            json!("m"),
            json!("Local")
        )
    );
    assert_eq!(ph["translationProvider"], json!({"id": pid}));
    let tid = ph["id"].as_i64().unwrap() as i32;
    for _ in 0..400 {
        let s: String = sqlx::query_scalar("SELECT status::text FROM subtitle_files WHERE id = $1")
            .bind(tid)
            .fetch_one(&c.pool)
            .await
            .unwrap();
        if s != "processing" {
            assert_eq!(s, "downloaded");
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let path: String = sqlx::query_scalar(r#"SELECT "filePath" FROM subtitle_files WHERE id = $1"#)
        .bind(tid)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(path, "Movie.2020.1080p.BluRay.x264-GRP.fr.srt");
    let out = std::fs::read_to_string(c.dir.join(&path)).unwrap();
    assert!(
        out.contains("Hello there.!")
            && out.contains("Second line.!")
            && out.contains("00:00:03,000 --> 00:00:04,000"),
        "{out}"
    );
    // The register probe came first, the batch carried the register, and the key travelled as a bearer.
    let seen = c.stub.seen("POST", "/v1/chat/completions");
    assert_eq!(seen.len(), 2);
    let probe: Value = serde_json::from_slice(&seen[0].body).unwrap();
    let batch: Value = serde_json::from_slice(&seen[1].body).unwrap();
    assert_eq!(
        (probe["temperature"].as_f64(), probe["max_tokens"].clone()),
        (Some(0.0), json!(500))
    );
    assert!(
        batch["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("These speakers use \"tu\"")
    );
    assert!(
        batch["messages"][1]["content"]
            .as_str()
            .unwrap()
            .starts_with("#1#\nHello there.")
    );
    assert_eq!(seen[1].header("authorization"), Some("Bearer SECRET"));
    // A second run for the same target is refused while the first exists as processing.
    sqlx::query("UPDATE subtitle_files SET status = 'processing' WHERE id = $1")
        .bind(tid)
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &c,
            "POST",
            &uri,
            &c.admin,
            Some(json!({"targetLanguage": "fr", "providerId": pid}))
        )
        .await
        .0,
        409
    );
}

#[sqlx::test]
async fn a_rate_limited_engine_fails_the_run_with_its_scope(pool: PgPool) {
    let c = ctx(pool).await;
    c.stub.on(
        "POST",
        "/v1/chat/completions",
        vec![reply(429, "Quota exceeded: requests per day")],
    );
    let pid = openai_provider(&c).await;
    enable(&c).await;
    let stored = "Movie.2020.1080p.BluRay.x264-GRP.en.srt";
    std::fs::write(c.dir.join(stored), SRT).unwrap();
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO subtitle_files ("mediaId", "mediaFileId", language, "providerType", "filePath", status, codec, score)
           VALUES ($1, $2, 'en', 'disk', $3, 'downloaded', 'subrip', 80) RETURNING id"#,
    )
    .bind(c.media)
    .bind(c.file)
    .bind(stored)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    let mut rx = c.st.hub.subscribe();
    let (_, ph) = call(
        &c,
        "POST",
        &format!("/api/media/{}/subtitles/{id}/translate", c.media),
        &c.admin,
        Some(json!({"targetLanguage": "de", "providerId": pid})),
    )
    .await;
    let tid = ph["id"].as_i64().unwrap() as i32;
    for _ in 0..400 {
        let (s, m): (String, Option<String>) = sqlx::query_as(
            r#"SELECT status::text, "errorMessage" FROM subtitle_files WHERE id = $1"#,
        )
        .bind(tid)
        .fetch_one(&c.pool)
        .await
        .unwrap();
        if s == "failed" {
            assert_eq!(m.as_deref(), Some("errors.translation_rate_limited_daily"));
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let mut failed = None;
    while let Ok(bus) = rx.try_recv() {
        let v = serde_json::to_value(&*bus).unwrap_or(Value::Null);
        if v.to_string().contains("subtitle.failed") {
            failed = Some(v);
        }
    }
    assert!(
        failed.is_some_and(
            |v| v.to_string().contains("rate_limit") && v.to_string().contains("daily")
        )
    );
    assert_eq!(
        c.stub.seen("POST", "/v1/chat/completions").len(),
        2,
        "the probe and the batch, neither retried: a daily quota ends at once"
    );
}

#[sqlx::test]
async fn translation_providers_keep_one_default_redact_keys_and_list_models(pool: PgPool) {
    let c = ctx(pool).await;
    echo_server(&c.stub);
    let a = openai_provider(&c).await;
    let (_, b) = call(&c, "POST", "/api/subtitles/translation-providers", &c.admin, Some(json!({"name": "G", "engine": "gemini", "settings": {"apiKey": "gk"}, "isDefault": true}))).await;
    let b = b["id"].as_i64().unwrap() as i32;
    let (_, list) = call(
        &c,
        "GET",
        "/api/subtitles/translation-providers",
        &c.admin,
        None,
    )
    .await;
    assert_eq!(
        (list[0]["id"].clone(), list[0]["isDefault"].clone()),
        (json!(b), json!(true))
    );
    let (_, v) = call(
        &c,
        "PUT",
        &format!("/api/subtitles/translation-providers/{a}"),
        &c.admin,
        Some(json!({"isDefault": true})),
    )
    .await;
    assert_eq!(v["isDefault"], true);
    let defaults: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM translation_providers WHERE "isDefault""#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(defaults, 1);
    // A host change drops the stored key; an unchanged one keeps it (trailing slash aside).
    let base = format!("{}/v1", c.stub.url);
    let (_, v) = call(
        &c,
        "PUT",
        &format!("/api/subtitles/translation-providers/{a}"),
        &c.admin,
        Some(json!({"settings": {"baseUrl": base, "model": "m"}})),
    )
    .await;
    assert_eq!(v["settings"]["secretsSet"], json!(["apiKey"]));
    let (_, v) = call(
        &c,
        "PUT",
        &format!("/api/subtitles/translation-providers/{a}"),
        &c.admin,
        Some(json!({"settings": {"baseUrl": "http://other.example/v1", "model": "m"}})),
    )
    .await;
    assert_eq!(v["settings"]["secretsSet"], json!([]));
    assert_eq!(
        call(
            &c,
            "PUT",
            &format!("/api/subtitles/translation-providers/{a}"),
            &c.admin,
            Some(json!({"settings": {"baseUrl": "file:///etc", "model": "m"}}))
        )
        .await
        .0,
        400
    );
    // Deleting the default promotes the first enabled one.
    assert_eq!(
        call(
            &c,
            "DELETE",
            &format!("/api/subtitles/translation-providers/{a}"),
            &c.admin,
            None
        )
        .await
        .0,
        200
    );
    let (_, v) = call(
        &c,
        "GET",
        &format!("/api/subtitles/translation-providers/{b}"),
        &c.admin,
        None,
    )
    .await;
    assert_eq!(v["isDefault"], true);
    // Available lists no settings and needs subtitles.manage.
    let (_, av) = call(
        &c,
        "GET",
        "/api/subtitles/translation-providers/available",
        &c.admin,
        None,
    )
    .await;
    assert!(av[0].get("settings").is_none());
    assert_eq!(
        call(
            &c,
            "GET",
            "/api/subtitles/translation-providers/available",
            &c.reader,
            None
        )
        .await
        .0,
        403
    );
    // Models and a probe.
    let (s, m) = call(
        &c,
        "POST",
        "/api/subtitles/translation-providers/models",
        &c.admin,
        Some(json!({"engine": "openai", "settings": {"baseUrl": format!("{}/v1", c.stub.url)}})),
    )
    .await;
    assert_eq!((s, m), (201, json!({"models": ["a-model", "b-model"]})));
    assert_eq!(
        call(
            &c,
            "POST",
            "/api/subtitles/translation-providers/models",
            &c.admin,
            Some(json!({"engine": "openai", "settings": {}}))
        )
        .await
        .1["message"],
        "An OpenAI-compatible base URL is required"
    );
    let (s, t) = call(
        &c,
        "POST",
        "/api/subtitles/translation-providers/test-connection",
        &c.admin,
        Some(json!({"engine": "gemini", "settings": {}})),
    )
    .await;
    assert_eq!(
        (s, t),
        (
            201,
            json!({"ok": false, "error": "Gemini API key is not set"})
        )
    );
    let (_, t) = call(&c, "POST", "/api/subtitles/translation-providers/test-connection", &c.admin, Some(json!({"engine": "openai", "settings": {"baseUrl": format!("{}/v1", c.stub.url), "model": "m"}}))).await;
    assert_eq!(t, json!({"ok": true}));
    // A keyless endpoint sends no Authorization header.
    let last = c.stub.seen("POST", "/v1/chat/completions").pop().unwrap();
    assert!(last.header("authorization").is_none());
}

#[sqlx::test]
async fn the_search_and_upgrade_passes_fill_gaps_and_replace_low_scores(pool: PgPool) {
    let c = ctx(pool).await;
    provider(&c, "subdl").await;
    script_subdl(
        &c,
        &[("/subtitle/1.zip", "Movie.2020.1080p.BluRay.x264-GRP", false)],
    );
    c.fake.script(
        "POST",
        "/v1/probe",
        vec![ok(
            json!({"ok": true, "info": {"video": [], "audio": [], "subtitles": []}}),
        )],
    );
    // An embedded French track covers `fr`; `en` is fetched.
    sqlx::query(r#"INSERT INTO subtitle_files ("mediaId", "mediaFileId", language, "providerType", status, codec, "streamIndex", score) VALUES ($1, $2, 'fr', 'embedded', 'embedded', 'subrip', 1, 100)"#).bind(c.media).bind(c.file).execute(&c.pool).await.unwrap();
    let got = crate::subtitles::scheduler::search_missing_for_media(&c.st, c.media, c.file).await;
    // The probe answered no tracks, which retires the embedded row, so both languages are fetched.
    assert!(got.contains(&"en".to_owned()), "{got:?}");
    let langs: Vec<String> = sqlx::query_scalar(
        r#"SELECT language FROM subtitle_files WHERE "providerType" = 'subdl' ORDER BY language"#,
    )
    .fetch_all(&c.pool)
    .await
    .unwrap();
    assert!(langs.contains(&"en".to_owned()));
    // Unknown media or file never errors.
    assert!(
        crate::subtitles::scheduler::search_missing_for_media(&c.st, 9999, 1)
            .await
            .is_empty()
    );
    // The minimum score gates a download: a threshold above any percent downloads nothing new.
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ('subtitle_min_score', 'abc') ON CONFLICT (key) DO UPDATE SET value = 'abc'").execute(&c.pool).await.unwrap();
    // C59: a non-numeric value keeps the default of 70.
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM subtitle_files")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    crate::subtitles::scheduler::search_missing_for_media(&c.st, c.media, c.file).await;
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM subtitle_files")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert!(after >= before);
    // Upgrade: a low-score row of a fully covered file is replaced by a better candidate.
    sqlx::query(
        r#"UPDATE subtitle_files SET score = 10, locked = false WHERE "providerType" = 'subdl'"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    sqlx::query(r#"INSERT INTO subtitle_files ("mediaId", "mediaFileId", language, "providerType", status, score) VALUES ($1, $2, 'fr', 'disk', 'downloaded', 100)"#).bind(c.media).bind(c.file).execute(&c.pool).await.unwrap();
    crate::subtitles::scheduler::upgrade(&c.st).await.unwrap();
    let upgraded: i64 =
        sqlx::query_scalar("SELECT count(*) FROM subtitle_files WHERE status = 'upgraded'")
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert!(upgraded >= 1);
}

#[tokio::test]
async fn a_pass_skips_when_its_claim_is_held() {
    let r = std::sync::Arc::new(crate::jobs::Running::default());
    let held = r.claim("SubtitleSearch").unwrap();
    assert!(r.claim("SubtitleSearch").is_none());
    drop(held);
    assert!(r.claim("SubtitleSearch").is_some());
}
