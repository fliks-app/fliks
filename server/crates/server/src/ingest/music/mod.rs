//! Music ingest (`docs/spec/music.md`, section Ingest): the files of an album, its editions, one ungrouped
//! track item per file, the tags read into `track_details` and the credits. Metadata is written by
//! `metadata::music`, never here.
pub mod identify;
pub mod naming;
pub mod tags;
pub mod tagwrite;

use super::{
    books::{KnownFile, Placed, Registered, Registration},
    library::file_name,
    probe,
    record::Record,
    rescan::{PROBE_VERSION, mtime_ms},
};
use crate::lyrics::discover::Embedded;
use crate::{
    media::items::lock_versions,
    metadata::music::{
        people::{self, Credited},
        works::{self, WorkSpec},
    },
    settings::setting_value,
    state::AppState,
};
use fliks_domain::{
    external_id::Namespace,
    media::{MUSIC_EXTS, family::Family},
    music::{
        provider::{self, STATUSES},
        split::{ARTIST_SEPARATORS, GENRE_SEPARATORS, separators},
    },
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tags::{Named, Separators, TrackTags, strip_lyrics};

pub fn format_of(name: &str) -> Option<String> {
    let dot = name.rfind('.').filter(|d| *d > 0)?;
    let ext = name[dot..].to_lowercase();
    MUSIC_EXTS
        .contains(&ext.as_str())
        .then(|| ext[1..].to_owned())
}

/// Whether `name` is an audio file a library of albums owns.
pub fn is_music_file(name: &str) -> bool {
    format_of(name).is_some()
}

/// The separators of the settings `music.artist_separators` and `music.genre_separators` (JSON arrays).
pub async fn separators_of(st: &AppState) -> Separators {
    let get = |k| async move { setting_value(&st.db, k).await.ok().flatten() };
    Separators {
        artists: separators(
            get("music.artist_separators").await.as_deref(),
            &ARTIST_SEPARATORS,
        ),
        genres: separators(
            get("music.genre_separators").await.as_deref(),
            &GENRE_SEPARATORS,
        ),
    }
}

fn stem(rel: &str) -> &str {
    let name = rel.rsplit(['/', '\\']).next().unwrap_or(rel);
    name.rsplit_once('.').map_or(name, |(s, _)| s)
}

/// What a folder's sample file says: the record that names the album, and the ids its tags carry.
pub struct Sample {
    pub record: Record,
    pub artist: String,
    pub release_group: Option<String>,
    pub release: Option<String>,
}

/// One probe of a file: the album record the scan and the creation of an unmatched album read.
pub async fn sample(st: &AppState, path: &Path) -> Option<Sample> {
    let p = probe(st, path, false).await.ok()?;
    let seps = separators_of(st).await;
    let t = TrackTags::read(&p.info, &seps, stem(&file_name(path)));
    Some(Sample {
        record: album_record(std::slice::from_ref(&t)),
        artist: t.artist_line(),
        release_group: t.release_group.clone(),
        release: t.release.clone(),
    })
}

/// The key that tells the albums of a folder at the root apart: one probe of the file.
pub async fn album_key(st: &AppState, path: &Path) -> Option<String> {
    let p = probe(st, path, false).await.ok()?;
    TrackTags::read(&p.info, &Separators::default(), stem(&file_name(path))).album_key()
}

/// The most frequent value, the first on a tie.
pub(super) fn most_common<T: Clone + Eq + std::hash::Hash>(
    items: impl Iterator<Item = T>,
) -> Option<T> {
    let mut counts: Vec<(T, usize)> = vec![];
    for i in items {
        match counts.iter_mut().find(|(v, _)| *v == i) {
            Some((_, n)) => *n += 1,
            None => counts.push((i, 1)),
        }
    }
    counts
        .into_iter()
        .rev()
        .max_by_key(|(_, n)| *n)
        .map(|(v, _)| v)
}

/// The `file` record of an album: its title, year and genres, as the majority of its files say.
pub fn album_record(tags: &[TrackTags]) -> Record {
    let mut m = Record::new();
    if let Some(t) = most_common(tags.iter().filter_map(|t| t.album.clone())) {
        m.insert("title".into(), t.into());
    }
    if let Some(y) = most_common(tags.iter().filter_map(|t| t.year)) {
        m.insert("year".into(), y.into());
    }
    let mut genres: Vec<(String, usize)> = vec![];
    for g in tags.iter().flat_map(|t| &t.genres) {
        match genres.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case(g)) {
            Some((_, n)) => *n += 1,
            None => genres.push((g.clone(), 1)),
        }
    }
    genres.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    if !genres.is_empty() {
        let list: Vec<String> = genres.into_iter().take(20).map(|(g, _)| g).collect();
        m.insert("genres".into(), json!(list));
    }
    m
}

