//! Accounts created by the Seerr and Emby importers (`importers.md` rule 33).
use super::db::add_library_access;
use sqlx::PgPool;

/// The user named `username` (exact match) or a new one with the default role and its default libraries
/// in one transaction; `true` when created. A concurrent writer's insert is re-read, not failed on.
pub async fn imported_user(
    db: &PgPool,
    username: &str,
    media_server_type: &str,
) -> Result<(i32, bool), sqlx::Error> {
    if let Some(id) = find(db, username).await? {
        return Ok((id, false));
    }
    let mut tx = db.begin().await?;
    let rows = sqlx::query!(
        r#"SELECT r.id, rdl."libraryId" AS "library_id?" FROM roles r
           LEFT JOIN role_default_libraries rdl ON rdl."roleId" = r.id
           WHERE r."isDefault" ORDER BY r.id, rdl."libraryId""#
    )
    .fetch_all(&mut *tx)
    .await?;
    // The first default role only.
    let role = rows.first().map(|r| r.id);
    let libraries: Vec<i32> = rows
        .iter()
        .filter(|r| Some(r.id) == role)
        .filter_map(|r| r.library_id)
        .collect();
    let inserted = sqlx::query_scalar!(
        r#"INSERT INTO users (username, "passwordHash", "roleId", "mediaServerType")
           VALUES ($1, NULL, $2, $3::text::users_mediaservertype_enum)
           ON CONFLICT (username) DO NOTHING RETURNING id"#,
        username,
        role,
        media_server_type
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(id) = inserted else {
        tx.rollback().await?;
        let id = find(db, username).await?.ok_or(sqlx::Error::RowNotFound)?;
        return Ok((id, false));
    };
    add_library_access(&mut tx, id, &libraries).await?;
    tx.commit().await?;
    Ok((id, true))
}

async fn find(db: &PgPool, username: &str) -> Result<Option<i32>, sqlx::Error> {
    sqlx::query_scalar!("SELECT id FROM users WHERE username = $1", username)
        .fetch_optional(db)
        .await
}
