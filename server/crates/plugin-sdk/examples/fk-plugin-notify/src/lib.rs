//! `fliks.notify`: forwards every domain event to the admin's HTTPS webhook, with retry.

mod delivery;
mod log_db;
mod queue;
mod routes;

use fliks_plugin_sdk::{HealthReport, HttpRequest, HttpResponse, Plugin, db, info, warn};

const MIGRATIONS: [(&str, &str); 1] = [(
    "0001_deliveries",
    include_str!("../migrations/0001_deliveries.sql"),
)];

struct Notify;

impl Plugin for Notify {
    fn start() -> Result<(), String> {
        db::migrate(&MIGRATIONS).map_err(|e| format!("{}: {}", e.code, e.message))?;
        log_db::sweep_stuck().map_err(|e| e.message)?;
        Ok(())
    }

    fn health() -> HealthReport {
        match log_db::stats() {
            Ok(s) => HealthReport {
                ok: true,
                detail: Some(format!(
                    "queued={} delivered={} failed={}",
                    s.queued, s.delivered, s.failed
                )),
            },
            Err(e) => HealthReport {
                ok: false,
                detail: Some(e.message),
            },
        }
    }

    fn job(_: String, _: String, _: Option<String>) -> Result<(), String> {
        Err("no jobs".into())
    }

    fn event(name: String, payload: String) {
        let payload = serde_json::from_str(&payload).unwrap_or(serde_json::Value::String(payload));
        if let Err(e) = queue::enqueue(&name, payload) {
            warn!("event {name} not queued: {e}");
        }
    }

    fn scheduled(key: String, payload: String, _attempt: u32) -> Result<(), String> {
        if key.starts_with(queue::PREFIX) {
            return queue::attempt(&key, &payload);
        }
        warn!("scheduled key {key} dropped: unknown prefix");
        Ok(())
    }

    fn http(req: HttpRequest) -> Result<HttpResponse, String> {
        routes::handle(req)
    }

    fn config_changed(keys: Vec<String>) {
        info!("config changed: {}", keys.join(", "));
    }
}

fliks_plugin_sdk::export!(Notify);
