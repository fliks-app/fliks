//! Queries on `remote_control_grants` and the `users` columns remote needs (`docs/spec/remote.md` SQL).
use chrono::{DateTime, Utc};
use fliks_domain::acl::{Action, Permissions, Subject};
use sqlx::PgPool;

pub struct Grant {
    pub id: i32,
    pub created_at: DateTime<Utc>,
    pub device_id: String,
    pub owner_user_id: i32,
    pub grantee_user_id: Option<i32>,
    pub device_name: String,
    pub code_expires_at: DateTime<Utc>,
}

/// `isAdmin` is the CASL `Manage Settings` test (spec rule 8).
pub struct User {
    pub id: i32,
    pub username: String,
    pub enabled: bool,
    pub is_admin: bool,
}

struct UserRow {
    id: i32,
    username: String,
    enabled: bool,
    is_admin: bool,
    permissions: Option<String>,
}

impl From<UserRow> for User {
    fn from(r: UserRow) -> Self {
        let perms: Vec<String> = r
            .permissions
            .and_then(|p| serde_json::from_str(&p).ok())
            .unwrap_or_default();
        User {
            is_admin: Permissions::from(&perms, r.is_admin).can(Action::Manage, &Subject::Settings),
            id: r.id,
            username: r.username,
            enabled: r.enabled,
        }
    }
}

pub async fn users_by_ids(db: &PgPool, ids: &[i32]) -> sqlx::Result<Vec<User>> {
    let rows = sqlx::query_as!(
        UserRow,
        r#"SELECT u.id, u.username, u.enabled, u."isAdmin" AS is_admin, r.permissions AS "permissions?"
           FROM users u LEFT JOIN roles r ON r.id = u."roleId" WHERE u.id = ANY($1) ORDER BY u.id"#,
        ids
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn enabled_admin_ids(db: &PgPool) -> sqlx::Result<Vec<i32>> {
    let rows = sqlx::query_as!(
        UserRow,
        r#"SELECT u.id, u.username, u.enabled, u."isAdmin" AS is_admin, r.permissions AS "permissions?"
           FROM users u LEFT JOIN roles r ON r.id = u."roleId" WHERE u.enabled"#
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(User::from)
        .filter(|u| u.is_admin)
        .map(|u| u.id)
        .collect())
}

pub async fn is_granted(db: &PgPool, device: &str, grantee: i32) -> sqlx::Result<bool> {
    sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM remote_control_grants WHERE "deviceId" = $1 AND "granteeUserId" = $2"#,
        device,
        grantee
    )
    .fetch_one(db)
    .await
    .map(|n| n > 0)
}

pub async fn held(db: &PgPool, grantee: i32) -> sqlx::Result<Vec<Grant>> {
    sqlx::query_as!(
        Grant,
        r#"SELECT id, "createdAt" AS created_at, "deviceId" AS device_id, "ownerUserId" AS owner_user_id,
                  "granteeUserId" AS grantee_user_id, "deviceName" AS device_name, "codeExpiresAt" AS code_expires_at
           FROM remote_control_grants WHERE "granteeUserId" = $1"#,
        grantee
    )
    .fetch_all(db)
    .await
}

pub async fn issued(db: &PgPool, owner: i32, device: Option<&str>) -> sqlx::Result<Vec<Grant>> {
    sqlx::query_as!(
        Grant,
        r#"SELECT id, "createdAt" AS created_at, "deviceId" AS device_id, "ownerUserId" AS owner_user_id,
                  "granteeUserId" AS grantee_user_id, "deviceName" AS device_name, "codeExpiresAt" AS code_expires_at
           FROM remote_control_grants
           WHERE "ownerUserId" = $1 AND "granteeUserId" IS NOT NULL AND ($2::text IS NULL OR "deviceId" = $2)"#,
        owner,
        device
    )
    .fetch_all(db)
    .await
}

/// Scoped to the owner: anyone can mint a code for another account's device id.
pub async fn grantees_of_device(db: &PgPool, owner: i32, device: &str) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar!(
        r#"SELECT "granteeUserId" AS "grantee!" FROM remote_control_grants
           WHERE "ownerUserId" = $1 AND "deviceId" = $2 AND "granteeUserId" IS NOT NULL"#,
        owner,
        device
    )
    .fetch_all(db)
    .await
}

