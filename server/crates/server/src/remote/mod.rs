//! `/api/remote/*` and the household fan-out (`docs/spec/remote.md`); target state lives in the hub.
mod db;
pub(crate) mod dto;
mod fanout;
mod routes;

pub use fanout::{device_id_of, init};
pub use routes::*;
