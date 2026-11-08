//! The `file` record of a group of files: one parser per format, one dispatcher on the kind
//! (`metadata-orchestrator.md` rule 39). Scan guesses and file ids are read back from it.
use super::{books, comics, fsx, library::file_name};
use crate::{importers::nfo, state::AppState};
use fliks_domain::{
    comics::{info, name},
    media::kind::MediaKind,
    nfo::NfoData,
    release::parsing::title::{ExtractedRelease, extract_media_title},
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

pub type Record = Map<String, Value>;

/// Where a group of files lives: `dir` is the folder of its series, `at_root` a title with no folder.
pub struct Group<'a> {
    pub kind: MediaKind,
    pub root: &'a Path,
    pub dir: &'a Path,
    pub sample: &'a Path,
    pub at_root: bool,
}

/// An id the files name, as the scan offers it for a pick.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileId {
    pub provider: &'static str,
    pub external_id: String,
}

/// The record of a group, `None` for a kind that reads no file.
pub async fn of_group(g: &Group<'_>) -> Option<Record> {
    match g.kind {
        MediaKind::Movie | MediaKind::Series => {
            let found = match g.kind {
                MediaKind::Series => nfo::for_show(g.dir, g.sample).await,
                _ if g.at_root => nfo::file(&g.sample.with_extension("nfo")).await,
                _ => nfo::for_video(g.sample).await,
            };
            Some(video(found.as_ref(), &guess_from_path(g.root, g.sample)))
        }
        MediaKind::Book => {
            let rel = fsx::rel_under(g.root, g.sample)?;
            let (family, _) = books::group::classify(&file_name(g.sample))?;
            Some(books::record_of(family, g.sample, &rel, None).await)
        }
        MediaKind::Comic => {
            let rel = fsx::rel_under(g.root, g.sample)?;
            let format = comics::format_of(&file_name(g.sample))?;
            let read = comics::read_info(g.sample, format).await;
            Some(comic(&name::parse_path(&rel), read.as_ref()))
        }
        MediaKind::Album => None,
    }
}

fn nonempty(t: Option<&str>) -> Option<String> {
    t.map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

fn video(nfo: Option<&NfoData>, ex: &ExtractedRelease) -> Record {
    let mut m = Record::new();
    let mut put = |k: &str, v: Option<Value>| {
        if let Some(v) = v {
            m.insert(k.into(), v);
        }
    };
    put(
        "title",
        nonempty(nfo.and_then(|n| n.title.as_deref()))
            .or(nonempty(Some(&ex.title)))
            .map(Value::from),
    );
    put(
        "year",
        nfo.and_then(|n| n.year)
            .or(ex.year.map(i64::from))
            .map(Value::from),
    );
    let Some(n) = nfo else { return m };
    put("originalTitle", n.original_title.clone().map(Value::from));
    put("overview", n.plot.clone().map(Value::from));
    put("genres", n.genres.clone().map(|g| json!(g)));
    put("runtime", n.runtime.map(Value::from));
    put("rating", n.rating.map(Value::from));
    put("releaseDate", n.premiered.clone().map(Value::from));
    put("tmdbId", n.tmdb_id.filter(|i| *i != 0).map(Value::from));
    put("tvdbId", n.tvdb_id.filter(|i| *i != 0).map(Value::from));
    put(
        "imdbId",
        n.imdb_id.clone().filter(|i| !i.is_empty()).map(Value::from),
    );
    m
}

fn comic(n: &name::ComicName, read: Option<&info::ComicInfo>) -> Record {
    let r = info::resolve(n, read);
    let mut m = Record::new();
    m.insert("title".into(), r.series.into());
    for (k, v) in [
        ("year", r.start_year.map(Value::from)),
        ("publisher", r.publisher.map(Value::from)),
        ("volume", r.volume_no.map(Value::from)),
        ("overview", r.summary.map(Value::from)),
    ] {
        if let Some(v) = v {
            m.insert(k.into(), v);
        }
    }
    m
}

/// The file name's title, unless it has no year and a folder between it and `root` has one
/// (`00000.m2ts` in `Title (2024)/`, a disc's `BDMV/STREAM`).
pub(crate) fn guess_from_path(root: &Path, file: &Path) -> ExtractedRelease {
    let ex = extract_media_title(&file_name(file));
    if ex.year.is_some() {
        return ex;
    }
    file.ancestors()
        .skip(1)
        .take_while(|d| d.starts_with(root) && *d != root)
        .map(|d| extract_media_title(&file_name(d)))
        .find(|f| f.year.is_some())
        .unwrap_or(ex)
}

/// A group's title and year, as its record gives them.
pub fn title_year(r: Option<&Record>) -> (Option<String>, Option<i64>) {
    let r = r.cloned().unwrap_or_default();
    (
        nonempty(r.get("title").and_then(Value::as_str)),
        r.get("year").and_then(Value::as_i64),
    )
}

/// The ids a record names: a video's nfo ids, a book's ISBN-13 and ASIN.
pub fn file_ids(r: &Record) -> Vec<FileId> {
    let id = |provider, v: Option<String>| {
        v.map(|external_id| FileId {
            provider,
            external_id,
        })
    };
    let number = |k: &str| r.get(k).and_then(Value::as_i64).map(|n| n.to_string());
    let text = |k: &str| r.get(k).and_then(Value::as_str).map(str::to_owned);
    [
        id("tmdb", number("tmdbId")),
        id("tvdb", number("tvdbId")),
        id("imdb", text("imdbId")),
        id(
            "isbn",
            r.get("isbn13")
                .and_then(|a| a.get(0))
                .and_then(Value::as_str)
                .map(str::to_owned),
        ),
        id("asin", text("asin")),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// The file records of a media's files: what its first file (a comic's lowest issue) says; none
/// when that file is unreachable.
pub async fn file_records(st: &AppState, media: i32) -> Vec<Record> {
    let row = sqlx::query!(
        r#"SELECT m.type AS "kind!", COALESCE(m."folderName", '') AS "folder!",
                  f."relativePath" AS rel, lf.path AS root
           FROM media m JOIN media_files f ON f."mediaId" = m.id
           JOIN library_folders lf ON lf.id = f."folderId"
           LEFT JOIN item_parts p ON p."mediaFileId" = f.id
           LEFT JOIN comic_issues ci ON ci."itemId" = p."itemId"
           WHERE m.id = $1
           ORDER BY ci."sortNumber" NULLS LAST, f.id LIMIT 1"#,
        media
    )
    .fetch_optional(&st.db)
    .await;
    let Ok(Some(r)) = row else { return vec![] };
    if r.kind == MediaKind::Album.as_str() {
        return super::music::records(st, media).await.into_iter().collect();
    }
    let (Some(kind), Some(rel)) = (MediaKind::parse(&r.kind), fsx::safe_rel(&r.rel)) else {
        return vec![];
    };
    let root = PathBuf::from(&r.root);
    let sample = root.join(rel);
    if !tokio::fs::try_exists(&sample).await.unwrap_or(false) {
        return vec![];
    }
    let dir = root.join(&r.folder);
    let group = Group {
        kind,
        root: &root,
        dir: &dir,
        sample: &sample,
        at_root: r.folder.is_empty(),
    };
    of_group(&group).await.into_iter().collect()
}
