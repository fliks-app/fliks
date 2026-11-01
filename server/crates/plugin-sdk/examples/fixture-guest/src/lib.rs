//! Test and parity fixture: the parity routes follow `server/parity/plugins/`;
//! `/test/*` routes exercise one host behaviour each.

use fliks_plugin_sdk::bindings::fliks::plugin::types as t;
use fliks_plugin_sdk::bindings::wasi::http::types::Method;
use fliks_plugin_sdk::db::{self, Param, Value};
use fliks_plugin_sdk::router::{Request, Response, Router, not_found};
use fliks_plugin_sdk::{HealthReport, HttpRequest, HttpResponse, Plugin, host, http, info, rt};
use serde_json::{Value as Json, json};
use std::hint::black_box;
use std::io::Write;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

const MIGRATIONS: [(&str, &str); 8] = [
    (
        "0001_initial_schema",
        include_str!("../migrations/0001_initial_schema.sql"),
    ),
    (
        "0002_indexer_caps_probed_at",
        include_str!("../migrations/0002_indexer_caps_probed_at.sql"),
    ),
    (
        "0003_download_history_size",
        include_str!("../migrations/0003_download_history_size.sql"),
    ),
    (
        "0004_download_history_info_url",
        include_str!("../migrations/0004_download_history_info_url.sql"),
    ),
    (
        "0005_indexer_sources",
        include_str!("../migrations/0005_indexer_sources.sql"),
    ),
    (
        "0006_indexer_interactive_search",
        include_str!("../migrations/0006_indexer_interactive_search.sql"),
    ),
    (
        "0007_indexer_caps_supported_params",
        include_str!("../migrations/0007_indexer_caps_supported_params.sql"),
    ),
    (
        "0008_download_history_coverage",
        include_str!("../migrations/0008_download_history_coverage.sql"),
    ),
];

struct Fixture;

/// A behaviour switch set through `plugin.fliks.fixture.<key>`.
fn mode(key: &str) -> String {
    host::config_get(Some(&[key.to_owned()]))
        .ok()
        .and_then(|v| v.into_iter().find(|(k, _)| k == key).map(|(_, v)| v))
        .unwrap_or_default()
}

fn pg_sleep(secs: f64) -> Result<(), String> {
    let end = Instant::now() + Duration::from_secs_f64(secs);
    while let Some(left) = end
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
    {
        let s = left.as_secs_f64().min(50.0);
        db::query("SELECT 1 AS slept FROM pg_sleep($1)", &[Param::Float(s)])
            .map_err(|e| format!("{}: {}", e.code, e.message))?;
    }
    Ok(())
}

fn spin(secs: f64) {
    let end = Instant::now() + Duration::from_secs_f64(secs);
    let mut n = 0u64;
    while Instant::now() < end {
        for _ in 0..10_000 {
            n = black_box(n.wrapping_mul(31).wrapping_add(7));
        }
    }
}

fn param(v: &Json) -> Param {
    let x = &v["v"];
    match v["t"].as_str().unwrap_or("") {
        "bool" => Param::Boolean(x.as_bool().unwrap_or(false)),
        "int" => Param::Int(x.as_i64().unwrap_or(0)),
        "float" => Param::Float(x.as_f64().unwrap_or(0.0)),
        "text" => Param::Text(x.as_str().unwrap_or("").into()),
        "bytes" => Param::Bytes(x.as_array().map_or(vec![], |a| {
            a.iter().map(|b| b.as_u64().unwrap_or(0) as u8).collect()
        })),
        "json" => Param::Json(x.to_string()),
        "text-list" => Param::TextList(x.as_array().map_or(vec![], |a| {
            a.iter()
                .map(|s| s.as_str().unwrap_or("").to_owned())
                .collect()
        })),
        "int-list" => Param::IntList(x.as_array().map_or(vec![], |a| {
            a.iter().map(|s| s.as_i64().unwrap_or(0)).collect()
        })),
        _ => Param::Null,
    }
}

fn value(v: &Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Boolean(b) => json!(b),
        Value::Int(i) => json!(i),
        Value::Float(f) => json!(f),
        Value::Text(t) => json!(t),
        Value::Bytes(b) => json!(b),
        Value::Json(t) => json!({ "json": t }),
    }
}

fn run_query(body: &[u8]) -> Json {
    let q: Json = serde_json::from_slice(body).unwrap_or_default();
    let params: Vec<Param> = q["params"]
        .as_array()
        .map_or(vec![], |a| a.iter().map(param).collect());
    match db::query(q["sql"].as_str().unwrap_or(""), &params) {
        Ok(rows) => json!({
            "columns": rows.0.columns,
            "rows": rows.0.rows.iter().map(|r| Json::Array(r.iter().map(value).collect())).collect::<Vec<_>>(),
        }),
        Err(e) => json!({ "error": e.code, "message": e.message }),
    }
}

