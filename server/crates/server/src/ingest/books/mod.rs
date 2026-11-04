//! Book ingest (`docs/spec/book-ingest.md`): files, editions, items and parts of a book, and its
//! identification. Metadata is written by `metadata::books::link::attach`, never here.
pub mod archive;
pub mod group;
pub mod merge;
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
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
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
        MediaKind::Comic => super::comics::is_comic_file(name),
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

/// The folder a new file of `family` goes to: the media's want of that `language`, else its first
/// want of the family (any language first), else the library default.
pub async fn folder_for(
    db: &PgPool,
    media: i32,
    family: Family,
    language: Option<&str>,
) -> sqlx::Result<Option<Folder>> {
    let r = sqlx::query!(
        r#"SELECT COALESCE(wf.id, df."folderId") AS "id?", COALESCE(wf.path, df.path) AS "path?"
           FROM media m
           LEFT JOIN LATERAL (SELECT "folderId" FROM wants WHERE "mediaId" = m.id AND family = $2
                              ORDER BY (language IS NOT DISTINCT FROM $3) DESC, language NULLS FIRST, id LIMIT 1) w ON true
           LEFT JOIN library_folders wf ON wf.id = w."folderId" AND wf."libraryId" = m."libraryId"
           LEFT JOIN library_default_folders df ON df."libraryId" = m."libraryId"
           WHERE m.id = $1"#,
        media,
        family.as_str(),
        language
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

/// The files of the media's own work: the works of its linked files (one per language), else of the first book file of `new`.
fn own_paths(known: &[String], new: &[String]) -> HashSet<String> {
    let all: Vec<String> = known.iter().chain(new).cloned().collect();
    let works = group::group(&all);
    let files_of = |w: &group::Work| -> HashSet<String> {
        w.versions.iter().flat_map(|v| v.files.clone()).collect()
    };
    let first = new.iter().find(|p| classify(p).is_some());
    let linked: Vec<&group::Work> = works
        .iter()
        .filter(|w| files_of(w).iter().any(|p| known.contains(p)))
        .collect();
    if !linked.is_empty() {
        return linked.into_iter().flat_map(files_of).collect();
    }
    works
        .iter()
        .find(|w| first.is_some_and(|f| files_of(w).contains(f)))
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
    register_language(st, media, files, None).await
}

/// `register` with the new files joining the edition of `language` (rule 7); a request with a
/// language skips the anchored checks, its names are the host's own.
pub async fn register_language(
    st: &AppState,
    media: i32,
    files: &[Placed],
    language: Option<&str>,
) -> Result<Registration, String> {
    register_to(st, media, files, language, None).await
}

/// `register_language`, the new audio files joining the edition `into` when it is set.
pub async fn register_to(
    st: &AppState,
    media: i32,
    files: &[Placed],
    language: Option<&str>,
    into: Option<i32>,
) -> Result<Registration, String> {
    let mut out = vec![];
    let mut conflicts = vec![];
    let mut facts: Vec<(Family, String, Facts)> = vec![];
    let mut cover = None;
    let anchored = language.is_none()
        && into.is_none()
        && anchored(&st.db, media).await.map_err(|e| e.to_string())?;
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
        facts.extend(found.map(|x| (family, f.rel.replace('\\', "/"), x)));
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
    lay_out(&st.db, media, anchored, &facts, (language, into)).await?;
    if let Some(c) = cover {
        store_cover(st, media, &c).await;
    }
    for r in &out {
        st.ingest.queue.enqueue(st, r.file_id).await;
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
    lay_out(&st.db, media, anchored, &[], (None, None)).await
}

struct Known {
    id: i32,
    rel: String,
    info: Option<Value>,
}

/// Where a new file goes among the editions of its family: one of them (`stamp` = the language it
/// takes) or a new one with that language.
#[derive(Debug, PartialEq)]
enum Pick {
    Use(i32, Option<String>),
    New(Option<String>),
}

/// `editions` = (id, language, empty: no part, publisher or external id), by id. With a `language`:
/// its edition, else an empty one without language, else a new one. Without: the edition of `hint`
/// (the language the file says), else an empty one without language, else a new one when `hint` is
/// set and every edition has another language, else the first (no language first).
fn choose(
    editions: &[(i32, Option<String>, bool)],
    language: Option<&str>,
    hint: Option<&str>,
) -> Pick {
    let want = language.or(hint);
    let blank = || editions.iter().find(|e| e.1.is_none() && e.2);
    if let Some(w) = want
        && let Some(e) = editions.iter().find(|e| e.1.as_deref() == Some(w))
    {
        return Pick::Use(e.0, None);
    }
    if let (Some(w), Some(e)) = (want, blank()) {
        return Pick::Use(e.0, Some(w.to_owned()));
    }
    if language.is_some() || (hint.is_some() && editions.iter().all(|e| e.1.is_some())) {
        return Pick::New(want.map(str::to_owned));
    }
    match editions.iter().find(|e| e.1.is_none()).or(editions.first()) {
        Some(e) => Pick::Use(e.0, None),
        None => Pick::New(None),
    }
}

/// The edition of `family` a new file joins, and its ungrouped item (see [`choose`]).
async fn ensure(
    c: &mut PgConnection,
    media: i32,
    family: Family,
    (language, into): (Option<&str>, Option<i32>),
    hint: Option<&str>,
) -> sqlx::Result<(i32, i32)> {
    if let Some(e) = into.filter(|_| family == Family::Audio) {
        return Ok((e, item_of(c, media, e).await?));
    }
    let editions: Vec<(i32, Option<String>, bool)> = sqlx::query_as(
        r#"SELECT e.id, e.language,
             (e.publisher IS NULL
              AND NOT EXISTS (SELECT 1 FROM edition_external_ids x WHERE x."editionId" = e.id)
              AND NOT EXISTS (SELECT 1 FROM items i JOIN item_parts p ON p."itemId" = i.id
                               WHERE i."editionId" = e.id))
           FROM editions e WHERE e."mediaId" = $1 AND e.family = $2 ORDER BY e.id"#,
    )
    .bind(media)
    .bind(family.as_str())
    .fetch_all(&mut *c)
    .await?;
    let edition = match choose(&editions, language, hint) {
        Pick::Use(e, stamp) => {
            if stamp.is_some() {
                sqlx::query(r#"UPDATE editions SET language = $2 WHERE id = $1 AND language IS NULL"#)
                    .bind(e)
                    .bind(stamp)
                    .execute(&mut *c)
                    .await?;
            }
            e
        }
        Pick::New(l) => {
            sqlx::query_scalar(
                r#"INSERT INTO editions ("mediaId", family, language) VALUES ($1, $2, $3) RETURNING id"#,
            )
            .bind(media)
            .bind(family.as_str())
            .bind(l)
            .fetch_one(&mut *c)
            .await?
        }
    };
    Ok((edition, item_of(c, media, edition).await?))
}

/// The ungrouped item of an edition, created when it has none.
async fn item_of(c: &mut PgConnection, media: i32, edition: i32) -> sqlx::Result<i32> {
    Ok(match sqlx::query_scalar!(
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
    })
}

/// Rules 5-7: the editions, items and parts of every file the media has; an anchored media
/// (rule 10) holds one work, and its files making more are refused.
async fn lay_out(
    db: &PgPool,
    media: i32,
    anchored: bool,
    facts: &[(Family, String, Facts)],
    target: (Option<&str>, Option<i32>),
) -> Result<(), String> {
    let rows = sqlx::query_as!(
        Known,
        r#"SELECT id, "relativePath" AS rel, "streamInfo" AS info FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
        media
    )
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    lay_out_tx(db, media, anchored, &rows, facts, target)
        .await
        .map_err(|e| match e {
            LayError::Db(e) => e.to_string(),
            LayError::Works(m) => m,
        })
}

enum LayError {
    Db(sqlx::Error),
    Works(String),
}

impl From<sqlx::Error> for LayError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e)
    }
}

async fn lay_out_tx(
    db: &PgPool,
    media: i32,
    anchored: bool,
    rows: &[Known],
    facts: &[(Family, String, Facts)],
    (language, into): (Option<&str>, Option<i32>),
) -> Result<(), LayError> {
    let mut tx = db.begin().await?;
    crate::media::items::lock_versions(&mut tx, media).await?;
    let placed: HashMap<i32, i32> = sqlx::query_as::<_, (i32, i32)>(
        r#"SELECT p."mediaFileId", i."editionId" FROM item_parts p JOIN items i ON i.id = p."itemId"
            WHERE i."mediaId" = $1 ORDER BY i."editionId" DESC"#,
    )
    .bind(media)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();
    for family in [Family::Text, Family::Audio] {
        // Files stay in their edition and a version never spans two: the new files of the family
        // join the edition of `language` (or the one they say), and each edition is grouped alone.
        let mut by_edition: BTreeMap<i32, Vec<String>> = BTreeMap::new();
        let mut new = vec![];
        for r in rows {
            let path = r.rel.replace('\\', "/");
            if classify(path.rsplit('/').next().unwrap_or(&path)).map(|c| c.0) != Some(family) {
                continue;
            }
            match placed.get(&r.id) {
                Some(e) => by_edition.entry(*e).or_default().push(path),
                None => new.push(path),
            }
        }
        // Each new file joins the edition of its own language hint (tags or OPF, else its name).
        let fact = |p: &str| {
            facts
                .iter()
                .find(|(f, r, _)| *f == family && r == p)
                .map(|(_, _, f)| f)
        };
        let mut firsts: HashMap<i32, &Facts> = HashMap::new();
        let mut by_hint: BTreeMap<Option<String>, Vec<String>> = BTreeMap::new();
        let own = |p: &String| {
            fact(p)
                .and_then(|f| f.language.clone())
                .or_else(|| group::name_language(p))
        };
        let distinct: BTreeSet<String> = new.iter().filter_map(own).collect();
        if distinct.len() <= 1 {
            if !new.is_empty() {
                by_hint.insert(distinct.into_iter().next(), new);
            }
        } else {
            // Several languages: a version goes by the first language one of its files says.
            for v in group::group(&new).into_iter().flat_map(|w| w.versions) {
                let hint = v.files.iter().find_map(own);
                by_hint.entry(hint).or_default().extend(v.files);
            }
        }
        for (hint, paths) in by_hint {
            let (e, _) = ensure(&mut tx, media, family, (language, into), hint.as_deref()).await?;
            if let Some(f) = paths.iter().find_map(|p| fact(p)) {
                firsts.entry(e).or_insert(f);
            }
            by_edition.entry(e).or_default().extend(paths);
        }
        for (edition, paths) in by_edition {
            let mine: Vec<group::Version> = group::group(&paths)
                .into_iter()
                .flat_map(|w| w.versions)
                .filter(|v| v.family == family)
                .collect();
            if mine.is_empty() {
                continue;
            }
            if anchored && group::group(&paths).len() > 1 {
                return Err(LayError::Works(format!(
                    "media #{media}: its folder holds several works"
                )));
            }
            let item = item_of(&mut tx, media, edition).await?;
            let by_path = |p: &str| rows.iter().find(|r| r.rel.replace('\\', "/") == p);
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
                            by_path(p)
                                .and_then(|r| r.info.as_ref()?.get("durationSeconds")?.as_f64())
                        })
                        .sum::<Option<f64>>()
                })
                .flatten()
                .map(|d| d.round() as i32)
                .filter(|d| *d > 0);
            let first = firsts.get(&edition);
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
    }
    Ok(tx.commit().await?)
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
    /// The media the book lives in when it failed: an earlier edition may have merged it.
    pub media: i32,
    pub retry: bool,
    pub cause: String,
}

