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

/// A library's root folder (`libraries.md` rule 42).
#[derive(Debug, Clone)]
pub struct Folder {
    pub id: i32,
    pub path: String,
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
    pub folders: Vec<FolderChoice>,
}

/// A folder a user may pick for new files: no path, only its last segment (rule 49).
#[derive(Serialize)]
pub struct FolderChoice {
    pub id: i32,
    pub name: String,
}

/// A library folder with its disk and the number of media living in it (rule 48).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderOut {
    pub id: i32,
    pub path: String,
    pub position: i32,
    pub disk: Disk,
    pub media_count: i64,
}

#[derive(Serialize, Clone)]
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
    pub folders: Vec<FolderOut>,
}

/// Absolute server paths only for callers who can manage libraries.
pub fn paths_visible(perms: &Permissions) -> bool {
    perms.can(Action::Manage, &Subject::Settings)
}

impl Detailed {
    pub fn json(self, paths: bool) -> Value {
        let mut v = serde_json::to_value(self).expect("library serialises");
        if !paths && let Some(o) = v.as_object_mut() {
            o.remove("path");
            o.remove("disk");
            o.remove("folders");
        }
        v
    }
}

pub fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("Library #{id} not found"))
}

/// Byte-order name sort (collation-dependent lists), then `id`.
pub async fn list(db: &PgPool, ids: &[i32]) -> sqlx::Result<Vec<Library>> {
    sqlx::query_as!(
        Library,
        r#"SELECT l.id, l."createdAt" AS created_at, l."updatedAt" AS updated_at, l.name, l.icon, l.color,
        l."mediaTypes" AS "media_types: Json<Vec<String>>", l."preferredProvider" AS preferred_provider,
        "metadataLanguage" AS metadata_language, "metadataRegion" AS metadata_region,
        "defaultQualityProfileId" AS default_quality_profile_id,
        "defaultLanguageProfileId" AS default_language_profile_id,
        df.path AS "path?", NULL::text AS label
        FROM libraries l LEFT JOIN library_default_folders df ON df."libraryId" = l.id
        WHERE l.id = ANY($1) ORDER BY name COLLATE "C", l.id"#,
        ids
    )
    .fetch_all(db)
    .await
}

pub async fn find(db: &PgPool, id: i32) -> sqlx::Result<Option<Library>> {
    Ok(list(db, &[id]).await?.pop())
}

pub async fn summaries(db: &PgPool, ids: &[i32]) -> sqlx::Result<Vec<Summary>> {
    let rows = sqlx::query!(
        r#"SELECT id, name, icon, color, "mediaTypes" AS "media_types: Json<Vec<String>>",
        "defaultQualityProfileId" AS default_quality_profile_id,
        "defaultLanguageProfileId" AS default_language_profile_id
        FROM libraries WHERE id = ANY($1) ORDER BY name COLLATE "C", id"#,
        ids
    )
    .fetch_all(db)
    .await?;
    let mut folders = folder_rows(db, ids).await?;
    Ok(rows
        .into_iter()
        .map(|r| Summary {
            folders: folders
                .remove(&r.id)
                .unwrap_or_default()
                .into_iter()
                .map(|f| FolderChoice {
                    id: f.id,
                    name: super::folders::name_of(&f.path),
                })
                .collect(),
            id: r.id,
            name: r.name,
            icon: r.icon,
            color: r.color,
            media_types: r.media_types,
            default_quality_profile_id: r.default_quality_profile_id,
            default_language_profile_id: r.default_language_profile_id,
        })
        .collect())
}

pub struct FolderRow {
    pub id: i32,
    pub path: String,
    pub position: i32,
}

/// The folders of each library, `position` then `id`.
pub async fn folder_rows(
    db: &PgPool,
    libraries: &[i32],
) -> sqlx::Result<HashMap<i32, Vec<FolderRow>>> {
    let rows = sqlx::query!(
        r#"SELECT id, "libraryId" AS library_id, path, position FROM library_folders
        WHERE "libraryId" = ANY($1) ORDER BY "libraryId", position, id"#,
        libraries
    )
    .fetch_all(db)
    .await?;
    let mut by_library: HashMap<i32, Vec<FolderRow>> = HashMap::new();
    for r in rows {
        by_library.entry(r.library_id).or_default().push(FolderRow {
            id: r.id,
            path: r.path,
            position: r.position,
        });
    }
    Ok(by_library)
}

/// Folders with their disk and media count (rule 48).
pub async fn folders_out(db: &PgPool, rows: Vec<FolderRow>) -> sqlx::Result<Vec<FolderOut>> {
    let ids: Vec<i32> = rows.iter().map(|f| f.id).collect();
    let counts: HashMap<i32, i64> = sqlx::query!(
        r#"SELECT "folderId" AS folder_id, count(DISTINCT "mediaId") AS "n!" FROM media_files
        WHERE "folderId" = ANY($1) GROUP BY "folderId""#,
        &ids
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|r| (r.folder_id, r.n))
    .collect();
    let disks =
        futures_util::future::join_all(rows.iter().map(|f| super::path::disk(&f.path))).await;
    Ok(rows
        .into_iter()
        .zip(disks)
        .map(|(f, disk)| FolderOut {
            media_count: counts.get(&f.id).copied().unwrap_or(0),
            id: f.id,
            path: f.path,
            position: f.position,
            disk,
        })
        .collect())
}

/// `library_user_access.userId` per library, in insertion order.
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
    let mut folders = folder_rows(db, &ids).await?;
    let rows = libraries.into_iter().map(|library| {
        let mine = folders.remove(&library.id).unwrap_or_default();
        let user_ids = users.remove(&library.id).unwrap_or_default();
        async move {
            let folders = folders_out(db, mine).await?;
            Ok(Detailed {
                user_ids,
                disk: folders.first().map(|f| f.disk.clone()),
                library,
                folders,
            })
        }
    });
    futures_util::future::join_all(rows)
        .await
        .into_iter()
        .collect()
}

/// Maps the constraint failures 4.x answered 500 for (rule 38).
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
