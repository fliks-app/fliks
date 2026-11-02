//! Folder routes and the checks every folder write shares (`libraries.md` rules 48-54).
use super::{
    db::{self, FolderOut, FolderRow, not_found},
    path::{ensure_dir, normalize, sanitize},
    routes::{body, id_of},
};
use crate::{
    http::{AppError, auth::Authed, validate::PathParams},
    ingest::fsx,
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use fliks_domain::acl::{Action, Subject};
use serde::Deserialize;
use sqlx::{PgConnection, PgPool};
use std::{
    collections::HashMap,
    path::{Component, Path},
};

const RESERVED: &str = "errors.folder_reserved";
const OVERLAP: &str = "errors.folder_overlap";
const IN_USE: &str = "errors.folder_in_use";
const MISMATCH: &str = "errors.folder_relocation_mismatch";
const NOT_IN_LIBRARY: &str = "errors.folder_not_in_library";

/// The last segment of a folder path, the whole path for a drive root (rule 49).
pub fn name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned())
}

/// Serialises folder writes: the overlap check cannot be a constraint (rule 50).
pub async fn lock(c: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('library_folders'))")
        .execute(c)
        .await
        .map(drop)
}

/// The filesystem root, or a path overlapping the data or cache directory (rule 50.1).
pub fn reserved(path: &str) -> bool {
    let p = Path::new(path);
    p.components().all(|c| matches!(c, Component::RootDir))
        || [crate::paths::data_dir(), crate::paths::cache_dir()]
            .into_iter()
            .any(|d| fsx::dirs_overlap(p, d))
}

/// A folder of another library, or any but `except_folder`, that overlaps `path` (rule 50.2).
pub async fn overlapping(
    c: &mut PgConnection,
    path: &str,
    except_folder: Option<i32>,
    except_library: Option<i32>,
) -> sqlx::Result<Option<(i32, String)>> {
    let rows = sqlx::query!(
        r#"SELECT "libraryId" AS library_id, path FROM library_folders
        WHERE ($1::int IS NULL OR id <> $1) AND ($2::int IS NULL OR "libraryId" <> $2)"#,
        except_folder,
        except_library
    )
    .fetch_all(c)
    .await?;
    Ok(rows
        .into_iter()
        .find(|r| fsx::dirs_overlap(Path::new(&r.path), Path::new(path)))
        .map(|r| (r.library_id, r.path)))
}

/// Rule 50 up to the overlap check: the normalised path, or the reason it is refused.
async fn checked(
    c: &mut PgConnection,
    raw: &str,
    except_folder: Option<i32>,
) -> Result<String, AppError> {
    let clean = sanitize(raw);
    if clean.is_empty() {
        return Err(AppError::bad_request(vec!["path should not be empty"]));
    }
    if !Path::new(&clean).is_absolute() {
        return Err(AppError::bad_request(vec!["path must be an absolute path"]));
    }
    let path = normalize(&clean);
    if reserved(&path) {
        return Err(AppError::bad_request(RESERVED));
    }
    if let Some((library, other)) = overlapping(c, &path, except_folder, None).await? {
        tracing::warn!("Folder \"{path}\" overlaps \"{other}\" of library #{library}");
        return Err(AppError::conflict(OVERLAP));
    }
    Ok(path)
}

fn lost_race(e: sqlx::Error) -> AppError {
    if e.as_database_error().and_then(|d| d.code()).as_deref() == Some("23505") {
        AppError::conflict(OVERLAP)
    } else {
        e.into()
    }
}

/// A folder id that is not one of the library's is 400 (rule 54).
pub async fn assert_in_library(
    db: impl sqlx::PgExecutor<'_>,
    library_id: i32,
    folder_id: i32,
) -> Result<(), AppError> {
    let ok = sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM library_folders WHERE id = $1 AND "libraryId" = $2) AS "ok!""#,
        folder_id,
        library_id
    )
    .fetch_one(db)
    .await?;
    if ok {
        Ok(())
    } else {
        Err(AppError::bad_request(NOT_IN_LIBRARY))
    }
}

