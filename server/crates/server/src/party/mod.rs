//! Watch party (`docs/spec/watch-party.md`): routes, the in-memory registry and its tick.
mod cover;
mod db;
mod dto;
mod proposals;
mod queue;
mod registry;
mod routes;

pub use cover::{DIR as COVER_DIR, owned_uploads};
pub use proposals::*;
pub use registry::{Parties, boot, spawn, sweep, tick};
pub use routes::*;
