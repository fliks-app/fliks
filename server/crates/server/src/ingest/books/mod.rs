//! Book ingest (`docs/spec/book-ingest.md`): files, editions, items and parts of a book, and its
//! identification. Metadata is written by `metadata::books::link::attach`, never here.
pub mod archive;
pub mod group;
pub mod parts;
pub mod plan;
pub mod tags;

use super::{library::file_name, post_import::file_path, probe, rescan::PROBE_VERSION};
use crate::{
    books::koreader,
    images::paths::{Target, Variant},
    libraries::Folder,
    metadata::{
        MetaError,
        books::{identify, link},
    },
    state::AppState,
};
use fliks_domain::{
    language::normalize_language_code,
    media::{family::Family, kind::MediaKind},
    metadata::limiter::Priority,
};
use fliks_engine_core::api::MediaTags;
use serde_json::{Map, Value};
use sqlx::{PgConnection, PgPool};
use std::{
    collections::HashSet,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

pub use group::classify;

pub fn is_book_file(name: &str) -> bool {
    classify(name).is_some()
}

/// Whether `name` is a file a media of `kind` owns: a video for a movie or a series, a book file for a book.
pub fn owns(kind: MediaKind, name: &str) -> bool {
    match kind {
        MediaKind::Book => is_book_file(name),
        MediaKind::Movie | MediaKind::Series => super::is_video(name),
    }
}

/// A book file already on disk under one of the media's folders.
pub struct Placed {
    pub folder_id: i32,
    pub rel: String,
    pub abs: PathBuf,
}

pub struct Registered {
    pub file_id: i32,
    pub rel: String,
    pub family: Family,
    pub format: String,
}

/// What `register` did: the files it wrote, and one message per file it left alone.
#[derive(Default)]
pub struct Registration {
    pub files: Vec<Registered>,
    pub conflicts: Vec<String>,
}

/// The folder a new file of `family` goes to: the media's want of that family, else the library default.
pub async fn folder_for(db: &PgPool, media: i32, family: Family) -> sqlx::Result<Option<Folder>> {
    let r = sqlx::query!(
        r#"SELECT COALESCE(wf.id, df."folderId") AS "id?", COALESCE(wf.path, df.path) AS "path?"
           FROM media m
           LEFT JOIN wants w ON w."mediaId" = m.id AND w.family = $2 AND w.language IS NULL
           LEFT JOIN library_folders wf ON wf.id = w."folderId" AND wf."libraryId" = m."libraryId"
           LEFT JOIN library_default_folders df ON df."libraryId" = m."libraryId"
           WHERE m.id = $1"#,
        media,
        family.as_str()
    )
    .fetch_optional(db)
    .await?;
    Ok(r.and_then(|r| {
        Some(Folder {
            id: r.id?,
            path: r.path?,
        })
    }))
}

/// Every folder a book media may hold files in: its wants' folders and the target.
pub async fn want_folders(db: &PgPool, media: i32) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar!(
        r#"SELECT w."folderId" AS "id!" FROM wants w JOIN media m ON m.id = w."mediaId"
           JOIN library_folders f ON f.id = w."folderId" AND f."libraryId" = m."libraryId"
           WHERE w."mediaId" = $1"#,
        media
    )
    .fetch_all(db)
    .await
}

/// The KOReader partial MD5 of a file; `None` when it cannot be read.
fn hash_file(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    koreader::partial_md5(|offset, len| {
        f.seek(SeekFrom::Start(offset))?;
        let mut buf = vec![0u8; len];
        let mut n = 0;
        while n < len {
            match f.read(&mut buf[n..])? {
                0 => break,
                k => n += k,
            }
        }
        buf.truncate(n);
        Ok::<_, std::io::Error>(buf)
    })
    .ok()
}

async fn store_hash(db: &PgPool, file: i32, abs: &Path) {
    let p = abs.to_path_buf();
    let hash = tokio::task::spawn_blocking(move || hash_file(&p))
        .await
        .ok()
        .flatten();
    let Some(hash) = hash else {
        tracing::warn!("KOReader hash of file #{file} skipped: unreadable");
        return;
    };
    if let Err(e) = sqlx::query!(
        r#"INSERT INTO media_file_hashes ("mediaFileId", kind, hash) VALUES ($1, 'koreader', $2)
           ON CONFLICT ("mediaFileId", kind) DO UPDATE SET hash = EXCLUDED.hash
           WHERE media_file_hashes.hash IS DISTINCT FROM EXCLUDED.hash"#,
        file,
        hash
    )
    .execute(db)
    .await
    {
        tracing::warn!("KOReader hash of file #{file}: {e}");
    }
}