fn ok(body: Json) -> Result<Response, String> {
    Ok(Response::json(200, &body))
}

fn host_result<T: serde::Serialize>(r: Result<T, t::HostError>) -> Result<Response, String> {
    match r {
        Ok(v) => ok(json!({ "ok": v })),
        Err(e) => ok(json!({ "error": e.code, "message": e.message })),
    }
}

fn hello(req: &Request) -> Result<Response, String> {
    ok(json!({ "hello": "world", "path": req.path }))
}

fn headers(_: &Request) -> Result<Response, String> {
    Ok(Response::json(200, &json!({ "headers": true }))
        .with_header("set-cookie", "a=b")
        .with_header("x-custom", "1")
        .with_header("ETag", "\"v1\"")
        .with_header("cache-control", "max-age=60")
        .with_header("location", "/elsewhere"))
}

fn echo(req: &Request) -> Result<Response, String> {
    let body: Json = req.json().unwrap_or(Json::Null);
    let query: Vec<Json> = req.query.iter().map(|(k, v)| json!([k, v])).collect();
    ok(json!({ "method": req.method, "body": body, "query": query }))
}

fn config(_: &Request) -> Result<Response, String> {
    match host::config_get(None) {
        Ok(v) => ok(Json::Object(
            v.into_iter().map(|(k, v)| (k, Json::String(v))).collect(),
        )),
        Err(e) => ok(json!({ "error": e.code })),
    }
}

fn status(req: &Request) -> Result<Response, String> {
    let code = req
        .param("code")
        .and_then(|c| c.parse().ok())
        .unwrap_or(500);
    Ok(Response::json(code, &json!({ "status": true })))
}

fn path(req: &Request) -> Result<Response, String> {
    ok(json!({ "path": req.path }))
}

fn media(req: &Request) -> Result<Response, String> {
    ok(json!({ "media": req.param("id") }))
}

static ROUTES: LazyLock<Router> = LazyLock::new(|| {
    Router::new()
        .route("GET", "/hello", hello)
        .route("GET", "/admin", hello)
        .route("GET", "/queue", hello)
        .route("GET", "/media/:id", media)
        .route("GET", "/status/:code", status)
        .route("GET", "/headers", headers)
        .route("POST", "/echo", echo)
        .route("GET", "/path/:p", path)
        .route("GET", "/config", config)
        .route("GET", "/test/*rest", test_route)
        .route("POST", "/test/*rest", test_route)
});

