//! SSE hub, event catalogue and activity registry (`docs/spec/events-hub.md`).
pub mod activity;
pub mod event;
mod hub;
mod replay;
mod routes;
mod sse;
mod ticket;

pub use event::{Bus, DomainEvent, Num, RawEvent, SseEvent, Subject};
pub(crate) use hub::uuid_v4;
pub use hub::{Connection, Hub, Identity, Target};
pub use routes::{
    __path_activity, __path_event_ticket, __path_events, activity, event_ticket, events, router,
};
pub use ticket::Tickets;
