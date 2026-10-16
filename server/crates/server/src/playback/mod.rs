//! `/api/playback/*` state, history, continue watching, recommendations and watched toggles
//! (`docs/spec/playback-state.md`); the heartbeat is `beat`, the QoE events route is another piece.
mod beat;
mod db;
mod recommend;
mod routes;

pub use beat::{__path_heartbeat, Debounce, heartbeat};
pub use db::remove_watched_from_auto_playlists;
pub use routes::*;
