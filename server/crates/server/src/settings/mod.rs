//! `/api/settings/*` (`docs/spec/settings.md`): flat KV store over `app_settings`, secrets redacted (F5).
pub mod checklist;
mod db;
mod routes;
mod secrets;

use crate::state::AppState;
use axum::{Router, routing::get};

pub use db::value as setting_value;
pub use routes::*;

/// A write on behalf of `origin` (a plugin's `config.set`, an import): the row, then the same
/// change notification as a `PUT`, the writer excluded from its own `config-changed`.
pub async fn write(
    st: &AppState,
    entries: &[(String, Option<String>)],
    origin: Option<&str>,
) -> sqlx::Result<()> {
    let mut tx = st.db.begin().await?;
    for (k, v) in entries {
        db::set(&mut tx, k, v.as_deref()).await?;
    }
    tx.commit().await?;
    let keys: Vec<String> = entries.iter().map(|(k, _)| k.clone()).collect();
    routes::notify(st, &keys, origin).await;
    Ok(())
}

/// One row inside the caller's transaction; `notify_changed` once it commits.
pub async fn set_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    key: &str,
    value: Option<&str>,
) -> sqlx::Result<()> {
    db::set(tx, key, value).await.map(drop)
}

pub async fn notify_changed(st: &AppState, keys: &[String], origin: Option<&str>) {
    routes::notify(st, keys, origin).await;
}

pub fn router() -> Router<AppState> {
    checklist::router()
        .route("/api/settings", get(routes::list).put(routes::put_bulk))
        .route(
            "/api/settings/{key}",
            get(routes::get_one).put(routes::put_one),
        )
}
