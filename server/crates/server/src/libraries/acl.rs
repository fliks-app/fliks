//! Library ACL (`libraries.md` rules 30-34), shared by every route that reads library-scoped data.
use crate::http::{AppError, auth::Authed};
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
        r#"SELECT "libraryId" AS "library_id!" FROM library_user_access
           WHERE "userId" = $1 AND "libraryId" IS NOT NULL ORDER BY id"#,
        user
    )
    .fetch_all(db)
    .await
}

/// The editions linking a file that sit in a library outside the readable ids bound after it (`books.md` rule 22).
/// Callers add `) AND hp."mediaFileId" ...`; one rule for hydrate, the lists and `assert_file_accessible`.
pub const HIDDEN_FILES_FROM: &str = r#"FROM item_parts hp JOIN items hi ON hi.id = hp."itemId"
  JOIN editions he ON he.id = hi."editionId" JOIN media hm ON hm.id = he."mediaId"
  WHERE NOT COALESCE(he."libraryId", hm."libraryId") = ANY("#;

/// The predicate every "readable text file" query shares: work, edition and each edition linking
/// `file` sit in the libraries bound at `acl` (`$n`). Expects the aliases `m` (media) and `e` (edition).
pub fn readable_file(acl: &str, file: &str) -> String {
    format!(
        r#"m."libraryId" = ANY({acl}) AND COALESCE(e."libraryId", m."libraryId") = ANY({acl})
  AND NOT EXISTS (SELECT 1 {HIDDEN_FILES_FROM}{acl}) AND hp."mediaFileId" = {file})"#
    )
}

/// 404 `MediaFile #<id> not found` for a missing file, or one linked by an edition outside `ids`
/// (an edition without `libraryId` follows its media, as in the book read routes).
pub async fn assert_file_accessible(db: &PgPool, file: i32, ids: &[i32]) -> Result<(), AppError> {
    let ok: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"SELECT EXISTS (SELECT 1 FROM media_files WHERE id = $1)
           AND NOT EXISTS (SELECT 1 {HIDDEN_FILES_FROM}$2) AND hp."mediaFileId" = $1)"#
    )))
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

pub fn media_not_found(media_id: i32) -> AppError {
    AppError::not_found(format!("Media #{media_id} not found"))
}