/// The stored tags of every file of the media, in file order.
pub async fn stored_tags(st: &AppState, media: i32) -> sqlx::Result<Vec<(i32, String, TrackTags)>> {
    let seps = separators_of(st).await;
    let rows: Vec<(i32, String, Option<Value>)> = sqlx::query_as(
        r#"SELECT id, "relativePath", "streamInfo" FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
    )
    .bind(media)
    .fetch_all(&st.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, rel, info)| {
            let info = info
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_else(empty_info);
            let t = TrackTags::read(&info, &seps, stem(&rel)).with_folder_disc(&rel);
            (id, rel, t)
        })
        .collect())
}

fn empty_info() -> fliks_engine_core::api::MediaInfo {
    serde_json::from_value(json!({"video": [], "audio": [], "subtitles": []})).expect("static")
}

/// The file record of a media: what the tags of its files say, no probe.
pub async fn records(st: &AppState, media: i32) -> Option<Record> {
    let all = stored_tags(st, media).await.ok()?;
    let tags: Vec<TrackTags> = all.into_iter().map(|(_, _, t)| t).collect();
    let r = album_record(&tags);
    (!r.is_empty()).then_some(r)
}

/// Inserts or updates the rows of `files`, then lays out the media's tracks (rules of `music.md`, Ingest). A
/// conflict is a file another media owns, or one the engine cannot read.
pub async fn register(st: &AppState, media: i32, files: &[Placed]) -> Result<Registration, String> {
    register_with(st, media, files, false).await
}

/// `register`, `force` reading the tags of known files again into their tracks.
pub async fn register_with(
    st: &AppState,
    media: i32,
    files: &[Placed],
    force: bool,
) -> Result<Registration, String> {
    let mut out = vec![];
    let mut conflicts = vec![];
    let mut found = vec![];
    for f in files {
        let name = file_name(&f.abs);
        let Some(format) = format_of(&name) else {
            continue;
        };
        let meta = match tokio::fs::metadata(&f.abs).await {
            Ok(m) => m,
            Err(e) => {
                conflicts.push(format!("{name}: {e}"));
                continue;
            }
        };
        let p = match probe(st, &f.abs, false).await {
            Ok(p) => p,
            Err(e) => {
                conflicts.push(format!("{name}: {e}"));
                continue;
            }
        };
        let id: Option<i32> = sqlx::query_scalar(
            r#"INSERT INTO media_files ("mediaId", "folderId", "relativePath", size, quality, "streamInfo",
                 "mtimeMs", "probeVersion")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT ("folderId", "relativePath") DO UPDATE
               SET size = EXCLUDED.size, quality = EXCLUDED.quality, "streamInfo" = EXCLUDED."streamInfo",
                   "mtimeMs" = EXCLUDED."mtimeMs", "probeVersion" = EXCLUDED."probeVersion"
               WHERE media_files."mediaId" = EXCLUDED."mediaId"
               RETURNING id"#,
        )
        .bind(media)
        .bind(f.folder_id)
        .bind(&f.rel)
        .bind(meta.len() as i64)
        .bind(&format)
        .bind(strip_lyrics(&p.info))
        .bind(mtime_ms(&meta))
        .bind(PROBE_VERSION)
        .fetch_optional(&st.db)
        .await
        .map_err(|e| e.to_string())?;
        let Some(id) = id else {
            conflicts.push(format!("{name}: file already linked to another media"));
            continue;
        };
        found.push((id, f.abs.clone(), embedded(&p.info)));
        out.push(Registered {
            file_id: id,
            rel: f.rel.clone(),
            family: Family::Audio,
            format,
        });
    }
    if out.is_empty() {
        return Ok(Registration {
            files: out,
            conflicts,
        });
    }
    let ids: Vec<i32> = out.iter().map(|r| r.file_id).collect();
    lay_out(st, media, &ids, force).await?;
    crate::lyrics::discover::after_layout(st, &found).await;
    for r in &out {
        st.ingest.queue.enqueue(st, r.file_id).await;
    }
    st.ingest.settle.schedule(st, media);
    Ok(Registration {
        files: out,
        conflicts,
    })
}

