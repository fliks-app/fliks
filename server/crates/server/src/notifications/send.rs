//! Senders and dispatch: one POST per matching connection, 10 s timeout, no retry.
use super::db::{self, Connection};
use fliks_domain::notifications::{Body, build_request};
use reqwest::header::CONTENT_TYPE;
use serde_json::{Map, Value};
use sqlx::PgPool;
use std::{error::Error, sync::OnceLock, time::Duration};

const TIMEOUT: Duration = Duration::from_secs(10);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().build().expect("reqwest client"))
}

/// Error text without the request URL: the gotify token and the webhook secret travel in it.
fn describe(e: reqwest::Error) -> String {
    if e.is_timeout() {
        return format!("timeout of {}ms exceeded", TIMEOUT.as_millis());
    }
    let e = e.without_url();
    let mut text = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        text = format!("{text}: {s}");
        source = s.source();
    }
    text
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
    let mut r = client().post(req.url).timeout(TIMEOUT);
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

/// Sends to every enabled connection subscribed to `event`; returns once all settled, a failing
/// sender affects neither the others nor the result.
pub async fn dispatch(
    pool: &PgPool,
    event: &str,
    payload: &Map<String, Value>,
) -> sqlx::Result<()> {
    let conns = db::subscribed(pool, event).await?;
    futures_util::future::join_all(conns.iter().map(|c| send(c, event, payload))).await;
    Ok(())
}
