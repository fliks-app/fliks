//! `/api/users/*` (`docs/spec/users.md`).
mod db;
mod dto;
mod imported;
mod routes;

pub use db::revoke_other_families;
pub use imported::imported_user;
pub use routes::*;
