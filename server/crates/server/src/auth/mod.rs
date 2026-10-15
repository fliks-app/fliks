//! Auth routes (`docs/spec/auth.md`): login, refresh, logout, register, me, pairing, stream tokens.
mod db;
mod jobs;
mod routes;

pub use jobs::spawn as spawn_jobs;
pub use routes::router;