/// The picture becomes the work's poster when it has none.
pub async fn store_cover(st: &AppState, media: i32, bytes: &[u8]) {
    let _one = st.ingest.covers.lock(media).await;
    let has = sqlx::query_scalar!(
        r#"SELECT "posterUrl" IS NOT NULL AS "has!" FROM media WHERE id = $1"#,
        media
    )
    .fetch_optional(&st.db)
    .await
    .ok()
    .flatten()
    .unwrap_or(true);
    if has {
        return;
    }
    let url = st
        .images
        .store_bytes(bytes.to_vec(), &Target::media(media, Variant::Poster))
        .await;
    if let Some(url) = url
        && let Err(e) = sqlx::query!(
            r#"UPDATE media SET "posterUrl" = $2 WHERE id = $1 AND "posterUrl" IS NULL"#,
            media,
            url
        )
        .execute(&st.db)
        .await
    {
        tracing::warn!("cover of book #{media}: {e}");
    }
}

struct Facts {
    language: Option<String>,
    publisher: Option<String>,
}

fn tag_facts(t: Option<&MediaTags>) -> Facts {
    Facts {
        language: t
            .and_then(|t| t.language.as_deref())
            .map(|l| normalize_language_code(Some(l)))
            .filter(|l| l != "und"),
        publisher: t.and_then(|t| t.publisher.clone()),
    }
}

async fn anchored(db: &PgPool, media: i32) -> sqlx::Result<bool> {
    sqlx::query_scalar!(
        r#"SELECT COALESCE("folderName", '') <> '' AS "a!" FROM media WHERE id = $1"#,
        media
    )
    .fetch_one(db)
    .await
}

async fn known_paths(db: &PgPool, media: i32) -> sqlx::Result<Vec<String>> {
    Ok(sqlx::query_scalar!(
        r#"SELECT "relativePath" FROM media_files WHERE "mediaId" = $1"#,
        media
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|r| r.replace('\\', "/"))
    .collect())
}

/// The files of the media's own work: the one of its linked files, else of the first book file of `new`.
fn own_paths(known: &[String], new: &[String]) -> HashSet<String> {
    let all: Vec<String> = known.iter().chain(new).cloned().collect();
    let works = group::group(&all);
    let files_of = |w: &group::Work| -> HashSet<String> {
        w.versions.iter().flat_map(|v| v.files.clone()).collect()
    };
    let first = new.iter().find(|p| classify(p).is_some());
    works
        .iter()
        .find(|w| files_of(w).iter().any(|p| known.contains(p)))
        .or_else(|| {
            works
                .iter()
                .find(|w| first.is_some_and(|f| files_of(w).contains(f)))
        })
        .map(files_of)
        .unwrap_or_default()
}

/// Whether `rel` is a file of the work an anchored media owns, counting `pending` (the files a
/// transfer already placed); always true for a media with no folder name.
pub async fn is_own_work(
    db: &PgPool,
    media: i32,
    pending: &[String],
    rel: &str,
) -> sqlx::Result<bool> {
    if !anchored(db, media).await? {
        return Ok(true);
    }
    let mut new: Vec<String> = pending.iter().map(|p| p.replace('\\', "/")).collect();
    let rel = rel.replace('\\', "/");
    new.push(rel.clone());
    Ok(own_paths(&known_paths(db, media).await?, &new).contains(&rel))
}

/// The files of an anchored media that belong to its own work; the others go to `conflicts`.
async fn own_work<'a>(
    db: &PgPool,
    media: i32,
    files: &'a [Placed],
    conflicts: &mut Vec<String>,
) -> sqlx::Result<Vec<&'a Placed>> {
    let new: Vec<String> = files.iter().map(|f| f.rel.replace('\\', "/")).collect();
    let mine = own_paths(&known_paths(db, media).await?, &new);
    let mut out = vec![];
    for (f, rel) in files.iter().zip(&new) {
        let name = file_name(&f.abs);
        if classify(&name).is_none() || mine.contains(rel) {
            out.push(f);
        } else {
            conflicts.push(format!("{name}: belongs to another work of the folder"));
        }
    }
    Ok(out)
}

