//! Calls other domains make across S5 (request lifecycle hooks) and the in-process "already running" sets.
use sqlx::PgConnection;
use std::{
    collections::HashSet,
    future::Future,
    hash::Hash,
    pin::Pin,
    sync::{Arc, Mutex},
};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The media row the lifecycle hooks read.
#[derive(Debug, Clone)]
pub struct MediaRef {
    pub id: i32,
    pub media_type: String,
    pub tmdb_id: Option<i32>,
    pub monitored: bool,
}

/// Request lifecycle hooks (`requests.md` rules 36-42), called in process.
pub trait Lifecycle: Send + Sync {
    fn on_media_imported(&self, media: MediaRef, added_by: Option<i32>) -> BoxFuture<'_, ()>;
    /// Runs inside the media delete's transaction (C48).
    fn on_media_removed<'a>(
        &'a self,
        tx: &'a mut PgConnection,
        media: &'a MediaRef,
    ) -> BoxFuture<'a, Result<(), sqlx::Error>>;
    fn on_media_monitor_change(&self, media: MediaRef, was_monitored: bool) -> BoxFuture<'_, ()>;
    fn on_season_monitor_change(
        &self,
        media: MediaRef,
        season: i32,
        was: bool,
        now: bool,
    ) -> BoxFuture<'_, ()>;
}

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
        let fresh = self.0.lock().expect("claims").insert(key.clone());
        fresh.then(|| Claim {
            set: self.0.clone(),
            key,
        })
    }
}

impl<K: Eq + Hash> Drop for Claim<K> {
    fn drop(&mut self) {
        self.set.lock().expect("claims").remove(&self.key);
    }
}

#[derive(Clone)]
pub struct Seams {
    pub lifecycle: Arc<dyn Lifecycle>,
    pub seerr: Arc<Claims<()>>,
    pub watch_history: Arc<Claims<i32>>,
    pub marker_seasons: Arc<Claims<i32>>,
}

impl Default for Seams {
    fn default() -> Self {
        Self {
            lifecycle: Arc::new(Unwired),
            seerr: Arc::default(),
            watch_history: Arc::default(),
            marker_seasons: Arc::default(),
        }
    }
}

/// No request lifecycle until the requests module is wired: every hook is a no-op.
pub struct Unwired;

impl Lifecycle for Unwired {
    fn on_media_imported(&self, _: MediaRef, _: Option<i32>) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
    fn on_media_removed<'a>(
        &'a self,
        _: &'a mut PgConnection,
        _: &'a MediaRef,
    ) -> BoxFuture<'a, Result<(), sqlx::Error>> {
        Box::pin(async { Ok(()) })
    }
    fn on_media_monitor_change(&self, _: MediaRef, _: bool) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
    fn on_season_monitor_change(&self, _: MediaRef, _: i32, _: bool, _: bool) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}
