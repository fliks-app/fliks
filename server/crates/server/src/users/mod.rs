//! `/api/users/*` (`docs/spec/users.md`).
mod db;
mod dto;
mod imported;
mod routes;

pub use db::{
    Access, NewUser, apply_access, create_user, default_libraries, is_last_enabled_admin,
    login_candidates, names_differing_by_case, not_found, revoke_other_sessions, taken_error,
    username_taken,
};
pub use imported::{Imported, imported_user, map_external};
pub use routes::*;
