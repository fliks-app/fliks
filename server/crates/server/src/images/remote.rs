//! Provider artwork served before the store holds it (`docs/spec/images.md` section E).
use super::paths::Size;
use crate::sync::MutexExt;
use axum::body::Bytes;
use image::ImageFormat;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_URL_LEN: usize = 2048;
pub const NETWORK_SLOTS: usize = 4;

pub struct Art {
    pub bytes: Bytes,
    pub mime: &'static str,
}

#[derive(Default)]
pub struct Cache(Mutex<Fifo>);

#[derive(Default)]
struct Fifo {
    map: HashMap<String, Arc<Art>>,
    order: VecDeque<String>,
    bytes: usize,
}

impl Cache {
    pub fn get(&self, key: &str) -> Option<Arc<Art>> {
        self.0.lock_clean().map.get(key).cloned()
    }

    // ponytail: oldest-first eviction; an LRU if browsing evicts posters still on screen.
    pub fn put(&self, key: String, art: Arc<Art>) {
        let mut c = self.0.lock_clean();
        if art.bytes.len() > MAX_CACHE_BYTES || c.map.contains_key(&key) {
            return;
        }
        c.bytes += art.bytes.len();
        c.order.push_back(key.clone());
        c.map.insert(key, art);
        while c.bytes > MAX_CACHE_BYTES {
            let Some(old) = c.order.pop_front() else {
                break;
            };
            if let Some(a) = c.map.remove(&old) {
                c.bytes -= a.bytes.len();
            }
        }
    }
}

/// TMDB serves its own renditions, so its URL is rewritten rather than the bytes resized (rule 21).
pub fn tmdb_sized(url: &str, size: Size) -> Option<String> {
    let mut u = reqwest::Url::parse(url).ok()?;
    if u.host_str() != Some("image.tmdb.org") {
        return None;
    }
    let (_, file) = u
        .path()
        .strip_prefix("/t/p/")?
        .split_once('/')
        .filter(|(s, f)| !s.is_empty() && !f.is_empty())?;
    let s = match size {
        Size::Thumb => "w342",
        Size::Medium => "w780",
        Size::Full => "original",
    };
    let path = format!("/t/p/{s}/{file}");
    u.set_path(&path);
    Some(u.into())
}

pub fn width(size: Size) -> Option<u32> {
    match size {
        Size::Thumb => Some(342),
        Size::Medium => Some(780),
        Size::Full => None,
    }
}

pub fn mime(f: ImageFormat) -> &'static str {
    match f {
        ImageFormat::Png => "image/png",
        ImageFormat::WebP => "image/webp",
        ImageFormat::Gif => "image/gif",
        _ => "image/jpeg",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmdb_urls_take_the_size_rendition_and_other_urls_none() {
        let u = "https://image.tmdb.org/t/p/w500/a.jpg";
        assert_eq!(
            tmdb_sized(u, Size::Thumb).as_deref(),
            Some("https://image.tmdb.org/t/p/w342/a.jpg")
        );
        assert_eq!(
            tmdb_sized(u, Size::Full).as_deref(),
            Some("https://image.tmdb.org/t/p/original/a.jpg")
        );
        assert_eq!(
            tmdb_sized("https://image.tmdb.org/x.jpg", Size::Thumb),
            None
        );
        assert_eq!(
            tmdb_sized("https://covers.example.org/t/p/w500/a.jpg", Size::Thumb),
            None
        );
    }

    #[test]
    fn the_cache_evicts_the_oldest_past_its_budget() {
        let c = Cache::default();
        let art = |n| {
            Arc::new(Art {
                bytes: Bytes::from(vec![0; n]),
                mime: "image/jpeg",
            })
        };
        c.put("a".into(), art(MAX_CACHE_BYTES / 2));
        c.put("b".into(), art(MAX_CACHE_BYTES / 2));
        assert!(c.get("a").is_some());
        c.put("c".into(), art(1));
        assert!(c.get("a").is_none());
        assert!(c.get("b").is_some() && c.get("c").is_some());
        c.put("huge".into(), art(MAX_CACHE_BYTES + 1));
        assert!(c.get("huge").is_none() && c.get("b").is_some());
    }
}
