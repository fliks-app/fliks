//! Translation against a mock OpenAI-compatible server and the provider CRUD.
use super::{routes::*, *};
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

mod engines {
    use super::super::*;
    use crate::subtitles::{
        Bases, Shared,
        translation::{ListError, list_models, translate},
    };
    use fliks_domain::translation::{Request, TranslationError};
    use serde_json::{Value, json};

    fn shared(stub: &Stub) -> Shared {
        Shared::new(Bases {
            gemini: stub.url.clone(),
            allow_http_link: true,
            ..Bases::default()
        })
    }

    fn req(source: &str) -> Request {
        Request {
            source_language: source.into(),
            target_language: "ja".into(),
            ..Request::default()
        }
    }

    fn texts(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("line {i}")).collect()
    }

    /// The `#N#` segments of a payload, each answered with its text and a `!`.
    fn echo(user: &str) -> (usize, String) {
        let mut out = String::new();
        let (mut n, mut lines) = (0, user.lines());
        while let Some(l) = lines.next() {
            if l.starts_with('#') && l.ends_with('#') {
                n += 1;
                out.push_str(&format!("{l}\n{}!\n", lines.next().unwrap_or("")));
            }
        }
        (n, out)
    }

    fn user_of(seen: &Seen, gemini: bool) -> String {
        let b: Value = serde_json::from_slice(&seen.body).unwrap();
        if gemini {
            b["contents"][0]["parts"][0]["text"]
                .as_str()
                .unwrap_or("")
                .into()
        } else {
            b["messages"][1]["content"].as_str().unwrap_or("").into()
        }
    }

    fn noop(_: usize, _: usize) {}

    #[tokio::test]
    async fn gemini_sends_its_key_in_a_header_splits_on_max_tokens_and_lists_models() {
        let stub = Stub::start().await;
        stub.on_fn("POST", "/models/gm:generateContent", |seen| {
            let (n, text) = echo(&user_of(seen, true));
            if n > 1 {
                return reply(
                    200,
                    json!({"candidates": [{"finishReason": "MAX_TOKENS"}], "usageMetadata": {}})
                        .to_string(),
                );
            }
            reply(
                200,
                json!({"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}]})
                    .to_string(),
            )
        });
        stub.on(
            "GET",
            "/models",
            vec![reply(
                200,
                json!({"models": [
                    {"name": "models/zeta", "supportedGenerationMethods": ["generateContent"]},
                    {"name": "models/embed", "supportedGenerationMethods": ["embedContent"]},
                    {"name": "models/alpha", "supportedGenerationMethods": ["generateContent"]}
                ]})
                .to_string(),
            )],
        );
        let sh = shared(&stub);
        let s = json!({"apiKey": "GKEY", "model": "gm"});
        let out = translate(&sh, "gemini", &texts(4), req("en"), &s, &mut noop)
            .await
            .unwrap();
        assert_eq!(out, ["line 0!", "line 1!", "line 2!", "line 3!"]);
        let sent = stub.seen("POST", "/models/gm:generateContent");
        assert!(sent.len() > 4, "the truncated batches were halved");
        assert!(
            sent.iter()
                .all(|r| r.header("x-goog-api-key") == Some("GKEY"))
        );
        assert!(sent.iter().all(|r| !r.query.contains("GKEY")));
        assert_eq!(
            list_models(&sh, "gemini", &s).await.ok(),
            Some(vec!["alpha".to_owned(), "zeta".to_owned()])
        );
        let listing = stub.seen("GET", "/models").pop().unwrap();
        assert_eq!(listing.header("x-goog-api-key"), Some("GKEY"));
        assert!(matches!(
            list_models(&sh, "gemini", &json!({})).await,
            Err(ListError::Bad(_))
        ));
    }

    #[tokio::test]
    async fn libretranslate_sends_chunks_of_25_with_source_auto_for_an_unknown_language() {
        let stub = Stub::start().await;
        stub.on_fn("POST", "/translate", |seen| {
            let b: Value = serde_json::from_slice(&seen.body).unwrap();
            let out: Vec<String> = b["q"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| format!("{}!", t.as_str().unwrap()))
                .collect();
            reply(200, json!({"translatedText": out}).to_string())
        });
        let sh = shared(&stub);
        let s = json!({"url": format!("{}/", stub.url), "apiKey": "LKEY"});
        let mut progress = vec![];
        let mut on = |d: usize, t: usize| progress.push((d, t));
        let out = translate(&sh, "libretranslate", &texts(60), req("und"), &s, &mut on)
            .await
            .unwrap();
        assert_eq!(out.len(), 60);
        assert_eq!(out[59], "line 59!");
        assert_eq!(progress, [(25, 60), (50, 60), (60, 60)]);
        let sent = stub.seen("POST", "/translate");
        let sizes: Vec<usize> = sent
            .iter()
            .map(|r| {
                serde_json::from_slice::<Value>(&r.body).unwrap()["q"]
                    .as_array()
                    .unwrap()
                    .len()
            })
            .collect();
        assert_eq!(sizes, [25, 25, 10]);
        let first: Value = serde_json::from_slice(&sent[0].body).unwrap();
        assert_eq!(
            (
                first["source"].clone(),
                first["target"].clone(),
                first["format"].clone(),
                first["api_key"].clone()
            ),
            (json!("auto"), json!("ja"), json!("text"), json!("LKEY"))
        );
        translate(&sh, "libretranslate", &texts(1), req("en"), &s, &mut noop)
            .await
            .unwrap();
        let last: Value =
            serde_json::from_slice(&stub.seen("POST", "/translate").pop().unwrap().body).unwrap();
        assert_eq!(last["source"], "en");
    }

    fn openai(stub: &Stub) -> Value {
        json!({"baseUrl": format!("{}/v1", stub.url), "model": "m", "apiKey": "OKEY"})
    }

    #[tokio::test]
    async fn openai_halves_a_batch_cut_at_its_context_limit() {
        let stub = Stub::start().await;
        stub.on_fn("POST", "/v1/chat/completions", |seen| {
            let (n, text) = echo(&user_of(seen, false));
            let finish = if n > 1 { "length" } else { "stop" };
            reply(
                200,
                json!({"choices": [{"message": {"content": text}, "finish_reason": finish}]})
                    .to_string(),
            )
        });
        let sh = shared(&stub);
        let out = translate(
            &sh,
            "openai",
            &texts(4),
            req("en"),
            &openai(&stub),
            &mut noop,
        )
        .await
        .unwrap();
        assert_eq!(out, ["line 0!", "line 1!", "line 2!", "line 3!"]);
        let sent = stub.seen("POST", "/v1/chat/completions");
        assert_eq!(sent[0].header("authorization"), Some("Bearer OKEY"));
        assert!(sent.len() > 4);
    }

    #[tokio::test(start_paused = true)]
    async fn a_429_waits_at_least_the_quota_delay_and_a_413_is_not_retried() {
        let stub = Stub::start().await;
        stub.on(
            "POST",
            "/v1/chat/completions",
            vec![
                reply(429, "slow down"),
                reply(
                    200,
                    json!({"choices": [{"message": {"content": "#1#\nline 0!\n"}, "finish_reason": "stop"}]})
                        .to_string(),
                ),
            ],
        );
        let sh = shared(&stub);
        let t0 = tokio::time::Instant::now();
        let out = translate(
            &sh,
            "openai",
            &texts(1),
            req("en"),
            &openai(&stub),
            &mut noop,
        )
        .await
        .unwrap();
        assert_eq!(out, ["line 0!"]);
        assert!(
            t0.elapsed() >= std::time::Duration::from_secs(20),
            "{:?}",
            t0.elapsed()
        );
        assert_eq!(stub.seen("POST", "/v1/chat/completions").len(), 2);

        let stub = Stub::start().await;
        stub.on(
            "POST",
            "/v1/chat/completions",
            vec![reply(413, "payload too big")],
        );
        let sh = shared(&stub);
        let t0 = tokio::time::Instant::now();
        let res = translate(
            &sh,
            "openai",
            &texts(1),
            req("en"),
            &openai(&stub),
            &mut noop,
        )
        .await;
        assert!(matches!(res, Err(TranslationError::TooLarge(_))), "{res:?}");
        assert_eq!(stub.seen("POST", "/v1/chat/completions").len(), 1);
        assert!(t0.elapsed() < std::time::Duration::from_secs(1));
    }

    #[tokio::test]
    async fn translation_follows_no_redirect_and_never_puts_the_key_in_an_error() {
        let other = Stub::start().await;
        other.on("POST", "/elsewhere", vec![reply(200, "{}")]);
        let stub = Stub::start().await;
        stub.on(
            "POST",
            "/v1/chat/completions",
            vec![with(
                reply(302, ""),
                "location",
                &format!("{}/elsewhere", other.url),
            )],
        );
        let sh = shared(&stub);
        let Err(e) = translate(
            &sh,
            "openai",
            &texts(1),
            req("en"),
            &openai(&stub),
            &mut noop,
        )
        .await
        else {
            panic!("a redirect is an error")
        };
        assert!(other.all().is_empty());
        assert!(!e.to_string().contains("OKEY"), "{e}");

        let stub = Stub::start().await;
        stub.on(
            "POST",
            "/v1/chat/completions",
            vec![reply(500, "bad key OKEY")],
        );
        let sh = shared(&stub);
        let Err(e) = translate(
            &sh,
            "openai",
            &texts(1),
            req("en"),
            &openai(&stub),
            &mut noop,
        )
        .await
        else {
            panic!("a 500 is an error")
        };
        assert!(
            e.to_string().contains("***") && !e.to_string().contains("OKEY"),
            "{e}"
        );
        // A dead host never leaks the URL either.
        let sh = shared(&stub);
        let dead = json!({"baseUrl": "http://127.0.0.1:1/v1", "model": "m", "apiKey": "OKEY"});
        let Err(e) = translate(&sh, "openai", &texts(1), req("en"), &dead, &mut noop).await else {
            panic!("a dead host is an error")
        };
        assert!(
            !e.to_string().contains("OKEY") && !e.to_string().contains("127.0.0.1"),
            "{e}"
        );
    }
}
