//! `/api/remote/*` and the household fan-out (`docs/spec/remote.md`); target state lives in the hub.
mod db;
mod dto;
mod fanout;
mod routes;

pub use fanout::init;
pub use routes::*;
