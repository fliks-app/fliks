//! Durable delayed calls (`schedule-call` / `cancel-call`, plugins.md rule 55).

use crate::host::{self, HostError};
use serde::Serialize;

pub const MAX_PAYLOAD: usize = 64 * 1024;

pub fn schedule<T: Serialize>(key: &str, delay_ms: u64, payload: &T) -> Result<(), HostError> {
    let json = serde_json::to_string(payload).map_err(|e| err("ERR", e.to_string()))?;
    if key.is_empty() || key.chars().count() > 128 {
        return Err(err("ERR_VALIDATION", "key must be 1-128 chars".into()));
    }
    if json.len() > MAX_PAYLOAD {
        return Err(err("ERR_VALIDATION", "payload over 64 KiB".into()));
    }
    host::schedule_call(key, delay_ms, &json)
}

pub fn cancel(key: &str) -> Result<bool, HostError> {
    host::cancel_call(key)
}

fn err(code: &str, message: String) -> HostError {
    HostError {
        code: code.into(),
        message,
    }
}
