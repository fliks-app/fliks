//! `GET /delivery-log`, `POST /test-delivery` (rust-port.md 1.2).

use crate::{log_db, queue};
use fliks_plugin_sdk::db::Value;
use fliks_plugin_sdk::{HttpRequest, HttpResponse, json_response, time};
use serde_json::{Value as Json, json};

fn cell(v: Option<&Value>) -> Json {
    match v {
        Some(Value::Int(i)) => json!(i),
        Some(Value::Text(t)) => json!(t),
        _ => Json::Null,
    }
}

pub fn handle(req: HttpRequest) -> Result<HttpResponse, String> {
    match (
        req.method.to_ascii_uppercase().as_str(),
        req.path.trim_end_matches('/'),
    ) {
        ("GET", "/delivery-log") => {
            let rows = log_db::entries().map_err(|e| e.message)?;
            let cols = [
                "id",
                "event",
                "targetHost",
                "attempt",
                "lastStatus",
                "createdAt",
                "lastAttemptAt",
            ];
            let entries: Vec<Json> = (0..rows.len())
                .map(|i| {
                    Json::Object(
                        cols.iter()
                            .map(|c| ((*c).to_owned(), cell(rows.get(i, c))))
                            .collect(),
                    )
                })
                .collect();
            let s = log_db::stats().map_err(|e| e.message)?;
            let body = json!({
                "entries": entries,
                "stats": {
                    "queued": s.queued,
                    "delivered": s.delivered,
                    "failedPermanently": s.failed,
                    "droppedForCapacity": s.dropped,
                },
            });
            Ok(json_response(200, body.to_string()))
        }
        ("POST", "/test-delivery") => {
            let body: Json = serde_json::from_slice(&req.body).unwrap_or(Json::Null);
            let event = body["event"].as_str().unwrap_or("test.delivery").to_owned();
            let payload = json!({ "triggeredBy": "admin-test", "at": time::now_rfc3339() });
            let id = queue::enqueue(&event, payload)?;
            Ok(json_response(
                202,
                json!({ "queued": true, "id": id }).to_string(),
            ))
        }
        _ => Ok(json_response(404, r#"{"error":"not found"}"#)),
    }
}
