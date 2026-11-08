//! Opt-in tag writing (`docs/spec/music.md`, Naming and tags): the setting `music.write_tags` makes a settled album's
//! files carry what the library knows. A file with several hard links is copied first, so the other links keep their
//! bytes (a seeding torrent stays valid).
use super::super::rescan::mtime_ms;
use crate::{settings::setting_value, state::AppState};
use lofty::{
    config::WriteOptions,
    file::TaggedFileExt,
    tag::{Accessor, ItemKey, Tag, TagExt},
};
use std::path::{Path, PathBuf};

#[derive(sqlx::FromRow)]
struct Facts {
    file: i32,
    folder: String,
    rel: String,
    title: Option<String>,
    disc: i32,
    number: Option<i32>,
    recording: Option<String>,
    release_track: Option<String>,
    album: String,
    year: Option<i32>,
    release: Option<String>,
    group: Option<String>,
    artists: Option<String>,
    album_artists: Option<String>,
}

pub async fn enabled(st: &AppState) -> bool {
    setting_value(&st.db, "music.write_tags")
        .await
        .ok()
        .flatten()
        .is_some_and(|v| v == "true")
}

fn linked(meta: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.nlink() > 1
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        false
    }
}

fn set(tag: &mut Tag, key: ItemKey, v: Option<&str>) {
    if let Some(v) = v.filter(|v| !v.is_empty()) {
        tag.insert_text(key, v.to_owned());
    }
}

/// Writes `f` into the file at `path`; a file with several links is rewritten through a copy.
fn write(path: &Path, f: &Facts) -> Result<(), String> {
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let mut tag = tagged
        .primary_tag()
        .cloned()
        .unwrap_or_else(|| Tag::new(tagged.primary_tag_type()));
    set(&mut tag, ItemKey::TrackTitle, f.title.as_deref());
    set(&mut tag, ItemKey::AlbumTitle, Some(&f.album));
    set(&mut tag, ItemKey::TrackArtist, f.artists.as_deref());
    set(&mut tag, ItemKey::AlbumArtist, f.album_artists.as_deref());
    set(
        &mut tag,
        ItemKey::MusicBrainzRecordingId,
        f.recording.as_deref(),
    );
    set(
        &mut tag,
        ItemKey::MusicBrainzTrackId,
        f.release_track.as_deref(),
    );
    set(
        &mut tag,
        ItemKey::MusicBrainzReleaseId,
        f.release.as_deref(),
    );
    set(
        &mut tag,
        ItemKey::MusicBrainzReleaseGroupId,
        f.group.as_deref(),
    );
    if let Some(n) = f.number.and_then(|n| u32::try_from(n).ok()) {
        tag.set_track(n);
    }
    tag.set_disk(u32::try_from(f.disc).unwrap_or(1));
    set(
        &mut tag,
        ItemKey::Year,
        f.year.map(|y| y.to_string()).as_deref(),
    );
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !linked(&meta) {
        return tag
            .save_to_path(path, WriteOptions::default())
            .map_err(|e| e.to_string());
    }
    let mut copy: PathBuf = path.to_path_buf();
    copy.set_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("audio")
    ));
    std::fs::copy(path, &copy).map_err(|e| e.to_string())?;
    let saved = tag
        .save_to_path(&copy, WriteOptions::default())
        .map_err(|e| e.to_string())
        .and_then(|()| std::fs::rename(&copy, path).map_err(|e| e.to_string()));
    if saved.is_err() {
        let _ = std::fs::remove_file(&copy);
    }
    saved
}

