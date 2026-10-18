//! `/api/media` routes: reads (`media-query.md`) and writes (`media-write.md`).
mod aggregates;
mod calendar;
pub mod hydrate;
mod list;
mod params;
mod related;
mod routes;
mod streams;
mod tracking;
pub mod write;

pub use routes::*;
