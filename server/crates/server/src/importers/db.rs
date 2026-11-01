//! Queries of the importers (`importers.md` SQL 1-7).
use crate::media::external_ids::{self, Ids};
use fliks_domain::{external_id::ExternalProvider, media::kind::MediaKind};
use serde_json::Value;
use sqlx::{PgPool, types::Json};

/// A media write that failed: the database, or an id another title of the kind already holds.
#[derive(Debug)]
pub enum WriteError {
    Db(sqlx::Error),
    Held(ExternalProvider),
}

impl From<sqlx::Error> for WriteError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e)
    }
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(e) => e.fmt(f),
            Self::Held(p) => write!(f, "the {p} id already belongs to another title"),
        }
    }
}

pub struct Library {
    pub id: i32,
    pub name: String,
    pub path: Option<String>,
    pub media_types: Vec<MediaKind>,
}

pub async fn libraries(db: &PgPool) -> sqlx::Result<Vec<Library>> {
    let rows = sqlx::query!(
        r#"SELECT id, name, path, "mediaTypes" AS "media_types: Json<Vec<String>>" FROM libraries ORDER BY id"#
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Library {
            id: r.id,
            name: r.name,
            path: r.path,
            media_types: r
                .media_types
                .0
                .iter()
                .filter_map(|t| MediaKind::parse(t))
                .collect(),
        })
        .collect())
}

pub struct Existing {
    pub id: i32,
    pub year: Option<i32>,
    pub monitored: bool,
    pub imdb_id: Option<String>,
    pub overview: Option<String>,
    pub quality_profile_id: Option<i32>,
}

pub async fn media_by_tmdb(
    db: &PgPool,
    tmdb_id: i32,
    media_type: MediaKind,
) -> sqlx::Result<Option<Existing>> {
    sqlx::query_as!(
        Existing,
        r#"SELECT m.id, m.year, m.monitored, ids.imdb AS imdb_id, m.overview,
                  m."qualityProfileId" AS quality_profile_id
           FROM media m
           LEFT JOIN LATERAL (SELECT max(value) FILTER (WHERE provider = $3)::int AS tmdb,
             max(value) FILTER (WHERE provider = $4)::int AS tvdb,
             max(value) FILTER (WHERE provider = $5) AS imdb
             FROM media_external_ids WHERE "mediaId" = m.id) ids ON true
           WHERE m.id = (SELECT "mediaId" FROM media_external_ids
             WHERE kind = $2 AND provider = $3 AND value = $1::int4::text)"#,
        tmdb_id,
        media_type.as_str(),
        external_ids::TMDB,
        external_ids::TVDB,
        external_ids::IMDB
    )
    .fetch_optional(db)
    .await
}

pub struct NewMedia<'a> {
    pub title: &'a str,
    pub tmdb_id: i32,
    pub year: Option<i32>,
    pub media_type: MediaKind,
    pub status: &'a str,
    pub monitored: bool,
    pub library_id: i32,
    pub folder_name: &'a str,
    pub imdb_id: Option<&'a str>,
    pub overview: Option<&'a str>,
    pub quality_profile_id: Option<i32>,
}

pub async fn insert_media(db: &PgPool, m: &NewMedia<'_>) -> Result<i32, WriteError> {
    let mut tx = db.begin().await?;
    let id = sqlx::query_scalar!(
        r#"INSERT INTO media (title, year, type, status, monitored, "libraryId", "folderName",
                              overview, "qualityProfileId")
           VALUES ($1, $2, $3, $4::text::media_status_enum, $5, $6, $7, $8, $9)
           RETURNING id"#,
        m.title,
        m.year,
        m.media_type.as_str(),
        m.status,
        m.monitored,
        m.library_id,
        m.folder_name,
        m.overview,
        m.quality_profile_id
    )
    .fetch_one(&mut *tx)
    .await?;
    let ids = Ids {
        tmdb: Some(m.tmdb_id),
        imdb: m.imdb_id.map(str::to_owned),
        ..Ids::default()
    };
    if let Some(p) = ids.fill(&mut tx, id, m.media_type).await?.taken.first() {
        return Err(WriteError::Held(*p));
    }
    tx.commit().await?;
    Ok(id)
}

