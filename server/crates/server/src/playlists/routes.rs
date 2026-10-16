//! Playlist CRUD, saves and members (`docs/spec/playlists.md` rules 7-27, 36).
use super::{
    access::{PlaylistView, Role, assert_role},
    view::{list_for, view_for},
};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    social::{follows, require_user},
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

const NAME_MAX: usize = 255;

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Visibility {
    Private,
    Followers,
    Public,
}

impl Visibility {
    fn as_str(self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::Followers => "followers",
            Self::Public => "public",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateDto {
    name: String,
    auto_remove_watched: Option<bool>,
    auto_download: Option<bool>,
    auto_play: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateDto {
    name: Option<String>,
    auto_remove_watched: Option<bool>,
    auto_download: Option<bool>,
    auto_play: Option<bool>,
    visibility: Option<Visibility>,
}

fn check_name(name: Option<&str>) -> Result<(), AppError> {
    match name {
        Some(n) if n.chars().count() > NAME_MAX => Err(AppError::bad_request(vec![format!(
            "name must be shorter than or equal to {NAME_MAX} characters"
        )])),
        _ => Ok(()),
    }
}

fn sharing_disabled() -> AppError {
    AppError::bad_request("Sharing features are disabled")
}

#[utoipa::path(get, path = "/api/playlists", responses((status = 200)))]
pub async fn list(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<Vec<PlaylistView>>, AppError> {
    Ok(Json(list_for(&st.db, &a).await?))
}

#[utoipa::path(post, path = "/api/playlists", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(dto): ValidJson<CreateDto>,
) -> Result<(StatusCode, Json<PlaylistView>), AppError> {
    check_name(Some(&dto.name))?;
    let id = sqlx::query_scalar!(
        r#"INSERT INTO playlists (name, "ownerId", "autoRemoveWatched", "autoDownload", "autoPlay")
           VALUES ($1, $2, $3, $4, $5) RETURNING id"#,
        dto.name.trim(),
        a.user.id,
        dto.auto_remove_watched.unwrap_or(false),
        dto.auto_download.unwrap_or(false),
        dto.auto_play.unwrap_or(false)
    )
    .fetch_one(&st.db)
    .await?;
    Ok((StatusCode::CREATED, Json(view_for(&st.db, &a, id).await?)))
}

#[utoipa::path(get, path = "/api/playlists/{id}", responses((status = 200)))]
pub async fn get_one(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Result<Json<PlaylistView>, AppError> {
    Ok(Json(view_for(&st.db, &a, id).await?))
}

#[utoipa::path(patch, path = "/api/playlists/{id}", responses((status = 200)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
    ValidJson(dto): ValidJson<UpdateDto>,
) -> Result<Json<PlaylistView>, AppError> {
    check_name(dto.name.as_deref())?;
    assert_role(&st.db, a.user.id, id, Role::Administrator).await?;
    if a.user.share_disabled
        && dto
            .visibility
            .is_some_and(|v| !matches!(v, Visibility::Private))
    {
        return Err(sharing_disabled());
    }
    let patch = dto.name.is_some()
        || dto.auto_remove_watched.is_some()
        || dto.auto_download.is_some()
        || dto.auto_play.is_some()
        || dto.visibility.is_some();
    if patch {
        sqlx::query!(
            r#"UPDATE playlists SET
                 name = COALESCE($2, name),
                 "autoRemoveWatched" = COALESCE($3, "autoRemoveWatched"),
                 "autoDownload" = COALESCE($4, "autoDownload"),
                 "autoPlay" = COALESCE($5, "autoPlay"),
                 visibility = COALESCE($6::text::playlists_visibility_enum, visibility),
                 "updatedAt" = now()
               WHERE id = $1"#,
            id,
            dto.name.as_deref().map(str::trim),
            dto.auto_remove_watched,
            dto.auto_download,
            dto.auto_play,
            dto.visibility.map(Visibility::as_str)
        )
        .execute(&st.db)
        .await?;
    }
    Ok(Json(view_for(&st.db, &a, id).await?))
}

#[utoipa::path(delete, path = "/api/playlists/{id}", responses((status = 200)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Result<(), AppError> {
    let (_, role) = assert_role(&st.db, a.user.id, id, Role::Viewer).await?;
    if role != Role::Owner {
        return Err(AppError::forbidden("Only the owner can delete a playlist"));
    }
    sqlx::query!("DELETE FROM playlists WHERE id = $1", id)
        .execute(&st.db)
        .await?;
    Ok(())
}

#[utoipa::path(post, path = "/api/playlists/{id}/save", responses((status = 201)))]
pub async fn save(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    if a.user.share_disabled {
        return Err(sharing_disabled());
    }
    let (_, role) = assert_role(&st.db, a.user.id, id, Role::Viewer).await?;
    if role == Role::Owner {
        return Err(AppError::bad_request("You already own this playlist"));
    }
    sqlx::query!(
        r#"INSERT INTO playlist_saves ("userId", "playlistId") VALUES ($1, $2)
           ON CONFLICT ("userId", "playlistId") DO NOTHING"#,
        a.user.id,
        id
    )
    .execute(&st.db)
    .await?;
    Ok(StatusCode::CREATED)
}

#[utoipa::path(delete, path = "/api/playlists/{id}/save", responses((status = 200)))]
pub async fn unsave(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Result<(), AppError> {
    sqlx::query!(
        r#"DELETE FROM playlist_saves WHERE "userId" = $1 AND "playlistId" = $2"#,
        a.user.id,
        id
    )
    .execute(&st.db)
    .await?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    user_id: i32,
    username: String,
    avatar: Option<String>,
    role: Role,
}

/// The owner, then the share holders by share id (rule 17).
async fn roster(db: &PgPool, playlist: i32, owner: i32) -> sqlx::Result<Vec<Member>> {
    let owner = sqlx::query!("SELECT username, avatar FROM users WHERE id = $1", owner)
        .fetch_optional(db)
        .await?
        .map(|o| Member {
            user_id: owner,
            username: o.username,
            avatar: o.avatar,
            role: Role::Owner,
        });
    let shares = sqlx::query!(
        r#"SELECT u.id, u.username, u.avatar, ps.role::text AS "role!"
           FROM playlist_shares ps JOIN users u ON u.id = ps."userId"
           WHERE ps."playlistId" = $1 ORDER BY ps.id"#,
        playlist
    )
    .fetch_all(db)
    .await?;
    Ok(owner
        .into_iter()
        .chain(shares.into_iter().map(|s| Member {
            user_id: s.id,
            username: s.username,
            avatar: s.avatar,
            role: Role::parse(&s.role),
        }))
        .collect())
}

#[utoipa::path(get, path = "/api/playlists/{id}/members", responses((status = 200)))]
pub async fn members(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Result<Json<Vec<Member>>, AppError> {
    let (p, _) = assert_role(&st.db, a.user.id, id, Role::Viewer).await?;
    Ok(Json(roster(&st.db, id, p.owner_id).await?))
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum ShareRole {
    Viewer,
    Editor,
    Administrator,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddMemberDto {
    user_id: i32,
    role: ShareRole,
}

#[utoipa::path(post, path = "/api/playlists/{id}/members", responses((status = 201)))]
pub async fn add_member(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
    ValidJson(dto): ValidJson<AddMemberDto>,
) -> Result<(StatusCode, Json<Vec<Member>>), AppError> {
    let (p, _) = assert_role(&st.db, a.user.id, id, Role::Administrator).await?;
    if a.user.share_disabled {
        return Err(sharing_disabled());
    }
    if dto.user_id == a.user.id {
        return Err(AppError::bad_request("Cannot change your own role"));
    }
    if dto.user_id == p.owner_id {
        return Err(AppError::bad_request("The owner is already a member"));
    }
    let target = require_user(&st.db, dto.user_id).await?;
    if target.share_disabled {
        return Err(crate::social::user_not_found(target.id));
    }
    if !(target.public || follows(&st.db, a.user.id, target.id).await?) {
        return Err(AppError::forbidden(
            "You can only add public members or members you follow",
        ));
    }
    let role = match dto.role {
        ShareRole::Viewer => "viewer",
        ShareRole::Editor => "editor",
        ShareRole::Administrator => "administrator",
    };
    sqlx::query!(
        r#"INSERT INTO playlist_shares ("playlistId", "userId", role)
           VALUES ($1, $2, $3::text::playlist_shares_role_enum)
           ON CONFLICT ("playlistId", "userId") DO UPDATE SET role = EXCLUDED.role, "updatedAt" = now()"#,
        id,
        target.id,
        role
    )
    .execute(&st.db)
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(roster(&st.db, id, p.owner_id).await?),
    ))
}

#[utoipa::path(delete, path = "/api/playlists/{id}/members/{userId}", responses((status = 200)))]
pub async fn remove_member(
    State(st): State<AppState>,
    a: Authed,
    PathParams((id, user)): PathParams<(i32, i32)>,
) -> Result<Json<Vec<Member>>, AppError> {
    let (p, _) = assert_role(&st.db, a.user.id, id, Role::Administrator).await?;
    if user == a.user.id {
        return Err(AppError::bad_request("Cannot change your own membership"));
    }
    if user == p.owner_id {
        return Err(AppError::bad_request("Cannot remove the owner"));
    }
    sqlx::query!(
        r#"DELETE FROM playlist_shares WHERE "playlistId" = $1 AND "userId" = $2"#,
        id,
        user
    )
    .execute(&st.db)
    .await?;
    Ok(Json(roster(&st.db, id, p.owner_id).await?))
}