/// Inserts or updates the rows of `files`, then lays out every file of the media (rule 6).
pub async fn register(st: &AppState, media: i32, files: &[Placed]) -> Result<Registration, String> {
    let mut out = vec![];
    let mut conflicts = vec![];
    let mut facts: Vec<(Family, Facts)> = vec![];
    let mut cover = None;
    let anchored = anchored(&st.db, media).await.map_err(|e| e.to_string())?;
    let files: Vec<&Placed> = if anchored {
        own_work(&st.db, media, files, &mut conflicts)
            .await
            .map_err(|e| e.to_string())?
    } else {
        files.iter().collect()
    };
    for f in files {
        let name = file_name(&f.abs);
        let Some((family, format)) = classify(&name) else {
            continue;
        };
        let meta = tokio::fs::metadata(&f.abs)
            .await
            .map_err(|e| format!("{name}: {e}"))?;
        let mtime = super::rescan::mtime_ms(&meta);
        let mut found = None;
        let mut found_cover = None;
        let (info, version) = if family == Family::Audio {
            let p = probe(st, &f.abs, false).await?;
            found = Some(tag_facts(p.info.tags.as_ref()));
            (
                Some(serde_json::to_value(&p.info).map_err(|e| e.to_string())?),
                Some(PROBE_VERSION),
            )
        } else {
            if format == "epub" {
                let p = f.abs.clone();
                if let Some(e) = tokio::task::spawn_blocking(move || archive::read_epub(&p))
                    .await
                    .map_err(|e| e.to_string())?
                {
                    found = Some(Facts {
                        language: e
                            .meta
                            .language
                            .as_deref()
                            .map(|l| normalize_language_code(Some(l)))
                            .filter(|l| l != "und"),
                        publisher: e.meta.publisher.clone(),
                    });
                    found_cover = e.cover;
                }
            }
            (None::<Value>, None)
        };
        let Some(id) = sqlx::query_scalar!(
            r#"INSERT INTO media_files ("mediaId", "folderId", "relativePath", size, quality, "streamInfo",
                 "mtimeMs", "probeVersion")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT ("folderId", "relativePath") DO UPDATE
               SET size = EXCLUDED.size, quality = EXCLUDED.quality, "streamInfo" = EXCLUDED."streamInfo",
                   "mtimeMs" = EXCLUDED."mtimeMs", "probeVersion" = EXCLUDED."probeVersion"
               WHERE media_files."mediaId" = EXCLUDED."mediaId"
               RETURNING id"#,
            media,
            f.folder_id,
            f.rel,
            meta.len() as i64,
            format,
            info,
            mtime,
            version
        )
        .fetch_optional(&st.db)
        .await
        .map_err(|e| e.to_string())?
        else {
            conflicts.push(format!("{name}: file already linked to another media"));
            continue;
        };
        facts.extend(found.map(|f| (family, f)));
        cover = cover.or(found_cover);
        if family == Family::Text {
            store_hash(&st.db, id, &f.abs).await;
        }
        out.push(Registered {
            file_id: id,
            rel: f.rel.clone(),
            family,
            format,
        });
    }
    if out.is_empty() {
        return Ok(Registration {
            files: out,
            conflicts,
        });
    }
    lay_out(&st.db, media, anchored, &facts).await?;
    if let Some(c) = cover {
        store_cover(st, media, &c).await;
    }
    for r in &out {
        st.ingest.queue.enqueue(st, r.file_id);
    }
    st.ingest.settle.schedule(st, media);
    Ok(Registration {
        files: out,
        conflicts,
    })
}

/// Lays out the files the media has again, after a rescan removed some.
pub async fn relay(st: &AppState, media: i32) -> Result<(), String> {
    let anchored = anchored(&st.db, media).await.map_err(|e| e.to_string())?;
    lay_out(&st.db, media, anchored, &[]).await
}

struct Known {
    id: i32,
    rel: String,
    info: Option<Value>,
}

/// One edition and its ungrouped item per family; `None` family files are ignored.
async fn ensure(c: &mut PgConnection, media: i32, family: Family) -> sqlx::Result<(i32, i32)> {
    let edition = match sqlx::query_scalar!(
        r#"SELECT id FROM editions WHERE "mediaId" = $1 AND family = $2 ORDER BY id LIMIT 1"#,
        media,
        family.as_str()
    )
    .fetch_optional(&mut *c)
    .await?
    {
        Some(e) => e,
        None => {
            sqlx::query_scalar!(
                r#"INSERT INTO editions ("mediaId", family) VALUES ($1, $2) RETURNING id"#,
                media,
                family.as_str()
            )
            .fetch_one(&mut *c)
            .await?
        }
    };
    let item = match sqlx::query_scalar!(
        r#"SELECT id FROM items WHERE "mediaId" = $1 AND "editionId" = $2 AND "groupId" IS NULL
           ORDER BY id LIMIT 1"#,
        media,
        edition
    )
    .fetch_optional(&mut *c)
    .await?
    {
        Some(i) => i,
        None => {
            sqlx::query_scalar!(
                r#"INSERT INTO items ("mediaId", "editionId", monitored) VALUES ($1, $2, true) RETURNING id"#,
                media,
                edition
            )
            .fetch_one(&mut *c)
            .await?
        }
    };
    Ok((edition, item))
}

