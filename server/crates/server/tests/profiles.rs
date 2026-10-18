//! `/api/profiles/*`, `/api/custom-formats/*`, `/api/quality-definitions/*` (`docs/spec/profiles.md`) through the real router.
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, profiles, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    st: AppState,
    admin: String,
    user: String,
    settings: String,
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let mut toks = vec![];
    for (name, admin, perms) in [
        ("admin", true, "[]"),
        ("user", false, r#"["media.read"]"#),
        ("settings", false, r#"["settings.access"]"#),
    ] {
        let role: i32 = sqlx::query_scalar(
            "INSERT INTO roles (name, permissions) VALUES ($1, $2) RETURNING id",
        )
        .bind(name)
        .bind(perms)
        .fetch_one(&pool)
        .await
        .unwrap();
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin", "roleId") VALUES ($1, $2, $3) RETURNING id"#,
        )
        .bind(name)
        .bind(admin)
        .bind(role)
        .fetch_one(&pool)
        .await
        .unwrap();
        toks.push(st.jwt.sign_access(id, name).unwrap().token);
    }
    let app = app::router(st.clone(), None, "/nonexistent".into(), None);
    Ctx {
        app,
        st,
        settings: toks.pop().unwrap(),
        user: toks.pop().unwrap(),
        admin: toks.pop().unwrap(),
    }
}

async fn call(c: &Ctx, method: &str, uri: &str, tok: &str, body: Value) -> (u16, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if !tok.is_empty() {
        req = req.header("authorization", format!("Bearer {tok}"));
    }
    let res = c
        .app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status().as_u16();
    let b = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

fn qp(extra: Value) -> Value {
    let mut v = json!({
        "name": "HD", "cutoff": 16,
        "items": [
            {"qualityId": 16, "qualityName": "WEBDL-1080p", "resolution": 1080, "source": "web",
             "allowed": true, "sortOrder": 1, "groupId": 3},
            {"qualityId": 18, "qualityName": "Bluray-1080p", "resolution": 1080, "source": "bluray",
             "allowed": false, "sortOrder": 2, "groupId": null},
        ],
    });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    v
}

#[sqlx::test(migrations = false)]
async fn quality_round_trip_defaults_and_keep(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, p) = call(&c, "POST", "/api/profiles/quality", &c.admin, qp(json!({}))).await;
    assert_eq!(s, 201);
    assert_eq!(
        (
            p["upgradeAllowed"].clone(),
            p["resolutionUpgradeOnly"].clone(),
            p["minCustomFormatScore"].clone()
        ),
        (json!(false), json!(false), json!(0))
    );
    assert_eq!(p["items"][0]["quality"]["name"], "WEBDL-1080p");
    assert_eq!(p["items"][0]["groupId"], 3);
    assert!(
        p["items"][1].get("groupId").is_none(),
        "null groupId is dropped"
    );
    assert!(p["createdAt"].as_str().unwrap().ends_with('Z'));
    let id = p["id"].as_i64().unwrap();
    let uri = format!("/api/profiles/quality/{id}");
    let full = qp(
        json!({"upgradeAllowed": true, "resolutionUpgradeOnly": true, "minCustomFormatScore": 5}),
    );
    let (s, _) = call(&c, "PUT", &uri, &c.admin, full).await;
    assert_eq!(s, 200);
    // optionals absent or null keep the stored value on update
    let (s, p) = call(
        &c,
        "PUT",
        &uri,
        &c.admin,
        qp(json!({"name": "HD2", "minCustomFormatScore": null})),
    )
    .await;
    assert_eq!(
        (
            s,
            p["name"].clone(),
            p["upgradeAllowed"].clone(),
            p["resolutionUpgradeOnly"].clone(),
            p["minCustomFormatScore"].clone()
        ),
        (200, json!("HD2"), json!(true), json!(true), json!(5))
    );
    let (s, list) = call(&c, "GET", "/api/profiles/quality", &c.user, json!(null)).await;
    assert_eq!((s, list.as_array().unwrap().len()), (200, 1));
    let (s, _) = call(&c, "DELETE", &uri, &c.admin, json!(null)).await;
    assert_eq!(s, 200);
    let (s, b) = call(&c, "GET", &uri, &c.admin, json!(null)).await;
    assert_eq!(
        (s, b["message"].as_str().unwrap()),
        (404, format!("QualityProfile #{id} not found").as_str())
    );
}