/// The lyrics tags of a file, probed again (`streamInfo` keeps none).
pub async fn embedded_of(st: &AppState, path: &Path) -> Embedded {
    match probe(st, path, false).await {
        Ok(p) => embedded(&p.info),
        Err(_) => Embedded::default(),
    }
}

fn embedded(info: &fliks_engine_core::api::MediaInfo) -> Embedded {
    let t = info.tags.as_ref();
    Embedded {
        lyrics: t.and_then(|t| t.lyrics.clone()),
        synced: t.and_then(|t| t.synced_lyrics.clone()),
    }
}

/// A file changed on disk: its probe and its technical facts again; `force` reads its tags into the track too.
pub async fn refresh(
    st: &AppState,
    media: i32,
    base: &Path,
    rows: &[&KnownFile],
) -> Result<i64, String> {
    let mut changed = vec![];
    let mut found = vec![];
    for r in rows {
        let abs: PathBuf = base.join(r.rel.replace('\\', "/"));
        let Ok(meta) = tokio::fs::metadata(&abs).await else {
            continue;
        };
        let mtime = mtime_ms(&meta);
        if r.size == meta.len() as i64
            && mtime.is_some()
            && r.mtime_ms == mtime
            && r.probe_version == Some(PROBE_VERSION)
        {
            continue;
        }
        let p = probe(st, &abs, false).await?;
        sqlx::query(
            r#"UPDATE media_files SET size = $2, "streamInfo" = $3, "mtimeMs" = $4, "probeVersion" = $5 WHERE id = $1"#,
        )
        .bind(r.id)
        .bind(meta.len() as i64)
        .bind(strip_lyrics(&p.info))
        .bind(mtime)
        .bind(PROBE_VERSION)
        .execute(&st.db)
        .await
        .map_err(|e| e.to_string())?;
        if let Some(ms) = p.info.duration_seconds.map(|s| (s * 1000.0) as i32) {
            crate::karaoke::store::invalidate_if_replaced(&st.db, r.id, ms)
                .await
                .map_err(|e| e.to_string())?;
        }
        changed.push(r.id);
        found.push((r.id, abs, embedded(&p.info)));
    }
    if !changed.is_empty() {
        lay_out(st, media, &changed, false).await?;
        crate::lyrics::discover::after_layout(st, &found).await;
        st.ingest.settle.schedule(st, media);
    }
    Ok(changed.len() as i64)
}

struct FileRow {
    id: i32,
    rel: String,
    info: Option<Value>,
    has_part: bool,
}

/// An edition's tracks the files have not claimed: a file that moved takes its old track back.
struct Free {
    item: i32,
    disc: i32,
    number: Option<i32>,
    recording: Option<String>,
    title: Option<String>,
}

impl Free {
    /// A file's track: its recording id, else its disc and track number, else its title.
    fn pairs(&self, t: &TrackTags) -> bool {
        t.recording
            .as_ref()
            .is_some_and(|r| self.recording.as_ref() == Some(r))
            || (t.track.is_some() && self.number == t.track && self.disc == t.disc_number())
            || t.title.as_ref().is_some_and(|n| {
                self.title
                    .as_ref()
                    .is_some_and(|m| m.trim().to_lowercase() == n.trim().to_lowercase())
            })
    }
}

