//! `/api/users/*` (`docs/spec/users.md`).
mod db;
mod dto;
mod routes;

pub use db::revoke_other_families;
pub use routes::*;
