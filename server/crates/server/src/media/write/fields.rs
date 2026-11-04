//! The one writer of the `media` columns every kind shares (`metadata-orchestrator.md` rule 41).
use super::map_status;
use crate::{
    ingest::record::file_records,
    media::{details::set_release_dates, field_sources},
    state::AppState,
};
use fliks_domain::{
    external_id::Namespace,
    media::{kind::MediaKind, release::ReleaseKind},
    metadata::merge::{FieldOrder, merge},
};
use serde_json::{Map, Value};
use sqlx::PgConnection;

/// The values of a merged record; a field the merge left out (locked or absent) stays `None`.
#[derive(Default)]
pub struct Fields {
    pub title: Option<String>,
    pub original_title: Option<String>,
    pub alternative_titles: Option<Value>,
    pub year: Option<i32>,
    pub overview: Option<String>,
    pub status: Option<String>,
    pub poster_url: Option<String>,
    pub fanart_url: Option<String>,
    pub logo_url: Option<String>,
    pub rating: Option<f64>,
    pub genres: Option<Value>,
    pub runtime: Option<i32>,
}

impl Fields {
    pub fn from_map(kind: MediaKind, m: &Map<String, Value>) -> Self {
        let text = |k: &str| {
            m.get(k)
                .and_then(Value::as_str)
                .filter(|t| !t.trim().is_empty())
                .map(str::to_owned)
        };
        let list = |k: &str| m.get(k).filter(|v| v.is_array()).cloned();
        let int = |k: &str| {
            m.get(k)
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
                .map(|n| n as i32)
        };
        Self {
            title: text("title"),
            original_title: text("originalTitle"),
            alternative_titles: list("alternativeTitles"),
            year: int("year").filter(|y| (1..=9999).contains(y)),
            overview: text("overview"),
            status: m
                .get("status")
                .and_then(Value::as_str)
                .map(|s| map_status(kind, s).to_owned()),
            poster_url: text("posterUrl"),
            fanart_url: text("fanartUrl"),
            logo_url: text("logoUrl"),
            rating: m
                .get("rating")
                .and_then(Value::as_f64)
                .filter(|r| r.is_finite()),
            genres: list("genres"),
            runtime: int("runtime"),
        }
    }
}

/// Writes the given fields of `media` and stamps `metadataRefreshedAt`; a `None` leaves its column.
pub async fn apply(c: &mut PgConnection, media: i32, f: &Fields) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE media SET title = COALESCE($2, title), "originalTitle" = COALESCE($3, "originalTitle"),
             "alternativeTitles" = COALESCE($4, "alternativeTitles"),
             year = COALESCE($5, year), overview = COALESCE($6, overview),
             status = COALESCE($7::text::media_status_enum, status), "posterUrl" = COALESCE($8, "posterUrl"),
             "fanartUrl" = COALESCE($9, "fanartUrl"), "logoUrl" = COALESCE($10, "logoUrl"),
             rating = COALESCE($11, rating), genres = COALESCE($12, genres), runtime = COALESCE($13, runtime),
             "metadataRefreshedAt" = now()
           WHERE id = $1"#,
        media,
        f.title,
        f.original_title,
        f.alternative_titles,
        f.year,
        f.overview,
        f.status,
        f.poster_url,
        f.fanart_url,
        f.logo_url,
        f.rating,
        f.genres,
        f.runtime
    )
    .execute(c)
    .await?;
    Ok(())
}

/// Merges the file records of a media that has no provider id and writes the result: the shared
/// columns, the kind's own, and the sources.
pub async fn merge_files(
    c: &mut PgConnection,
    media: i32,
    kind: MediaKind,
    records: &[Map<String, Value>],
) -> sqlx::Result<()> {
    let locked = field_sources::locked_fields(&mut *c, media).await?;
    let records: Vec<_> = records
        .iter()
        .map(|r| (Namespace::FILE, r.clone()))
        .collect();
    let (m, provenance) = merge(&records, &FieldOrder::new(kind, &[]), &locked);
    apply(c, media, &Fields::from_map(kind, &m)).await?;
    let date = m
        .get("releaseDate")
        .and_then(Value::as_str)
        .map(|d| d.chars().take(10).collect::<String>());
    if kind.is_video() {
        set_release_dates(c, media, &[(ReleaseKind::Release, date)], true).await?;
    }
    if kind == MediaKind::Comic {
        crate::metadata::comics::set_details(c, media, &m).await?;
    }
    field_sources::merge_field_sources(c, media, &provenance).await
}

/// Reads the files of a media that holds no provider id and merges them; no row is written
/// when it holds an id (the provider's refresh merges the files with its record) or has no files.
pub async fn merge_unmatched(st: &AppState, media: i32) -> sqlx::Result<bool> {
    let kind = sqlx::query_scalar!(r#"SELECT type FROM media WHERE id = $1"#, media)
        .fetch_optional(&st.db)
        .await?
        .and_then(|t| MediaKind::parse(&t));
    let Some(kind) =
        kind.filter(|k| matches!(k, MediaKind::Movie | MediaKind::Series | MediaKind::Comic))
    else {
        return Ok(false);
    };
    if crate::media::external_ids::any(&st.db, media).await? {
        return Ok(false);
    }
    let records = file_records(st, media).await;
    if records.is_empty() {
        return Ok(false);
    }
    let mut tx = st.db.begin().await?;
    merge_files(&mut tx, media, kind, &records).await?;
    tx.commit().await?;
    Ok(true)
}