async fn target_edition(c: &mut PgConnection, media: i32) -> sqlx::Result<Option<i32>> {
    Ok(
        sqlx::query_scalar(r#"SELECT "targetEditionId" FROM album_details WHERE "mediaId" = $1"#)
            .bind(media)
            .fetch_optional(&mut *c)
            .await?
            .flatten(),
    )
}

/// Loads the free tracks and the last position of `edition` once.
async fn load_free(
    c: &mut PgConnection,
    edition: i32,
    free: &mut HashMap<i32, Vec<Free>>,
    next: &mut HashMap<i32, i32>,
) -> sqlx::Result<()> {
    let std::collections::hash_map::Entry::Vacant(slot) = free.entry(edition) else {
        return Ok(());
    };
    type Row = (i32, i32, Option<i32>, Option<String>, Option<String>);
    let list: Vec<Row> = sqlx::query_as(
        r#"SELECT i.id, td."discNumber", td."trackNumber", td."recordingMbid"::text, i.title
           FROM items i JOIN track_details td ON td."itemId" = i.id
           WHERE i."editionId" = $1
             AND NOT EXISTS (SELECT 1 FROM item_parts p WHERE p."itemId" = i.id)
           ORDER BY i.id"#,
    )
    .bind(edition)
    .fetch_all(&mut *c)
    .await?;
    slot.insert(
        list.into_iter()
            .map(|(item, disc, number, recording, title)| Free {
                item,
                disc,
                number,
                recording,
                title,
            })
            .collect(),
    );
    let max: i32 = sqlx::query_scalar(
        r#"SELECT COALESCE(max(td.position), 0) FROM track_details td JOIN items i ON i.id = td."itemId"
           WHERE i."editionId" = $1"#,
    )
    .bind(edition)
    .fetch_one(&mut *c)
    .await?;
    next.insert(edition, max);
    Ok(())
}

fn edition_status(t: &TrackTags) -> Option<&'static str> {
    let s = t.release_status.as_deref()?.trim().to_lowercase();
    STATUSES.iter().find(|k| **k == s).copied()
}

fn barcode(t: &TrackTags) -> Option<String> {
    t.barcode
        .clone()
        .filter(|b| (8..=14).contains(&b.len()) && b.bytes().all(|c| c.is_ascii_digit()))
}

/// The audio edition a file with these tags belongs to: its release id's, else the one no release names.
async fn edition_for(
    c: &mut PgConnection,
    st: &AppState,
    media: i32,
    t: &TrackTags,
) -> sqlx::Result<i32> {
    let held: Option<i32> = match &t.release {
        Some(r) => {
            sqlx::query_scalar(
                r#"SELECT e.id FROM editions e JOIN edition_external_ids x ON x."editionId" = e.id
                   WHERE e."mediaId" = $1 AND e.family = 'audio' AND x.provider = 'musicbrainz' AND x.value = $2
                   ORDER BY e.id LIMIT 1"#,
            )
            .bind(media)
            .bind(r)
            .fetch_optional(&mut *c)
            .await?
        }
        None => {
            sqlx::query_scalar(
                r#"SELECT e.id FROM editions e WHERE e."mediaId" = $1 AND e.family = 'audio'
                     AND NOT EXISTS (SELECT 1 FROM edition_external_ids x WHERE x."editionId" = e.id
                                      AND x.provider = 'musicbrainz')
                   ORDER BY e.id LIMIT 1"#,
            )
            .bind(media)
            .fetch_optional(&mut *c)
            .await?
        }
    };
    if let Some(id) = held {
        return Ok(id);
    }
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO editions ("mediaId", family, publisher, status, media, barcode, "catalogNumber")
           VALUES ($1, 'audio', $2, $3, $4, $5, $6) RETURNING id"#,
    )
    .bind(media)
    .bind(&t.label)
    .bind(edition_status(t))
    .bind(t.media.as_deref().map(provider::medium))
    .bind(barcode(t))
    .bind(&t.catalog)
    .fetch_one(&mut *c)
    .await?;
    if let Some(r) = &t.release {
        crate::media::external_ids::link_edition(
            c,
            &st.namespaces(),
            id,
            media,
            Namespace::MUSICBRAINZ,
            r,
        )
        .await?;
    }
    Ok(id)
}