#[sqlx::test(migrations = false)]
async fn quality_validation_ids_and_acl(pool: PgPool) {
    let c = ctx(pool).await;
    let post = |b: Value| call(&c, "POST", "/api/profiles/quality", &c.admin, b);
    let mut no_items = qp(json!({}));
    no_items.as_object_mut().unwrap().remove("items");
    let mut nested = qp(json!({}));
    nested["items"][0]["x"] = json!(1);
    for body in [
        no_items,
        qp(json!({"extra": 1})),
        nested,
        qp(json!({"cutoff": "16"})),
        qp(json!({"cutoff": 16.5})),
        qp(json!({"cutoff": 4_000_000_000_i64})),
        qp(json!({"minCustomFormatScore": 1.5})),
        qp(json!({"upgradeAllowed": "true"})),
    ] {
        let (s, b) = post(body.clone()).await;
        assert_eq!(s, 400, "{body}");
        assert_eq!(b["error"], "Bad Request");
    }
    for id in ["abc", "%207%20", "1e1", "0x10", "99999999999"] {
        let (s, b) = call(
            &c,
            "GET",
            &format!("/api/profiles/quality/{id}"),
            &c.admin,
            json!(null),
        )
        .await;
        assert_eq!(s, 400, "{id}");
        assert_eq!(
            b["message"],
            "Validation failed (numeric string is expected)"
        );
    }
    // the policy answers before the id and body pipes
    let (s, _) = call(&c, "PUT", "/api/profiles/quality/abc", &c.user, json!({})).await;
    assert_eq!(s, 403);
    for (m, uri) in [
        ("POST", "/api/profiles/quality"),
        ("PUT", "/api/profiles/quality/1"),
        ("DELETE", "/api/profiles/quality/1"),
    ] {
        let (s, _) = call(&c, m, uri, &c.user, qp(json!({}))).await;
        assert_eq!(s, 403, "{m}");
    }
    let (s, _) = call(&c, "GET", "/api/profiles/quality", "", json!(null)).await;
    assert_eq!(s, 401);
    let (s, _) = call(
        &c,
        "POST",
        "/api/profiles/quality",
        &c.settings,
        qp(json!({})),
    )
    .await;
    assert_eq!(s, 201);
    let (s, _) = call(
        &c,
        "PUT",
        "/api/profiles/quality/99",
        &c.admin,
        qp(json!({})),
    )
    .await;
    assert_eq!(s, 404);
}

