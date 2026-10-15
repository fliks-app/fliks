//! SSE hub, event catalogue and activity registry (`docs/spec/events-hub.md`); the bridges to Nest
//! are `docs/bridge.md` rows `/internal/events*` and `/internal/activity*`.
pub mod activity;
pub mod event;
mod hub;
mod replay;
mod routes;
mod sse;

pub use event::{Bus, DomainEvent, Num, RawEvent, SseEvent, Subject};
pub use hub::{Connection, Hub, Identity, Target};
pub use routes::{__path_activity, __path_events, activity, events, router};