fn credited(n: &Named) -> Credited {
    Credited {
        name: n.name.clone(),
        mbid: n.mbid.clone(),
        ..Credited::default()
    }
}

/// The credits and works of a track as its tags name them.
async fn describe(c: &mut PgConnection, item: i32, t: &TrackTags) -> sqlx::Result<()> {
    let artists: Vec<Credited> = if t.artists.is_empty() {
        t.album_artists.iter().map(credited).collect()
    } else {
        t.artists.iter().map(credited).collect()
    };
    people::replace_track_credits(c, item, "artist", &artists).await?;
    let named = |n: &String| Credited {
        name: n.clone(),
        ..Credited::default()
    };
    let composers: Vec<Credited> = t.composers.iter().map(named).collect();
    people::replace_track_credits(c, item, "composer", &composers).await?;
    let conductors: Vec<Credited> = t.conductor.iter().map(named).collect();
    people::replace_track_credits(c, item, "conductor", &conductors).await?;
    let performers: Vec<Credited> = t
        .performers
        .iter()
        .map(|(name, instrument)| Credited {
            name: name.clone(),
            instrument: instrument.clone(),
            ..Credited::default()
        })
        .collect();
    people::replace_track_credits(c, item, "performer", &performers).await?;
    let composer = composers.first().cloned();
    let work = match (&t.movement, &t.work) {
        (Some(m), parent) => Some(WorkSpec {
            mbid: t.work_id.clone(),
            title: m.clone(),
            parent_title: parent.clone(),
            composer,
            ..WorkSpec::default()
        }),
        (None, Some(w)) => Some(WorkSpec {
            mbid: t.work_id.clone(),
            title: w.clone(),
            composer,
            ..WorkSpec::default()
        }),
        _ => None,
    };
    if let Some(w) = work {
        works::set_track_works(c, item, &[w]).await?;
    }
    Ok(())
}

