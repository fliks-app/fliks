//! Queries of the importers (`importers.md` SQL 1-7).
use fliks_domain::media::kind::MediaKind;
use serde_json::Value;
use sqlx::{PgPool, types::Json};

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
        r#"SELECT id, year, monitored, "imdbId" AS imdb_id, overview, "qualityProfileId" AS quality_profile_id
           FROM media WHERE "tmdbId" = $1 AND type = $2 LIMIT 1"#,
        tmdb_id,
        media_type.as_str()
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

pub async fn insert_media(db: &PgPool, m: &NewMedia<'_>) -> sqlx::Result<i32> {
    sqlx::query_scalar!(
        r#"INSERT INTO media (title, "tmdbId", year, type, status, monitored, "libraryId", "folderName",
                              "imdbId", overview, "qualityProfileId")
           VALUES ($1, $2, $3, $4, $5::text::media_status_enum, $6, $7, $8, $9, $10, $11)
           RETURNING id"#,
        m.title,
        m.tmdb_id,
        m.year,
        m.media_type.as_str(),
        m.status,
        m.monitored,
        m.library_id,
        m.folder_name,
        m.imdb_id,
        m.overview,
        m.quality_profile_id
    )
    .fetch_one(db)
    .await
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

pub async fn update_media(db: &PgPool, m: &MediaUpdate<'_>) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE media SET title = $2, year = $3, "folderName" = $4, "imdbId" = $5,
                  overview = $6, "qualityProfileId" = $7, "libraryId" = $8, "updatedAt" = now()
           WHERE id = $1"#,
        m.id,
        m.title,
        m.year,
        m.folder_name,
        m.imdb_id,
        m.overview,
        m.quality_profile_id,
        m.library_id
    )
    .execute(db)
    .await
    .map(drop)
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
           WHERE m."tmdbId" = $1 AND m.type = 'series' LIMIT 1"#,
        tmdb_id
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
