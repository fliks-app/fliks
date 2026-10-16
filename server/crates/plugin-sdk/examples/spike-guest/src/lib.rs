//! Stand-in guest for the spike: every route exercises one host behaviour.

use fliks_plugin_sdk::bindings::wasi::http::types::Method;
use fliks_plugin_sdk::db::{self, Param, Value};
use fliks_plugin_sdk::http::Request;
use fliks_plugin_sdk::{HttpRequest, HttpResponse, Plugin, info, json_response};
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

struct Spike;

/// One query per 50 s, under the 60 s db deadline.
fn pg_sleep(secs: f64) -> Result<(), String> {
    let end = Instant::now() + Duration::from_secs_f64(secs);
    while let Some(left) = end
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
    {
        let s = left.as_secs_f64().min(50.0);
        db::query("SELECT 1 AS slept FROM pg_sleep($1)", &[Param::Float(s)])
            .map_err(|e| e.message)?;
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

fn run_query(body: &[u8]) -> Result<Json, String> {
    let q: Json = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    let params: Vec<Param> = q["params"]
        .as_array()
        .map_or(vec![], |a| a.iter().map(param).collect());
    let rows = db::query(q["sql"].as_str().unwrap_or(""), &params)
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    let rows: Vec<Json> = rows
        .0
        .rows
        .iter()
        .map(|r| Json::Array(r.iter().map(value).collect()))
        .collect();
    Ok(json!(rows))
}

fn ok(body: Json) -> Result<HttpResponse, String> {
    Ok(json_response(200, body.to_string()))
}

impl Plugin for Spike {
    fn job(name: String, _id: String, args: Option<String>) -> Result<(), String> {
        let secs: f64 = args.as_deref().and_then(|a| a.parse().ok()).unwrap_or(1.0);
        match name.as_str() {
            "spin" => spin(secs),
            "pgsleep" => {
                pg_sleep(secs)?;
            }
            _ => return Err(format!("unknown job {name}")),
        }
        Ok(())
    }

    fn scheduled(key: String, payload: String, attempt: u32) -> Result<(), String> {
        let secs: f64 = payload.parse().unwrap_or(1.0);
        info!("scheduled {key} attempt {attempt}");
        if key.starts_with("spin:") {
            spin(secs);
        } else if key.starts_with("pgsleep:") {
            pg_sleep(secs)?;
        } else if key.starts_with("fail:") {
            return Err("asked to fail".into());
        }
        Ok(())
    }

    fn event(name: String, _payload: String) {
        info!("event {name}");
    }

    fn http(req: HttpRequest) -> Result<HttpResponse, String> {
        match req.path.as_str() {
            "/echo" => Ok(HttpResponse {
                status: 200,
                headers: vec![],
                body: req.body,
            }),
            "/loop" => loop {
                black_box(());
            },
            "/trap" => panic!("asked to trap"),
            "/grow" => {
                let mb: usize = arg(&req, "mb").and_then(|v| v.parse().ok()).unwrap_or(1);
                let v = vec![1u8; mb << 20];
                ok(json!({ "len": black_box(v).len() }))
            }
            "/sock" => {
                let r = std::net::TcpStream::connect("93.184.216.34:80");
                ok(json!({ "connected": r.is_ok(), "error": r.err().map(|e| e.to_string()) }))
            }
            "/fetch" => {
                let url = arg(&req, "url").unwrap_or_default();
                match Request::new(Method::Get, url)
                    .timeout(Duration::from_secs(10))
                    .send()
                {
                    Ok(r) => ok(json!({
                        "status": r.status,
                        "location": r.header("location"),
                        "body": String::from_utf8_lossy(&r.body),
                    })),
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
                let r = db::execute("SET statement_timeout = 1", &[]);
                ok(json!({ "ok": r.is_ok() }))
            }
            "/db/show-timeout" => {
                let r = db::query("SHOW statement_timeout", &[]).map_err(|e| e.message)?;
                ok(json!({ "statement_timeout": r.text(0, "statement_timeout") }))
            }
            "/db/migrate" => match db::migrate(&MIGRATIONS) {
                Ok(applied) => ok(json!({ "applied": applied })),
                Err(e) => ok(json!({ "error": e.code, "message": e.message })),
            },
            "/db/query" => match run_query(&req.body) {
                Ok(rows) => ok(json!({ "rows": rows })),
                Err(e) => ok(json!({ "error": e })),
            },
            _ => Ok(json_response(404, r#"{"error":"not found"}"#)),
        }
    }
}

fliks_plugin_sdk::export!(Spike);
