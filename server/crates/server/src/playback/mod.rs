//! `/api/playback/*` state, history, continue watching, recommendations and watched toggles
//! (`docs/spec/playback-state.md`); the heartbeat and QoE events routes are other pieces.
mod db;
mod recommend;
mod routes;

pub use db::remove_watched_from_auto_playlists;
pub use routes::*;
