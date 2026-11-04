//! Small in-process caches for the page routes (`docs/spec/comics.md`, rule 28): the page list of an
//! archive and, for a solid one, the decoded pages (or just their archive order when they do not
//! fit) so that page N does not decode the N-1 before it again. Keys carry the file's identity, so a
//! changed file is a new key. One fill per key runs at a time.
use super::archive::{Page, SOLID_CACHE_BYTES};
use crate::sync::MutexExt;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Key {
    pub file: i32,
    pub size: u64,
    pub mtime: u128,
    pub ino: u64,
    pub ctime: i128,
}

/// What one pass learned of an archive.
pub struct Entry {
    pub pages: Vec<Page>,
    /// Archive position of each page, for a solid archive: a page is then one pass.
    pub ordinals: Option<Vec<usize>>,
}

const LISTS: usize = 64;

type Lists = Vec<(Key, Arc<Entry>, ())>;
type Solids = Vec<(Key, Arc<Vec<Vec<u8>>>, u64)>;

static LIST_CACHE: Mutex<Lists> = Mutex::new(Vec::new());
// ponytail: one process-wide LRU capped by bytes; a per-archive stream or a disk cache if
// solid archives above the cap are common.
static SOLID_CACHE: Mutex<Solids> = Mutex::new(Vec::new());
static FLIGHTS: Mutex<Option<HashMap<Key, Arc<Mutex<()>>>>> = Mutex::new(None);

fn touch<T: Clone, E>(v: &mut Vec<(Key, T, E)>, key: Key) -> Option<T> {
    let at = v.iter().position(|e| e.0 == key)?;
    let e = v.remove(at);
    let out = e.1.clone();
    v.push(e);
    Some(out)
}

pub fn list(key: Key) -> Option<Arc<Entry>> {
    touch(&mut LIST_CACHE.lock_clean(), key)
}

pub fn put_list(key: Key, entry: Arc<Entry>) {
    let mut v = LIST_CACHE.lock_clean();
    v.retain(|e| e.0 != key);
    v.push((key, entry, ()));
    let extra = v.len().saturating_sub(LISTS);
    v.drain(..extra);
}

pub fn solid(key: Key) -> Option<Arc<Vec<Vec<u8>>>> {
    touch(&mut SOLID_CACHE.lock_clean(), key)
}

/// Keeps the pages when their capacity fits the cap, evicting the oldest archives first.
pub fn put_solid(key: Key, pages: Arc<Vec<Vec<u8>>>) {
    let bytes: u64 = pages.iter().map(|p| p.capacity() as u64).sum();
    if bytes > SOLID_CACHE_BYTES {
        return;
    }
    let mut v = SOLID_CACHE.lock_clean();
    v.retain(|e| e.0 != key);
    v.push((key, pages, bytes));
    while v.iter().map(|e| e.2).sum::<u64>() > SOLID_CACHE_BYTES && v.len() > 1 {
        v.remove(0);
    }
}

/// The lock of one fill: concurrent first requests of an archive wait for one decode.
pub fn flight(key: Key) -> Arc<Mutex<()>> {
    let mut g = FLIGHTS.lock_clean();
    let m = g.get_or_insert_with(HashMap::new);
    m.retain(|_, l| Arc::strong_count(l) > 1);
    m.entry(key).or_default().clone()
}
