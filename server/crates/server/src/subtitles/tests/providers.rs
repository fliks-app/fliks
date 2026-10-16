//! Providers against loopback stubs and the saved pages of `fixtures/subtitle-providers`.
use super::*;
use crate::subtitles::{
    Bases, Shared,
    providers::{Provider, Query, limiter::Circuit, provider_url, supersubtitles, yify, zip},
};
use fliks_domain::subtitle_score::Candidate;
use serde_json::{Value, json};

fn shared(stub: &Stub) -> Shared {
    let u = &stub.url;
    Shared::new(Bases {
        opensubtitles: format!("{u}/api/v1"),
        subdl_api: format!("{u}/api/v1/subtitles"),
        subdl_dl: u.clone(),
        subsynchro: u.clone(),
        supersubtitles: u.clone(),
        yify: u.clone(),
        gestdown: u.clone(),
        gemini: u.clone(),
        allow_http_link: true,
    })
}

fn q(title: &str) -> Query {
    Query {
        title: title.into(),
        language: "en".into(),
        ..Query::default()
    }
}

fn cand(id: &str, ptype: &str) -> Candidate {
    serde_json::from_value(json!({"providerFileId": id, "language": "en", "providerType": ptype, "providerName": ptype})).unwrap()
}

fn query_of(s: &Seen) -> Vec<(String, String)> {
    reqwest::Url::parse(&format!("http://x/?{}", s.query))
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect()
}

#[test]
fn provider_urls_stay_on_the_provider_origin() {
    let base = "https://dl.subdl.com";
    assert_eq!(
        provider_url(base, "/subtitle/1.zip").unwrap(),
        "https://dl.subdl.com/subtitle/1.zip"
    );
    assert_eq!(
        provider_url(base, "@attacker.tld/x").unwrap(),
        "https://dl.subdl.com/@attacker.tld/x"
    );
    assert_eq!(
        provider_url(base, "https://dl.subdl.com/a").unwrap(),
        "https://dl.subdl.com/a"
    );
    for bad in [
        "https://attacker.tld/x",
        "//attacker.tld/x",
        "file:///etc/passwd",
        "http://dl.subdl.com/a",
        "https://dl.subdl.com:8443/a",
        "\\\\host",
    ] {
        assert!(provider_url(base, bad).is_err(), "{bad}");
    }
}

#[tokio::test]
async fn opensubtitles_logs_in_once_searches_and_downloads() {
    let stub = Stub::start().await;
    stub.on("POST", "/api/v1/login", vec![reply(200, json!({"token": "tok1"}).to_string())])
        .on(
            "GET",
            "/api/v1/subtitles",
            vec![reply(
                200,
                json!({"data": [
                    {"id": "10", "attributes": {"release": "Movie.2020.1080p", "language": "en", "hearing_impaired": true,
                      "foreign_parts_only": false, "download_count": 7, "moviehash_match": true,
                      "files": [{"file_id": 555}], "feature_details": {"imdb_id": 111}}},
                    {"id": "11", "attributes": {"release": "R2", "language": "en", "files": []}}
                ]})
                .to_string(),
            )],
        )
        .on("POST", "/api/v1/download", vec![reply(200, json!({"link": format!("{}/cdn/f.srt", stub.url), "remaining": 0}).to_string())])
        .on("GET", "/cdn/f.srt", vec![reply(200, SRT)]);
    let sh = shared(&stub);
    let s = json!({"username": "u", "password": "p"});
    let p = Provider::new("opensubtitles", &s, &sh).unwrap();
    let mut query = q("Movie");
    query.imdb_id = Some("tt0111161".into());
    query.moviehash = Some("abcdef0123456789".into());
    query.season = Some(2);
    query.episode = Some(3);
    let out = p.search(&query).await.unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!(
        (
            out[0].provider_file_id.as_str(),
            out[0].imdb_id.as_deref(),
            out[0].hash_matched
        ),
        ("555", Some("111"), Some(true))
    );
    assert_eq!(out[1].provider_file_id, "11");
    let seen = stub.seen("GET", "/api/v1/subtitles");
    let keys: Vec<_> = query_of(&seen[0]).into_iter().map(|(k, _)| k).collect();
    assert_eq!(
        keys,
        [
            "moviehash",
            "imdb_id",
            "languages",
            "season_number",
            "episode_number"
        ]
    );
    assert_eq!(seen[0].header("authorization"), Some("Bearer tok1"));
    assert_eq!(
        seen[0].header("api-key"),
        Some("KXXhBJcOUG9xTxmPzIIkE56obyHtyCyd")
    );
    p.search(&q("Again")).await.unwrap();
    assert_eq!(
        stub.seen("POST", "/api/v1/login").len(),
        1,
        "the token is cached"
    );
    let by_title = &stub.seen("GET", "/api/v1/subtitles")[1];
    assert!(
        query_of(by_title)
            .iter()
            .any(|(k, v)| k == "query" && v == "Again")
    );
    let bytes = p.download(&cand("555", "opensubtitles")).await.unwrap();
    assert_eq!(String::from_utf8(bytes).unwrap(), SRT);
    let dl: Value = serde_json::from_slice(&stub.seen("POST", "/api/v1/download")[0].body).unwrap();
    assert_eq!(dl, json!({"file_id": 555}));
    assert!(
        sh.limiter.is_rate_limited("opensubtitles"),
        "a spent quota cools the type for an hour"
    );
    assert!(p.search(&q("x")).await.unwrap().is_empty());
}

