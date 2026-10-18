//! The data and cache directories, resolved as Nest's `getDataDir` / `getCacheDir` (`common/constants/paths.ts`).
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

fn env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// `FLIKS_DATA_DIR`, else the deprecated `FLIKS_IMAGES_DIR`, else `<cwd>/images` when present, else `<cwd>/data`.
fn intended_data_dir() -> PathBuf {
    env("FLIKS_DATA_DIR")
        .or_else(|| env("FLIKS_IMAGES_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let cwd = std::env::current_dir().unwrap_or_default();
            let legacy = cwd.join("images");
            if legacy.exists() {
                legacy
            } else {
                cwd.join("data")
            }
        })
}

/// `resolveWritableDir([preferred, <tmp>/<fallback>])`: the first directory a `.probe` file can be written to.
fn writable_or(preferred: PathBuf, fallback: &str, what: &str) -> PathBuf {
    let writable = |d: &Path| {
        let probe = d.join(".probe");
        std::fs::create_dir_all(d).is_ok()
            && std::fs::File::create(&probe).is_ok()
            && std::fs::remove_file(probe).is_ok()
    };
    if writable(&preferred) {
        return preferred;
    }
    let fallback = std::env::temp_dir().join(fallback);
    tracing::warn!(dir = %preferred.display(), "{what} directory not writable: using {}", fallback.display());
    fallback
}

/// Artwork and uploaded avatars; resolved once.
pub fn data_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| writable_or(intended_data_dir(), "fliks-data", "data"))
}

/// Extracted subtitles and seek-preview sprites: `FLIKS_CACHE_DIR`, else `<data dir>/cache`; resolved once.
pub fn cache_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let preferred =
            env("FLIKS_CACHE_DIR").map_or_else(|| data_dir().join("cache"), PathBuf::from);
        writable_or(preferred, "fliks-cache", "cache")
    })
}
