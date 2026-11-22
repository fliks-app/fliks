//! Senders and dispatch: one POST per matching connection, 10 s timeout, no retry.
use super::db::{self, Connection};
use fliks_domain::notifications::{Body, build_request};
use reqwest::header::CONTENT_TYPE;
use serde_json::{Map, Value};
use sqlx::PgPool;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);

/// The `test` message names no host, port or resolver answer: it must not map the network behind a URL.
fn describe(e: reqwest::Error) -> String {
    let e = e.without_url();
    tracing::debug!("notification transport error: {e:?}");
    if e.is_timeout() {
        return format!("timeout of {}ms exceeded", TIMEOUT.as_millis());
    }
    "Could not reach the endpoint".to_owned()
}

/// `send` of the spec (rule 14): the error is the `test` response message.
pub async fn send(
    conn: &Connection,
    event: &str,
    payload: &Map<String, Value>,
) -> Result<(), String> {
    let res = deliver(conn, event, payload).await;
    if let Err(e) = &res {
        tracing::warn!("Failed to send notification via {}: {e}", conn.name);
    }
    res
}

async fn deliver(
    conn: &Connection,
    event: &str,
    payload: &Map<String, Value>,
) -> Result<(), String> {
    let Some(req) = build_request(&conn.typ, &conn.settings, event, payload)? else {
        tracing::warn!("Unknown notification type: {}", conn.typ);
        return Ok(());
    };
    let mut r = crate::outbound::client().post(req.url).timeout(TIMEOUT);
    for (k, v) in req.headers {
        r = r.header(k, v);
    }
    r = match req.body {
        Body::Json(v) => r.json(&v),
        // axios sends a string body as a form.
        Body::Text(t) => r
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(t),
    };
    let res = r.send().await.map_err(describe)?;
    match res.status() {
        s if s.is_success() => Ok(()),
        s => Err(format!("Request failed with status code {}", s.as_u16())),
    }
}

/// Spawned: sends to every enabled connection subscribed to `event`. A failing sender affects
/// neither the others nor the caller, and everything that fails is logged.
pub fn dispatch(pool: &PgPool, event: &str, payload: Map<String, Value>) {
    let (pool, event) = (pool.clone(), event.to_owned());
    tokio::spawn(async move {
        match db::subscribed(&pool, &event).await {
            Ok(conns) => {
                futures_util::future::join_all(conns.iter().map(|c| send(c, &event, &payload)))
                    .await;
            }
            Err(e) => tracing::warn!("notification {event} not sent: {e}"),
        }
    });
}
