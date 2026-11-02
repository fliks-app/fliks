//! `/api/media` routes: reads (`media-query.md`) and writes (`media-write.md`).
pub(crate) mod aggregates;
pub(crate) mod books;
mod calendar;
pub mod details;
pub mod editions;
pub mod external_ids;
pub mod field_sources;
pub mod hydrate;
pub mod items;
pub(crate) mod list;
pub(crate) mod params;
mod related;
mod routes;
mod streams;
mod tracking;
pub mod wants;
pub(crate) mod watched;
pub mod write;

pub use routes::*;