async fn write_details(c: &mut PgConnection, item: i32, t: &TrackTags) -> sqlx::Result<()> {
    sqlx::query(r#"UPDATE items SET title = COALESCE($2, title) WHERE id = $1"#)
        .bind(item)
        .bind(&t.title)
        .execute(&mut *c)
        .await?;
    sqlx::query(
        r#"UPDATE track_details SET "discNumber" = $2, "discTitle" = $3, "trackNumber" = $4,
             "recordingMbid" = $5::uuid, "releaseTrackMbid" = $6::uuid, isrc = $7, "durationMs" = $8,
             gain = $9, peak = $10
           WHERE "itemId" = $1"#,
    )
    .bind(item)
    .bind(t.disc_number())
    .bind(&t.disc_title)
    .bind(t.track.filter(|n| (0..=9999).contains(n)))
    .bind(&t.recording)
    .bind(&t.release_track)
    .bind(&t.isrc)
    .bind(t.duration_ms)
    .bind(t.gain.filter(|g| g.abs() <= 100.0).map(|g| g as f32))
    .bind(t.peak.filter(|p| *p > 0.0 && *p <= 100.0).map(|p| p as f32))
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// Rules of `music.md`, Ingest: the editions, tracks and parts of every file the media has; a file that has no
/// part gets one, a file in `fresh` gets its technical facts again (and its tags with `force`). Every
/// `item_parts` write is under the versions lock.
async fn lay_out(st: &AppState, media: i32, fresh: &[i32], force: bool) -> Result<(), String> {
    let seps = separators_of(st).await;
    let mut tx = st.db.begin().await.map_err(|e| e.to_string())?;
    lock_versions(&mut tx, media)
        .await
        .map_err(|e| e.to_string())?;
    let rows: Vec<FileRow> = sqlx::query_as::<_, (i32, String, Option<Value>, bool)>(
        r#"SELECT f.id, f."relativePath", f."streamInfo",
                  EXISTS (SELECT 1 FROM item_parts p WHERE p."mediaFileId" = f.id)
           FROM media_files f WHERE f."mediaId" = $1 ORDER BY f.id"#,
    )
    .bind(media)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(id, rel, info, has_part)| FileRow {
        id,
        rel,
        info,
        has_part,
    })
    .collect();
    let mut todo: Vec<(&FileRow, TrackTags)> = rows
        .iter()
        .map(|r| {
            let info = r
                .info
                .clone()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_else(empty_info);
            (
                r,
                TrackTags::read(&info, &seps, stem(&r.rel)).with_folder_disc(&r.rel),
            )
        })
        .collect();
    todo.sort_by_key(|(r, t)| {
        (
            t.disc_number(),
            t.track.unwrap_or(i32::MAX),
            r.rel.to_lowercase(),
        )
    });
    let mut free: HashMap<i32, Vec<Free>> = HashMap::new();
    let mut next: HashMap<i32, i32> = HashMap::new();
    let mut editions = vec![];
    for (r, t) in &todo {
        if r.has_part {
            if fresh.contains(&r.id) {
                let item: Option<i32> = sqlx::query_scalar(
                    r#"SELECT "itemId" FROM item_parts WHERE "mediaFileId" = $1 ORDER BY version LIMIT 1"#,
                )
                .bind(r.id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                if let Some(item) = item {
                    if force {
                        write_details(&mut tx, item, t)
                            .await
                            .map_err(|e| e.to_string())?;
                        describe(&mut tx, item, t)
                            .await
                            .map_err(|e| e.to_string())?;
                    } else {
                        sqlx::query(
                            r#"UPDATE track_details SET "durationMs" = COALESCE($2, "durationMs"),
                                 gain = COALESCE($3, gain), peak = COALESCE($4, peak) WHERE "itemId" = $1"#,
                        )
                        .bind(item)
                        .bind(t.duration_ms)
                        .bind(t.gain.filter(|g| g.abs() <= 100.0).map(|g| g as f32))
                        .bind(t.peak.filter(|p| *p > 0.0 && *p <= 100.0).map(|p| p as f32))
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                    }
                }
            }
            continue;
        }
        let target = if t.release.is_none() {
            target_edition(&mut tx, media)
                .await
                .map_err(|e| e.to_string())?
        } else {
            None
        };
        if let Some(target) = target {
            load_free(&mut tx, target, &mut free, &mut next)
                .await
                .map_err(|e| e.to_string())?;
        }
        // A release-less file joins the target edition only where it pairs with one of its free tracks.
        let edition = match target.filter(|e| free[e].iter().any(|f| f.pairs(t))) {
            Some(e) => e,
            None => edition_for(&mut tx, st, media, t)
                .await
                .map_err(|e| e.to_string())?,
        };
        if !editions.contains(&edition) {
            editions.push(edition);
        }
        load_free(&mut tx, edition, &mut free, &mut next)
            .await
            .map_err(|e| e.to_string())?;
        let heirs = free.entry(edition).or_default();
        let heir = heirs.iter().position(|f| f.pairs(t));
        let item = match heir {
            Some(i) => heirs.remove(i).item,
            None => {
                let item: i32 = sqlx::query_scalar(
                    r#"INSERT INTO items ("mediaId", "editionId", monitored, title) VALUES ($1, $2, true, $3)
                       RETURNING id"#,
                )
                .bind(media)
                .bind(edition)
                .bind(&t.title)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                let position = next.entry(edition).or_default();
                *position += 1;
                sqlx::query(
                    r#"INSERT INTO track_details ("itemId", "mediaId", position) VALUES ($1, $2, $3)"#,
                )
                .bind(item)
                .bind(media)
                .bind(*position)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                item
            }
        };
        write_details(&mut tx, item, t)
            .await
            .map_err(|e| e.to_string())?;
        describe(&mut tx, item, t)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query(
            r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
               VALUES ($1, $2, $3, (SELECT COALESCE(max(version) + 1, 0) FROM item_parts WHERE "itemId" = $1), 0)"#,
        )
        .bind(item)
        .bind(r.id)
        .bind(media)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        crate::lyrics::store::rebind(&mut tx, item, r.id, t.duration_ms)
            .await
            .map_err(|e| e.to_string())?;
    }
    let all: Vec<TrackTags> = todo.iter().map(|(_, t)| t.clone()).collect();
    album_facts(&mut tx, media, &all, &editions)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())
}

/// What the tags give the album and its editions while no provider has spoken: the details row, the album
/// artists, the counts and the format of an edition.
async fn album_facts(
    c: &mut PgConnection,
    media: i32,
    tags: &[TrackTags],
    editions: &[i32],
) -> sqlx::Result<()> {
    let identified: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM media_external_ids WHERE "mediaId" = $1 AND kind = 'album' AND provider = 'musicbrainz')"#,
    )
    .bind(media)
    .fetch_one(&mut *c)
    .await?;
    sqlx::query(
        r#"INSERT INTO album_details ("mediaId") VALUES ($1) ON CONFLICT ("mediaId") DO NOTHING"#,
    )
    .bind(media)
    .execute(&mut *c)
    .await?;
    if !identified && !tags.is_empty() {
        let primary = tags.iter().find_map(|t| {
            let ty = t
                .release_type
                .as_deref()?
                .split(['/', ';', ','])
                .next()?
                .trim()
                .to_lowercase();
            provider::PRIMARY_TYPES.iter().find(|k| **k == ty).copied()
        });
        let tagged_line = tags
            .iter()
            .find(|t| !t.album_artists.is_empty())
            .map(|t| &t.album_artists);
        let mut firsts: Vec<String> = tags
            .iter()
            .filter_map(|t| Some(t.artists.first()?.name.to_lowercase()))
            .collect();
        firsts.sort();
        firsts.dedup();
        let compilation =
            tags.iter().any(|t| t.compilation) || (tagged_line.is_none() && firsts.len() > 1);
        let first = tags
            .iter()
            .filter_map(|t| provider::partial_date(t.original_date.as_deref()?))
            .min();
        sqlx::query(
            r#"UPDATE album_details SET "primaryType" = COALESCE($2, "primaryType"), "isCompilation" = $3,
                 "firstReleaseDate" = COALESCE($4, "firstReleaseDate") WHERE "mediaId" = $1"#,
        )
        .bind(media)
        .bind(primary)
        .bind(compilation)
        .bind(first)
        .execute(&mut *c)
        .await?;
        let line = tagged_line.or_else(|| {
            tags.iter()
                .find(|t| !t.artists.is_empty())
                .map(|t| &t.artists)
                .filter(|_| !compilation)
        });
        let mut artists: Vec<Credited> = line.into_iter().flatten().map(credited).collect();
        if compilation && artists.is_empty() {
            artists = vec![people::various_artists()];
        }
        people::replace_album_artists(c, media, &artists).await?;
    }
    for e in editions {
        sqlx::query(
            r#"UPDATE editions e SET
                 "trackCount" = COALESCE(e."trackCount", n.tracks), "discCount" = COALESCE(e."discCount", n.discs),
                 format = COALESCE(e.format, n.format)
               FROM (SELECT count(*)::int AS tracks, GREATEST(max(td."discNumber"), 1) AS discs,
                            (SELECT CASE WHEN count(DISTINCT f.quality) = 1 THEN min(f.quality) END
                               FROM item_parts p JOIN media_files f ON f.id = p."mediaFileId"
                               JOIN items x ON x.id = p."itemId" WHERE x."editionId" = $1) AS format
                       FROM items i JOIN track_details td ON td."itemId" = i.id WHERE i."editionId" = $1) n
               WHERE e.id = $1"#,
        )
        .bind(e)
        .execute(&mut *c)
        .await?;
    }
    Ok(())
}

