//! The audio item of a book as the host delivers it (`docs/spec/item-delivery.md` rules 1-6).
use super::file::{ResolvedFile, resolve_file};
use crate::{
    http::{AppError, auth::Authed},
    state::AppState,
};
use sqlx::PgPool;

/// An audio item opened for playback: its parts in order, on one timeline.
pub struct ResolvedItem {
    pub item: i32,
    pub version: i32,
    pub parts: Vec<ResolvedFile>,
    /// Start of each part on the item's timeline.
    pub offsets: Vec<f64>,
}

impl ResolvedItem {
    pub fn duration(&self) -> f64 {
        self.parts
            .iter()
            .map(|p| {
                p.info
                    .as_ref()
                    .and_then(|i| i.duration_seconds)
                    .unwrap_or(0.0)
            })
            .sum()
    }
}

fn missing(item: i64) -> AppError {
    AppError::not_found(format!("Item #{item} not found"))
}

/// Rules 1-6; every refusal that hides the item reads like a missing one.
pub async fn resolve(
    st: &AppState,
    a: &Authed,
    item: i64,
    version: Option<i32>,
) -> Result<ResolvedItem, AppError> {
    let id = i32::try_from(item).map_err(|_| missing(item))?;
    let acl = crate::libraries::accessible_library_ids(&st.db, a).await?;
    let row = sqlx::query!(
        r#"SELECT e.family
           FROM items i JOIN editions e ON e.id = i."editionId" JOIN media m ON m.id = i."mediaId"
           WHERE i.id = $1 AND m."libraryId" = ANY($2)
             AND COALESCE(e."libraryId", m."libraryId") = ANY($2)"#,
        id,
        &acl
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| missing(item))?;
    if row.family != "audio" {
        return Err(AppError::bad_request(format!(
            "Item #{item} is not an audio item"
        )));
    }
    let versions = sqlx::query_scalar!(
        r#"SELECT DISTINCT version AS "version!" FROM item_parts WHERE "itemId" = $1 ORDER BY 1"#,
        id
    )
    .fetch_all(&st.db)
    .await?;
    let saved = sqlx::query_scalar!(
        r#"SELECT version FROM playback_states WHERE "userId" = $1 AND "itemId" = $2"#,
        a.user.id,
        id
    )
    .fetch_optional(&st.db)
    .await?
    .flatten();
    let version = match version {
        Some(v) if versions.contains(&v) => v,
        Some(v) => {
            return Err(AppError::not_found(format!(
                "Item #{item} has no version {v}"
            )));
        }
        None => saved
            .filter(|v| versions.contains(v))
            .or_else(|| versions.last().copied())
            .ok_or_else(|| AppError::not_found(format!("Item #{item} has no file")))?,
    };
    let files = sqlx::query_scalar!(
        r#"SELECT "mediaFileId" FROM item_parts WHERE "itemId" = $1 AND version = $2 ORDER BY position"#,
        id,
        version
    )
    .fetch_all(&st.db)
    .await?;
    let mut parts = Vec::with_capacity(files.len());
    for f in files {
        parts.push(resolve_file(st, Some(a), i64::from(f)).await?);
    }
    let mut at = 0.0;
    let offsets = parts
        .iter()
        .map(|p| {
            let start = at;
            at += p
                .info
                .as_ref()
                .and_then(|i| i.duration_seconds)
                .unwrap_or(0.0);
            start
        })
        .collect();
    Ok(ResolvedItem {
        item: id,
        version,
        parts,
        offsets,
    })
}

/// A part of the audio item a file belongs to, as the resolver answers it.
pub struct PartRow {
    pub id: i32,
    pub duration: Option<f64>,
}

/// The parts of the lowest-numbered audio item playing `file`, in the version holding it; empty when
/// no audio item plays it (rule 11).
pub async fn audio_parts_of_file(db: &PgPool, file: i32) -> sqlx::Result<Vec<PartRow>> {
    sqlx::query_as!(
        PartRow,
        r#"WITH it AS (
             SELECT ip."itemId" AS item, ip.version FROM item_parts ip
             JOIN items i ON i.id = ip."itemId" JOIN editions e ON e.id = i."editionId"
             WHERE ip."mediaFileId" = $1 AND e.family = 'audio'
             ORDER BY ip."itemId" LIMIT 1)
           SELECT ip."mediaFileId" AS id, (f."streamInfo"->>'durationSeconds')::float8 AS duration
           FROM it JOIN item_parts ip ON ip."itemId" = it.item AND ip.version = it.version
           JOIN media_files f ON f.id = ip."mediaFileId"
           ORDER BY ip.position"#,
        file
    )
    .fetch_all(db)
    .await
}
