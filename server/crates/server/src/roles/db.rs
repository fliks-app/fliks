use super::grants::PERMISSIONS;
use crate::http::json::iso_ms;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgPool, types::Json};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub id: i32,
    #[serde(with = "iso_ms")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub media_types: Json<Vec<String>>,
    pub preferred_provider: Option<String>,
    pub metadata_language: Option<String>,
    pub metadata_region: Option<String>,
    pub default_quality_profile_id: Option<i32>,
    pub default_language_profile_id: Option<i32>,
    pub path: Option<String>,
    pub label: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: i32,
    #[serde(with = "iso_ms")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub permissions: Vec<String>,
    pub is_default: bool,
    pub default_libraries: Vec<Library>,
    pub default_library_ids: Vec<i32>,
}

struct RoleRow {
    id: i32,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    name: String,
    permissions: String,
    is_default: bool,
}

/// Roles (all, or one) with their default libraries, library id ascending (`roles.md` rule 3).
async fn load(pool: &PgPool, id: Option<i32>) -> sqlx::Result<Vec<Role>> {
    let rows = sqlx::query_as!(
        RoleRow,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, permissions,
                  "isDefault" AS is_default
           FROM roles WHERE $1::int4 IS NULL OR id = $1 ORDER BY name ASC"#,
        id
    )
    .fetch_all(pool)
    .await?;
    let ids: Vec<i32> = rows.iter().map(|r| r.id).collect();
    let libs = sqlx::query!(
        r#"SELECT rdl."roleId" AS role_id,
                  l.id, l."createdAt" AS created_at, l."updatedAt" AS updated_at, l.name, l.icon, l.color,
                  l."mediaTypes" AS "media_types: Json<Vec<String>>", l."preferredProvider" AS preferred_provider,
                  l."metadataLanguage" AS metadata_language, l."metadataRegion" AS metadata_region,
                  l."defaultQualityProfileId" AS default_quality_profile_id,
                  l."defaultLanguageProfileId" AS default_language_profile_id, l.path, l.label
           FROM role_default_libraries rdl JOIN libraries l ON l.id = rdl."libraryId"
           WHERE rdl."roleId" = ANY($1) ORDER BY l.id"#,
        &ids
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let default_libraries: Vec<Library> = libs
                .iter()
                .filter(|l| l.role_id == r.id)
                .map(|l| Library {
                    id: l.id,
                    created_at: l.created_at,
                    updated_at: l.updated_at,
                    name: l.name.clone(),
                    icon: l.icon.clone(),
                    color: l.color.clone(),
                    media_types: Json(l.media_types.0.clone()),
                    preferred_provider: l.preferred_provider.clone(),
                    metadata_language: l.metadata_language.clone(),
                    metadata_region: l.metadata_region.clone(),
                    default_quality_profile_id: l.default_quality_profile_id,
                    default_language_profile_id: l.default_language_profile_id,
                    path: l.path.clone(),
                    label: l.label.clone(),
                })
                .collect();
            Role {
                id: r.id,
                created_at: r.created_at,
                updated_at: r.updated_at,
                name: r.name,
                permissions: serde_json::from_str(&r.permissions).unwrap_or_default(),
                is_default: r.is_default,
                default_library_ids: default_libraries.iter().map(|l| l.id).collect(),
                default_libraries,
            }
        })
        .collect())
}

pub async fn list(pool: &PgPool) -> sqlx::Result<Vec<Role>> {
    load(pool, None).await
}

pub async fn find(pool: &PgPool, id: i32) -> sqlx::Result<Option<Role>> {
    Ok(load(pool, Some(id)).await?.pop())
}

pub async fn name_taken(pool: &PgPool, name: &str) -> sqlx::Result<bool> {
    sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM roles WHERE name = $1) AS "e!""#,
        name
    )
    .fetch_one(pool)
    .await
}

pub async fn clear_default(pool: &PgPool) -> sqlx::Result<()> {
    sqlx::query!(r#"UPDATE roles SET "isDefault" = false, "updatedAt" = now() WHERE "isDefault""#)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn insert(
    pool: &PgPool,
    name: &str,
    permissions: &[String],
    is_default: bool,
) -> sqlx::Result<i32> {
    let permissions = serde_json::to_string(permissions).unwrap_or_default();
    sqlx::query_scalar!(
        r#"INSERT INTO roles (name, permissions, "isDefault") VALUES ($1, $2, $3) RETURNING id"#,
        name,
        permissions,
        is_default
    )
    .fetch_one(pool)
    .await
}

pub async fn update(
    pool: &PgPool,
    id: i32,
    name: Option<&str>,
    permissions: Option<&[String]>,
    is_default: Option<bool>,
) -> sqlx::Result<()> {
    let permissions = permissions.map(|p| serde_json::to_string(p).unwrap_or_default());
    sqlx::query!(
        r#"UPDATE roles SET name = COALESCE($2, name), permissions = COALESCE($3, permissions),
               "isDefault" = COALESCE($4, "isDefault"), "updatedAt" = now() WHERE id = $1"#,
        id,
        name,
        permissions,
        is_default
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Replaces the join set; ids with no library are dropped (`roles.md` rules 6-7).
pub async fn set_libraries(pool: &PgPool, id: i32, library_ids: &[i32]) -> sqlx::Result<()> {
    sqlx::query!(
        r#"DELETE FROM role_default_libraries WHERE "roleId" = $1"#,
        id
    )
    .execute(pool)
    .await?;
    sqlx::query!(
        r#"INSERT INTO role_default_libraries ("roleId", "libraryId")
           SELECT $1, id FROM libraries WHERE id = ANY($2)"#,
        id,
        library_ids
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn user_count(pool: &PgPool, id: i32) -> sqlx::Result<i64> {
    sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM users WHERE "roleId" = $1"#,
        id
    )
    .fetch_one(pool)
    .await
}

pub async fn delete(pool: &PgPool, id: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"DELETE FROM role_default_libraries WHERE "roleId" = $1"#,
        id
    )
    .execute(pool)
    .await?;
    sqlx::query!("DELETE FROM roles WHERE id = $1", id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn plugin_manifests(pool: &PgPool) -> sqlx::Result<Vec<(String, Value)>> {
    let rows = sqlx::query!(
        r#"SELECT "pluginId" AS plugin_id, manifest FROM plugin_packages
           WHERE enabled AND status = 'active'"#
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.plugin_id, r.manifest))
        .collect())
}

/// Admin, User, Readonly when `roles` is empty (`roles.md` rule 11); idempotent.
pub async fn seed(pool: &PgPool) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    let empty = sqlx::query_scalar!(r#"SELECT NOT EXISTS(SELECT 1 FROM roles) AS "e!""#)
        .fetch_one(&mut *tx)
        .await?;
    if empty {
        let admin: Vec<_> = PERMISSIONS.iter().map(|p| p.to_string()).collect();
        let user = ["media.read", "livetv.read", "requests.create"].map(String::from);
        let readonly = ["media.read", "livetv.read"].map(String::from);
        for (name, perms, default) in [
            ("Admin", &admin[..], false),
            ("User", &user[..], true),
            ("Readonly", &readonly[..], false),
        ] {
            let perms = serde_json::to_string(perms).unwrap_or_default();
            sqlx::query!(
                r#"INSERT INTO roles (name, permissions, "isDefault") VALUES ($1, $2, $3)"#,
                name,
                perms,
                default
            )
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await
}