/// A cover picture beside the tracks: `cover.*`, `folder.*`, `front.*` in the album folder (not the root).
pub async fn folder_cover(st: &AppState, media: i32) -> Option<Vec<u8>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        r#"SELECT lf.path, f."relativePath" FROM media_files f JOIN library_folders lf ON lf.id = f."folderId"
           WHERE f."mediaId" = $1 ORDER BY f.id"#,
    )
    .bind(media)
    .fetch_all(&st.db)
    .await
    .ok()?;
    let mut dirs: Vec<PathBuf> = vec![];
    for (root, rel) in rows {
        let Some(dir) = PathBuf::from(&root)
            .join(rel.replace('\\', "/"))
            .parent()
            .map(Path::to_path_buf)
        else {
            continue;
        };
        for d in [Some(dir.clone()), dir.parent().map(Path::to_path_buf)]
            .into_iter()
            .flatten()
        {
            if d.starts_with(&root) && d != Path::new(&root) && !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    }
    tokio::task::spawn_blocking(move || {
        for d in dirs {
            let names: Vec<String> = std::fs::read_dir(&d)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .collect();
            for base in ["cover", "folder", "front", "album"] {
                for ext in ["jpg", "jpeg", "png", "webp"] {
                    let want = format!("{base}.{ext}");
                    if let Some(n) = names.iter().find(|n| n.to_lowercase() == want)
                        && let Ok(bytes) = std::fs::read(d.join(n))
                        && bytes.len() <= 16 << 20
                    {
                        return Some(bytes);
                    }
                }
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

/// Settles an album once its post-import work is done: its file record merged, the cover (embedded first,
/// then the folder's), then its identification while it holds no id.
pub async fn settled(st: &AppState, media: i32) {
    if let Err(e) = crate::media::write::fields::merge_unmatched(st, media).await {
        tracing::warn!("Post-import[album #{media}]: file merge failed: {e}");
    }
    let has_poster: bool =
        sqlx::query_scalar(r#"SELECT "posterUrl" IS NOT NULL FROM media WHERE id = $1"#)
            .bind(media)
            .fetch_optional(&st.db)
            .await
            .ok()
            .flatten()
            .unwrap_or(true);
    if !has_poster && let Some(bytes) = folder_cover(st, media).await {
        super::books::store_cover(st, media, &bytes).await;
    }
    if let Err(e) = identify::identify_media(st, media).await {
        tracing::warn!(
            "Post-import[album #{media}]: identification failed: {}",
            e.text()
        );
    }
    crate::lyrics::providers::enqueue_missing(st, Some(media)).await;
    if tagwrite::enabled(st).await
        && let Err(e) = tagwrite::write_album_tags(st, media).await
    {
        tracing::warn!("Post-import[album #{media}]: tags not written: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn music_files_are_the_audio_a_library_of_albums_owns() {
        for n in ["a.flac", "A.WAV", "b.dsf", "c.m4a", "d.aif"] {
            assert!(is_music_file(n), "{n}");
        }
        for n in ["a.epub", "cover.jpg", "a.mkv", ".mp3", "a"] {
            assert!(!is_music_file(n), "{n}");
        }
        assert_eq!(format_of("x.FLAC").as_deref(), Some("flac"));
    }

    #[test]
    fn the_record_of_an_album_is_what_most_of_its_files_say() {
        let t = |album: &str, year: i32, genre: &str| TrackTags {
            album: Some(album.into()),
            year: Some(year),
            genres: vec![genre.into()],
            ..Default::default()
        };
        let r = album_record(&[
            t("Alpha", 1999, "Rock"),
            t("Alpha", 1999, "rock"),
            t("Other", 2001, "Pop"),
        ]);
        assert_eq!(r["title"], "Alpha");
        assert_eq!(r["year"], 1999);
        assert_eq!(r["genres"], json!(["Rock", "Pop"]));
        assert!(album_record(&[]).is_empty());
    }
}
