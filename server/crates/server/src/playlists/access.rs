//! The playlist row and `assertRole` (`docs/spec/playlists.md` rules 2-6).
use crate::{
    http::{AppError, json::iso_ms},
    social::follows,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Editor,
    Administrator,
    Owner,
}

impl Role {
    pub fn parse(s: &str) -> Self {
        match s {
            "editor" => Self::Editor,
            "administrator" => Self::Administrator,
            _ => Self::Viewer,
        }
    }
}

/// A `playlists` row.
pub struct Playlist {
    pub id: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub owner_id: i32,
    pub auto_remove_watched: bool,
    pub auto_download: bool,
    pub auto_play: bool,
    pub visibility: String,
    pub cover_image_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistView {
    id: i32,
    name: String,
    owner_id: i32,
    role: Role,
    auto_remove_watched: bool,
    auto_download: bool,
    auto_play: bool,
    visibility: String,
    saved: bool,
    cover_image_url: Option<String>,
    item_count: i32,
    posters: Vec<String>,
    #[serde(with = "iso_ms")]
    created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    updated_at: DateTime<Utc>,
}

impl PlaylistView {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn id(&self) -> i32 {
        self.id
    }

    pub fn new(p: Playlist, role: Role, saved: bool, stats: Option<(i32, Vec<String>)>) -> Self {
        let (item_count, posters) = stats.unwrap_or_default();
        Self {
            id: p.id,
            name: p.name,
            owner_id: p.owner_id,
            role,
            auto_remove_watched: p.auto_remove_watched,
            auto_download: p.auto_download,
            auto_play: p.auto_play,
            visibility: p.visibility,
            saved,
            cover_image_url: p.cover_image_url,
            item_count,
            posters,
            created_at: p.created_at,
            updated_at: p.updated_at,
        }
    }
}

pub fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("Playlist #{id} not found"))
}

pub async fn find(db: &PgPool, id: i32) -> sqlx::Result<Option<Playlist>> {
    sqlx::query_as!(
        Playlist,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, "ownerId" AS owner_id,
                  "autoRemoveWatched" AS auto_remove_watched, "autoDownload" AS auto_download,
                  "autoPlay" AS auto_play, visibility::text AS "visibility!",
                  "coverImageUrl" AS cover_image_url
           FROM playlists WHERE id = $1"#,
        id
    )
    .fetch_optional(db)
    .await
}

/// The playlist and the caller's role, 404 for a non-member and 403 below `min`.
/// A share's role wins over the read-only grant of public / followed visibility (C13).
pub async fn assert_role(
    db: &PgPool,
    user: i32,
    id: i32,
    min: Role,
) -> Result<(Playlist, Role), AppError> {
    let playlist = find(db, id).await?.ok_or_else(|| not_found(id))?;
    if playlist.owner_id == user {
        return Ok((playlist, Role::Owner));
    }
    let share = sqlx::query_scalar!(
        r#"SELECT role::text AS "role!" FROM playlist_shares WHERE "playlistId" = $1 AND "userId" = $2"#,
        id,
        user
    )
    .fetch_optional(db)
    .await?;
    let readable = min == Role::Viewer
        && (playlist.visibility == "public"
            || (playlist.visibility == "followers"
                && follows(db, user, playlist.owner_id).await?));
    let role = match share {
        Some(r) => Role::parse(&r),
        None if readable => Role::Viewer,
        None => return Err(not_found(id)),
    };
    if role < min {
        return Err(AppError::forbidden("Insufficient playlist role"));
    }
    Ok((playlist, role))
}