#[sqlx::test(migrations = false)]
async fn language_verbatim_jsonb_and_reset(pool: PgPool) {
    let c = ctx(pool).await;
    let body = json!({
        "name": "L",
        "audioLanguages": [{"isoCode": "en", "name": "English"}],
        "subtitleLanguages": [
            {"isoCode": "fr", "name": "French", "forced": false, "hi": false},
            {"isoCode": "en", "name": "English", "forced": true, "hi": true, "hearingImpaired": null},
            {"isoCode": "de", "name": "German", "forced": false, "hi": false, "hearingImpaired": "prefer"},
        ],
    });
    let (s, p) = call(&c, "POST", "/api/profiles/language", &c.admin, body).await;
    assert_eq!(s, 201);
    let subs = &p["subtitleLanguages"];
    assert!(subs[0].get("hearingImpaired").is_none());
    assert!(subs[1]["hearingImpaired"].is_null() && subs[1].get("hearingImpaired").is_some());
    assert_eq!(subs[2]["hearingImpaired"], "prefer");
    let uri = format!("/api/profiles/language/{}", p["id"]);
    let (s, p) = call(&c, "PUT", &uri, &c.admin, json!({"name": "L2"})).await;
    assert_eq!(
        (
            s,
            p["audioLanguages"].clone(),
            p["subtitleLanguages"].clone()
        ),
        (200, json!([]), json!([]))
    );
    for bad in [
        json!({"name": "x", "subtitleLanguages": [{"isoCode": "a", "name": "A", "forced": false, "hi": false, "hearingImpaired": "maybe"}]}),
        json!({"name": "x", "subtitleLanguages": [{"isoCode": "a", "name": "A", "hi": false}]}),
        json!({"name": "x", "audioLanguages": [{"isoCode": "a", "name": "A", "z": 1}]}),
        json!({}),
    ] {
        let (s, _) = call(&c, "POST", "/api/profiles/language", &c.admin, bad).await;
        assert_eq!(s, 400);
    }
    let (s, b) = call(
        &c,
        "DELETE",
        "/api/profiles/language/999",
        &c.admin,
        json!(null),
    )
    .await;
    assert_eq!(
        (s, b["message"].as_str().unwrap()),
        (404, "LanguageProfile #999 not found")
    );
    let (s, defs) = call(
        &c,
        "GET",
        "/api/profiles/language-definitions",
        &c.user,
        json!(null),
    )
    .await;
    let defs = defs.as_array().unwrap();
    assert_eq!((s, defs.len()), (200, 38));
    assert!(defs[37].get("iso639_2").is_none() && defs[0]["iso639_2"].is_array());
    let (s, _) = call(
        &c,
        "POST",
        "/api/profiles/language",
        &c.user,
        json!({"name": "x"}),
    )
    .await;
    assert_eq!(s, 403);
}

fn cf(extra: Value) -> Value {
    let mut v = json!({"name": "F", "score": 10, "specs": [
        {"type": "title_regex", "value": "remux", "negate": false},
        {"type": "release_flag", "value": "freeleech", "required": null},
    ]});
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    v
}

#[sqlx::test(migrations = false)]
async fn custom_formats_crud_regex_test_and_acl(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, f) = call(
        &c,
        "POST",
        "/api/custom-formats",
        &c.settings,
        cf(json!({})),
    )
    .await;
    assert_eq!(s, 201);
    assert!(f["specs"][0].get("required").is_none());
    assert!(f["specs"][1]["required"].is_null() && f["specs"][1].get("required").is_some());
    let uri = format!("/api/custom-formats/{}", f["id"]);
    // an absent score resets to 0 on PUT
    let mut upd = cf(json!({"name": "G"}));
    upd.as_object_mut().unwrap().remove("score");
    let (s, f) = call(&c, "PUT", &uri, &c.admin, upd).await;
    assert_eq!(
        (s, f["score"].clone(), f["name"].clone()),
        (200, json!(0), json!("G"))
    );
    for bad in [
        cf(json!({"specs": []})),
        cf(json!({"name": ""})),
        cf(json!({"specs": [{"type": "nope", "value": "x"}]})),
        cf(json!({"specs": [{"type": "source", "value": ""}]})),
        cf(json!({"score": 1.5})),
    ] {
        let (s, _) = call(&c, "POST", "/api/custom-formats", &c.admin, bad).await;
        assert_eq!(s, 400);
    }
    let regex = cf(
        json!({"specs": [{"type": "title_regex", "value": "ok"}, {"type": "title_regex", "value": "("}]}),
    );
    let (s, b) = call(&c, "POST", "/api/custom-formats", &c.admin, regex.clone()).await;
    assert_eq!(
        (s, b["message"].as_str().unwrap()),
        (400, "Invalid regular expression: (")
    );
    let (s, _) = call(
        &c,
        "PUT",
        "/api/custom-formats/999",
        &c.admin,
        regex.clone(),
    )
    .await;
    assert_eq!(s, 404);
    let (s, _) = call(&c, "PUT", &uri, &c.admin, regex).await;
    assert_eq!(s, 400);
    let (s, m) = call(
        &c,
        "POST",
        "/api/custom-formats/test",
        &c.admin,
        json!({"title": "A.REMUX", "freeleech": true}),
    )
    .await;
    assert_eq!(s, 201);
    assert_eq!(m[0]["formatName"], "G");
    assert!(m[0]["matched"].is_boolean());
    let (s, _) = call(
        &c,
        "POST",
        "/api/custom-formats/test",
        &c.admin,
        json!({"title": ""}),
    )
    .await;
    assert_eq!(s, 400);
    for (m, uri) in [
        ("GET", "/api/custom-formats"),
        ("GET", "/api/custom-formats/1"),
        ("POST", "/api/custom-formats/test"),
        ("DELETE", "/api/custom-formats/1"),
    ] {
        let (s, _) = call(&c, m, uri, &c.user, json!({"title": "x"})).await;
        assert_eq!(s, 403, "{m} {uri}");
    }
    let (s, _) = call(&c, "DELETE", &uri, &c.admin, json!(null)).await;
    assert_eq!(s, 200);
    let (s, b) = call(&c, "GET", &uri, &c.admin, json!(null)).await;
    assert_eq!(s, 404);
    assert!(
        b["message"]
            .as_str()
            .unwrap()
            .starts_with("Custom format #")
    );
}

