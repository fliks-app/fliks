//! Senders and dispatch: one POST per matching connection, 10 s timeout, one retry after 5 s.
use super::db::{self, Connection};
use crate::{outbound, vetted};
use fliks_domain::notifications::{Body, build_request};
use reqwest::{Url, header::CONTENT_TYPE};
use serde_json::{Map, Value};
use sqlx::PgPool;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_AFTER: Duration = Duration::from_secs(5);

/// A failure and whether a second attempt can help: a timeout, a transport error or a 5xx, never a 4xx.
struct Failure {
    text: String,
    transient: bool,
}
const UNREACHABLE: &str = "Could not reach the endpoint";

/// The `test` message names no host, port or resolver answer: it must not map the network behind a URL.
fn describe(e: reqwest::Error) -> String {
    let e = e.without_url();
    tracing::debug!("notification transport error: {e:?}");
    if e.is_timeout() {
        return format!("timeout of {}ms exceeded", TIMEOUT.as_millis());
    }
    UNREACHABLE.to_owned()
}

/// `send` of the spec (rule 14): the error is the `test` response message. The outcome is stored on
/// the connection; `retry` allows one more attempt after a transient failure.
pub async fn send(
    pool: &PgPool,
    conn: &Connection,
    event: &str,
    payload: &Map<String, Value>,
    retry: bool,
) -> Result<(), String> {
    let mut res = deliver(conn, event, payload).await;
    if retry && res.as_ref().is_err_and(|f| f.transient) {
        tokio::time::sleep(RETRY_AFTER).await;
        res = deliver(conn, event, payload).await;
    }
    let res = res.map_err(|f| f.text);
    if let Err(e) = &res {
        tracing::warn!("Failed to send notification via {}: {e}", conn.name);
    }
    db::record(pool, conn.id, res.as_ref().err().map(String::as_str)).await;
    res
}

async fn deliver(
    conn: &Connection,
    event: &str,
    payload: &Map<String, Value>,
) -> Result<(), Failure> {
    let permanent = |text| Failure {
        text,
        transient: false,
    };
    let Some(req) = build_request(&conn.typ, &conn.settings, event, payload).map_err(permanent)?
    else {
        tracing::warn!("Unknown notification type: {}", conn.typ);
        return Ok(());
    };
    let transient = |text| Failure {
        text,
        transient: true,
    };
    let mut url = Url::parse(&req.url).map_err(|_| permanent(UNREACHABLE.into()))?;
    // By hand: reqwest drops `Authorization` on the http to https upgrade, a token endpoint needs it kept.
    for _ in 0..=outbound::MAX_REDIRECTS {
        let mut r = outbound::no_redirect_client()
            .post(url.clone())
            .timeout(TIMEOUT);
        for (k, v) in &req.headers {
            r = r.header(*k, v);
        }
        r = match &req.body {
            Body::Json(v) => r.json(v),
            // axios sends a string body as a form.
            Body::Text(t) => r
                .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(t.clone()),
        };
        let res = r.send().await.map_err(|e| transient(describe(e)))?;
        if let Some(next) = vetted::next_hop(&url, res.status(), res.headers())
            && outbound::follows(&url, &next)
        {
            url = next;
            continue;
        }
        return match res.status() {
            s if s.is_success() => Ok(()),
            s => Err(Failure {
                text: format!("Request failed with status code {}", s.as_u16()),
                transient: s.is_server_error(),
            }),
        };
    }
    Err(permanent("Too many redirects".into()))
}

/// Spawned: sends to every enabled connection subscribed to `event`. A failing sender affects
/// neither the others nor the caller, and everything that fails is logged.
pub fn dispatch(pool: &PgPool, event: &str, payload: Map<String, Value>) {
    let (pool, event) = (pool.clone(), event.to_owned());
    tokio::spawn(async move {
        match db::subscribed(&pool, &event).await {
            Ok(conns) => {
                futures_util::future::join_all(
                    conns.iter().map(|c| send(&pool, c, &event, &payload, true)),
                )
                .await;
            }
            Err(e) => tracing::warn!("notification {event} not sent: {e}"),
        }
    });
}