/// Rules 5-7: the editions, items and parts of every file the media has; an anchored media
/// (rule 10) holds one work, and its files making more are refused.
async fn lay_out(
    db: &PgPool,
    media: i32,
    anchored: bool,
    facts: &[(Family, Facts)],
) -> Result<(), String> {
    let rows = sqlx::query_as!(
        Known,
        r#"SELECT id, "relativePath" AS rel, "streamInfo" AS info FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
        media
    )
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    let paths: Vec<String> = rows.iter().map(|r| r.rel.replace('\\', "/")).collect();
    let works = group::group(&paths);
    if anchored && works.len() > 1 {
        return Err(format!("media #{media}: its folder holds several works"));
    }
    let versions: Vec<group::Version> = works.into_iter().flat_map(|w| w.versions).collect();
    lay_out_tx(db, media, &rows, &versions, facts)
        .await
        .map_err(|e| e.to_string())
}

async fn lay_out_tx(
    db: &PgPool,
    media: i32,
    rows: &[Known],
    versions: &[group::Version],
    facts: &[(Family, Facts)],
) -> sqlx::Result<()> {
    let by_path = |p: &str| rows.iter().find(|r| r.rel.replace('\\', "/") == p);
    let mut tx = db.begin().await?;
    crate::media::items::lock_versions(&mut tx, media).await?;
    for family in [Family::Text, Family::Audio] {
        let mine: Vec<&group::Version> = versions.iter().filter(|v| v.family == family).collect();
        if mine.is_empty() {
            continue;
        }
        let (edition, item) = ensure(&mut tx, media, family).await?;
        let ids: Vec<Vec<i32>> = mine
            .iter()
            .map(|v| {
                v.files
                    .iter()
                    .filter_map(|p| by_path(p).map(|r| r.id))
                    .collect()
            })
            .collect();
        parts::write_versions(&mut tx, media, item, &ids).await?;
        let format =
            (mine.iter().all(|v| v.format == mine[0].format)).then(|| mine[0].format.clone());
        let duration = (family == Family::Audio)
            .then(|| {
                mine[0]
                    .files
                    .iter()
                    .map(|p| {
                        by_path(p).and_then(|r| r.info.as_ref()?.get("durationSeconds")?.as_f64())
                    })
                    .sum::<Option<f64>>()
            })
            .flatten()
            .map(|d| d.round() as i32)
            .filter(|d| *d > 0);
        let first = facts.iter().find(|(f, _)| *f == family).map(|(_, f)| f);
        sqlx::query!(
            r#"UPDATE editions SET format = COALESCE(format, $2), "durationSeconds" = COALESCE("durationSeconds", $3),
                 language = COALESCE(language, $4), publisher = COALESCE(publisher, $5)
               WHERE id = $1"#,
            edition,
            format,
            duration,
            first.and_then(|f| f.language.clone()),
            first.and_then(|f| f.publisher.clone())
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// A row of the media as the rescan knows it.
pub struct KnownFile {
    pub id: i32,
    pub rel: String,
    pub size: i64,
    pub mtime_ms: Option<i64>,
    pub probe_version: Option<i32>,
}

/// Probes again or hashes again the files whose size or mtime changed; the number updated.
pub async fn refresh(st: &AppState, base: &Path, rows: &[&KnownFile]) -> Result<i64, String> {
    let mut updated = 0;
    for r in rows {
        let abs = base.join(r.rel.replace('\\', "/"));
        let Ok(meta) = tokio::fs::metadata(&abs).await else {
            continue;
        };
        let Some((family, _)) = classify(&file_name(&abs)) else {
            continue;
        };
        let mtime = super::rescan::mtime_ms(&meta);
        let audio = family == Family::Audio;
        let same = r.size == meta.len() as i64
            && mtime.is_some()
            && r.mtime_ms == mtime
            && (!audio || r.probe_version == Some(PROBE_VERSION));
        if same {
            continue;
        }
        let info = if audio {
            let p = probe(st, &abs, false).await?;
            Some(serde_json::to_value(&p.info).map_err(|e| e.to_string())?)
        } else {
            None
        };
        sqlx::query!(
            r#"UPDATE media_files SET size = $2, "streamInfo" = $3, "mtimeMs" = $4, "probeVersion" = $5 WHERE id = $1"#,
            r.id,
            meta.len() as i64,
            info,
            mtime,
            audio.then_some(PROBE_VERSION)
        )
        .execute(&st.db)
        .await
        .map_err(|e| e.to_string())?;
        if !audio {
            store_hash(&st.db, r.id, &abs).await;
        }
        updated += 1;
    }
    Ok(updated)
}

struct Candidate {
    edition: i32,
    family: Family,
    file: Option<i32>,
    rel: Option<String>,
}

/// Why `identify_media` failed; `retry` is set when a later call can succeed (provider outage).
pub struct IdentifyError {
    pub retry: bool,
    pub cause: String,
}

impl IdentifyError {
    fn of(edition: i32, what: &str, e: MetaError) -> Self {
        match e {
            MetaError::Upstream(u) => Self {
                retry: u.is_outage(),
                cause: format!("{what} of edition #{edition}: {u}"),
            },
            MetaError::Db(e) => Self::permanent(format!("{what} of edition #{edition}: {e}")),
        }
    }

    fn permanent(cause: String) -> Self {
        Self {
            retry: false,
            cause,
        }
    }
}

/// Rule 16: identifies the editions of a book that have no id yet and attaches the match.
pub async fn identify_media(st: &AppState, media: i32) -> Result<(), IdentifyError> {
    let rows = sqlx::query!(
        r#"SELECT e.id, e.family,
             (SELECT p."mediaFileId" FROM item_parts p JOIN items i ON i.id = p."itemId"
               WHERE i."editionId" = e.id ORDER BY p."version", p.position LIMIT 1) AS file,
             (SELECT f."relativePath" FROM item_parts p JOIN items i ON i.id = p."itemId"
               JOIN media_files f ON f.id = p."mediaFileId"
               WHERE i."editionId" = e.id ORDER BY p."version", p.position LIMIT 1) AS rel
           FROM editions e WHERE e."mediaId" = $1
             AND NOT EXISTS (SELECT 1 FROM edition_external_ids x WHERE x."editionId" = e.id)
           ORDER BY e.id"#,
        media
    )
    .fetch_all(&st.db)
    .await
    .map_err(|e| IdentifyError::permanent(e.to_string()))?;
    let candidates = rows.into_iter().filter_map(|r| {
        Some(Candidate {
            edition: r.id,
            family: Family::parse(&r.family)?,
            file: r.file,
            rel: r.rel,
        })
    });
    for c in candidates {
        let (Some(file), Some(rel)) = (c.file, c.rel) else {
            continue;
        };
        let Some((path, info)) = file_path(st, file)
            .await
            .map_err(|e| IdentifyError::permanent(e.to_string()))?
        else {
            continue;
        };
        let (hints, record) = hints_of(c.family, &path, &rel, info.and_then(|i| i.tags)).await;
        let found = match identify::identify(st, &hints, Priority::Background).await {
            Ok(m) => m,
            Err(e) => return Err(IdentifyError::of(c.edition, "identify", e)),
        };
        let m = match found {
            Some(m) => m,
            None => match link::stored(&st.db, media, None).await {
                Ok(Some(s)) => identify::BookMatch {
                    edition: vec![],
                    ..s
                },
                _ => continue,
            },
        };
        link::attach_with(
            st,
            media,
            Some(c.edition),
            &m,
            record.as_ref(),
            Priority::Background,
        )
        .await
        .map_err(|e| IdentifyError::of(c.edition, "attach", e))?;
    }
    Ok(())
}

async fn hints_of(
    family: Family,
    path: &Path,
    rel: &str,
    tags: Option<MediaTags>,
) -> (identify::BookHints, Option<Map<String, Value>>) {
    if family == Family::Audio {
        let h = tags::audio_hints(tags.as_ref(), rel);
        let record = tags.as_ref().map(|t| tags::audio_record(t, &h, None));
        return (h, record);
    }
    let p = path.to_path_buf();
    let epub = tokio::task::spawn_blocking(move || archive::read_epub(&p))
        .await
        .ok()
        .flatten();
    match epub {
        Some(e) => {
            let h = tags::epub_hints(&e.meta, rel);
            let record = tags::epub_record(&e.meta, &h, "epub");
            (h, Some(record))
        }
        None => (tags::name_hints(family, rel), None),
    }
}

/// Settles a book once its post-import work is done (`post_import::settled`).
pub async fn settled(st: &AppState, media: i32) {
    if let Err(e) = identify_media(st, media).await {
        tracing::warn!("Post-import[book #{media}]: {}", e.cause);
        if e.retry {
            st.ingest.settle.schedule(st, media);
        }
    }
}