fn test_route(req: &Request) -> Result<Response, String> {
    let rest = req.param("rest").unwrap_or_default();
    match rest.as_str() {
        "loop" => loop {
            black_box(());
        },
        "trap" => panic!("asked to trap"),
        "spin" => {
            spin(
                req.query("s")
                    .map(str::to_owned)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1.0),
            );
            ok(json!({ "spun": true }))
        }
        "deadline" => ok(json!({ "remaining": host::deadline_remaining_ms() })),
        "grow" => {
            let mb: usize = req
                .query("mb")
                .map(str::to_owned)
                .and_then(|v| v.parse().ok())
                .unwrap_or(1);
            let v = vec![1u8; mb << 20];
            ok(json!({ "len": black_box(v).len() }))
        }
        "sock" => {
            let r = std::net::TcpStream::connect("93.184.216.34:80");
            ok(json!({ "connected": r.is_ok() }))
        }
        "fetch" => {
            let url = req.query("url").map(str::to_owned).unwrap_or_default();
            match http::Request::new(Method::Get, url)
                .timeout(Duration::from_secs(10))
                .send()
            {
                Ok(r) => ok(
                    json!({ "status": r.status, "location": r.header("location"), "body": String::from_utf8_lossy(&r.body) }),
                ),
                Err(e) => ok(json!({ "error": format!("{e:?}") })),
            }
        }
        "post" => {
            let url = req.query("url").map(str::to_owned).unwrap_or_default();
            let kb: usize = req.query("kb").and_then(|v| v.parse().ok()).unwrap_or(1);
            match http::Request::new(Method::Post, url)
                .timeout(Duration::from_secs(10))
                .body(vec![b'x'; kb << 10])
                .send()
            {
                Ok(r) => ok(json!({ "status": r.status })),
                Err(e) => ok(json!({ "error": format!("{e:?}") })),
            }
        }
        "fanout" => {
            let urls = req.query("urls").map(str::to_owned).unwrap_or_default();
            let started = Instant::now();
            let sends = urls.split(',').map(|u| {
                let r = http::Request::new(Method::Get, u).timeout(Duration::from_secs(10));
                rt::spawn_local(r.send_async())
            });
            // Tasks spawn on the running reactor, so inside `block_on`.
            let statuses: Vec<Json> = rt::block_on(async { rt::join_all(sends).await })
                .into_iter()
                .map(|r| r.map_or_else(|e| json!(format!("{e:?}")), |r| json!(r.status)))
                .collect();
            ok(json!({ "statuses": statuses, "ms": started.elapsed().as_millis() as u64 }))
        }
        "abandon" => {
            let url = req.query("url").map(str::to_owned).unwrap_or_default();
            let send = http::Request::new(Method::Get, url).send_async();
            let r = rt::block_on(rt::timeout(Duration::from_millis(200), send));
            ok(json!({ "timedOut": r.is_none() }))
        }
        "drip" => {
            let url = req.query("url").map(str::to_owned).unwrap_or_default();
            let get = || http::Request::new(Method::Get, &url).timeout(Duration::from_secs(2));
            let started = Instant::now();
            let blocking = get().deadline(Duration::from_millis(400)).send();
            let blocking_ms = started.elapsed().as_millis() as u64;
            let b = rt::Budget::new(Duration::from_millis(400));
            let started = Instant::now();
            let budgeted = rt::block_on(get().budget(&b).send_async());
            ok(json!({
                "blocking": blocking.err().map(|e| format!("{e:?}")),
                "blockingMs": blocking_ms,
                "budgeted": budgeted.err().map(|e| format!("{e:?}")),
                "budgetedMs": started.elapsed().as_millis() as u64,
            }))
        }
        "budget" => {
            let url = req.query("url").map(str::to_owned).unwrap_or_default();
            let b = rt::Budget::new(Duration::from_millis(300));
            let started = Instant::now();
            let r = http::Request::new(Method::Get, url)
                .timeout(b.cap(Duration::from_secs(60)))
                .send();
            ok(json!({
                "error": r.err().map(|e| format!("{e:?}")),
                "expired": b.expired(),
                "ms": started.elapsed().as_millis() as u64,
                "hostMs": rt::Budget::host().remaining().as_millis() as u64,
            }))
        }
        "spam" => {
            let kb: usize = req
                .query("kb")
                .map(str::to_owned)
                .and_then(|v| v.parse().ok())
                .unwrap_or(1);
            let line = "x".repeat(1023);
            for i in 0..kb {
                if i % 2 == 0 {
                    let _ = writeln!(std::io::stdout(), "{line}");
                } else {
                    let _ = writeln!(std::io::stderr(), "{line}");
                }
            }
            info!("spam done");
            ok(json!({ "kb": kb }))
        }
        "db/sleep" => {
            let s: f64 = req
                .query("s")
                .map(str::to_owned)
                .and_then(|v| v.parse().ok())
                .unwrap_or(1.0);
            match db::query("SELECT 1 AS slept FROM pg_sleep($1)", &[Param::Float(s)]) {
                Ok(_) => ok(json!({ "slept": s })),
                Err(e) => ok(json!({ "error": e.code, "message": e.message })),
            }
        }
        "db/set-timeout" => {
            ok(json!({ "ok": db::execute("SET statement_timeout = 1", &[]).is_ok() }))
        }
        "db/show-timeout" => {
            let r = db::query("SHOW statement_timeout", &[]).map_err(|e| e.message)?;
            ok(json!({ "statement_timeout": r.text(0, "statement_timeout") }))
        }
        "db/migrate" => match db::migrate(&MIGRATIONS) {
            Ok(applied) => ok(json!({ "applied": applied })),
            Err(e) => ok(json!({ "error": e.code, "message": e.message })),
        },
        "db/script" => {
            let up = String::from_utf8_lossy(&req.body).into_owned();
            let name = req
                .query("name")
                .map(str::to_owned)
                .unwrap_or_else(|| "script".into());
            match db::migrate(&[(name.as_str(), up.as_str())]) {
                Ok(applied) => ok(json!({ "applied": applied })),
                Err(e) => ok(json!({ "error": e.code, "message": e.message })),
            }
        }
        "db/query" => ok(run_query(&req.body)),
        "schedule" => {
            let key = req.query("key").map(str::to_owned).unwrap_or_default();
            let delay = req
                .query("delay")
                .map(str::to_owned)
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let payload = String::from_utf8_lossy(&req.body).into_owned();
            host_result(host::schedule_call(&key, delay, &payload))
        }
        "cancel" => host_result(host::cancel_call(
            &req.query("key").map(str::to_owned).unwrap_or_default(),
        )),
        "counts" => host_result(host::counts_set(
            &req.query("key").map(str::to_owned).unwrap_or_default(),
            req.query("v")
                .map(str::to_owned)
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
        )),
        "config-set" => {
            let v = req.query("value").map(str::to_owned);
            host_result(host::config_set(
                &req.query("key").map(str::to_owned).unwrap_or_default(),
                v.as_deref(),
            ))
        }
        "emit" => host_result(host::events_emit_own(
            "ping",
            r#"{"n":1}"#,
            t::Audience::Everyone,
        )),
        "resolve" => host_result(
            host::media_resolve(&t::ResolveQuery {
                media_ids: vec![1, 2],
                group_ids: vec![],
                item_ids: vec![],
            })
            .map(|v| v.into_iter().map(|(k, m)| (k, m.title)).collect::<Vec<_>>()),
        ),
        "exists" => host_result(host::media_exists(&[1, 2, 999_999])),
        "create" => {
            let ids: Vec<t::ExternalId> = req
                .query("tmdb")
                .map(|v| t::ExternalId {
                    provider: "tmdb".into(),
                    value: v.into(),
                })
                .into_iter()
                .collect();
            let library = req.query("library").and_then(|v| v.parse().ok());
            let kind = req.query("kind").unwrap_or("movie");
            host_result(host::media_resolve_or_create(kind, &ids, library))
        }
        "ingest" => {
            let paths: Vec<String> = req.query("path").map(str::to_owned).into_iter().collect();
            host_result(
                host::library_ingest(&t::IngestRequest {
                    idempotency_key: "k".into(),
                    media_id: req
                        .query("media")
                        .map(str::to_owned)
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(1),
                    family: t::Family::Video,
                    language: None,
                    paths,
                    transfer: t::TransferMode::Copy,
                    fallback_quality: None,
                    source_label: "fixture".into(),
                })
                .map(|r| r.imported.len()),
            )
        }
        _ => Ok(not_found()),
    }
}