#[sqlx::test(migrations = false)]
async fn quality_definitions_seed_reset_update(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, rows) = call(&c, "GET", "/api/quality-definitions", &c.admin, json!(null)).await;
    let ids: Vec<i64> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["qualityId"].as_i64().unwrap())
        .collect();
    assert_eq!((s, ids), (200, (1..=24).collect::<Vec<_>>()));
    assert_eq!(rows[17]["title"], "Bluray-1080p");
    assert_eq!(rows[17]["preferredSize"], 5000.0);
    let (s, _) = call(&c, "GET", "/api/quality-definitions", &c.user, json!(null)).await;
    assert_eq!(s, 403);
    let put = json!({"items": [
        {"qualityId": 18, "minSize": 1, "preferredSize": 2, "maxSize": 3},
        {"qualityId": 16, "title": "Web", "minSize": 1, "preferredSize": 2, "maxSize": 3},
        {"qualityId": 777, "minSize": 1, "preferredSize": 2, "maxSize": 3},
    ]});
    let (s, after) = call(&c, "PUT", "/api/quality-definitions", &c.settings, put).await;
    assert_eq!(s, 200);
    assert_eq!(after.as_array().unwrap().len(), 24);
    assert_eq!(
        (after[17]["title"].clone(), after[17]["maxSize"].clone()),
        (json!("Bluray-1080p"), json!(3.0))
    );
    assert_eq!(after[15]["title"], "Web");
    // reset computes defaults and writes nothing
    let (s, reset) = call(
        &c,
        "POST",
        "/api/quality-definitions/reset",
        &c.admin,
        json!({}),
    )
    .await;
    assert_eq!(
        (
            s,
            reset[17]["maxSize"].clone(),
            reset[0]["preferredSize"].clone()
        ),
        (201, json!(10000.0), json!(700.0))
    );
    let (_, again) = call(&c, "GET", "/api/quality-definitions", &c.admin, json!(null)).await;
    assert_eq!(again, after);
    for bad in [
        json!({"items": [{"qualityId": 1, "minSize": -1, "preferredSize": 0, "maxSize": 0}]}),
        json!({"items": [{"qualityId": 1, "title": null, "minSize": 0, "preferredSize": 0, "maxSize": 0}]}),
        json!({"items": [{"qualityId": 1.5, "minSize": 0, "preferredSize": 0, "maxSize": 0}]}),
        json!({"items": [{"qualityId": 5_000_000_000_i64, "minSize": 0, "preferredSize": 0, "maxSize": 0}]}),
        json!({"items": [{"qualityId": 1, "minSize": 0}]}),
        json!({}),
    ] {
        let (s, _) = call(&c, "PUT", "/api/quality-definitions", &c.admin, bad).await;
        assert_eq!(s, 400);
    }
}

