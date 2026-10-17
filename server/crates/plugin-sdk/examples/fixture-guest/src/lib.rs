//! Test and parity fixture: the parity routes behave like the Node fixture of
//! `server/parity/plugins/`; `/test/*` routes exercise one host behaviour each.

use fliks_plugin_sdk::bindings::fliks::plugin::types as t;
use fliks_plugin_sdk::bindings::wasi::http::types::Method;
use fliks_plugin_sdk::db::{self, Param, Value};
use fliks_plugin_sdk::http::Request;
use fliks_plugin_sdk::{
    HealthReport, HttpRequest, HttpResponse, Plugin, host, info, json_response,
};
use serde_json::{Value as Json, json};
use std::hint::black_box;
use std::io::Write;
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

fn arg(req: &HttpRequest, k: &str) -> Option<String> {
    req.query
        .iter()
        .find(|(n, _)| n == k)
        .map(|(_, v)| v.clone())
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

fn ok(body: Json) -> Result<HttpResponse, String> {
    Ok(json_response(200, body.to_string()))
}

fn host_result<T: serde::Serialize>(r: Result<T, t::HostError>) -> Result<HttpResponse, String> {
    match r {
        Ok(v) => ok(json!({ "ok": v })),
        Err(e) => ok(json!({ "error": e.code, "message": e.message })),
    }
}

fn parity(req: &HttpRequest) -> Option<Result<HttpResponse, String>> {
    let p = req.path.to_ascii_lowercase();
    let p = p.strip_suffix('/').unwrap_or(&p);
    Some(match p {
        "/hello" | "/admin" | "/queue" => ok(json!({ "hello": "world", "path": req.path })),
        "/headers" => Ok(HttpResponse {
            status: 200,
            headers: vec![
                ("content-type".into(), "application/json".into()),
                ("set-cookie".into(), "a=b".into()),
                ("x-custom".into(), "1".into()),
                ("ETag".into(), "\"v1\"".into()),
                ("cache-control".into(), "max-age=60".into()),
                ("location".into(), "/elsewhere".into()),
            ],
            body: br#"{"headers":true}"#.to_vec(),
        }),
        "/echo" => {
            let body: Json = serde_json::from_slice(&req.body).unwrap_or(Json::Null);
            ok(
                json!({ "method": req.method, "body": body, "query": req.query.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>() }),
            )
        }
        "/config" => match host::config_get(None) {
            Ok(v) => ok(Json::Object(
                v.into_iter().map(|(k, v)| (k, Json::String(v))).collect(),
            )),
            Err(e) => ok(json!({ "error": e.code })),
        },
        _ if p.starts_with("/status/") => {
            let code: u16 = p["/status/".len()..].parse().unwrap_or(500);
            Ok(HttpResponse {
                status: code,
                headers: vec![("content-type".into(), "application/json".into())],
                body: br#"{"status":true}"#.to_vec(),
            })
        }
        _ if p.starts_with("/media/") => ok(json!({ "media": &req.path["/media/".len()..] })),
        _ if p.starts_with("/path/") => ok(json!({ "path": req.path })),
        _ => return None,
    })
}

fn test_route(req: HttpRequest) -> Result<HttpResponse, String> {
    let rest = req
        .path
        .strip_prefix("/test")
        .unwrap_or(&req.path)
        .to_owned();
    match rest.as_str() {
        "/loop" => loop {
            black_box(());
        },
        "/trap" => panic!("asked to trap"),
        "/spin" => {
            spin(arg(&req, "s").and_then(|v| v.parse().ok()).unwrap_or(1.0));
            ok(json!({ "spun": true }))
        }
        "/deadline" => ok(json!({ "remaining": host::deadline_remaining_ms() })),
        "/grow" => {
            let mb: usize = arg(&req, "mb").and_then(|v| v.parse().ok()).unwrap_or(1);
            let v = vec![1u8; mb << 20];
            ok(json!({ "len": black_box(v).len() }))
        }
        "/sock" => {
            let r = std::net::TcpStream::connect("93.184.216.34:80");
            ok(json!({ "connected": r.is_ok() }))
        }
        "/fetch" => {
            let url = arg(&req, "url").unwrap_or_default();
            match Request::new(Method::Get, url)
                .timeout(Duration::from_secs(10))
                .send()
            {
                Ok(r) => ok(
                    json!({ "status": r.status, "location": r.header("location"), "body": String::from_utf8_lossy(&r.body) }),
                ),
                Err(e) => ok(json!({ "error": format!("{e:?}") })),
            }
        }
        "/spam" => {
            let kb: usize = arg(&req, "kb").and_then(|v| v.parse().ok()).unwrap_or(1);
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
        "/db/sleep" => {
            let s: f64 = arg(&req, "s").and_then(|v| v.parse().ok()).unwrap_or(1.0);
            match db::query("SELECT 1 AS slept FROM pg_sleep($1)", &[Param::Float(s)]) {
                Ok(_) => ok(json!({ "slept": s })),
                Err(e) => ok(json!({ "error": e.code, "message": e.message })),
            }
        }
        "/db/set-timeout" => {
            ok(json!({ "ok": db::execute("SET statement_timeout = 1", &[]).is_ok() }))
        }
        "/db/show-timeout" => {
            let r = db::query("SHOW statement_timeout", &[]).map_err(|e| e.message)?;
            ok(json!({ "statement_timeout": r.text(0, "statement_timeout") }))
        }
        "/db/migrate" => match db::migrate(&MIGRATIONS) {
            Ok(applied) => ok(json!({ "applied": applied })),
            Err(e) => ok(json!({ "error": e.code, "message": e.message })),
        },
        "/db/script" => {
            let up = String::from_utf8_lossy(&req.body).into_owned();
            let name = arg(&req, "name").unwrap_or_else(|| "script".into());
            match db::migrate(&[(name.as_str(), up.as_str())]) {
                Ok(applied) => ok(json!({ "applied": applied })),
                Err(e) => ok(json!({ "error": e.code, "message": e.message })),
            }
        }
        "/db/query" => ok(run_query(&req.body)),
        "/schedule" => {
            let key = arg(&req, "key").unwrap_or_default();
            let delay = arg(&req, "delay").and_then(|v| v.parse().ok()).unwrap_or(0);
            let payload = String::from_utf8_lossy(&req.body).into_owned();
            host_result(host::schedule_call(&key, delay, &payload))
        }
        "/cancel" => host_result(host::cancel_call(&arg(&req, "key").unwrap_or_default())),
        "/counts" => host_result(host::counts_set(
            &arg(&req, "key").unwrap_or_default(),
            arg(&req, "v").and_then(|v| v.parse().ok()).unwrap_or(0),
        )),
        "/config-set" => {
            let v = arg(&req, "value");
            host_result(host::config_set(
                &arg(&req, "key").unwrap_or_default(),
                v.as_deref(),
            ))
        }
        "/emit" => host_result(host::events_emit_own(
            "ping",
            r#"{"n":1}"#,
            t::Audience::Everyone,
        )),
        "/resolve" => host_result(
            host::media_resolve(&t::ResolveQuery {
                media_ids: vec![1, 2],
                season_ids: vec![],
                episode_ids: vec![],
            })
            .map(|v| v.into_iter().map(|(k, m)| (k, m.title)).collect::<Vec<_>>()),
        ),
        "/exists" => host_result(host::media_exists(&[1, 2, 999_999])),
        "/ingest" => {
            let paths: Vec<String> = arg(&req, "path").into_iter().collect();
            host_result(
                host::library_ingest(&t::IngestRequest {
                    idempotency_key: "k".into(),
                    media_id: arg(&req, "media").and_then(|v| v.parse().ok()).unwrap_or(1),
                    paths,
                    transfer: t::TransferMode::Copy,
                    fallback_quality: None,
                    source_label: "fixture".into(),
                })
                .map(|r| r.imported.len()),
            )
        }
        _ => Ok(json_response(404, r#"{"error":"not found"}"#)),
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
        if let Some(r) = parity(&req) {
            return r;
        }
        if req.path.to_ascii_lowercase().starts_with("/test/") {
            return test_route(req);
        }
        Ok(json_response(404, r#"{"error":"not found"}"#))
    }
}

fliks_plugin_sdk::export!(Fixture);
