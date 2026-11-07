//! Completion estimate: the speed of the last jobs of each device, stretched over the time window.
use super::settings::{self, Settings};
use crate::{optimize::select::PerLevelF, state::AppState};
use chrono::{DateTime, Timelike, Utc};
use serde::Serialize;
use sqlx::Row;
use std::collections::{BTreeMap, HashMap};

/// Jobs per device and level the speed averages over.
const LAST_JOBS: i64 = 20;
const LEVELS: [&str; 3] = ["metadata", "remux", "reencode"];

/// Playing seconds a level gets through per second of wall time.
#[derive(Default)]
pub struct Speeds {
    /// Summed over the devices, one job each at its slots.
    throughput: HashMap<String, f64>,
}

pub async fn speeds(st: &AppState) -> sqlx::Result<Speeds> {
    let rows = sqlx::query(
        r#"SELECT "deviceId", level, sum(dur)::float8 AS dur, sum(wall)::float8 AS wall FROM (
             SELECT "deviceId", payload #>> '{plan,level}' AS level,
                    (payload #>> '{info,durationSeconds}')::float8 AS dur,
                    EXTRACT(EPOCH FROM "encodedAt" - "startedAt")::float8 AS wall,
                    row_number() OVER (PARTITION BY "deviceId", payload #>> '{plan,level}'
                                       ORDER BY "encodedAt" DESC) AS rn
             FROM jobs WHERE kind = 'optimize' AND "encodedAt" IS NOT NULL AND "startedAt" IS NOT NULL
               AND "deviceId" IS NOT NULL AND payload #>> '{info,durationSeconds}' IS NOT NULL
               AND state IN ('staged', 'committing', 'done')) t
           WHERE rn <= $1 AND wall > 0 GROUP BY "deviceId", level"#,
    )
    .bind(LAST_JOBS)
    .fetch_all(&st.db)
    .await?;
    let conf = settings::load(&st.db).await?;
    let workers = st.queue.workers();
    let mut out = Speeds::default();
    for r in rows {
        let (device, level): (String, Option<String>) = (r.get("deviceId"), r.get("level"));
        let (dur, wall): (f64, f64) = (r.get("dur"), r.get("wall"));
        let Some(level) = level else { continue };
        // A device nobody offers any more does not count; with no worker known yet, history alone does.
        let slots: u32 = if workers.is_empty() {
            1
        } else {
            workers
                .iter()
                .flat_map(|(_, w)| w.devices.iter())
                .filter(|d| d.id == device)
                .map(|d| conf.max_jobs(&d.id, d.max_jobs))
                .sum()
        };
        *out.throughput.entry(level).or_default() += dur / wall * f64::from(slots);
    }
    Ok(out)
}

impl Speeds {
    fn seconds(&self, level: &str, play: f64) -> Option<f64> {
        self.throughput
            .get(level)
            .filter(|t| **t > 0.0)
            .map(|t| play / t)
    }

    /// Estimated encoding seconds per level for these playing seconds; none without history.
    pub fn estimate(&self, play: &PerLevelF) -> PerLevelOpt {
        PerLevelOpt {
            metadata: self.seconds("metadata", play.metadata),
            remux: self.seconds("remux", play.remux),
            reencode: self.seconds("reencode", play.reencode),
        }
    }
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct PerLevelOpt {
    pub metadata: Option<f64>,
    pub remux: Option<f64>,
    pub reencode: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelLeft {
    pub jobs: i64,
    pub play_seconds: f64,
    pub estimate_seconds: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub per_level: BTreeMap<String, LevelLeft>,
    /// Wall seconds until the queue is empty, the closed hours of the window included; none when a level
    /// with jobs has no history yet.
    pub eta_seconds: Option<f64>,
    pub ends_at: Option<DateTime<Utc>>,
}

/// What is queued or running, and when it should end.
pub async fn remaining(st: &AppState) -> sqlx::Result<Estimate> {
    let rows = sqlx::query(
        r#"SELECT payload #>> '{plan,level}' AS level, count(*) AS n,
             COALESCE(sum(COALESCE((payload #>> '{info,durationSeconds}')::float8, 0) * (1 - progress)), 0)::float8 AS play
           FROM jobs WHERE kind = 'optimize' AND state IN ('queued', 'leased') GROUP BY 1"#,
    )
    .fetch_all(&st.db)
    .await?;
    let sp = speeds(st).await?;
    let conf = settings::load(&st.db).await?;
    let mut per_level = BTreeMap::new();
    let (mut work, mut known) = (0.0, true);
    for r in rows {
        let Some(level) = r.get::<Option<String>, _>("level") else {
            continue;
        };
        let play: f64 = r.get("play");
        let secs = sp.seconds(&level, play);
        match secs {
            Some(s) => work += s,
            None => known = false,
        }
        per_level.insert(
            level,
            LevelLeft {
                jobs: r.get("n"),
                play_seconds: play,
                estimate_seconds: secs,
            },
        );
    }
    debug_assert!(per_level.keys().all(|k| LEVELS.contains(&k.as_str())));
    let eta = known.then(|| conf.stretch(work));
    Ok(Estimate {
        per_level,
        eta_seconds: eta,
        ends_at: eta.map(|s| Utc::now() + chrono::Duration::milliseconds((s * 1000.0) as i64)),
    })
}

/// Wall seconds `work` seconds of encoding take from `minute` of the day, closed hours skipped.
pub fn stretch_from(window: Option<settings::Window>, minute: u16, work: f64) -> f64 {
    let Some(w) = window else { return work };
    let (mut left, mut wall, mut m) = (work, 0.0, u32::from(minute));
    // Beyond 60 days the answer is not an estimate any more.
    for _ in 0..60 * 24 * 60 {
        if left <= 0.0 {
            break;
        }
        if w.contains((m % 1440) as u16) {
            let take = left.min(60.0);
            left -= take;
            wall += take;
        } else {
            wall += 60.0;
        }
        m += 1;
    }
    wall
}

impl Settings {
    pub fn stretch(&self, work: f64) -> f64 {
        let t = Utc::now().with_timezone(&crate::jobs::server_tz());
        stretch_from(self.window, (t.hour() * 60 + t.minute()) as u16, work)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::settings::Window;

    #[test]
    fn closed_hours_lengthen_the_estimate() {
        let w = Some(Window {
            start_min: 60,
            end_min: 120,
        });
        assert_eq!(stretch_from(None, 0, 600.0), 600.0);
        // 10 min of work at 00:00 waits for 01:00: 60 min closed, then 10 open.
        assert_eq!(stretch_from(w, 0, 600.0), 4200.0);
        assert_eq!(stretch_from(w, 70, 600.0), 600.0);
    }
}
