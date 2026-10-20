//! One poisoning policy: a panic under a lock never wedges the server, the state it left is used.
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub trait MutexExt<T> {
    fn lock_clean(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_clean(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub trait RwLockExt<T> {
    fn read_clean(&self) -> RwLockReadGuard<'_, T>;
    fn write_clean(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T> RwLockExt<T> for RwLock<T> {
    fn read_clean(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write_clean(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap_or_else(|e| e.into_inner())
    }
}