pub async fn grantees_of_owner(db: &PgPool, owner: i32) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar!(
        r#"SELECT "granteeUserId" AS "grantee!" FROM remote_control_grants
           WHERE "ownerUserId" = $1 AND "granteeUserId" IS NOT NULL"#,
        owner
    )
    .fetch_all(db)
    .await
}

pub async fn prune_expired_codes(db: &PgPool) -> sqlx::Result<()> {
    sqlx::query!(
        r#"DELETE FROM remote_control_grants WHERE "granteeUserId" IS NULL AND "codeExpiresAt" < now()"#
    )
    .execute(db)
    .await
    .map(drop)
}

pub async fn unclaimed_count(db: &PgPool, device: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM remote_control_grants WHERE "deviceId" = $1 AND "granteeUserId" IS NULL"#,
        device
    )
    .fetch_one(db)
    .await
}

pub async fn code_taken(db: &PgPool, code: &str) -> sqlx::Result<bool> {
    sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM remote_control_grants WHERE code = $1"#,
        code
    )
    .fetch_one(db)
    .await
    .map(|n| n > 0)
}

pub async fn insert_code(
    db: &PgPool,
    code: &str,
    device: &str,
    owner: i32,
    name: &str,
    expires: DateTime<Utc>,
) -> sqlx::Result<i32> {
    sqlx::query_scalar!(
        r#"INSERT INTO remote_control_grants (code, "deviceId", "ownerUserId", "granteeUserId", "deviceName", "codeExpiresAt")
           VALUES ($1, $2, $3, NULL, $4, $5) RETURNING id"#,
        code,
        device,
        owner,
        name,
        expires
    )
    .fetch_one(db)
    .await
}

pub async fn unclaimed_by_code(db: &PgPool, code: &str) -> sqlx::Result<Option<Grant>> {
    sqlx::query_as!(
        Grant,
        r#"SELECT id, "createdAt" AS created_at, "deviceId" AS device_id, "ownerUserId" AS owner_user_id,
                  "granteeUserId" AS grantee_user_id, "deviceName" AS device_name, "codeExpiresAt" AS code_expires_at
           FROM remote_control_grants WHERE code = $1 AND "granteeUserId" IS NULL LIMIT 1"#,
        code
    )
    .fetch_optional(db)
    .await
}

pub async fn held_on_device(
    db: &PgPool,
    device: &str,
    grantee: i32,
) -> sqlx::Result<Option<Grant>> {
    sqlx::query_as!(
        Grant,
        r#"SELECT id, "createdAt" AS created_at, "deviceId" AS device_id, "ownerUserId" AS owner_user_id,
                  "granteeUserId" AS grantee_user_id, "deviceName" AS device_name, "codeExpiresAt" AS code_expires_at
           FROM remote_control_grants WHERE "deviceId" = $1 AND "granteeUserId" = $2 LIMIT 1"#,
        device,
        grantee
    )
    .fetch_optional(db)
    .await
}

pub async fn find(db: &PgPool, id: i32) -> sqlx::Result<Option<Grant>> {
    sqlx::query_as!(
        Grant,
        r#"SELECT id, "createdAt" AS created_at, "deviceId" AS device_id, "ownerUserId" AS owner_user_id,
                  "granteeUserId" AS grantee_user_id, "deviceName" AS device_name, "codeExpiresAt" AS code_expires_at
           FROM remote_control_grants WHERE id = $1 LIMIT 1"#,
        id
    )
    .fetch_optional(db)
    .await
}

/// False when a concurrent claim took the code first (single use, spec rule 26).
pub async fn set_grantee(db: &PgPool, id: i32, grantee: i32) -> sqlx::Result<bool> {
    sqlx::query!(
        r#"UPDATE remote_control_grants SET code = NULL, "granteeUserId" = $1, "updatedAt" = now()
           WHERE id = $2 AND "granteeUserId" IS NULL"#,
        grantee,
        id
    )
    .execute(db)
    .await
    .map(|r| r.rows_affected() == 1)
}

pub async fn delete(db: &PgPool, id: i32) -> sqlx::Result<()> {
    sqlx::query!("DELETE FROM remote_control_grants WHERE id = $1", id)
        .execute(db)
        .await
        .map(drop)
}
