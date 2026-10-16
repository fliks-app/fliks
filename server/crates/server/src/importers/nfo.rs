//! File lookup of the NFO reader (`importers.md` rule 48); the parser is `fliks_domain::nfo`.
use fliks_domain::nfo::{NfoData, parse};
use std::{io::Read, path::Path};

/// Larger files are cut here (C55), far above any real `.nfo`.
const MAX_BYTES: u64 = 1024 * 1024;

/// The parsed file; `None` for a missing or unreadable one. Blocking: call it from `spawn_blocking`.
pub fn read_nfo_file(path: &Path) -> Option<NfoData> {
    let mut bytes = vec![];
    std::fs::File::open(path)
        .ok()?
        .take(MAX_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(parse(&String::from_utf8_lossy(&bytes)))
}

/// The `.nfo` files around a video merged most-specific first, stopping at the first that gives an id.
pub fn read_for_video_file(video: &Path) -> Option<NfoData> {
    let dir = video.parent()?;
    let mut candidates = vec![
        video.with_extension("nfo"),
        dir.join("movie.nfo"),
        dir.join("tvshow.nfo"),
    ];
    candidates.extend(dir.parent().map(|p| p.join("tvshow.nfo")));
    let mut merged: Option<NfoData> = None;
    for c in candidates {
        let Some(data) = read_nfo_file(&c) else {
            continue;
        };
        match merged.as_mut() {
            Some(m) => m.backfill(data),
            None => merged = Some(data),
        }
        if merged.as_ref().is_some_and(NfoData::has_id) {
            break;
        }
    }
    merged
}

/// `read_for_video_file` off the async threads.
pub async fn for_video(video: &Path) -> Option<NfoData> {
    let video = video.to_path_buf();
    tokio::task::spawn_blocking(move || read_for_video_file(&video))
        .await
        .ok()
        .flatten()
}

/// `read_nfo_file` off the async threads.
pub async fn file(path: &Path) -> Option<NfoData> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || read_nfo_file(&path))
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_specific_first_and_stops_at_an_id() {
        let dir = std::env::temp_dir().join(format!("s5imp-nfo-{}", std::process::id()));
        let season = dir.join("Season 1");
        std::fs::create_dir_all(&season).unwrap();
        std::fs::write(season.join("Show.S01E01.nfo"), "<e><title>Ep</title></e>").unwrap();
        std::fs::write(
            dir.join("tvshow.nfo"),
            "<t><title>Show</title><uniqueid type='tvdb'>5</uniqueid></t>",
        )
        .unwrap();
        let got = read_for_video_file(&season.join("Show.S01E01.mkv")).unwrap();
        assert_eq!((got.title.as_deref(), got.tvdb_id), (Some("Ep"), Some(5)));
        assert!(read_for_video_file(&dir.join("lone.mkv")).is_some());
        assert!(read_nfo_file(&dir.join("missing.nfo")).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
