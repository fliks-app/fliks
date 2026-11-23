//! Library ACL (`libraries.md` rules 30-34), shared by every route that reads library-scoped data.
use crate::http::{AppError, auth::Authed, kinds::Kinds};
use fliks_domain::acl::{Action, Subject};
use sqlx::PgPool;

/// Every library id for admins and `manage:all`, else the user's `library_user_access` rows; `[]` means no access.
pub async fn accessible_library_ids(db: &PgPool, a: &Authed) -> Result<Vec<i32>, sqlx::Error> {
    let all = a.user.is_admin || a.perms.can(Action::Manage, &Subject::All);
    library_ids_of(db, a.user.id, all).await
}

/// The ids behind `accessible_library_ids`, for callers that hold a user row instead of an `Authed`.
pub async fn library_ids_of(db: &PgPool, user: i32, all: bool) -> Result<Vec<i32>, sqlx::Error> {
    if all {
        return sqlx::query_scalar!(r#"SELECT id AS "id!" FROM libraries ORDER BY id"#)
            .fetch_all(db)
            .await;
    }
    sqlx::query_scalar!(
        r#"SELECT "libraryId" FROM library_user_access WHERE "userId" = $1 ORDER BY id"#,
        user
    )
    .fetch_all(db)
    .await
}

/// 404 `MediaFile #<id> not found` for a missing file or one whose media is outside `ids`.
pub async fn assert_file_accessible(db: &PgPool, file: i32, ids: &[i32]) -> Result<(), AppError> {
    let ok: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM media_files mf JOIN media m ON m.id = mf."mediaId"
             WHERE mf.id = $1 AND m."libraryId" = ANY($2))"#,
    )
    .bind(file)
    .bind(ids)
    .fetch_one(db)
    .await?;
    ok.then_some(())
        .ok_or_else(|| AppError::not_found(format!("MediaFile #{file} not found")))
}

/// 404 `Media #<id> not found` for a missing media, one without library or outside `ids`.
pub async fn assert_media_accessible(
    db: &PgPool,
    media_id: i32,
    ids: &[i32],
) -> Result<(), AppError> {
    let library = sqlx::query_scalar!(r#"SELECT "libraryId" FROM media WHERE id = $1"#, media_id)
        .fetch_optional(db)
        .await?
        .flatten();
    match library {
        Some(l) if ids.contains(&l) => Ok(()),
        _ => Err(media_not_found(media_id)),
    }
}

/// `assert_media_accessible` that also refuses a media of a kind the client did not declare.
pub async fn assert_media_visible(
    db: &PgPool,
    media_id: i32,
    ids: &[i32],
    kinds: &Kinds,
) -> Result<(), AppError> {
    let row: Option<(Option<i32>, String)> =
        sqlx::query_as(r#"SELECT "libraryId", type FROM media WHERE id = $1"#)
            .bind(media_id)
            .fetch_optional(db)
            .await?;
    match row {
        Some((Some(l), kind)) if ids.contains(&l) && kinds.has_name(&kind) => Ok(()),
        _ => Err(media_not_found(media_id)),
    }
}

pub fn media_not_found(media_id: i32) -> AppError {
    AppError::not_found(format!("Media #{media_id} not found"))
}

/// Whether every item's media is in a library of `acl`.
pub async fn items_open(db: &PgPool, items: &[i32], acl: &[i32]) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        r#"SELECT NOT EXISTS (
               SELECT 1 FROM unnest($1::int[]) AS t(id)
               WHERE NOT EXISTS (
                   SELECT 1 FROM items i JOIN media m ON m.id = i."mediaId"
                   WHERE i.id = t.id AND m."libraryId" = ANY($2)))"#,
    )
    .bind(items)
    .bind(acl)
    .fetch_one(db)
    .await
}
