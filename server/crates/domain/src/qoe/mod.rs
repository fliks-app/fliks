//! Playback QoE core: sample/event validation, CMCD, stall classification, diagnosis, aggregation.
pub mod aggregate;
pub mod classify;
pub mod cmcd;
pub mod diagnose;
pub mod types;
pub mod validate;

pub use aggregate::{QoeAggregator, StallLast, merge_summaries};
pub use classify::classify_stall;
pub use cmcd::{CmcdSnapshot, read_cmcd, read_cmcd_raw};
pub use diagnose::diagnose;
pub use types::*;
pub use validate::{parse_events, parse_playback_id, parse_sample, parse_sent_at};