#[tokio::test]
async fn opensubtitles_refuses_a_non_https_link_in_production() {
    let stub = Stub::start().await;
    stub.on(
        "POST",
        "/api/v1/download",
        vec![reply(
            200,
            json!({"link": format!("{}/cdn/f.srt", stub.url), "remaining": 5}).to_string(),
        )],
    );
    let mut bases = shared(&stub).bases;
    bases.allow_http_link = false;
    let sh = Shared::new(bases);
    let e = Provider::new("opensubtitles", &json!({}), &sh)
        .unwrap()
        .download(&cand("1", "opensubtitles"))
        .await
        .unwrap_err();
    assert_eq!(e, "OpenSubtitles returned a non-https link (http:)");
}

#[tokio::test]
async fn opensubtitles_test_needs_credentials() {
    let sh = Shared::default();
    let r = Provider::new("opensubtitles", &json!({}), &sh)
        .unwrap()
        .test()
        .await;
    assert_eq!(
        (r.ok, r.detail.as_deref()),
        (false, Some("missing username or password"))
    );
    let r = Provider::new("opensubtitles", &json!({"username": "u"}), &sh)
        .unwrap()
        .test()
        .await;
    assert!(!r.ok);
}

#[tokio::test]
async fn subdl_searches_downloads_a_zip_and_reports_its_status() {
    let stub = Stub::start().await;
    let zip = zip_of("movie.srt", SRT.as_bytes(), true);
    stub.on(
        "GET",
        "/api/v1/subtitles",
        vec![
            reply(200, json!({"status": true, "subtitles": [{"release_name": "R.1080p", "language": "EN", "hi": true, "url": "/subtitle/1.zip"}]}).to_string()),
            reply(200, json!({"status": false, "error": "can't find movie"}).to_string()),
            reply(500, "boom"),
        ],
    )
    .on("GET", "/subtitle/1.zip", vec![reply(200, zip)]);
    let sh = shared(&stub);
    let p = Provider::new("subdl", &json!({"apiKey": "K3Y"}), &sh).unwrap();
    let mut query = q("Show");
    query.moviehash = Some("h".into());
    let out = p.search(&query).await.unwrap();
    assert_eq!(
        (
            out[0].provider_file_id.as_str(),
            out[0].hearing_impaired,
            out[0].language.as_str()
        ),
        ("/subtitle/1.zip", true, "EN")
    );
    let qs = query_of(&stub.seen("GET", "/api/v1/subtitles")[0]);
    assert_eq!(qs[0], ("api_key".into(), "K3Y".into()));
    assert!(
        qs.contains(&("film_name".into(), "Show".into())),
        "a hash does not suppress the title"
    );
    assert!(
        qs.contains(&("type".into(), "movie".into()))
            && qs.contains(&("subs_per_page".into(), "30".into()))
    );
    assert!(p.search(&q("x")).await.unwrap().is_empty());
    assert!(p.search(&q("x")).await.unwrap().is_empty());
    assert_eq!(
        String::from_utf8(p.download(&cand("/subtitle/1.zip", "subdl")).await.unwrap()).unwrap(),
        SRT
    );
    let e = p
        .download(&cand("https://evil.example/x.zip", "subdl"))
        .await
        .unwrap_err();
    assert_eq!(e, "Refusing to download from https://evil.example");
}

