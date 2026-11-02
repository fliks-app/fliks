//! Wants, follows, the wanted list and the follow refresh job (`docs/spec/wants-follows.md`).
mod follows;
mod refresh;
mod routes;
#[cfg(test)]
mod tests;

pub use follows::{
    __path_follow_delete, __path_follow_get, __path_follow_put, __path_follows,
    __path_watch_delete, __path_watch_get, __path_watch_put, follow_delete, follow_get, follow_put,
    follows, watch_delete, watch_get, watch_put,
};
pub use refresh::run as refresh_follows;
pub use routes::{
    __path_wanted, __path_wants_get, __path_wants_put, router, wanted, wants_get, wants_put,
};
