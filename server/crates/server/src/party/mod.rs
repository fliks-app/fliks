//! Watch party (`docs/spec/watch-party.md`): routes, the in-memory registry and its tick.
mod db;
mod dto;
mod queue;
mod registry;
mod routes;

pub use registry::{Parties, boot, spawn, sweep};
pub use routes::*;
