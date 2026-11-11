//! SSE hub, event catalogue and activity registry (`docs/spec/events-hub.md`).
pub mod activity;
pub mod event;
mod hub;
mod routes;
mod sse;
pub mod subject;
mod ticket;

pub use event::{Bus, DomainEvent, ExternalId, Num, RawEvent, SseEvent, Subject};
pub(crate) use hub::uuid_v4;
pub use hub::{COMMAND_TTL_MS, Connection, Hub, Identity, Target};
pub use routes::{
    __path_activity, __path_event_ticket, __path_events, __path_keepalive, activity, credential,
    event_ticket, events, keepalive, router,
};
pub use ticket::Tickets;
