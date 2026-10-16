//! `/api/media` read routes (`docs/spec/media-query.md`); the writes and `sync-queue` stay in Nest.
mod aggregates;
mod calendar;
mod hydrate;
mod list;
mod params;
mod related;
mod routes;
mod streams;
mod tracking;

pub use routes::*;