async fn library_exists(c: &mut PgConnection, id: i32) -> Result<(), AppError> {
    let ok = sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM libraries WHERE id = $1) AS "e!""#,
        id
    )
    .fetch_one(c)
    .await?;
    if ok { Ok(()) } else { Err(not_found(id)) }
}

fn folder_not_found(id: i32) -> AppError {
    AppError::not_found(format!("Folder #{id} not found"))
}

async fn folder_of(c: &mut PgConnection, library: i32, id: i32) -> Result<FolderRow, AppError> {
    sqlx::query_as!(
        FolderRow,
        r#"SELECT id, path, position FROM library_folders WHERE id = $1 AND "libraryId" = $2"#,
        id,
        library
    )
    .fetch_optional(c)
    .await?
    .ok_or_else(|| folder_not_found(id))
}

async fn touch(c: &mut PgConnection, library: i32) -> Result<(), AppError> {
    sqlx::query!(
        r#"UPDATE libraries SET "updatedAt" = now() WHERE id = $1"#,
        library
    )
    .execute(c)
    .await?;
    Ok(())
}

/// Positions `0..n-1` in the order of `ids`.
async fn renumber(c: &mut PgConnection, ids: &[i32]) -> Result<(), AppError> {
    sqlx::query!(
        r#"UPDATE library_folders SET position = (n.pos - 1)::int
        FROM unnest($1::int[]) WITH ORDINALITY AS n(id, pos)
        WHERE library_folders.id = n.id AND library_folders.position <> (n.pos - 1)::int"#,
        ids
    )
    .execute(c)
    .await?;
    Ok(())
}

async fn ordered_ids(c: &mut PgConnection, library: i32) -> Result<Vec<i32>, AppError> {
    Ok(sqlx::query_scalar!(
        r#"SELECT id FROM library_folders WHERE "libraryId" = $1 ORDER BY position, id"#,
        library
    )
    .fetch_all(c)
    .await?)
}