/// Writes the tags of every file of the album `media`; the count of files written. A file that fails is
/// logged and left as it was.
pub async fn write_album_tags(st: &AppState, media: i32) -> Result<usize, String> {
    let rows: Vec<Facts> = sqlx::query_as(
        r#"SELECT mf.id AS file, lf.path AS folder, mf."relativePath" AS rel, i.title, td."discNumber" AS disc,
             td."trackNumber" AS number, td."recordingMbid"::text AS recording,
             td."releaseTrackMbid"::text AS release_track, m.title AS album, m.year,
             (SELECT x.value FROM edition_external_ids x
               WHERE x."editionId" = i."editionId" AND x.provider = 'musicbrainz') AS release,
             (SELECT x.value FROM media_external_ids x
               WHERE x."mediaId" = m.id AND x.kind = 'album' AND x.provider = 'musicbrainz') AS "group",
             (SELECT string_agg(p.name, '; ' ORDER BY c.position) FROM item_credits c
               JOIN persons p ON p.id = c."personId" WHERE c."itemId" = i.id AND c.role = 'artist') AS artists,
             (SELECT string_agg(p.name, '; ' ORDER BY c.position) FROM media_credits c
               JOIN persons p ON p.id = c."personId" WHERE c."mediaId" = m.id AND c.role = 'artist') AS album_artists
           FROM media_files mf
             JOIN library_folders lf ON lf.id = mf."folderId"
             JOIN item_parts ip ON ip."mediaFileId" = mf.id
             JOIN items i ON i.id = ip."itemId"
             JOIN track_details td ON td."itemId" = i.id
             JOIN media m ON m.id = mf."mediaId"
           WHERE mf."mediaId" = $1 ORDER BY mf.id"#,
    )
    .bind(media)
    .fetch_all(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    let mut done = 0;
    for f in rows {
        let path = Path::new(&f.folder).join(&f.rel);
        let facts = f;
        let (p, file) = (path.clone(), facts.file);
        let facts = tokio::task::spawn_blocking(move || write(&p, &facts).map(|()| facts))
            .await
            .map_err(|e| e.to_string())?;
        match facts {
            Ok(_) => {
                let meta = tokio::fs::metadata(&path)
                    .await
                    .map_err(|e| e.to_string())?;
                sqlx::query(r#"UPDATE media_files SET size = $2, "mtimeMs" = $3 WHERE id = $1"#)
                    .bind(file)
                    .bind(meta.len() as i64)
                    .bind(mtime_ms(&meta))
                    .execute(&st.db)
                    .await
                    .map_err(|e| e.to_string())?;
                done += 1;
            }
            Err(e) => tracing::warn!("tags of \"{}\" not written: {e}", path.display()),
        }
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A silent 8-bit mono WAV, enough for lofty to read and tag.
    fn wav() -> Vec<u8> {
        let data = [128u8; 64];
        let mut b = Vec::new();
        b.extend(b"RIFF");
        b.extend((36 + data.len() as u32).to_le_bytes());
        b.extend(b"WAVEfmt ");
        b.extend(16u32.to_le_bytes());
        b.extend([1, 0, 1, 0]);
        b.extend(8000u32.to_le_bytes());
        b.extend(8000u32.to_le_bytes());
        b.extend([1, 0, 8, 0]);
        b.extend(b"data");
        b.extend((data.len() as u32).to_le_bytes());
        b.extend(data);
        b
    }

    fn facts() -> Facts {
        Facts {
            file: 1,
            folder: String::new(),
            rel: String::new(),
            title: Some("Low Tide".into()),
            disc: 1,
            number: Some(5),
            recording: Some("55555555-5555-5555-5555-555555555555".into()),
            release_track: None,
            album: "Salt Meadows".into(),
            year: Some(2019),
            release: None,
            group: None,
            artists: Some("Cora Vell".into()),
            album_artists: Some("Cora Vell".into()),
        }
    }

    #[test]
    fn a_file_is_tagged_in_place() {
        let dir =
            std::env::temp_dir().join(format!("fliks-tagwrite-{}", crate::config::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.wav");
        std::fs::write(&path, wav()).unwrap();
        write(&path, &facts()).unwrap();
        let tagged = lofty::read_from_path(&path).unwrap();
        let tag = tagged.primary_tag().unwrap();
        assert_eq!(tag.title().as_deref(), Some("Low Tide"));
        assert_eq!(tag.track(), Some(5));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_with_several_links_is_never_rewritten_in_place() {
        let dir =
            std::env::temp_dir().join(format!("fliks-tagwrite-{}", crate::config::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let (path, seed) = (dir.join("a.wav"), dir.join("seeding.wav"));
        std::fs::write(&seed, wav()).unwrap();
        std::fs::hard_link(&seed, &path).unwrap();
        write(&path, &facts()).unwrap();
        assert_eq!(
            std::fs::read(&seed).unwrap(),
            wav(),
            "the other link keeps its bytes"
        );
        assert_ne!(std::fs::read(&path).unwrap(), wav());
        assert!(!dir.join("a.wav.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
