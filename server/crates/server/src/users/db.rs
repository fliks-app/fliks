//! Queries and the `PublicUser` shape (`docs/spec/users.md` rules 2-4, SQL section).
use crate::http::{
    AppError,
    auth::{RoleRow, UserRow, load_users},
};
use fliks_domain::media::kind::MediaKind;
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
    pub identities: Vec<Identity>,
    /// The provider whose groups decide this user's role, admin flag or libraries.
    pub access_managed_by: Option<i32>,
    pub has_password: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub provider_id: i32,
    pub name: String,
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
        identities: vec![],
        access_managed_by: None,
        has_password: true,
    }
}

/// Fills the SSO fields of `users` with three queries, whatever their number.
async fn with_sso(db: &PgPool, users: &mut [PublicUser]) -> Result<(), sqlx::Error> {
    let ids: Vec<i32> = users.iter().map(|u| u.user.id).collect();
    let linked = sqlx::query!(
        r#"SELECT i."userId" AS user_id, i."providerId" AS provider_id, p.name
           FROM user_identities i JOIN oidc_providers p ON p.id = i."providerId"
           WHERE i."userId" = ANY($1) ORDER BY p."position", p.id"#,
        &ids
    )
    .fetch_all(db)
    .await?;
    let managed = sqlx::query!(
        r#"SELECT DISTINCT ON (i."userId") i."userId" AS "user_id!", p.id AS "provider_id!"
           FROM user_identities i JOIN oidc_providers p ON p.id = i."providerId"
           WHERE i."userId" = ANY($1) AND p.enabled AND p."groupsClaim" IS NOT NULL
             AND (cardinality(p."adminGroups") > 0
                  OR EXISTS (SELECT 1 FROM oidc_role_mappings m WHERE m."providerId" = p.id))
           ORDER BY i."userId", p."position", p.id"#,
        &ids
    )
    .fetch_all(db)
    .await?;
    let no_password = sqlx::query_scalar!(
        r#"SELECT id AS "id!" FROM users WHERE id = ANY($1) AND "passwordHash" IS NULL"#,
        &ids
    )
    .fetch_all(db)
    .await?;
    for u in users {
        let id = u.user.id;
        u.identities = linked
            .iter()
            .filter(|l| l.user_id == id)
            .map(|l| Identity {
                provider_id: l.provider_id,
                name: l.name.clone(),
            })
            .collect();
        u.access_managed_by = managed
            .iter()
            .find(|m| m.user_id == id)
            .map(|m| m.provider_id);
        u.has_password = !no_password.contains(&id);
    }
    Ok(())
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
    let mut out: Vec<PublicUser> = rows
        .into_iter()
        .map(|row| {
            let libs = by_user.remove(&row.0.id).unwrap_or_default();
            public(row, libs)
        })
        .collect();
    with_sso(db, &mut out).await?;
    Ok(out)
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
    let mut one = [public(row, ids)];
    with_sso(db, &mut one).await?;
    let [user] = one;
    Ok(Some(user))
}

/// What `create_user` inserts: a `None` hash is a user with no password (signs in with SSO).
pub struct NewUser {
    pub username: String,
    pub email: Option<String>,
    pub password_hash: Option<String>,
    /// A falsy or unknown role falls back to the default one.
    pub role_id: Option<i32>,
    pub is_admin: bool,
    pub enabled: bool,
    /// `None`: the role's default libraries.
    pub library_ids: Option<Vec<i32>>,
}

