//! Mailing books to e-readers (`docs/spec/email-devices.md`): admin SMTP settings, per-user e-mail
//! devices and "Send to…".
mod config;
mod devices;
mod message;
mod send;

use crate::state::AppState;
use axum::{
    Router,
    routing::{get, post, put},
};

pub use config::validate as validate_setting;
pub use devices::*;
pub use send::*;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/email-devices",
            get(devices::list).post(devices::create),
        )
        .route(
            "/api/email-devices/{id}",
            put(devices::update).delete(devices::remove),
        )
        .route("/api/email-devices/{id}/send", post(send::send))
        .route("/api/book-sends", get(send::recent))
        .route("/api/email/test", post(send::test_send))
}
