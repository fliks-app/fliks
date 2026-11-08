//! Watch party (`docs/spec/watch-party.md`): routes, the in-memory registry and its tick.
mod cover;
mod db;
mod dto;
mod karaoke_ws;
mod proposals;
mod queue;
mod registry;
mod routes;

pub use cover::{DIR as COVER_DIR, owned_uploads};
pub use karaoke_ws::{__path_karaoke_ws, Relay, karaoke_ws};
pub use proposals::*;
pub use registry::{Parties, boot, end_owned, end_playing, end_playing_items, spawn, sweep, tick};
pub use routes::*;
