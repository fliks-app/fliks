//! Two small in-process caches for the page routes (`docs/spec/comics.md`, rule 28): the page list
//! of an archive, and the decoded pages of one solid archive so that page N does not decode the
//! N-1 before it again. Keys carry the file's size and mtime, so a changed file is a new key.
use super::archive::{Page, SOLID_CACHE_BYTES};
use crate::sync::MutexExt;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Key {
    pub file: i32,
    pub size: u64,
    pub mtime: u128,
}

const LISTS: usize = 64;

type Lists = Vec<(Key, Arc<Vec<Page>>)>;
type Solids = Vec<(Key, Arc<Vec<Vec<u8>>>, u64)>;

static LIST_CACHE: Mutex<Lists> = Mutex::new(Vec::new());
// ponytail: one process-wide LRU capped by bytes; a per-archive stream or a disk cache if
// solid archives above the cap are common.
static SOLID_CACHE: Mutex<Solids> = Mutex::new(Vec::new());

fn touch<T: Clone>(v: &mut Vec<(Key, T)>, key: Key) -> Option<T> {
    let at = v.iter().position(|e| e.0 == key)?;
    let e = v.remove(at);
    let out = e.1.clone();
    v.push(e);
    Some(out)
}

pub fn list(key: Key) -> Option<Arc<Vec<Page>>> {
    touch(&mut LIST_CACHE.lock_clean(), key)
}

pub fn put_list(key: Key, pages: Arc<Vec<Page>>) {
    let mut v = LIST_CACHE.lock_clean();
    v.retain(|e| e.0 != key);
    v.push((key, pages));
    let extra = v.len().saturating_sub(LISTS);
    v.drain(..extra);
}

pub fn solid(key: Key) -> Option<Arc<Vec<Vec<u8>>>> {
    let mut v = SOLID_CACHE.lock_clean();
    let at = v.iter().position(|e| e.0 == key)?;
    let e = v.remove(at);
    let out = e.1.clone();
    v.push(e);
    Some(out)
}

pub fn put_solid(key: Key, pages: Arc<Vec<Vec<u8>>>) {
    let bytes: u64 = pages.iter().map(|p| p.len() as u64).sum();
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
