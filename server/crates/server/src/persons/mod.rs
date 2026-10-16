//! `/api/persons/*` (`docs/spec/persons.md`): person search, detail with a lazy provider refresh, provider credits.
mod routes;
pub mod service;

pub use routes::*;
