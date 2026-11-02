//! `/api/playback/*` state, history, continue watching, recommendations and watched toggles
//! (`docs/spec/playback-state.md`); the heartbeat is `beat`, the QoE events route is another piece.
mod beat;
mod db;
mod recommend;
mod routes;
#[cfg(test)]
mod tests;
mod watched;

pub use watched::{Watch, finish_context, record_watch};

pub use beat::{__path_heartbeat, Debounce, heartbeat};
pub use db::{beat_item, find_state, history as user_history, item_of, named_item};
pub use recommend::{recommendations as user_recommendations, top_genres};
pub use routes::*;
