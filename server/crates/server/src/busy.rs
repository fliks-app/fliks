//! The in-process "already running" sets of the Seerr import, the Emby watch-history import and marker detection.
use crate::sync::MutexExt;
use std::{
    collections::HashSet,
    hash::Hash,
    sync::{Arc, Mutex},
};

/// In-process "already running" sets; the guard frees its key on drop.
pub struct Claims<K: Eq + Hash>(Arc<Mutex<HashSet<K>>>);

pub struct Claim<K: Eq + Hash> {
    set: Arc<Mutex<HashSet<K>>>,
    key: K,
}

impl<K: Eq + Hash> Default for Claims<K> {
    fn default() -> Self {
        Self(Arc::default())
    }
}

impl<K: Eq + Hash + Clone> Claims<K> {
    pub fn claim(&self, key: K) -> Option<Claim<K>> {
        let fresh = self.0.lock_clean().insert(key.clone());
        fresh.then(|| Claim {
            set: self.0.clone(),
            key,
        })
    }
}

impl<K: Eq + Hash> Drop for Claim<K> {
    fn drop(&mut self) {
        self.set.lock_clean().remove(&self.key);
    }
}

#[derive(Clone, Default)]
pub struct Busy {
    pub seerr: Arc<Claims<()>>,
    pub watch_history: Arc<Claims<i32>>,
    pub marker_seasons: Arc<Claims<i32>>,
}