#[tokio::test]
async fn supersubtitles_reads_the_saved_pages() {
    let stub = Stub::start().await;
    let sh = shared(&stub);
    stub.on(
        "GET",
        "/index.php",
        vec![
            reply(200, fixture("json/supersubtitles-hit.json")),
            reply(200, fixture("json/supersubtitles-episode.json")),
        ],
    );
    let mut query = q("Placeholder");
    query.language = String::new();
    query.season = Some(1);
    query.episode = Some(1);
    let p = Provider::new("supersubtitles", &json!({}), &sh).unwrap();
    let out = p.search(&query).await.unwrap();
    assert_eq!(
        (
            out[0].provider_file_id.as_str(),
            out[0].language.as_str(),
            out[0].provider_type.as_str()
        ),
        ("1295179297", "hu", "supersubtitles")
    );
    let seen = stub.seen("GET", "/index.php");
    assert!(
        seen[0].query.contains("action=autoname") && seen[1].query.contains("sid=252&ev=1&rtol=1")
    );
    assert!(seen[0].header("referer").unwrap().ends_with("/index.php"));

    let html = fixture("html/supersubtitles-movie.html");
    let all = supersubtitles::parse_movie_results(&html, "");
    assert_eq!(all.len(), 2);
    assert_eq!(
        (
            all[0].provider_file_id.as_str(),
            all[0].language.as_str(),
            all[0].title.as_str()
        ),
        ("1756650761", "en", "Inception (2010) (NF.WEBRip)")
    );
    assert_eq!(
        (all[1].provider_file_id.as_str(), all[1].language.as_str()),
        ("1728736777", "hu")
    );
    let en = supersubtitles::parse_movie_results(&html, "en");
    assert_eq!(
        en.iter()
            .map(|c| c.provider_file_id.as_str())
            .collect::<Vec<_>>(),
        ["1756650761"]
    );
    assert!(
        supersubtitles::parse_movie_results("<table><tr><td>Nothing</td></tr></table>", "")
            .is_empty()
    );
}

