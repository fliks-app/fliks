//! Provider connection accounting (`livetv-sessions.md` rules 2, 5, 8).
use serde::Serialize;
use std::{cmp::Reverse, collections::HashMap, time::Instant};

/// Stream order at open: priority, then a stream without an error, then the most recently confirmed (stable).
pub fn sort_streams<T>(streams: &mut [T], key: impl Fn(&T) -> (i32, bool, i64)) {
    streams.sort_by_key(|s| {
        let (priority, bad, last_ok_ms) = key(s);
        (priority, bad, Reverse(last_ok_ms))
    });
}

/// Upstreams closed recently that the provider still counts as open; monotonic clock, pruned on every touch.
#[derive(Debug, Default)]
pub struct Releases(HashMap<i32, Vec<Instant>>);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtCapacity {
    pub code: &'static str,
    pub source_name: String,
    pub limit: i32,
}

impl Releases {
    fn prune(&mut self, source: i32, grace_s: f64, now: Instant) {
        if let Some(v) = self.0.get_mut(&source) {
            v.retain(|t| now.saturating_duration_since(*t).as_secs_f64() < grace_s);
            if v.is_empty() {
                self.0.remove(&source);
            }
        }
    }

    /// `grace_s` is the longest anything is worth keeping; the next read passes the real one.
    pub fn record(&mut self, source: i32, now: Instant, grace_s: f64) {
        self.prune(source, grace_s, now);
        self.0.entry(source).or_default().push(now);
    }

    pub fn in_use(&mut self, source: i32, grace_s: f64, live_holds: usize, now: Instant) -> usize {
        self.prune(source, grace_s, now);
        live_holds + self.0.get(&source).map_or(0, Vec::len)
    }

    /// The 409 body when the source is at its limit; `max_streams` 0 or none is unlimited.
    pub fn verdict(
        &mut self,
        source: (i32, &str, Option<i32>),
        grace_s: f64,
        live_holds: usize,
        now: Instant,
    ) -> Option<AtCapacity> {
        let (id, name, max) = source;
        let limit = max.filter(|m| *m != 0)?;
        (self.in_use(id, grace_s, live_holds, now) as i64 >= i64::from(limit)).then(|| AtCapacity {
            code: "livetv_source_at_capacity",
            source_name: name.to_owned(),
            limit,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_release_counts_until_exactly_the_grace() {
        let t0 = Instant::now();
        let mut r = Releases::default();
        r.record(1, t0, 15.0);
        assert_eq!(r.in_use(1, 15.0, 0, t0 + Duration::from_secs(14)), 1);
        assert_eq!(r.in_use(1, 15.0, 0, t0 + Duration::from_secs(15)), 0);
        r.record(1, t0, 15.0);
        assert_eq!(r.in_use(1, 15.0, 2, t0 + Duration::from_secs(1)), 3);
    }

    #[test]
    fn the_limit_is_reached_not_exceeded() {
        let t0 = Instant::now();
        let mut r = Releases::default();
        assert!(r.verdict((1, "S", Some(1)), 15.0, 0, t0).is_none());
        let v = r.verdict((1, "S", Some(1)), 15.0, 1, t0).unwrap();
        assert_eq!((v.limit, v.source_name.as_str()), (1, "S"));
        for unlimited in [Some(0), None] {
            assert!(r.verdict((1, "S", unlimited), 15.0, 9, t0).is_none());
        }
        r.record(1, t0, 15.0);
        assert!(r.verdict((1, "S", Some(1)), 15.0, 0, t0).is_some());
        assert!(r.verdict((1, "S", Some(1)), -1.0, 0, t0).is_none());
    }

    #[test]
    fn streams_sort_by_priority_then_health_and_stay_stable() {
        let mut v = vec![
            (1, true, 0),
            (0, false, 5),
            (0, true, 9),
            (0, false, 7),
            (0, false, 7),
        ];
        let tagged: Vec<(usize, _)> = v.drain(..).enumerate().collect();
        let mut tagged = tagged;
        sort_streams(&mut tagged, |(_, s)| *s);
        let order: Vec<usize> = tagged.iter().map(|(i, _)| *i).collect();
        assert_eq!(order, [3, 4, 1, 2, 0]);
    }
}