async fn out(db: &PgPool, library: i32, id: i32) -> Result<Json<FolderOut>, AppError> {
    let mut c = db.acquire().await?;
    let row = folder_of(&mut c, library, id).await?;
    drop(c);
    Ok(Json(db::folders_out(db, vec![row]).await?.remove(0)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddDto {
    path: String,
}

#[utoipa::path(post, path = "/api/libraries/{id}/folders", responses((status = 201)))]
pub async fn add(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
    req: Request,
) -> Result<Response, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = id_of(id)?;
    let dto: AddDto = body(req).await?;
    let mut tx = st.db.begin().await?;
    lock(&mut tx).await?;
    library_exists(&mut tx, id).await?;
    let path = checked(&mut tx, &dto.path, None).await?;
    ensure_dir(&path).await?;
    let position = ordered_ids(&mut tx, id).await?.len() as i32;
    let folder = sqlx::query_scalar!(
        r#"INSERT INTO library_folders ("libraryId", path, position) VALUES ($1, $2, $3) RETURNING id"#,
        id,
        path,
        position
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(lost_race)?;
    touch(&mut tx, id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, out(&st.db, id, folder).await?).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatchDto {
    path: Option<String>,
    position: Option<i32>,
}

/// Rule 51: every first segment of the linked files (the first 100) must exist under the new path.
async fn relocation_matches(
    c: &mut PgConnection,
    folder: i32,
    new: &str,
) -> Result<bool, AppError> {
    let firsts = sqlx::query_scalar!(
        r#"SELECT seg AS "seg!" FROM (SELECT split_part("relativePath", '/', 1) AS seg, min(id) AS first
        FROM media_files WHERE "folderId" = $1 GROUP BY 1) t ORDER BY first LIMIT 100"#,
        folder
    )
    .fetch_all(c)
    .await?;
    if firsts.is_empty() {
        ensure_dir(new).await?;
        return Ok(true);
    }
    for seg in firsts {
        if !tokio::fs::try_exists(Path::new(new).join(seg))
            .await
            .unwrap_or(false)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

#[utoipa::path(patch, path = "/api/libraries/{id}/folders/{folderId}", responses((status = 200)))]
pub async fn patch(
    State(st): State<AppState>,
    a: Authed,
    ids: Result<PathParams<(i32, i32)>, AppError>,
    req: Request,
) -> Result<Json<FolderOut>, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let PathParams((library, folder)) = ids?;
    let dto: PatchDto = body(req).await?;
    if dto.position.is_some_and(|p| p < 0) {
        return Err(AppError::bad_request(vec![
            "position must not be less than 0",
        ]));
    }
    let mut tx = st.db.begin().await?;
    lock(&mut tx).await?;
    library_exists(&mut tx, library).await?;
    let current = folder_of(&mut tx, library, folder).await?;
    if let Some(raw) = dto.path.as_deref() {
        let new = checked(&mut tx, raw, Some(folder)).await?;
        if new != current.path {
            if !relocation_matches(&mut tx, folder, &new).await? {
                return Err(AppError::conflict(MISMATCH));
            }
            sqlx::query!(
                "UPDATE library_folders SET path = $2 WHERE id = $1",
                folder,
                new
            )
            .execute(&mut *tx)
            .await
            .map_err(lost_race)?;
        }
    }
    if let Some(at) = dto.position {
        let mut ids = ordered_ids(&mut tx, library).await?;
        ids.retain(|i| *i != folder);
        ids.insert((at as usize).min(ids.len()), folder);
        renumber(&mut tx, &ids).await?;
    }
    touch(&mut tx, library).await?;
    tx.commit().await?;
    out(&st.db, library, folder).await
}

#[utoipa::path(delete, path = "/api/libraries/{id}/folders/{folderId}", responses((status = 200)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    ids: Result<PathParams<(i32, i32)>, AppError>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<StatusCode, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let PathParams((library, folder)) = ids?;
    let mut tx = st.db.begin().await?;
    lock(&mut tx).await?;
    library_exists(&mut tx, library).await?;
    folder_of(&mut tx, library, folder).await?;
    let media = sqlx::query_scalar!(
        r#"SELECT DISTINCT "mediaId" AS "id!" FROM media_files
        WHERE "folderId" = $1 AND "mediaId" IS NOT NULL ORDER BY 1"#,
        folder
    )
    .fetch_all(&mut *tx)
    .await?;
    if !media.is_empty() {
        tracing::warn!(
            "Folder #{folder} of library #{library} holds files of {} media",
            media.len()
        );
        if q.get("removeMedia").map(String::as_str) != Some("true") {
            return Err(AppError::conflict(IN_USE));
        }
        for m in &media {
            let guard = st.ingest.media.lock(*m).await;
            crate::media::write::remove_media(&st, &guard, *m).await?;
        }
    }
    sqlx::query!("DELETE FROM library_folders WHERE id = $1", folder)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            if e.as_database_error().and_then(|d| d.code()).as_deref() == Some("23503") {
                AppError::conflict(IN_USE)
            } else {
                e.into()
            }
        })?;
    let rest = ordered_ids(&mut tx, library).await?;
    renumber(&mut tx, &rest).await?;
    touch(&mut tx, library).await?;
    tx.commit().await?;
    Ok(StatusCode::OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_is_the_last_segment() {
        assert_eq!(name_of("/data/Films"), "Films");
        assert_eq!(name_of("/data/Films/"), "Films");
    }

    #[test]
    fn the_filesystem_root_is_reserved() {
        assert!(reserved("/"));
        assert!(!reserved("/srv/media-test"));
    }
}
