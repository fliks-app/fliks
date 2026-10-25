//! The plugin `db` driver (rule 35): types, deadline cancel, session reset, the migrate ledger.
use super::harness::*;
use fliks_server::plugins::runtime::{HttpRequest, Principal};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn post(path: &str, body: Vec<u8>, query: &[(&str, &str)]) -> HttpRequest {
    HttpRequest {
        method: "POST".into(),
        path: path.into(),
        query: query
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect(),
        body,
        principal: Principal::Delegated(1),
    }
}

fn q(sql: &str, params: Value) -> Vec<u8> {
    json!({ "sql": sql, "params": params })
        .to_string()
        .into_bytes()
}

const NAMES: [&str; 8] = [
    "0001_initial_schema",
    "0002_indexer_caps_probed_at",
    "0003_download_history_size",
    "0004_download_history_info_url",
    "0005_indexer_sources",
    "0006_indexer_interactive_search",
    "0007_indexer_caps_supported_params",
    "0008_download_history_coverage",
];

/// Rule 35's typed value against what the 4.x driver handed the plugin (a `Date` as ISO text, bytes, parsed JSON).
fn same_value(sql: &str, got: &Value, columns: &Value, want: &Value) -> bool {
    // Where the 4.x driver crashed the plugin or lost the value, the host decodes the text or refuses the type.
    let special = [
        ("SELECT 'infinity'::timestamptz AS v", json!("infinity")),
        ("SELECT '-infinity'::timestamp AS v", json!("-infinity")),
        ("SELECT pg_advisory_unlock_all() AS v", Value::Null),
        ("SELECT now() - now() AS v", json!("error")),
        ("SELECT ARRAY[1,2]::int4[] AS v", json!("error")),
    ];
    if let Some((_, v)) = special.iter().find(|(s, _)| *s == sql) {
        return got == v;
    }
    if want == "error" {
        return got == "error";
    }
    if *columns != want["columns"] {
        return false;
    }
    let want = &want["value"];
    match (got, want.get("date").or(want.get("bytes"))) {
        (Value::String(s), Some(Value::String(iso))) => {
            iso == s || *iso == format!("{s}T00:00:00.000Z")
        }
        (Value::Array(b), Some(Value::Array(w))) => b == w,
        _ => match got.get("json").and_then(Value::as_str) {
            Some(text) => serde_json::from_str::<Value>(text).ok().as_ref() == Some(want),
            None => got == want,
        },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn db_driver() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("dbdrv").await else {
        return;
    };
    let h = harness(&s, "dbdrv", |c| {
        c.deadlines.db_query = Duration::from_secs(2)
    })
    .await;
    allow_unsigned(&h).await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    let rt = h.st.plugins.rt("fliks.fixture").unwrap();
    let call = async |path: &str, body: Vec<u8>, query: &[(&str, &str)]| {
        serde_json::from_slice::<Value>(
            &rt.http(post(path, body, query), false).await.unwrap().body,
        )
        .unwrap()
    };
    // A 4.x ledger is adopted: nothing re-runs.
    call("/test/db/query", q(r#"CREATE TABLE "_migrations" ("name" varchar PRIMARY KEY, "appliedAt" timestamptz NOT NULL DEFAULT now())"#, json!([])), &[]).await;
    call(
        "/test/db/query",
        q(
            r#"INSERT INTO "_migrations" ("name") SELECT unnest($1::text[])"#,
            json!([{"t":"text-list","v":NAMES}]),
        ),
        &[],
    )
    .await;
    assert_eq!(
        call("/test/db/migrate", vec![], &[]).await["applied"],
        json!([])
    );
    assert_eq!(
        call(
            "/test/db/query",
            q(
                "SELECT to_regclass('indexers') IS NULL AS absent",
                json!([])
            ),
            &[]
        )
        .await["rows"][0][0],
        true
    );
    call(
        "/test/db/query",
        q(r#"DROP TABLE "_migrations""#, json!([])),
        &[],
    )
    .await;
    let (a, b) = tokio::join!(
        call("/test/db/migrate", vec![], &[]),
        call("/test/db/migrate", vec![], &[])
    );
    let mut all: Vec<String> = [a["applied"].clone(), b["applied"].clone()]
        .iter()
        .flat_map(|v| v.as_array().cloned().unwrap_or_default())
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    all.sort();
    assert_eq!(
        all, NAMES,
        "two concurrent migrates apply each once: {a} {b}"
    );
    // A script whose second statement fails rolls back whole.
    let r = call(
        "/test/db/script",
        b"CREATE TABLE half (a int); SELECT nope FROM missing;".to_vec(),
        &[("name", "0009_bad")],
    )
    .await;
    assert_eq!(r["error"], "42P01", "{r}");
    assert_eq!(
        call(
            "/test/db/query",
            q("SELECT to_regclass('half') IS NULL AS absent", json!([])),
            &[]
        )
        .await["rows"][0][0],
        true
    );
    assert_eq!(
        call(
            "/test/db/query",
            q(
                r#"SELECT count(*) AS n FROM "_migrations" WHERE name = '0009_bad'"#,
                json!([])
            ),
            &[]
        )
        .await["rows"][0][0],
        0
    );
    // The `db-driver` vectors: the 4.x driver with the download plugin's parsers, as that plugin saw each value.
    let file: Value =
        serde_json::from_str(include_str!("../../../../../fixtures/db-driver/cases.json")).unwrap();
    let mut failed = vec![];
    for c in file["cases"].as_array().unwrap() {
        let (sql, params) = (c["input"]["sql"].as_str().unwrap(), &c["input"]["params"]);
        let r = call("/test/db/query", q(sql, params.clone()), &[]).await;
        let got = if r.get("error").is_some() {
            json!("error")
        } else {
            r["rows"][0][0].clone()
        };
        if !same_value(sql, &got, &r["columns"], &c["expected"]) {
            failed.push(format!("{sql}: got {got} ({r}) want {}", c["expected"]));
        }
    }
    assert!(failed.is_empty(), "{failed:#?}");
    let r = call(
        "/test/db/query",
        q("SELECT 1 AS one, 'a' AS two WHERE false", json!([])),
        &[],
    )
    .await;
    assert_eq!(
        (r["columns"].clone(), r["rows"].clone()),
        (json!(["one", "two"]), json!([])),
        "an empty result keeps its columns"
    );
    let r = call(
        "/test/db/query",
        q(
            "SELECT repeat('x', 1000000) FROM generate_series(1, 40)",
            json!([]),
        ),
        &[],
    )
    .await;
    assert_eq!(r["error"], "ERR_RESULT_TOO_LARGE", "{r}");
    let r = call("/test/db/query", q("SELECT 1 AS one", json!([])), &[]).await;
    assert_eq!(
        r["rows"],
        json!([[1]]),
        "the connection survives the cut: {r}"
    );
    let t = Instant::now();
    let r = call("/test/db/sleep", vec![], &[("s", "30")]).await;
    assert_eq!(r["error"], "57014", "{r}");
    assert!(t.elapsed() < Duration::from_secs(4));
    let role = format!("fp_{}_fliks_fixture", s.oid().await);
    until("the cancelled query gone", Duration::from_secs(5), async || {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM pg_stat_activity WHERE usename = $1 AND state = 'active' AND query LIKE '%pg_sleep%'")
            .bind(&role)
            .fetch_one(&s.pool)
            .await
            .unwrap()
            == 0
    })
    .await;
    call("/test/db/set-timeout", vec![], &[]).await;
    assert_eq!(
        call("/test/db/show-timeout", vec![], &[]).await["statement_timeout"],
        "3s",
        "session state dies with its call"
    );
    h.finish().await;
    s.finish().await;
}

/// Rule 54: import runs plugin code (triggers) as the plugin's role, never as core.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn import_runs_plugin_triggers_as_the_plugin_role() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("impsbx").await else {
        return;
    };
    let h = harness(&s, "impsbx", |_| {}).await;
    allow_unsigned(&h).await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    let rt = h.st.plugins.rt("fliks.fixture").unwrap();
    let sql = r#"CREATE TABLE spied (id int PRIMARY KEY);
        CREATE FUNCTION spy() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM count(*) FROM public.users; RETURN NEW; END $$;
        CREATE TRIGGER spy BEFORE INSERT ON spied FOR EACH ROW EXECUTE FUNCTION spy();"#;
    let r = rt
        .http(
            post(
                "/test/db/script",
                sql.as_bytes().to_vec(),
                &[("name", "0100_spy")],
            ),
            false,
        )
        .await
        .unwrap();
    let made: Value = serde_json::from_slice(&r.body).unwrap();
    assert!(made.get("error").is_none(), "{made}");
    let (st, doc) = h
        .call(
            "GET",
            "/api/plugins/fliks.fixture/export",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!((st, &doc["tables"]["spied"]), (200, &json!([])), "{doc}");
    let mut doc = doc;
    doc["tables"]["spied"] = json!([{"id": 1}]);
    let (st, b) = h
        .call(
            "POST",
            "/api/plugins/fliks.fixture/import",
            Some(&h.admin),
            Some(doc),
        )
        .await;
    assert_eq!(st, 500, "{b}");
    assert!(
        b["message"]
            .as_str()
            .unwrap_or_default()
            .contains("permission denied for table users"),
        "{b}"
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_fliks_fixture.spied")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(n, 0, "the failed import left no row");
    h.finish().await;
    s.finish().await;
}

/// Rule 54: settings and rows commit together; a deferred trigger failing at commit keeps neither.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_import_failing_at_commit_writes_nothing() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("impatom").await else {
        return;
    };
    let h = harness(&s, "impatom", |_| {}).await;
    allow_unsigned(&h).await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    let rt = h.st.plugins.rt("fliks.fixture").unwrap();
    let sql = r#"CREATE TABLE late (id int PRIMARY KEY);
        CREATE FUNCTION refuse() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'refused at commit'; END $$;
        CREATE CONSTRAINT TRIGGER refuse AFTER INSERT ON late DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION refuse();"#;
    let r = rt
        .http(
            post(
                "/test/db/script",
                sql.as_bytes().to_vec(),
                &[("name", "0100_late")],
            ),
            false,
        )
        .await
        .unwrap();
    let made: Value = serde_json::from_slice(&r.body).unwrap();
    assert!(made.get("error").is_none(), "{made}");
    let (_, mut doc) = h
        .call(
            "GET",
            "/api/plugins/fliks.fixture/export",
            Some(&h.admin),
            None,
        )
        .await;
    doc["tables"]["late"] = json!([{"id": 1}]);
    doc["settings"] = json!({"plugin.fliks.fixture.restored": "yes"});
    let (st, b) = h
        .call(
            "POST",
            "/api/plugins/fliks.fixture/import",
            Some(&h.admin),
            Some(doc),
        )
        .await;
    assert_eq!(st, 500, "{b}");
    assert!(
        b["message"]
            .as_str()
            .unwrap_or_default()
            .contains("refused at commit"),
        "{b}"
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_fliks_fixture.late")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    let set: Option<String> = sqlx::query_scalar(
        r#"SELECT "key" FROM app_settings WHERE "key" = 'plugin.fliks.fixture.restored'"#,
    )
    .fetch_optional(&s.pool)
    .await
    .unwrap();
    assert_eq!(
        (n, set),
        (0, None),
        "neither the row nor the setting survived"
    );
    h.finish().await;
    s.finish().await;
}

/// Rule 54: the import body is bounded at 64 MiB by the route, after authentication.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_import_body_cap_is_the_routes_own() {
    let Some(s) = Scratch::create("impcap").await else {
        return;
    };
    let h = harness(&s, "impcap", |_| {}).await;
    let big = json!({"formatVersion": 1, "pad": "x".repeat(200 << 10)});
    let (st, b) = h
        .call(
            "POST",
            "/api/plugins/fliks.none/import",
            Some(&h.admin),
            Some(big.clone()),
        )
        .await;
    assert_eq!(st, 400, "past the global 100 kB JSON cap: {b}");
    assert_eq!(
        h.call("POST", "/api/plugins/fliks.none/import", None, Some(big))
            .await
            .0,
        401
    );
    let huge = json!({"pad": "x".repeat((64 << 20) + 1)});
    assert_eq!(
        h.call(
            "POST",
            "/api/plugins/fliks.none/import",
            Some(&h.admin),
            Some(huge)
        )
        .await
        .0,
        413
    );
    h.finish().await;
    s.finish().await;
}