#[tokio::test]
async fn supersubtitles_stops_at_the_no_match_sentinel_and_survives_odd_bodies() {
    for body in [
        "",
        "Nincs SorozatID!",
        "null",
        r#"{"a": null, "b": {"felirat": ""}}"#,
    ] {
        let stub = Stub::start().await;
        stub.on(
            "GET",
            "/index.php",
            vec![
                reply(200, fixture("json/supersubtitles-hit.json")),
                reply(200, body),
            ],
        );
        let sh = shared(&stub);
        let mut query = q("Placeholder");
        query.season = Some(1);
        query.episode = Some(1);
        assert!(
            Provider::new("supersubtitles", &json!({}), &sh)
                .unwrap()
                .search(&query)
                .await
                .unwrap()
                .is_empty(),
            "{body:?}"
        );
    }
    let stub = Stub::start().await;
    stub.on(
        "GET",
        "/index.php",
        vec![reply(200, fixture("json/supersubtitles-miss.json"))],
    );
    let sh = shared(&stub);
    let mut query = q("Placeholder");
    query.season = Some(1);
    query.episode = Some(1);
    assert!(
        Provider::new("supersubtitles", &json!({}), &sh)
            .unwrap()
            .search(&query)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(stub.all().len(), 1, "no request for the sentinel id");
}

#[tokio::test]
async fn supersubtitles_extracts_an_archive_it_is_served() {
    let stub = Stub::start().await;
    stub.on(
        "GET",
        "/index.php",
        vec![reply(200, zip_of("a.srt", SRT.as_bytes(), false))],
    );
    let sh = shared(&stub);
    let bytes = Provider::new("supersubtitles", &json!({}), &sh)
        .unwrap()
        .download(&cand("1", "supersubtitles"))
        .await
        .unwrap();
    assert_eq!(String::from_utf8(bytes).unwrap(), SRT);
}

#[tokio::test]
async fn yify_reads_the_saved_pages_and_follows_the_download_link() {
    let html = fixture("html/yify-movie.html");
    let fr = yify::parse_results(&html, Some("french"), "fr");
    assert_eq!(fr.len(), 2);
    assert_eq!(
        (
            fr[0].provider_file_id.as_str(),
            fr[0].title.as_str(),
            fr[0].hearing_impaired
        ),
        (
            "/subtitles/inception-2010-french-yify-357699",
            "Inception.2010.1080p.BluRay.x264-GRP",
            false
        )
    );
    assert!(fr[1].hearing_impaired);
    assert_eq!(
        yify::parse_results(&html, None, "xx").len(),
        3,
        "an unmapped language accepts every row"
    );
    assert!(yify::parse_results("<p>none</p>", None, "fr").is_empty());

    let stub = Stub::start().await;
    stub.on("GET", "/movie-imdb/tt1375666", vec![reply(200, html)])
        .on(
            "GET",
            "/subtitles/inception-2010-french-yify-357699",
            vec![reply(200, fixture("html/yify-subtitle.html"))],
        )
        .on(
            "GET",
            "/subtitle/inception-2010-french-yify-357699.zip",
            vec![reply(200, zip_of("x.srt", SRT.as_bytes(), true))],
        )
        .on(
            "GET",
            "/movie-imdb/tt0111161",
            vec![with(reply(302, ""), "location", "/elsewhere")],
        );
    let sh = shared(&stub);
    let p = Provider::new("yify", &json!({}), &sh).unwrap();
    let mut query = q("Inception");
    query.language = "fr".into();
    assert!(p.search(&query).await.unwrap().is_empty(), "no imdb id");
    query.imdb_id = Some("tt1375666".into());
    let out = p.search(&query).await.unwrap();
    assert_eq!(out.len(), 2);
    let bytes = p.download(&out[0]).await.unwrap();
    assert_eq!(String::from_utf8(bytes).unwrap(), SRT);
    query.imdb_id = Some("tt0111161".into());
    assert!(
        p.search(&query).await.unwrap().is_empty(),
        "a redirect is no result"
    );
    let t = p.test().await;
    assert_eq!((t.ok, t.detail.as_deref()), (false, Some("HTTP 302 Found")));
}

#[tokio::test]
async fn subsynchro_and_gestdown_map_their_json() {
    let stub = Stub::start().await;
    stub.on("GET", "/include/ajax/subMarin.php", vec![reply(200, fixture("json/subsynchro-search.json"))])
        .on("GET", "/telecharger/12345", vec![reply(200, zip_of("readme.txt", b"hello", false))])
        .on(
            "GET",
            "/shows/search/Some%20Show",
            vec![reply(200, json!({"shows": [{"id": "s1", "tmdbId": 1}, {"id": "s2", "tmdbId": 99}]}).to_string())],
        )
        .on(
            "GET",
            "/subtitles/get/s2/1/2/French",
            vec![reply(
                200,
                json!({"matchingSubtitles": [
                    {"completed": true, "version": "WEB", "release": "Rel", "hearingImpaired": true, "downloadUri": "/subtitles/download/x", "downloadCount": 4},
                    {"completed": false, "downloadUri": "/subtitles/download/y"}
                ]})
                .to_string(),
            )],
        )
        .on("GET", "/subtitles/download/x", vec![reply(200, SRT)]);
    let sh = shared(&stub);
    let mut query = q("Inception");
    query.year = Some(2010);
    let sub = Provider::new("subsynchro", &json!({}), &sh).unwrap();
    let out = sub.search(&query).await.unwrap();
    assert_eq!(
        (
            out[0].title.as_str(),
            out[0].release_name.as_deref(),
            out[0].language.as_str()
        ),
        (
            "Inception.2010.1080p.BluRay.x264-GRP",
            Some("Inception.2010.1080p.BluRay.x264-GRP"),
            "fr"
        )
    );
    assert_eq!(
        (out[1].title.as_str(), out[1].release_name.clone()),
        ("Inception", None)
    );
    // A zip with no subtitle name falls back to its first entry.
    assert_eq!(sub.download(&out[0]).await.unwrap(), b"hello");
    let mut series = q("Inception");
    series.season = Some(1);
    assert!(sub.search(&series).await.unwrap().is_empty(), "movies only");

    let g = Provider::new("gestdown", &json!({}), &sh).unwrap();
    let mut ep = q("Some Show");
    ep.language = "fr".into();
    ep.season = Some(1);
    ep.episode = Some(2);
    ep.tmdb_id = Some(99);
    let out = g.search(&ep).await.unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(
        (
            out[0].title.as_str(),
            out[0].release_name.as_deref(),
            out[0].hearing_impaired,
            out[0].download_count
        ),
        ("Some Show - WEB - Rel", Some("Rel"), true, Some(4.0))
    );
    assert_eq!(g.download(&out[0]).await.unwrap(), SRT.as_bytes());
    ep.language = "xx".into();
    assert!(g.search(&ep).await.unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn the_breaker_opens_after_three_failures_and_lets_one_probe_through() {
    let stub = Stub::start().await;
    stub.on(
        "GET",
        "/api/v1/subtitles",
        vec![
            reply(500, "down"),
            reply(500, "down"),
            reply(500, "down"),
            reply(200, json!({"status": true, "subtitles": []}).to_string()),
        ],
    );
    let sh = shared(&stub);
    let p = Provider::new("subdl", &json!({"apiKey": "k"}), &sh).unwrap();
    for _ in 0..3 {
        let _ = p.search(&q("x")).await;
    }
    assert!(sh.limiter.is_rate_limited("subdl"));
    let before = stub.all().len();
    assert!(p.search(&q("x")).await.unwrap().is_empty());
    assert_eq!(stub.all().len(), before, "an open circuit sends nothing");
    let info = &sh.limiter.all()[0];
    assert_eq!(
        (info.circuit, info.consecutive_failures),
        (Circuit::Open, 3)
    );
    tokio::time::sleep(Duration::from_secs(301)).await;
    assert!(!sh.limiter.is_rate_limited("subdl"));
    assert!(p.search(&q("x")).await.unwrap().is_empty());
    assert_eq!(stub.all().len(), before + 1, "the probe reached the stub");
    assert!(sh.limiter.all().is_empty(), "a success closes the circuit");
}

#[tokio::test(start_paused = true)]
async fn a_failed_probe_reopens_and_a_429_cools_down_with_a_capped_retry_after() {
    let stub = Stub::start().await;
    stub.on("GET", "/api/v1/subtitles", vec![reply(500, "x")]);
    let sh = shared(&stub);
    let p = Provider::new("subdl", &json!({"apiKey": "k"}), &sh).unwrap();
    for _ in 0..3 {
        let _ = p.search(&q("x")).await;
    }
    tokio::time::sleep(Duration::from_secs(301)).await;
    let _ = p.search(&q("x")).await;
    assert_eq!(
        sh.limiter.all()[0].circuit,
        Circuit::Open,
        "a failed probe re-opens at once"
    );

    let stub = Stub::start().await;
    stub.on(
        "GET",
        "/api/v1/subtitles",
        vec![with(reply(429, ""), "retry-after", "86400")],
    );
    let sh = shared(&stub);
    let p = Provider::new("subdl", &json!({"apiKey": "k"}), &sh).unwrap();
    assert!(p.search(&q("x")).await.unwrap().is_empty());
    assert_eq!(stub.all().len(), 3, "two retries");
    let info = &sh.limiter.all()[0];
    assert!(
        info.delay_sec <= 3600 && info.delay_sec > 3500,
        "{}",
        info.delay_sec
    );
}

#[tokio::test]
async fn errors_never_carry_a_url_or_a_key() {
    let sh = Shared::new(Bases {
        subdl_api: "http://127.0.0.1:1/api/v1/subtitles".into(),
        ..Bases::default()
    });
    let p = Provider::new("subdl", &json!({"apiKey": "SECRETKEY"}), &sh).unwrap();
    assert!(p.search(&q("x")).await.unwrap().is_empty());
    let t = p.test().await;
    let detail = t.detail.unwrap();
    assert!(
        !detail.contains("SECRETKEY") && !detail.contains("127.0.0.1"),
        "{detail}"
    );
}

#[tokio::test]
async fn a_redirect_off_the_origin_or_port_is_not_followed() {
    let other = Stub::start().await;
    other.on("GET", "/elsewhere", vec![reply(200, SRT)]);
    let stub = Stub::start().await;
    stub.on(
        "GET",
        "/cdn/f.srt",
        vec![with(
            reply(302, ""),
            "location",
            &format!("{}/elsewhere", other.url),
        )],
    );
    let res = crate::outbound::client()
        .get(format!("{}/cdn/f.srt", stub.url))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 302);
    assert!(other.all().is_empty());
}

#[tokio::test]
async fn downloads_are_capped() {
    let big = vec![b'a'; 6 * 1024 * 1024];
    let bomb = zip_of("x.srt", &big, true);
    assert!(
        zip::extract_subtitle(&bomb, false)
            .unwrap_err()
            .contains("too large")
    );
    let small = zip_of("dir/x.SRT", SRT.as_bytes(), true);
    assert_eq!(
        zip::extract_subtitle(&small, false).unwrap(),
        SRT.as_bytes()
    );
    assert!(zip::extract_subtitle(&zip_of("a.txt", b"x", false), false).is_err());
    assert!(zip::extract_subtitle(b"not a zip", true).is_err());
}

#[tokio::test(start_paused = true)]
async fn a_probe_that_never_answers_reports_a_timeout() {
    let stub = Stub::start().await;
    let mut hang = reply(200, "{}");
    hang.delay_ms = 3_600_000;
    stub.on("GET", "/api/v1/subtitles", vec![hang]);
    let sh = shared(&stub);
    let p = Provider::new("subdl", &json!({"apiKey": "k"}), &sh).unwrap();
    let t = p.test().await;
    assert!(!t.ok);
    assert!(t.detail.unwrap().contains("timeout"));
}

#[tokio::test]
async fn a_probe_failure_never_echoes_the_key() {
    let stub = Stub::start().await;
    stub.on(
        "GET",
        "/api/v1/subtitles",
        vec![reply(401, json!({"message": "bad key KEY123"}).to_string())],
    );
    let sh = shared(&stub);
    let p = Provider::new("subdl", &json!({"apiKey": "KEY123"}), &sh).unwrap();
    let detail = p.test().await.detail.unwrap();
    assert!(
        detail.contains("***") && !detail.contains("KEY123"),
        "{detail}"
    );
}

#[tokio::test]
async fn a_stored_zip_entry_is_capped_like_a_deflated_one() {
    let big = vec![b'a'; 6 * 1024 * 1024];
    assert!(zip::extract_subtitle(&zip_of("x.srt", &big, false), false).is_err());
}