impl Plugin for Fixture {
    fn health() -> HealthReport {
        match mode("health").as_str() {
            "false" => HealthReport {
                ok: false,
                detail: Some("asked to fail".into()),
            },
            "slow" => {
                spin(10.0);
                HealthReport {
                    ok: true,
                    detail: None,
                }
            }
            "trap" => panic!("asked to trap in health"),
            "db" => match db::query("SELECT 1 AS one", &[]) {
                Ok(_) => HealthReport {
                    ok: true,
                    detail: None,
                },
                Err(e) => HealthReport {
                    ok: false,
                    detail: Some(e.message),
                },
            },
            _ => HealthReport {
                ok: true,
                detail: None,
            },
        }
    }

    fn start() -> Result<(), String> {
        info!("start");
        match mode("start").as_str() {
            "fail" => Err("asked to fail".into()),
            "trap" => panic!("asked to trap in start"),
            "slow" => {
                spin(5.0);
                Ok(())
            }
            "db" => db::query("SELECT 1 AS one", &[])
                .map(drop)
                .map_err(|e| format!("{}: {}", e.code, e.message)),
            "migrate" => db::migrate(&MIGRATIONS)
                .map(drop)
                .map_err(|e| format!("{}: {}", e.code, e.message)),
            _ => Ok(()),
        }
    }

    fn job(name: String, _id: String, args: Option<String>) -> Result<(), String> {
        let secs: f64 = args.as_deref().and_then(|a| a.parse().ok()).unwrap_or(0.0);
        info!("job {name}");
        match name.as_str() {
            "FixtureJob" => spin(mode("job_secs").parse().unwrap_or(secs)),
            "pgsleep" => pg_sleep(secs.max(1.0))?,
            _ => return Err(format!("unknown job {name}")),
        }
        Ok(())
    }

    fn scheduled(key: String, payload: String, attempt: u32) -> Result<(), String> {
        info!("scheduled {key} attempt {attempt} payload {payload}");
        if key.starts_with("spin:") {
            spin(payload.parse().unwrap_or(1.0));
        } else if key.starts_with("pgsleep:") {
            pg_sleep(payload.parse().unwrap_or(1.0))?;
        } else if key.starts_with("trap:") && attempt == 1 {
            panic!("asked to trap in scheduled");
        } else if key.starts_with("fail:") {
            return Err("asked to fail".into());
        } else if key.starts_with("again:") && payload == "\"first\"" {
            fliks_plugin_sdk::scheduled::schedule(&key, 0, &json!("second"))
                .map_err(|e| e.message)?;
        }
        Ok(())
    }

    fn event(name: String, _payload: String) {
        info!("event {name}");
    }

    fn config_changed(keys: Vec<String>) {
        info!("config changed: {}", keys.join(","));
    }

    fn http(req: HttpRequest) -> Result<HttpResponse, String> {
        ROUTES.handle(req)
    }
}

fliks_plugin_sdk::export!(Fixture);
