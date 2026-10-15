//! Queries and the `PublicUser` shape (`docs/spec/users.md` rules 2-4, SQL section).
use crate::http::{
    AppError,
    auth::{USER_COLUMNS, UserRow},
};
use serde::Serialize;
use sqlx::{FromRow, PgConnection, PgPool, Row, postgres::PgRow};
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

fn select_users(tail: &str) -> String {
    format!(
        r#"SELECT {USER_COLUMNS}, r."name" AS "roleName", r."permissions" AS "rolePermissions"
           FROM users u LEFT JOIN roles r ON r."id" = u."roleId" {tail}"#
    )
}

fn public(row: &PgRow, library_ids: Vec<i32>) -> Result<PublicUser, sqlx::Error> {
    let user = UserRow::from_row(row)?;
    let perms: Option<String> = row.try_get("rolePermissions")?;
    let permissions = if user.is_admin {
        vec!["manage:all".into()]
    } else {
        perms
            .and_then(|p| serde_json::from_str(&p).ok())
            .unwrap_or_default()
    };
    Ok(PublicUser {
        role: row.try_get("roleName")?,
        permissions,
        library_ids,
        user,
    })
}

pub async fn list(db: &PgPool) -> Result<Vec<PublicUser>, sqlx::Error> {
    let rows = sqlx::query(&select_users(r#"ORDER BY u."username" ASC"#))
        .fetch_all(db)
        .await?;
    let ids: Vec<i32> = rows.iter().map(|r| r.get("id")).collect();
    let access: Vec<(i32, i32)> = sqlx::query_as(
        r#"SELECT lua."userId" AS "userId", lua."libraryId" AS "libraryId"
           FROM library_user_access lua WHERE lua."userId" = ANY($1) ORDER BY lua."id""#,
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let mut by_user: HashMap<i32, Vec<i32>> = HashMap::new();
    for (u, l) in access {
        by_user.entry(u).or_default().push(l);
    }
    rows.iter()
        .map(|r| {
            public(
                r,
                by_user.remove(&r.get::<i32, _>("id")).unwrap_or_default(),
            )
        })
        .collect()
}

pub async fn find_one(db: &PgPool, id: i32) -> Result<Option<PublicUser>, sqlx::Error> {
    let Some(row) = sqlx::query(&select_users(r#"WHERE u."id" = $1"#))
        .bind(id)
        .fetch_optional(db)
        .await?
    else {
        return Ok(None);
    };
    let ids = sqlx::query_scalar(
        r#"SELECT lua."libraryId" FROM library_user_access lua WHERE lua."userId" = $1 ORDER BY lua."id""#,
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    public(&row, ids).map(Some)
}

pub fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("User #{id} not found"))
}

pub async fn username_taken(
    c: &mut PgConnection,
    username: &str,
    except: Option<i32>,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT EXISTS(SELECT 1 FROM users WHERE "username" = $1 AND ($2::int IS NULL OR "id" <> $2))"#,
    )
    .bind(username)
    .bind(except)
    .fetch_one(c)
    .await
}

/// Locks and returns the target row with its password-less columns.
pub async fn lock_user(c: &mut PgConnection, id: i32) -> Result<Option<UserRow>, sqlx::Error> {
    let sql = format!(r#"SELECT {USER_COLUMNS} FROM users u WHERE u."id" = $1 FOR UPDATE"#);
    sqlx::query_as(&sql).bind(id).fetch_optional(c).await
}

/// True when no other enabled admin exists; locks the admin rows so concurrent demotions serialise.
pub async fn is_last_enabled_admin(c: &mut PgConnection, id: i32) -> Result<bool, sqlx::Error> {
    let others: Vec<i32> = sqlx::query_scalar(
        r#"SELECT "id" FROM users WHERE "isAdmin" AND "enabled" AND "id" <> $1 FOR UPDATE"#,
    )
    .bind(id)
    .fetch_all(c)
    .await?;
    Ok(others.is_empty())
}

pub async fn replace_library_access(
    c: &mut PgConnection,
    user_id: i32,
    ids: &[i32],
) -> Result<(), sqlx::Error> {
    sqlx::query(r#"DELETE FROM library_user_access WHERE "userId" = $1"#)
        .bind(user_id)
        .execute(&mut *c)
        .await?;
    add_library_access(c, user_id, ids).await
}

pub async fn add_library_access(
    c: &mut PgConnection,
    user_id: i32,
    ids: &[i32],
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO library_user_access ("userId", "libraryId")
           SELECT $1, l FROM unnest($2::int[]) WITH ORDINALITY AS t(l, n) ORDER BY n
           ON CONFLICT DO NOTHING"#,
    )
    .bind(user_id)
    .bind(ids)
    .execute(c)
    .await
    .map(drop)
}

/// Statements run in order, `$1` = the user id (spec "Social teardown", verbatim).
const TEARDOWN: [&str; 6] = [
    r#"DELETE FROM user_follows WHERE "followerId" = $1 OR "followingId" = $1"#,
    r#"DELETE FROM playlist_saves WHERE "userId" = $1"#,
    r#"DELETE FROM playlist_shares WHERE "userId" = $1"#,
    r#"DELETE FROM playlist_shares WHERE "playlistId" IN (SELECT id FROM playlists WHERE "ownerId" = $1)"#,
    r#"UPDATE playlists SET visibility = 'private' WHERE "ownerId" = $1 AND visibility <> 'private'"#,
    r#"DELETE FROM content_recommendations WHERE "senderId" = $1 OR "recipientId" = $1"#,
];

pub async fn social_teardown(c: &mut PgConnection, user_id: i32) -> Result<(), sqlx::Error> {
    for sql in TEARDOWN {
        sqlx::query(sql).bind(user_id).execute(&mut *c).await?;
    }
    Ok(())
}

/// Revoke every live refresh token of the user except `keep` (a `refresh_tokens.id`).
/// Same signature as the auth module's helper, which supersedes this one when merged.
pub async fn revoke_other_families(
    db: &PgPool,
    user_id: i32,
    keep: Option<i32>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE refresh_tokens SET "revokedAt" = now()
           WHERE "userId" = $1 AND "revokedAt" IS NULL AND ($2::int IS NULL OR "id" <> $2)"#,
    )
    .bind(user_id)
    .bind(keep)
    .execute(db)
    .await
    .map(drop)
}
