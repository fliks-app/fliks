//! The global optimizer settings: one JSON document under `app_settings`, written by `PUT /api/optimize/settings`.
use crate::settings;
use chrono::{Timelike, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::BTreeMap;

pub const KEY: &str = "optimize_settings";

/// What happens to the original once its replacement is committed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OriginalPolicy {
    Trash,
    Keep,
    Delete,
}

/// Minutes since local midnight; `start > end` wraps over midnight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Window {
    pub start_min: u16,
    pub end_min: u16,
}

impl Window {
    fn valid(self) -> bool {
        self.start_min < 1440 && self.end_min < 1440 && self.start_min != self.end_min
    }

    pub fn contains(self, minute: u16) -> bool {
        if self.start_min < self.end_min {
            (self.start_min..self.end_min).contains(&minute)
        } else {
            minute >= self.start_min || minute < self.end_min
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Settings {
    /// No new lease outside the window; running jobs finish. `None`: always open.
    pub window: Option<Window>,
    pub optimize_original: OriginalPolicy,
    pub trash_retention_days: u32,
    /// Trash is purged oldest first below this free space.
    pub trash_min_free_gb: u32,
    /// Caps the `maxJobs` a device declares.
    pub device_max_jobs: BTreeMap<String, u32>,
    pub device_weights: BTreeMap<String, u32>,
    pub gpu_playback_before_pause: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            window: None,
            optimize_original: OriginalPolicy::Trash,
            trash_retention_days: 7,
            trash_min_free_gb: 20,
            device_max_jobs: BTreeMap::new(),
            device_weights: BTreeMap::new(),
            gpu_playback_before_pause: true,
        }
    }
}

impl Settings {
    pub fn check(&self) -> Result<(), &'static str> {
        if self.window.is_some_and(|w| !w.valid()) {
            return Err("window must hold two different minutes below 1440");
        }
        if self.device_max_jobs.values().any(|n| *n == 0) {
            return Err("deviceMaxJobs values must be at least 1");
        }
        Ok(())
    }

    /// Whether a new lease may start now, in the server's zone.
    pub fn open_at(&self, minute: u16) -> bool {
        self.window.is_none_or(|w| w.contains(minute))
    }

    pub fn open_now(&self) -> bool {
        let t = Utc::now().with_timezone(&crate::jobs::server_tz());
        self.open_at((t.hour() * 60 + t.minute()) as u16)
    }

    pub fn max_jobs(&self, device: &str, declared: u32) -> u32 {
        self.device_max_jobs
            .get(device)
            .map_or(declared, |cap| declared.min(*cap))
    }
}

/// A missing or unreadable document is the defaults.
pub async fn load(pool: &PgPool) -> sqlx::Result<Settings> {
    let raw = settings::setting_value(pool, KEY).await?;
    Ok(raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

pub async fn save(pool: &PgPool, s: &Settings) -> sqlx::Result<()> {
    let text = serde_json::to_string(s).expect("settings serialise");
    let mut tx = pool.begin().await?;
    settings::set_in(&mut tx, KEY, Some(&text)).await?;
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_wraps_over_midnight() {
        let w = Window {
            start_min: 22 * 60,
            end_min: 6 * 60,
        };
        assert!(w.contains(23 * 60) && w.contains(0) && !w.contains(12 * 60));
        let day = Window {
            start_min: 8 * 60,
            end_min: 18 * 60,
        };
        assert!(day.contains(8 * 60) && !day.contains(18 * 60));
    }

    #[test]
    fn device_caps_only_lower_the_declared_slots() {
        let mut s = Settings::default();
        s.device_max_jobs.insert("gpu0".into(), 2);
        assert_eq!((s.max_jobs("gpu0", 4), s.max_jobs("gpu0", 1)), (2, 1));
        assert_eq!(s.max_jobs("cpu", 3), 3);
    }

    #[test]
    fn an_empty_window_is_refused() {
        let s = Settings {
            window: Some(Window {
                start_min: 60,
                end_min: 60,
            }),
            ..Settings::default()
        };
        assert!(s.check().is_err());
    }
}
