//! Library ACL (`libraries.md` rules 30-34), shared by every route that reads library-scoped data.
use crate::http::{AppError, auth::Authed};
use fliks_domain::acl::{Action, Subject};
use sqlx::PgPool;

/// Every library id for admins and `manage:all`, else the user's `library_user_access` rows; `[]` means no access.
pub async fn accessible_library_ids(db: &PgPool, user: &Authed) -> sqlx::Result<Vec<i32>> {
    if user.user.is_admin || user.perms.can(Action::Manage, &Subject::All) {
        return sqlx::query_scalar!("SELECT id FROM libraries")
            .fetch_all(db)
            .await;
    }
    let ids = sqlx::query_scalar!(
        r#"SELECT "libraryId" FROM library_user_access WHERE "userId" = $1"#,
        user.user.id
    )
    .fetch_all(db)
    .await?;
    Ok(ids.into_iter().flatten().collect())
}

/// 404 `Media #<id> not found` for a missing media, one without library, or one outside `ids` (no existence leak).
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
        _ => Err(AppError::not_found(format!("Media #{media_id} not found"))),
    }
}
