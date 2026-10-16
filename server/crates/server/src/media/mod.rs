//! `/api/media` read routes (`docs/spec/media-query.md`); the writes and `sync-queue` stay in Nest.
mod acl;
mod aggregates;
mod calendar;
mod hydrate;
mod list;
mod params;
mod related;
mod routes;
mod streams;
mod tracking;

pub use acl::{accessible_library_ids, assert_media_accessible, can_see_paths};
pub use routes::*;
