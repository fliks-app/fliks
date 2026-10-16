//! `/api/media` routes: reads (`media-query.md`) and writes (`media-write.md`); `sync-queue` stays in Nest.
mod aggregates;
mod calendar;
mod hydrate;
mod list;
mod params;
mod related;
mod routes;
mod streams;
mod tracking;
pub mod write;

pub use routes::*;
