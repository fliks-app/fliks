//! The in-process cache of search answers (`docs/spec/metadata.md` rule 11).
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

pub(crate) const TTL: Duration = Duration::from_secs(600);
pub(crate) const CAPACITY: usize = 500;

/// `FLIKS_DISABLE_SEARCH_CACHE=1` (exactly `1`): every search asks its providers, as a parity run needs.
pub(crate) fn enabled() -> bool {
    std::env::var("FLIKS_DISABLE_SEARCH_CACHE").as_deref() != Ok("1")
}

pub(crate) struct SearchCache {
    ttl: Duration,
    capacity: usize,
    entries: Mutex<HashMap<String, (Instant, Vec<Value>)>>,
}

impl Default for SearchCache {
    fn default() -> Self {
        Self::new(TTL, CAPACITY)
    }
}

impl SearchCache {
    pub(crate) fn new(ttl: Duration, capacity: usize) -> Self {
        Self {
            ttl,
            capacity,
            entries: Mutex::default(),
        }
    }

    pub(crate) fn get(&self, key: &str, now: Instant) -> Option<Vec<Value>> {
        let mut e = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        match e.get(key) {
            Some((at, hits)) if now.duration_since(*at) < self.ttl => Some(hits.clone()),
            Some(_) => {
                e.remove(key);
                None
            }
            None => None,
        }
    }

    /// Makes room by dropping the expired entries, then the oldest.
    pub(crate) fn put(&self, key: String, hits: Vec<Value>, now: Instant) {
        let mut e = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if e.len() >= self.capacity && !e.contains_key(&key) {
            e.retain(|_, (at, _)| now.duration_since(*at) < self.ttl);
            while e.len() >= self.capacity {
                let Some(oldest) = e
                    .iter()
                    .min_by_key(|(_, (at, _))| *at)
                    .map(|(k, _)| k.clone())
                else {
                    break;
                };
                e.remove(&oldest);
            }
        }
        e.insert(key, (now, hits));
    }

    pub(crate) fn clear(&self) {
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_entry_expires_after_the_ttl_and_the_oldest_goes_first_at_the_cap() {
        let t0 = Instant::now();
        let c = SearchCache::new(Duration::from_secs(10), 2);
        c.put("a".into(), vec![json!(1)], t0);
        c.put("b".into(), vec![json!(2)], t0 + Duration::from_secs(1));
        assert_eq!(
            c.get("a", t0 + Duration::from_secs(9)),
            Some(vec![json!(1)])
        );
        assert_eq!(c.get("a", t0 + Duration::from_secs(10)), None);
        c.put("a".into(), vec![], t0 + Duration::from_secs(2));
        c.put("c".into(), vec![], t0 + Duration::from_secs(3));
        assert_eq!(c.len(), 2);
        assert!(c.get("b", t0 + Duration::from_secs(4)).is_none());
        assert_eq!(c.get("c", t0 + Duration::from_secs(4)), Some(vec![]));
    }
}