impl IdentifyError {
    fn of(media: i32, edition: i32, what: &str, e: MetaError) -> Self {
        match e {
            MetaError::Upstream(u) => Self {
                media,
                retry: u.is_outage(),
                cause: format!("{what} of edition #{edition}: {u}"),
            },
            MetaError::Db(e) => {
                Self::permanent(media, format!("{what} of edition #{edition}: {e}"))
            }
        }
    }

    fn permanent(media: i32, cause: String) -> Self {
        Self {
            media,
            retry: false,
            cause,
        }
    }
}

/// Rule 16: identifies the editions of a book that have no id yet and attaches the match.
/// Answers the media the book ends up in: a work that holds the id already absorbs it.
pub async fn identify_media(st: &AppState, media: i32) -> Result<i32, IdentifyError> {
    merge_editions(st, media, false, Priority::Background).await
}

/// The refresh of a book: every edition is merged again from its stored ids (or, with none, identified
/// as `identify_media` does) and its file record.
pub async fn refresh_media(
    st: &AppState,
    media: i32,
    prio: Priority,
) -> Result<i32, IdentifyError> {
    merge_editions(st, media, true, prio).await
}

async fn merge_editions(
    st: &AppState,
    media: i32,
    all: bool,
    prio: Priority,
) -> Result<i32, IdentifyError> {
    let mut media = media;
    let rows = sqlx::query!(
        r#"SELECT e.id, e.family,
             (SELECT p."mediaFileId" FROM item_parts p JOIN items i ON i.id = p."itemId"
               WHERE i."editionId" = e.id ORDER BY p."version", p.position LIMIT 1) AS file,
             (SELECT f."relativePath" FROM item_parts p JOIN items i ON i.id = p."itemId"
               JOIN media_files f ON f.id = p."mediaFileId"
               WHERE i."editionId" = e.id ORDER BY p."version", p.position LIMIT 1) AS rel
           FROM editions e WHERE e."mediaId" = $1
             AND ($2 OR NOT EXISTS (SELECT 1 FROM edition_external_ids x WHERE x."editionId" = e.id)
               OR NOT EXISTS (SELECT 1 FROM media_external_ids w
                               WHERE w."mediaId" = e."mediaId" AND w.provider = 'openlibrary'))
           ORDER BY e.id"#,
        media,
        all
    )
    .fetch_all(&st.db)
    .await
    .map_err(|e| IdentifyError::permanent(media, e.to_string()))?;
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
            .map_err(|e| IdentifyError::permanent(media, e.to_string()))?
        else {
            continue;
        };
        let (hints, record) = hints_of(c.family, &path, &rel, info.and_then(|i| i.tags)).await;
        let stored = if all {
            link::stored(&st.db, media, Some(c.edition))
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        let m = match stored {
            Some(m) => Some(m),
            None => {
                let found = match identify::identify(st, &hints, prio).await {
                    Ok(m) => m,
                    Err(e) => {
                        // An outage still leaves an unanchored book its file metadata.
                        let held = link::stored(&st.db, media, None).await.ok().flatten();
                        if let (None, Some(r)) = (held, record.as_ref()) {
                            let _ =
                                link::attach_with(st, media, Some(c.edition), None, Some(r), prio)
                                    .await;
                        }
                        return Err(IdentifyError::of(media, c.edition, "identify", e));
                    }
                };
                // A work the media already holds wins over the one the file suggests.
                let held = link::stored(&st.db, media, None).await.ok().flatten();
                match (found, held) {
                    (Some(f), Some(h)) if f.work == h.work => Some(f),
                    (_, Some(h)) => Some(identify::BookMatch {
                        edition: vec![],
                        ..h
                    }),
                    (Some(f), None) => Some(f),
                    (None, None) => None,
                }
            }
        };
        // Unmatched: the file record alone still gives the media its own title, authors, overview.
        if m.is_none() && record.is_none() {
            continue;
        }
        let attached = link::attach_with(
            st,
            media,
            Some(c.edition),
            m.as_ref(),
            record.as_ref(),
            prio,
        )
        .await;
        if let Ok(Some((owner, _))) = crate::media::editions::of(&st.db, c.edition).await {
            media = owner;
        }
        attached.map_err(|e| IdentifyError::of(media, c.edition, "attach", e))?;
    }
    Ok(media)
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

/// Boot sweep: books with files and no id nor merge yet get a settle, one at a time, which merges their file records.
/// A settle stamps `metadataRefreshedAt`, so each book leaves the sweep once it has been merged.
pub async fn backfill_unmatched(st: &AppState) {
    let ids = sqlx::query_scalar!(
        r#"SELECT m.id FROM media m
           WHERE m.type = 'book' AND m."metadataRefreshedAt" IS NULL
             AND NOT EXISTS (SELECT 1 FROM media_external_ids x WHERE x."mediaId" = m.id)
             AND EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id)
           ORDER BY m.id"#
    )
    .fetch_all(&st.db)
    .await
    .unwrap_or_default();
    let st = st.clone();
    tokio::spawn(async move {
        for id in ids {
            settled(&st, id).await;
        }
    });
}

