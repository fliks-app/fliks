//! Accounts created by the Seerr and Emby importers, reached through `user_external_ids` only.
use super::db::add_library_access;
use sqlx::{PgExecutor, PgPool};

pub enum Imported {
    /// Imported or mapped before under this provider and external id.
    Known(i32),
    Created(i32),
    /// An account already holds the name (any case) and no mapping points at it: nothing is created.
    NameTaken,
}

/// The user recorded for `(provider, external_id)`, else a new one with the default role and libraries, in one
/// transaction. A name held by another account is `NameTaken`, never merged, except a released import's (`earlier_import`).
pub async fn imported_user(
    db: &PgPool,
    provider: &str,
    external_id: &str,
    username: &str,
    media_server_type: &str,
) -> Result<Imported, sqlx::Error> {
    let known = sqlx::query_scalar!(
        r#"SELECT "userId" FROM user_external_ids WHERE provider = $1 AND "externalId" = $2"#,
        provider,
        external_id
    )
    .fetch_optional(db)
    .await?;
    if let Some(id) = known {
        return Ok(Imported::Known(id));
    }
    let mut tx = db.begin().await?;
    let taken = sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM users WHERE lower(username) = lower($1)) AS "taken!""#,
        username
    )
    .fetch_one(&mut *tx)
    .await?;
    if taken {
        let Some(id) = earlier_import(&mut tx, username, media_server_type).await? else {
            return Ok(Imported::NameTaken);
        };
        map_external(&mut *tx, provider, external_id, id).await?;
        tx.commit().await?;
        return Ok(Imported::Known(id));
    }
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
        return Ok(Imported::NameTaken);
    };
    add_library_access(&mut tx, id, &libraries).await?;
    map_external(&mut *tx, provider, external_id, id).await?;
    tx.commit().await?;
    Ok(Imported::Created(id))
}

/// The account an import of a release before `user_external_ids` created under this name: no
/// password, the importer's own `mediaServerType` and no mapping yet. Only a type nothing else
/// writes qualifies: a `local` account cannot be told from one an admin made.
async fn earlier_import(
    tx: &mut sqlx::PgConnection,
    username: &str,
    media_server_type: &str,
) -> Result<Option<i32>, sqlx::Error> {
    if media_server_type == "local" {
        return Ok(None);
    }
    sqlx::query_scalar(
        r#"SELECT u.id FROM users u
           WHERE lower(u.username) = lower($1) AND u."passwordHash" IS NULL
             AND u."mediaServerType"::text = $2
             AND NOT EXISTS (SELECT 1 FROM user_external_ids x WHERE x."userId" = u.id)"#,
    )
    .bind(username)
    .bind(media_server_type)
    .fetch_optional(tx)
    .await
}

/// Records that this external user is that Fliks user, replacing an earlier mapping (the admin's choice).
pub async fn map_external<'e>(
    db: impl PgExecutor<'e>,
    provider: &str,
    external_id: &str,
    user_id: i32,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"INSERT INTO user_external_ids (provider, "externalId", "userId") VALUES ($1, $2, $3)
           ON CONFLICT (provider, "externalId") DO UPDATE SET "userId" = EXCLUDED."userId""#,
        provider,
        external_id,
        user_id
    )
    .execute(db)
    .await?;
    Ok(())
}