pub struct MediaUpdate<'a> {
    pub id: i32,
    pub title: &'a str,
    pub year: Option<i32>,
    pub folder_name: &'a str,
    pub imdb_id: Option<&'a str>,
    pub overview: Option<&'a str>,
    pub quality_profile_id: Option<i32>,
    pub library_id: i32,
}

pub async fn update_media(
    db: &PgPool,
    kind: MediaKind,
    m: &MediaUpdate<'_>,
) -> Result<(), WriteError> {
    let mut tx = db.begin().await?;
    sqlx::query!(
        r#"UPDATE media SET title = $2, year = $3, "folderName" = $4,
                  overview = $5, "qualityProfileId" = $6, "libraryId" = $7, "updatedAt" = now()
           WHERE id = $1"#,
        m.id,
        m.title,
        m.year,
        m.folder_name,
        m.overview,
        m.quality_profile_id,
        m.library_id
    )
    .execute(&mut *tx)
    .await?;
    let ids = Ids {
        imdb: m.imdb_id.map(str::to_owned),
        ..Ids::default()
    };
    if let Some(p) = ids.fill(&mut tx, m.id, kind).await?.taken.first() {
        return Err(WriteError::Held(*p));
    }
    tx.commit().await?;
    Ok(())
}

/// Local profiles, id ascending (the last of a duplicate name wins).
pub async fn quality_profiles(db: &PgPool) -> sqlx::Result<Vec<(i32, String)>> {
    let rows = sqlx::query!("SELECT id, name FROM quality_profiles ORDER BY id")
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|r| (r.id, r.name)).collect())
}

pub async fn insert_quality_profile(
    db: &PgPool,
    name: &str,
    cutoff: i32,
    upgrade_allowed: bool,
    items: &Value,
) -> sqlx::Result<i32> {
    sqlx::query_scalar!(
        r#"INSERT INTO quality_profiles (name, cutoff, items, "upgradeAllowed")
           VALUES ($1, $2, $3, $4) RETURNING id"#,
        name,
        cutoff,
        items,
        upgrade_allowed
    )
    .fetch_one(db)
    .await
}

pub struct Series {
    pub id: i32,
    pub library_path: Option<String>,
    pub folder_name: Option<String>,
}

pub async fn series_by_tmdb(db: &PgPool, tmdb_id: i32) -> sqlx::Result<Option<Series>> {
    sqlx::query_as!(
        Series,
        r#"SELECT m.id, l.path AS library_path, m."folderName" AS folder_name
           FROM media m LEFT JOIN libraries l ON l.id = m."libraryId"
           WHERE m.id = (SELECT "mediaId" FROM media_external_ids
             WHERE kind = $2 AND provider = $3 AND value = $1::int4::text)"#,
        tmdb_id,
        MediaKind::Series.as_str(),
        external_ids::TMDB
    )
    .fetch_optional(db)
    .await
}

/// The highest-id file of a movie.
pub async fn latest_file(db: &PgPool, media_id: i32) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar!(
        r#"SELECT id FROM media_files WHERE "mediaId" = $1 ORDER BY id DESC LIMIT 1"#,
        media_id
    )
    .fetch_optional(db)
    .await
}

pub struct SeriesFile {
    pub id: i32,
    pub relative_path: String,
    pub episode_id: Option<i32>,
}

pub async fn series_files(db: &PgPool, media_id: i32) -> sqlx::Result<Vec<SeriesFile>> {
    sqlx::query_as!(
        SeriesFile,
        r#"SELECT id, "relativePath" AS relative_path, "episodeId" AS episode_id
           FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
        media_id
    )
    .fetch_all(db)
    .await
}
