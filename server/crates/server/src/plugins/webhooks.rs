//! Data-tier webhooks (`plugins.md` rule 52, F65, F66).
use super::fetch::WebhookError;
use crate::state::AppState;
use serde::Serialize;
use serde_json::{Value, json};

/// `setting:<key>` reads `plugin.<id>.<key>`; empty means not configured.
async fn target(st: &AppState, id: &str, declared: &str) -> Option<String> {
    let Some(key) = declared.strip_prefix("setting:") else {
        return Some(declared.to_owned());
    };
    crate::settings::setting_value(&st.db, &format!("plugin.{id}.{key}"))
        .await
        .ok()
        .flatten()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

async fn deliver(st: &AppState, id: &str, url: &str, body: &Value) -> Result<(), WebhookError> {
    if !url.starts_with("https://") {
        tracing::warn!("plugin \"{id}\" webhook skipped — configured endpoint is not https");
        return Err(WebhookError::Refused);
    }
    let r = st.plugins.opts.fetch.webhook(url, body).await;
    match &r {
        Err(WebhookError::Refused) => {
            tracing::warn!("plugin \"{id}\" webhook skipped — target refused")
        }
        Err(WebhookError::Fetch(e)) => {
            tracing::warn!("plugin \"{id}\" webhook delivery failed: {}", e.kind())
        }
        Ok(()) => {}
    }
    r
}

/// Fans a domain event out to every webhook subscribed to it; never reaches the emitter.
pub fn dispatch(st: &AppState, event: &str, payload: Value) {
    let targets = st.plugins.registry.webhooks_for_event(event);
    for (id, declared) in targets {
        let (st, payload) = (st.clone(), payload.clone());
        tokio::spawn(async move {
            if let Some(url) = target(&st, &id, &declared).await {
                let _ = deliver(&st, &id, &url, &json!({"event": payload, "pluginId": id})).await;
            }
        });
    }
}

#[derive(Serialize)]
pub struct TestResult {
    configured: bool,
    delivered: u32,
    failures: Vec<String>,
}

pub async fn send_test(st: &AppState, id: &str) -> TestResult {
    let mut r = TestResult {
        configured: false,
        delivered: 0,
        failures: vec![],
    };
    for (event, declared) in st.plugins.registry.webhooks_of(id) {
        let Some(url) = target(st, id, &declared).await else {
            continue;
        };
        r.configured = true;
        let body = json!({"event": {"type": "test.delivery", "declaredFor": event}, "pluginId": id, "test": true});
        match deliver(st, id, &url, &body).await {
            Ok(()) => r.delivered += 1,
            Err(WebhookError::Refused) => r.failures.push(format!("{event}: target refused")),
            Err(WebhookError::Fetch(e)) => r.failures.push(format!("{event}: {}", e.kind())),
        }
    }
    r
}
