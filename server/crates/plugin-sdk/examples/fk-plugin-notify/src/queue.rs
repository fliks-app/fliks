//! Enqueue and the scheduled delivery handler (rust-port.md 3.2, 3.3).

use crate::delivery::{self, Action, Outcome};
use crate::log_db;
use fliks_plugin_sdk::bindings::wasi::http::types::Method;
use fliks_plugin_sdk::http::{Error as HttpError, Request};
use fliks_plugin_sdk::{host, scheduled, warn};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

pub const PREFIX: &str = "delivery:";

#[derive(Serialize, Deserialize)]
struct Call {
    event: String,
    #[serde(default)]
    payload: Value,
    #[serde(default)]
    n: u32,
}

fn target() -> Option<String> {
    let kv = host::config_get(Some(&["target_url".to_owned()])).ok()?;
    let v = kv.into_iter().find(|(k, _)| k == "target_url")?.1;
    let v = v.trim();
    (!v.is_empty()).then(|| v.to_owned())
}

pub fn enqueue(event: &str, payload: Value) -> Result<i64, String> {
    let e = |e: fliks_plugin_sdk::db::DbError| e.message;
    let _ = log_db::sweep_stuck();
    let target = target();
    let host = delivery::host_of(target.as_deref());
    let Some(_) = target else {
        let id =
            log_db::insert(event, &host, "refused", "refused:no target configured").map_err(e)?;
        warn!("delivery {id} refused: no target configured");
        return Ok(id);
    };
    let id = log_db::insert(event, &host, "pending", "pending").map_err(e)?;
    let dropped = log_db::drop_over_capacity().map_err(e)?;
    for d in &dropped {
        let _ = scheduled::cancel(&format!("{PREFIX}{d}"));
    }
    if !dropped.is_empty() {
        warn!("queue full: dropped {} oldest deliveries", dropped.len());
    }
    let call = Call {
        event: event.into(),
        payload,
        n: 0,
    };
    if let Err(err) = scheduled::schedule(&format!("{PREFIX}{id}"), 0, &call) {
        if err.code == "ERR_VALIDATION" {
            log_db::finish(id, "dropped", "dropped:payload too large", 0, None).map_err(e)?;
        } else {
            return Err(err.message);
        }
    }
    let _ = log_db::prune();
    Ok(id)
}

pub fn attempt(key: &str, payload: &str) -> Result<(), String> {
    let e = |e: fliks_plugin_sdk::db::DbError| e.message;
    let Ok(id) = key[PREFIX.len()..].parse::<i64>() else {
        warn!("scheduled key {key} dropped: bad id");
        return Ok(());
    };
    match log_db::state(id).map_err(e)?.as_deref() {
        Some("pending" | "retrying" | "lost") => {}
        _ => return Ok(()),
    }
    let Ok(call) = serde_json::from_str::<Call>(payload) else {
        warn!("scheduled key {key} dropped: unreadable payload");
        return Ok(());
    };
    let n = call.n + 1;
    let outcome = match target() {
        None => Outcome::Refused("no target configured".into()),
        Some(t) => post(&t, id, &call, n),
    };
    let action = delivery::next(n, outcome);
    let (state, status, counter, retry) = match &action {
        Action::Delivered { status } => ("delivered", status, Some("delivered"), None),
        Action::Refused { status } => ("refused", status, None, None),
        Action::Retry { status, delay_ms } => ("retrying", status, None, Some(*delay_ms)),
        Action::Failed { status } => ("failed", status, Some("failedPermanently"), None),
    };
    let live = log_db::finish(id, state, status, n, counter).map_err(e)?;
    if let (true, Some(delay)) = (live, retry) {
        let next = Call { n, ..call };
        scheduled::schedule(key, delay, &next).map_err(|e| e.message)?;
    }
    if state == "failed" {
        warn!("delivery {id} failed after {n} attempts");
    }
    Ok(())
}

fn post(target: &str, id: i64, call: &Call, n: u32) -> Outcome {
    let Ok(url) = url::Url::parse(target) else {
        return Outcome::Refused("not a valid URL".into());
    };
    if url.scheme() != "https" {
        return Outcome::Refused("target must be https:".into());
    }
    let body =
        serde_json::json!({ "id": id, "event": call.event, "payload": call.payload, "attempt": n });
    let sent = Request::new(Method::Post, url.as_str())
        .header("content-type", "application/json")
        .header(
            "user-agent",
            concat!("fliks.notify/", env!("CARGO_PKG_VERSION")),
        )
        .body(body.to_string())
        .timeout(Duration::from_secs(5))
        .body_cap(0)
        .send();
    match sent {
        Ok(r) if (200..300).contains(&r.status) => Outcome::Delivered(r.status),
        Ok(r) => Outcome::Failed(format!("target replied {}", r.status)),
        Err(HttpError::Denied) => Outcome::Refused(HttpError::Denied.to_string()),
        Err(d @ HttpError::Dns(_)) => Outcome::Refused(d.to_string()),
        Err(other) => Outcome::Failed(other.to_string()),
    }
}
