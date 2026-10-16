//! Library ACL of the media read routes (`libraries.md` rules 30-34).
use crate::http::{AppError, auth::Authed};
use fliks_domain::acl::{Action, Subject};
use sqlx::PgPool;

/// Every library for an admin or `manage:all`, else the caller's `library_user_access` rows.
pub async fn accessible_library_ids(db: &PgPool, a: &Authed) -> Result<Vec<i32>, sqlx::Error> {
    if a.user.is_admin || a.perms.can(Action::Manage, &Subject::All) {
        return sqlx::query_scalar!(r#"SELECT id AS "id!" FROM libraries ORDER BY id"#)
            .fetch_all(db)
            .await;
    }
    sqlx::query_scalar!(
        r#"SELECT "libraryId" AS "library_id!" FROM library_user_access
           WHERE "userId" = $1 AND "libraryId" IS NOT NULL ORDER BY id"#,
        a.user.id
    )
    .fetch_all(db)
    .await
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
        _ => Err(not_found(media_id)),
    }
}

pub fn not_found(media_id: i32) -> AppError {
    AppError::not_found(format!("Media #{media_id} not found"))
}

/// F22: absolute server paths only for callers who can manage libraries.
pub fn can_see_paths(a: &Authed) -> bool {
    a.perms.can(Action::Manage, &Subject::Library)
}
