//! The push identity file (`<conf>/.push-identity.json`, 0600): the relay identity and its pending
//! deletions, and the Web Push VAPID key. Kept out of the database so no dump carries the keys.
use crate::{config::Config, sync::MutexExt};
use p256::ecdsa::SigningKey as VapidKey;
use serde::{Deserialize, Serialize};
use std::{fs::OpenOptions, io::Write, path::PathBuf, sync::Mutex};

const FILE: &str = ".push-identity.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Server {
    pub url: String,
    /// Hex of the 32-byte Ed25519 seed.
    pub seed: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Data {
    #[serde(default)]
    pub relay: Option<Server>,
    #[serde(default)]
    pub pending: Vec<Server>,
    /// Hex of the 32-byte P-256 scalar.
    #[serde(default)]
    pub vapid: String,
}

pub struct Identity {
    path: Option<PathBuf>,
    data: Mutex<Data>,
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("os rng");
    b
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    (s.len().is_multiple_of(2) && s.is_ascii()).then_some(())?;
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

pub fn new_vapid() -> String {
    loop {
        let b = random::<32>();
        if VapidKey::from_slice(&b).is_ok() {
            return hex(&b);
        }
    }
}

fn valid_vapid(h: &str) -> bool {
    unhex(h).is_some_and(|b| VapidKey::from_slice(&b).is_ok())
}

/// Written next to the target with a private mode from the first byte, then renamed over it.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", crate::config::random_hex(4)));
    let mut open = OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
    open.open(&tmp)?.write_all(bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

impl Identity {
    /// Reads the file, creating it with a fresh VAPID key when absent; a file that does not parse is replaced.
    pub fn load(cfg: &Config) -> Self {
        let fresh = Data {
            vapid: new_vapid(),
            ..Data::default()
        };
        let fresh_text = serde_json::to_string(&fresh).expect("typed data");
        let (text, path) = crate::jwt_secret::resolve_state(cfg, FILE, fresh_text);
        let mut data: Data = serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::warn!("push identity file unreadable, starting over: {e}");
            Data::default()
        });
        let id = Self {
            path,
            data: Mutex::default(),
        };
        if !valid_vapid(&data.vapid) {
            data.vapid = new_vapid();
            *id.data.lock_clean() = data;
            if let Err(e) = id.persist() {
                tracing::warn!("cannot write the push identity: {e}");
            }
        } else {
            *id.data.lock_clean() = data;
        }
        id
    }

    pub fn snapshot(&self) -> Data {
        self.data.lock_clean().clone()
    }

    /// Applies `f`, then writes the file; the in-memory value changes even when the write fails.
    pub fn update<T>(&self, f: impl FnOnce(&mut Data) -> T) -> std::io::Result<T> {
        let out = f(&mut self.data.lock_clean());
        self.persist().map(|()| out)
    }

    fn persist(&self) -> std::io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let text = serde_json::to_vec(&*self.data.lock_clean()).expect("typed data");
        write_private(path, &text)
    }

    pub fn vapid(&self) -> VapidKey {
        let b = unhex(&self.data.lock_clean().vapid).expect("validated at load");
        VapidKey::from_slice(&b).expect("validated at load")
    }
}