/// The one way a user row is created: role, row, then libraries.
pub async fn create_user(c: &mut PgConnection, u: NewUser) -> Result<i32, sqlx::Error> {
    let wanted = u.role_id.filter(|r| *r != 0);
    let role = sqlx::query_scalar!(
        r#"SELECT "id" FROM roles WHERE "id" = $1 OR ($1::int IS NULL AND "isDefault")
           ORDER BY ("id" = $1) DESC LIMIT 1"#,
        wanted
    )
    .fetch_optional(&mut *c)
    .await?;
    let role = match role {
        Some(r) => Some(r),
        None => {
            sqlx::query_scalar!(r#"SELECT "id" FROM roles WHERE "isDefault" LIMIT 1"#)
                .fetch_optional(&mut *c)
                .await?
        }
    };
    let id = sqlx::query_scalar!(
        r#"INSERT INTO users (username, "passwordHash", email, "roleId", "isAdmin", enabled)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id"#,
        u.username,
        u.password_hash,
        u.email,
        role,
        u.is_admin,
        u.enabled
    )
    .fetch_one(&mut *c)
    .await?;
    let libraries = match (u.library_ids, role) {
        (Some(ids), _) => ids,
        (None, Some(r)) => default_libraries(c, r).await?,
        (None, None) => vec![],
    };
    add_library_access(c, id, &libraries).await?;
    Ok(id)
}

pub async fn default_libraries(c: &mut PgConnection, role: i32) -> Result<Vec<i32>, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT "libraryId" FROM role_default_libraries WHERE "roleId" = $1 ORDER BY "libraryId""#,
        role
    )
    .fetch_all(c)
    .await
}

/// The access columns of a user: each `Some` part is written.
#[derive(Default)]
pub struct Access {
    pub role_id: Option<Option<i32>>,
    pub is_admin: Option<bool>,
    pub library_ids: Option<Vec<i32>>,
}

/// Role, admin flag and library access, the parts `PUT /api/users` and the SSO sync share.
pub async fn apply_access(c: &mut PgConnection, id: i32, a: Access) -> Result<(), sqlx::Error> {
    if let Some(role) = a.role_id {
        sqlx::query!(
            r#"UPDATE users SET "roleId" = $2, "updatedAt" = now() WHERE id = $1"#,
            id,
            role
        )
        .execute(&mut *c)
        .await?;
    }
    if let Some(admin) = a.is_admin {
        sqlx::query!(
            r#"UPDATE users SET "isAdmin" = $2, "updatedAt" = now() WHERE id = $1"#,
            id,
            admin
        )
        .execute(&mut *c)
        .await?;
    }
    if let Some(ids) = a.library_ids {
        replace_library_access(c, id, &ids).await?;
    }
    Ok(())
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

/// A limit of 0 is no row: unlimited.
pub async fn set_quota(
    c: &mut PgConnection,
    user_id: i32,
    kind: MediaKind,
    limit: i32,
) -> Result<(), sqlx::Error> {
    if limit == 0 {
        sqlx::query!(
            r#"DELETE FROM user_quotas WHERE "userId" = $1 AND "kind" = $2"#,
            user_id,
            kind.as_str()
        )
        .execute(c)
        .await?;
    } else {
        sqlx::query!(
            r#"INSERT INTO user_quotas ("userId", "kind", "limit") VALUES ($1, $2, $3)
            ON CONFLICT ("userId", "kind") DO UPDATE SET "limit" = $3"#,
            user_id,
            kind.as_str(),
            limit
        )
        .execute(c)
        .await?;
    }
    Ok(())
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

/// Revokes every live session of the user except `keep`.
pub async fn revoke_other_sessions(
    db: &PgPool,
    user_id: i32,
    keep: Option<i32>,
) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    // Tokens first, as a refresh locks its token before the session.
    sqlx::query!(
        r#"UPDATE refresh_tokens SET "revokedAt" = now()
           WHERE "userId" = $1 AND "revokedAt" IS NULL AND ($2::int IS NULL OR "sessionId" <> $2)"#,
        user_id,
        keep
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        r#"UPDATE sessions SET "revokedAt" = now()
           WHERE "userId" = $1 AND "revokedAt" IS NULL AND ($2::int IS NULL OR id <> $2)"#,
        user_id,
        keep
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}
