//! Queries and the `Library` JSON shape (`libraries.md` rules 2-7, SQL section).
use crate::http::{AppError, json::iso_ms};
use chrono::{DateTime, Utc};
use fliks_domain::acl::{Action, Permissions, Subject};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgPool, types::Json};
use std::collections::HashMap;

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
pub struct Summary {
    pub id: i32,
    pub name: String,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub media_types: Json<Vec<String>>,
    pub default_quality_profile_id: Option<i32>,
    pub default_language_profile_id: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub free_space: i64,
    pub total_space: i64,
    pub accessible: bool,
}

/// A library with its access list and disk usage (`LibraryWithDetails`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detailed {
    #[serde(flatten)]
    pub library: Library,
    pub user_ids: Vec<i32>,
    pub disk: Option<Disk>,
}

/// F22: absolute server paths only for callers who can manage libraries.
pub fn paths_visible(perms: &Permissions) -> bool {
    perms.can(Action::Manage, &Subject::Settings)
}

impl Detailed {
    pub fn json(self, paths: bool) -> Value {
        let mut v = serde_json::to_value(self).expect("library serialises");
        if !paths && let Some(o) = v.as_object_mut() {
            o.remove("path");
            o.remove("disk");
        }
        v
    }
}

pub fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("Library #{id} not found"))
}

/// Byte-order name sort (README "Frozen as is": collation-dependent lists), then `id` (C12).
pub async fn list(db: &PgPool, ids: &[i32]) -> sqlx::Result<Vec<Library>> {
    sqlx::query_as!(
        Library,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, icon, color,
        "mediaTypes" AS "media_types: Json<Vec<String>>", "preferredProvider" AS preferred_provider,
        "metadataLanguage" AS metadata_language, "metadataRegion" AS metadata_region,
        "defaultQualityProfileId" AS default_quality_profile_id,
        "defaultLanguageProfileId" AS default_language_profile_id, path, label
        FROM libraries WHERE id = ANY($1) ORDER BY name COLLATE "C", id"#,
        ids
    )
    .fetch_all(db)
    .await
}

pub async fn find(db: &PgPool, id: i32) -> sqlx::Result<Option<Library>> {
    Ok(list(db, &[id]).await?.pop())
}

pub async fn summaries(db: &PgPool, ids: &[i32]) -> sqlx::Result<Vec<Summary>> {
    sqlx::query_as!(
        Summary,
        r#"SELECT id, name, icon, color, "mediaTypes" AS "media_types: Json<Vec<String>>",
        "defaultQualityProfileId" AS default_quality_profile_id,
        "defaultLanguageProfileId" AS default_language_profile_id
        FROM libraries WHERE id = ANY($1) ORDER BY name COLLATE "C", id"#,
        ids
    )
    .fetch_all(db)
    .await
}

/// `library_user_access.userId` per library, in insertion order (C12).
pub async fn user_ids(db: &PgPool, libraries: &[i32]) -> sqlx::Result<HashMap<i32, Vec<i32>>> {
    let rows = sqlx::query!(
        r#"SELECT "libraryId" AS "library_id!", "userId" AS "user_id!" FROM library_user_access
        WHERE "libraryId" = ANY($1) ORDER BY id"#,
        libraries
    )
    .fetch_all(db)
    .await?;
    let mut by_library: HashMap<i32, Vec<i32>> = HashMap::new();
    for r in rows {
        by_library.entry(r.library_id).or_default().push(r.user_id);
    }
    Ok(by_library)
}

pub async fn detail(db: &PgPool, libraries: Vec<Library>) -> sqlx::Result<Vec<Detailed>> {
    let ids: Vec<i32> = libraries.iter().map(|l| l.id).collect();
    let mut users = user_ids(db, &ids).await?;
    let disks = futures_util::future::join_all(
        libraries
            .iter()
            .map(|l| async { Some(super::path::disk(l.path.as_deref()?).await) }),
    )
    .await;
    Ok(libraries
        .into_iter()
        .zip(disks)
        .map(|(library, disk)| Detailed {
            user_ids: users.remove(&library.id).unwrap_or_default(),
            library,
            disk,
        })
        .collect())
}

/// Maps the constraint failures Nest answered 500 for (C1, rule 38).
pub fn constraint(e: sqlx::Error) -> AppError {
    let Some(d) = e.as_database_error() else {
        return e.into();
    };
    match (d.code().as_deref(), d.constraint().unwrap_or_default()) {
        (Some("23505"), _) => AppError::conflict("Library name already taken"),
        (Some("23503"), "FK_1127dccf41a2959b675a0aa8891") => AppError::bad_request(vec![
            "defaultQualityProfileId must reference an existing quality profile",
        ]),
        (Some("23503"), _) => AppError::bad_request(vec![
            "defaultLanguageProfileId must reference an existing language profile",
        ]),
        (Some("22001"), _) => AppError::bad_request(vec!["a value is too long"]),
        _ => e.into(),
    }
}
