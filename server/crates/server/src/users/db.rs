//! Queries and the `PublicUser` shape (`docs/spec/users.md` rules 2-4, SQL section).
use crate::http::{
    AppError,
    auth::{RoleRow, UserRow, load_users},
};
use serde::Serialize;
use sqlx::{PgConnection, PgPool};
use std::collections::HashMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUser {
    #[serde(flatten)]
    pub user: UserRow,
    pub role: Option<String>,
    pub permissions: Vec<String>,
    pub library_ids: Vec<i32>,
}

fn public((user, role): (UserRow, Option<RoleRow>), library_ids: Vec<i32>) -> PublicUser {
    let permissions = if user.is_admin {
        vec!["manage:all".into()]
    } else {
        role.as_ref()
            .map(|r| r.permissions.clone())
            .unwrap_or_default()
    };
    PublicUser {
        role: role.map(|r| r.name),
        permissions,
        library_ids,
        user,
    }
}

pub async fn list(db: &PgPool) -> Result<Vec<PublicUser>, sqlx::Error> {
    let rows = load_users(db, None, false).await?;
    let ids: Vec<i32> = rows.iter().map(|(u, _)| u.id).collect();
    let access = sqlx::query!(
        r#"SELECT "userId" AS "user_id!", "libraryId" AS "library_id!" FROM library_user_access WHERE "userId" = ANY($1) ORDER BY "id""#,
        &ids
    )
    .fetch_all(db)
    .await?;
    let mut by_user: HashMap<i32, Vec<i32>> = HashMap::new();
    for a in access {
        by_user.entry(a.user_id).or_default().push(a.library_id);
    }
    Ok(rows
        .into_iter()
        .map(|row| {
            let libs = by_user.remove(&row.0.id).unwrap_or_default();
            public(row, libs)
        })
        .collect())
}

pub async fn find_one(db: &PgPool, id: i32) -> Result<Option<PublicUser>, sqlx::Error> {
    let Some(row) = load_users(db, Some(id), false).await?.pop() else {
        return Ok(None);
    };
    let ids = sqlx::query_scalar!(
        r#"SELECT "libraryId" AS "library_id!" FROM library_user_access WHERE "userId" = $1 ORDER BY "id""#,
        id
    )
    .fetch_all(db)
    .await?;
    Ok(Some(public(row, ids)))
}

pub fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("User #{id} not found"))
}

pub async fn username_taken(
    c: &mut PgConnection,
    username: &str,
    except: Option<i32>,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM users WHERE "username" = $1 AND ($2::int IS NULL OR "id" <> $2)) AS "taken!""#,
        username,
        except
    )
    .fetch_one(c)
    .await
}

/// Locks and returns the target row with its password-less columns.
pub async fn lock_user(c: &mut PgConnection, id: i32) -> Result<Option<UserRow>, sqlx::Error> {
    let locked = sqlx::query_scalar!(r#"SELECT "id" FROM users WHERE "id" = $1 FOR UPDATE"#, id)
        .fetch_optional(&mut *c)
        .await?;
    match locked {
        Some(id) => Ok(load_users(c, Some(id), false).await?.pop().map(|(u, _)| u)),
        None => Ok(None),
    }
}

/// True when no other enabled admin exists; locks the admin rows so concurrent demotions serialise.
pub async fn is_last_enabled_admin(c: &mut PgConnection, id: i32) -> Result<bool, sqlx::Error> {
    let others = sqlx::query_scalar!(
        r#"SELECT "id" FROM users WHERE "isAdmin" AND "enabled" AND "id" <> $1 FOR UPDATE"#,
        id
    )
    .fetch_all(c)
    .await?;
    Ok(others.is_empty())
}

pub async fn replace_library_access(
    c: &mut PgConnection,
    user_id: i32,
    ids: &[i32],
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"DELETE FROM library_user_access WHERE "userId" = $1"#,
        user_id
    )
    .execute(&mut *c)
    .await?;
    add_library_access(c, user_id, ids).await
}

pub async fn add_library_access(
    c: &mut PgConnection,
    user_id: i32,
    ids: &[i32],
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"INSERT INTO library_user_access ("userId", "libraryId")
           SELECT $1, l FROM unnest($2::int[]) WITH ORDINALITY AS t(l, n) ORDER BY n
           ON CONFLICT DO NOTHING"#,
        user_id,
        ids
    )
    .execute(c)
    .await
    .map(drop)
}

/// Revoke every live refresh token of the user except `keep` (a `refresh_tokens.id`).
pub async fn revoke_other_families(
    db: &PgPool,
    user_id: i32,
    keep: Option<i32>,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"UPDATE refresh_tokens SET "revokedAt" = now()
           WHERE "userId" = $1 AND "revokedAt" IS NULL AND ($2::int IS NULL OR "id" <> $2)"#,
        user_id,
        keep
    )
    .execute(db)
    .await
    .map(drop)
}