#[sqlx::test(migrations = false)]
async fn definitions_update_is_one_transaction(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    profiles::seed_quality_definitions(&pool).await.unwrap();
    sqlx::query(r#"ALTER TABLE quality_definitions ADD CONSTRAINT cap CHECK ("maxSize" < 100000)"#)
        .execute(&pool)
        .await
        .unwrap();
    let put = json!({"items": [
        {"qualityId": 1, "title": "changed", "minSize": 1, "preferredSize": 2, "maxSize": 3},
        {"qualityId": 2, "minSize": 1, "preferredSize": 2, "maxSize": 200000},
    ]});
    let (s, _) = call(&c, "PUT", "/api/quality-definitions", &c.admin, put).await;
    assert_eq!(s, 500);
    let title: String =
        sqlx::query_scalar(r#"SELECT title FROM quality_definitions WHERE "qualityId" = 1"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(title, "WORKPRINT");
}

#[sqlx::test(migrations = false)]
async fn seed_is_idempotent_under_concurrency(pool: PgPool) {
    fliks_server::db::migrate(&pool).await.unwrap();
    let (a, b, c) = tokio::join!(
        profiles::seed_quality_definitions(&pool),
        profiles::seed_quality_definitions(&pool),
        profiles::seed_quality_definitions(&pool)
    );
    assert!(a.is_ok() && b.is_ok() && c.is_ok());
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM quality_definitions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 24);
    // a non-empty table is left alone
    sqlx::query(r#"DELETE FROM quality_definitions WHERE "qualityId" > 1"#)
        .execute(&pool)
        .await
        .unwrap();
    profiles::seed_quality_definitions(&pool).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM quality_definitions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

#[sqlx::test(migrations = false)]
async fn deleting_a_profile_nulls_its_references(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (_, q) = call(&c, "POST", "/api/profiles/quality", &c.admin, qp(json!({}))).await;
    let (_, l) = call(
        &c,
        "POST",
        "/api/profiles/language",
        &c.admin,
        json!({"name": "L"}),
    )
    .await;
    let (qid, lid) = (
        q["id"].as_i64().unwrap() as i32,
        l["id"].as_i64().unwrap() as i32,
    );
    let lib: i32 = sqlx::query_scalar(
        r#"INSERT INTO libraries (name, "defaultQualityProfileId", "defaultLanguageProfileId") VALUES ('l', $1, $2) RETURNING id"#,
    )
    .bind(qid)
    .bind(lid)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(r#"INSERT INTO media (title, type, "libraryId", "qualityProfileId", "languageProfileId") VALUES ('m', 'movie', $1, $2, $3)"#)
        .bind(lib)
        .bind(qid)
        .bind(lid)
        .execute(&pool)
        .await
        .unwrap();
    for uri in [
        format!("/api/profiles/quality/{qid}"),
        format!("/api/profiles/language/{lid}"),
    ] {
        let (s, _) = call(&c, "DELETE", &uri, &c.admin, json!(null)).await;
        assert_eq!(s, 200);
    }
    let row: (Option<i32>, Option<i32>, Option<i32>, Option<i32>) = sqlx::query_as(
        r#"SELECT l."defaultQualityProfileId", l."defaultLanguageProfileId", m."qualityProfileId", m."languageProfileId"
        FROM libraries l, media m WHERE l.id = $1"#,
    )
    .bind(lib)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row, (None, None, None, None));
}

#[sqlx::test(migrations = false)]
async fn import_resolution_and_covers(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let db = &c.st.db;
    // the default language profile is inserted by a migration; no quality profile yet
    assert_eq!(
        profiles::resolve_quality_profile_id_for_import(db, None, None)
            .await
            .unwrap(),
        None
    );
    let mut ids = vec![];
    for (name, cutoff, res) in [("hd", 16, 1080), ("uhd", 21, 2160)] {
        let body = json!({"name": name, "cutoff": cutoff, "items": [
            {"qualityId": cutoff, "qualityName": "q", "resolution": res, "source": "web", "allowed": true, "sortOrder": 1}]});
        let (_, p) = call(&c, "POST", "/api/profiles/quality", &c.admin, body).await;
        ids.push(p["id"].as_i64().unwrap() as i32);
    }
    let (hd, uhd) = (ids[0], ids[1]);
    let r = |req, lib| profiles::resolve_quality_profile_id_for_import(db, req, lib);
    assert_eq!(r(None, None).await.unwrap(), Some(hd));
    assert_eq!(r(Some(uhd), Some(hd)).await.unwrap(), Some(uhd));
    assert_eq!(r(None, Some(uhd)).await.unwrap(), Some(uhd));
    assert_eq!(r(None, Some(9999)).await.unwrap(), Some(hd));
    let e = r(Some(9999), None).await.unwrap_err();
    assert!(format!("{e:?}").contains("Quality profile #9999 not found"));
    let e = profiles::resolve_language_profile_id_for_import(db, Some(9999), None)
        .await
        .unwrap_err();
    assert!(format!("{e:?}").contains("Language profile #9999 not found"));

    let covers = |e, q| profiles::quality_profile_covers(db, e, q);
    assert!(covers(Some(hd), hd).await.unwrap(), "same id");
    assert!(!covers(None, hd).await.unwrap(), "null existing");
    assert!(covers(Some(uhd), hd).await.unwrap());
    assert!(!covers(Some(hd), uhd).await.unwrap());
    assert!(!covers(Some(hd), 9999).await.unwrap(), "missing requested");
    // a cutoff that names no item resolves to 0
    let (_, odd) = call(
        &c,
        "POST",
        "/api/profiles/quality",
        &c.admin,
        json!({"name": "odd", "cutoff": 99, "items": []}),
    )
    .await;
    let odd = odd["id"].as_i64().unwrap() as i32;
    assert!(!covers(Some(odd), hd).await.unwrap() && covers(Some(hd), odd).await.unwrap());

    let cr = &c;
    let lang = |audio: Value| async move {
        let (_, p) = call(
            cr,
            "POST",
            "/api/profiles/language",
            &cr.admin,
            json!({"name": "x", "audioLanguages": audio}),
        )
        .await;
        p["id"].as_i64().unwrap() as i32
    };
    let en = lang(json!([{"isoCode": "en", "name": "English"}])).await;
    let both =
        lang(json!([{"isoCode": "en", "name": "English"}, {"isoCode": "fr", "name": "French"}]))
            .await;
    let none = lang(json!([])).await;
    let covers = |e, q| profiles::language_profile_covers(db, e, q);
    assert!(covers(Some(both), en).await.unwrap());
    assert!(!covers(Some(en), both).await.unwrap());
    assert!(
        covers(Some(en), none).await.unwrap(),
        "empty requested list is covered"
    );
    assert!(!covers(None, en).await.unwrap() && !covers(Some(en), 9999).await.unwrap());
    let env = |e, r| profiles::envelope_covers(db, e, r);
    assert!(env((None, None), (None, None)).await.unwrap());
    assert!(
        env((Some(uhd), Some(both)), (Some(hd), Some(en)))
            .await
            .unwrap()
    );
    assert!(
        !env((Some(uhd), Some(en)), (Some(hd), Some(both)))
            .await
            .unwrap()
    );
}