/// Settles a book once its post-import work is done (`post_import::settled`).
pub async fn settled(st: &AppState, media: i32) {
    let media = match identify_media(st, media).await {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("Post-import[book #{media}]: {}", e.cause);
            if e.retry {
                st.ingest.settle.schedule(st, e.media);
            }
            e.media
        }
    };
    if let Err(e) = merge::settle(st, media).await {
        tracing::warn!("Post-import[book #{media}]: m4b merge: {e}");
    }
}

#[cfg(test)]
mod choose_tests {
    use super::*;

    #[test]
    fn a_file_joins_the_edition_of_its_language_or_makes_one() {
        let fr = (1, Some("fr".to_owned()), false);
        let blank = (2, None, true);
        let held = (3, None, false);
        let l = |s: &str| Some(s.to_owned());
        assert_eq!(choose(&[], None, None), Pick::New(None));
        assert_eq!(choose(&[], None, Some("fr")), Pick::New(l("fr")));
        assert_eq!(
            choose(std::slice::from_ref(&fr), None, Some("de")),
            Pick::New(l("de"))
        );
        assert_eq!(
            choose(std::slice::from_ref(&fr), None, Some("fr")),
            Pick::Use(1, None)
        );
        assert_eq!(
            choose(&[fr.clone(), blank.clone()], Some("de"), None),
            Pick::Use(2, l("de"))
        );
        assert_eq!(
            choose(&[fr.clone(), held.clone()], Some("de"), None),
            Pick::New(l("de"))
        );
        assert_eq!(
            choose(&[fr.clone(), held.clone()], None, Some("de")),
            Pick::Use(3, None)
        );
        assert_eq!(choose(&[fr, held], None, None), Pick::Use(3, None));
    }
}
