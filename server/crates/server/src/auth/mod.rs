//! Auth routes (`docs/spec/auth.md`): login, refresh, logout, register, me, pairing, stream tokens.
mod db;
mod jobs;
mod password;
mod routes;
mod throttle;

pub use jobs::spawn as spawn_jobs;
pub use password::hash_password;
pub use routes::*;
pub use throttle::LoginThrottle;
