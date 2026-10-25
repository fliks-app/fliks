use super::{
    db::{self, PublicUser, not_found},
    dto::{CreateUser, UpdateUser},
};
use crate::{
    http::{
        AppError,
        auth::{Authed, UserRow},
        validate::{PathParams, ValidJson, int_param},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, FromRequest, Multipart, Request, State, multipart::MultipartRejection,
    },
    http::StatusCode,
    routing::{get, post},
};
use fliks_domain::acl::{Action, Subject};
use serde_json::Value;
use sqlx::{PgPool, types::Json as Jsonb};
use std::path::PathBuf;

const AVATAR_MAX: usize = 5 * 1024 * 1024;
const BCRYPT_COST: u32 = 12;
const MSG_ROLE_ASSIGN: &str = "Only users with roles.manage permission can assign a role";
const MSG_ROLE_CHANGE: &str = "Only users with roles.manage permission can change a role";
const MSG_MANAGED: &str =
    "Only users with users.manage permission can change role or enabled status";
const MSG_LIBRARIES: &str = "Only users with users.manage permission can change library access";

pub fn router() -> Router<AppState> {
    let avatar = post(set_avatar)
        .delete(clear_avatar)
        .layer(DefaultBodyLimit::max(AVATAR_MAX + 64 * 1024));
    Router::new()
        .route("/api/users", get(list).post(create))
        .route("/api/users/me/avatar", avatar)
        .route("/api/users/{id}", get(get_one).put(update).delete(remove))
        .route("/api/users/{id}/stats", get(stats))
}

fn forbidden() -> AppError {
    AppError::bare(StatusCode::FORBIDDEN)
}

/// Canonical integer on the raw segment, parsed after the policy check.
async fn body<T: serde::de::DeserializeOwned>(req: Request) -> Result<T, AppError> {
    let ValidJson(dto) = ValidJson::<T>::from_request(req, &()).await?;
    Ok(dto)
}

async fn hash(password: String) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || bcrypt::hash(password, BCRYPT_COST))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
        .map_err(|e| AppError::internal(e.to_string()))
}

/// Engine revoke is fire-and-forget (rule 26).
fn revoke_in_background(st: &AppState, id: i32) {
    let engine = st.engine.clone();
    tokio::spawn(async move { engine.revoke_owner(id).await });
}

async fn public(db: &PgPool, id: i32) -> Result<Json<PublicUser>, AppError> {
    db::find_one(db, id)
        .await?
        .map(Json)
        .ok_or_else(|| not_found(id))
}

#[utoipa::path(get, path = "/api/users", responses((status = 200)))]
pub async fn list(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<Vec<PublicUser>>, AppError> {
    a.require(Action::Manage, Subject::User)?;
    Ok(Json(db::list(&st.db).await?))
}

#[utoipa::path(post, path = "/api/users", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Result<(StatusCode, Json<PublicUser>), AppError> {
    a.require(Action::Manage, Subject::User)?;
    let dto: CreateUser = body(req).await?;
    dto.validate()?;
    let mut tx = st.db.begin().await?;
    if db::username_taken(&mut tx, &dto.username, None).await? {
        return Err(AppError::conflict("Username already taken"));
    }
    if dto.role_id.is_some() && !a.perms.can(Action::Manage, &Subject::Role) {
        return Err(AppError::forbidden(MSG_ROLE_ASSIGN));
    }
    if dto.is_admin == Some(true) && !a.user.is_admin {
        return Err(forbidden());
    }
    // A falsy or unknown roleId falls back to the default role.
    let wanted = dto.role_id.flatten().filter(|r| *r != 0);
    let role = sqlx::query_scalar!(
        r#"SELECT "id" FROM roles WHERE "id" = $1 OR ($1::int IS NULL AND "isDefault")
           ORDER BY ("id" = $1) DESC LIMIT 1"#,
        wanted
    )
    .fetch_optional(&mut *tx)
    .await?;
    let role = match role {
        Some(r) => Some(r),
        None => {
            sqlx::query_scalar!(r#"SELECT "id" FROM roles WHERE "isDefault" LIMIT 1"#)
                .fetch_optional(&mut *tx)
                .await?
        }
    };
    let password = hash(dto.password).await?;
    let id = sqlx::query_scalar!(
        r#"INSERT INTO users (username, "passwordHash", email, "roleId", "isAdmin", enabled)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id"#,
        dto.username,
        password,
        dto.email.flatten(),
        role,
        dto.is_admin.unwrap_or(false),
        dto.enabled.unwrap_or(true)
    )
    .fetch_one(&mut *tx)
    .await?;
    let libraries = match dto.library_ids {
        Some(ids) => ids,
        None => match role {
            Some(r) => {
                sqlx::query_scalar!(
                    r#"SELECT "libraryId" FROM role_default_libraries WHERE "roleId" = $1 ORDER BY "libraryId""#,
                    r
                )
                .fetch_all(&mut *tx)
                .await?
            }
            None => vec![],
        },
    };
    db::add_library_access(&mut tx, id, &libraries).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, public(&st.db, id).await?))
}

#[utoipa::path(get, path = "/api/users/{id}", responses((status = 200)))]
pub async fn get_one(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Result<Json<PublicUser>, AppError> {
    a.require(Action::Read, Subject::User)?;
    let id = int_param(&id)?;
    if a.user.id != id && !a.perms.can(Action::Manage, &Subject::User) {
        return Err(forbidden());
    }
    public(&st.db, id).await
}

#[utoipa::path(put, path = "/api/users/{id}", responses((status = 200)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
    req: Request,
) -> Result<Json<PublicUser>, AppError> {
    a.require(Action::Update, Subject::User)?;
    let id = int_param(&id)?;
    let dto: UpdateUser = body(req).await?;
    dto.validate()?;
    let is_self = a.user.id == id;

    let mut tx = st.db.begin().await?;
    let target: UserRow = db::lock_user(&mut tx, id)
        .await?
        .ok_or_else(|| not_found(id))?;
    authorize_update(&a, &dto, &target)?;
    let role_changing = dto.role_id.is_some_and(|r| r != target.role_id);
    let admin_changing = dto.is_admin.is_some_and(|v| v != target.is_admin);
    let enabled_changing = dto.enabled.is_some_and(|v| v != target.enabled);
    let new_enabled = dto.enabled.unwrap_or(target.enabled);
    let new_admin = dto.is_admin.unwrap_or(target.is_admin);
    if target.is_admin
        && target.enabled
        && !(new_enabled && new_admin)
        && db::is_last_enabled_admin(&mut tx, id).await?
    {
        return Err(AppError::conflict("Cannot remove the last enabled admin"));
    }
    if let Some(name) = &dto.username
        && db::username_taken(&mut tx, name, Some(id)).await?
    {
        return Err(AppError::conflict("Username already taken"));
    }

    let mut t = target.clone();
    let password_changed = dto.password.is_some();
    if password_changed && is_self {
        t.require_password_change = false;
    }
    let hashed = match dto.password.clone() {
        Some(p) => Some(hash(p).await?),
        None => None,
    };
    merge_fields(&mut t, &dto);
    save_user(&mut tx, id, &t, hashed.as_deref()).await?;
    if dto.share_disabled == Some(true) && !target.share_disabled {
        crate::social::leave_social(&mut tx, id).await?;
    }
    if let Some(ids) = &dto.library_ids {
        db::replace_library_access(&mut tx, id, ids).await?;
    }
    tx.commit().await?;

    if role_changing || enabled_changing || password_changed {
        st.hub.drop_connections_for_user(id);
    }
    if password_changed {
        // The caller keeps working on its access token until it expires.
        db::revoke_other_families(&st.db, id, None).await?;
    }
    if dto.enabled == Some(false) || role_changing || admin_changing || dto.library_ids.is_some() {
        revoke_in_background(&st, id);
    }
    public(&st.db, id).await
}

/// Who may change what on `target`, before any write.
fn authorize_update(a: &Authed, dto: &UpdateUser, target: &UserRow) -> Result<(), AppError> {
    let is_self = a.user.id == target.id;
    let is_manager = a.perms.can(Action::Manage, &Subject::User);
    let is_admin = a.user.is_admin;
    if !is_self && !is_manager {
        return Err(forbidden());
    }
    if target.is_admin && !is_admin {
        return Err(forbidden());
    }
    let role_changing = dto.role_id.is_some_and(|r| r != target.role_id);
    let admin_changing = dto.is_admin.is_some_and(|v| v != target.is_admin);
    if !is_manager && dto.has_managed_field() {
        return Err(AppError::forbidden(MSG_MANAGED));
    }
    if role_changing && !a.perms.can(Action::Manage, &Subject::Role) {
        return Err(AppError::forbidden(MSG_ROLE_CHANGE));
    }
    if admin_changing && !is_admin {
        return Err(forbidden());
    }
    let quota = [
        dto.movie_quota_limit,
        dto.series_quota_limit,
        dto.quota_period_days,
    ];
    if !is_manager && quota.iter().any(Option::is_some) {
        return Err(forbidden());
    }
    if !is_manager && dto.library_ids.is_some() {
        return Err(AppError::forbidden(MSG_LIBRARIES));
    }
    Ok(())
}

fn merge_fields(t: &mut UserRow, dto: &UpdateUser) {
    macro_rules! set {
        ($($f:ident),*) => { $( if let Some(v) = dto.$f.clone() { t.$f = v; } )* };
    }
    set!(
        username,
        email,
        role_id,
        is_admin,
        enabled,
        require_password_change,
        movie_quota_limit,
        series_quota_limit,
        quota_period_days,
        profile_visibility,
        share_tastes,
        share_recommendations,
        share_watch_history,
        share_likes,
        share_stats,
        share_disabled,
        hide_spoilers,
        edl_enabled,
        edl_auto_skip_commercials,
        spoiler_hide_stills,
        spoiler_hide_overviews,
        spoiler_hide_titles
    );
    if let Some(v) = dto.library_order.clone() {
        t.library_order = Jsonb(v);
    }
    if let Some(v) = dto.hidden_library_ids.clone() {
        t.hidden_library_ids = Jsonb(v);
    }
}

async fn save_user(
    tx: &mut sqlx::PgConnection,
    id: i32,
    t: &UserRow,
    hashed: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"UPDATE users SET "username" = $2, "email" = $3,
        "passwordHash" = COALESCE($4, "passwordHash"), "roleId" = $5, "isAdmin" = $6, "enabled" = $7,
        "requirePasswordChange" = $8, "movieQuotaLimit" = $9, "seriesQuotaLimit" = $10,
        "quotaPeriodDays" = $11, "libraryOrder" = $12, "hiddenLibraryIds" = $13,
        "profileVisibility" = $14::text::users_profilevisibility_enum, "shareTastes" = $15,
        "shareRecommendations" = $16, "shareWatchHistory" = $17, "shareLikes" = $18, "shareStats" = $19,
        "shareDisabled" = $20, "hideSpoilers" = $21, "edlEnabled" = $22, "edlAutoSkipCommercials" = $23,
        "spoilerHideStills" = $24, "spoilerHideOverviews" = $25, "spoilerHideTitles" = $26,
        "updatedAt" = now() WHERE "id" = $1"#,
        id,
        &t.username,
        t.email.as_deref(),
        hashed,
        t.role_id,
        t.is_admin,
        t.enabled,
        t.require_password_change,
        t.movie_quota_limit,
        t.series_quota_limit,
        t.quota_period_days,
        &t.library_order as _,
        &t.hidden_library_ids as _,
        &t.profile_visibility,
        t.share_tastes,
        t.share_recommendations,
        t.share_watch_history,
        t.share_likes,
        t.share_stats,
        t.share_disabled,
        t.hide_spoilers,
        t.edl_enabled,
        t.edl_auto_skip_commercials,
        t.spoiler_hide_stills,
        t.spoiler_hide_overviews,
        t.spoiler_hide_titles
    )
        .execute(&mut *tx)
        .await?;
    Ok(())
}

#[utoipa::path(delete, path = "/api/users/{id}", responses((status = 200)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Result<(), AppError> {
    a.require(Action::Manage, Subject::User)?;
    let id = int_param(&id)?;
    let mut tx = st.db.begin().await?;
    let target = db::lock_user(&mut tx, id)
        .await?
        .ok_or_else(|| not_found(id))?;
    if target.is_admin && !a.user.is_admin {
        return Err(forbidden());
    }
    if target.is_admin && target.enabled && db::is_last_enabled_admin(&mut tx, id).await? {
        return Err(AppError::conflict("Cannot remove the last enabled admin"));
    }
    sqlx::query!("DELETE FROM users WHERE id = $1", id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    st.hub.drop_connections_for_user(id);
    revoke_in_background(&st, id);
    Ok(())
}

#[utoipa::path(get, path = "/api/users/{id}/stats", responses((status = 200)))]
pub async fn stats(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Manage, Subject::User)?;
    let id = int_param(&id)?;
    crate::social::user_stats(&st.db, id)
        .await?
        .map(Json)
        .ok_or_else(|| not_found(id))
}

fn avatar_path(id: i32, suffix: &str) -> PathBuf {
    crate::paths::data_dir()
        .join("users")
        .join(format!("{id}{suffix}"))
}

async fn set_avatar_url(db: &PgPool, id: i32, url: Option<String>) -> Result<(), AppError> {
    let done = sqlx::query!(
        r#"UPDATE users SET avatar = $1, "updatedAt" = now() WHERE id = $2"#,
        url,
        id
    )
    .execute(db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(not_found(id));
    }
    Ok(())
}

fn upload_error(e: impl std::fmt::Display) -> AppError {
    tracing::warn!(error = %e, "avatar upload failed");
    AppError::bad_request("No image uploaded")
}

#[utoipa::path(post, path = "/api/users/me/avatar", responses((status = 201)))]
pub async fn set_avatar(
    State(st): State<AppState>,
    a: Authed,
    multipart: Result<Multipart, MultipartRejection>,
) -> Result<(StatusCode, Json<PublicUser>), AppError> {
    let mut multipart = multipart.map_err(upload_error)?;
    let mut file: Option<(Option<String>, Vec<u8>)> = None;
    while let Some(mut field) = multipart.next_field().await.map_err(upload_error)? {
        if field.file_name().is_none() {
            continue;
        }
        let name = field.name().unwrap_or_default().to_owned();
        if name != "file" {
            return Err(AppError::bad_request(format!("Unexpected field - {name}")));
        }
        let mime = field.content_type().map(str::to_owned);
        let mut bytes = Vec::new();
        while let Some(chunk) = field.chunk().await.map_err(upload_error)? {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > AVATAR_MAX {
                return Err(AppError::payload_too_large("File too large"));
            }
        }
        file.get_or_insert((mime, bytes));
    }
    let Some((mime, bytes)) = file.filter(|(_, b)| !b.is_empty()) else {
        return Err(AppError::bad_request("No image uploaded"));
    };
    if mime.as_deref() != Some("image/jpeg") {
        return Err(AppError::bad_request("Avatar must be a JPEG image"));
    }
    let id = a.user.id;
    let dest = avatar_path(id, ".jpg");
    let io = |e: std::io::Error| AppError::internal(e.to_string());
    tokio::fs::create_dir_all(dest.parent().expect("avatar dir"))
        .await
        .map_err(io)?;
    tokio::fs::write(&dest, bytes).await.map_err(io)?;
    let version = chrono::Utc::now().timestamp_millis();
    set_avatar_url(
        &st.db,
        id,
        Some(format!("/api/images/user/{id}?v={version}")),
    )
    .await?;
    Ok((StatusCode::CREATED, public(&st.db, id).await?))
}

#[utoipa::path(delete, path = "/api/users/me/avatar", responses((status = 200)))]
pub async fn clear_avatar(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<PublicUser>, AppError> {
    let id = a.user.id;
    set_avatar_url(&st.db, id, None).await?;
    for suffix in [".jpg", "-thumb.jpg", "-medium.jpg", ".src.json"] {
        if let Err(e) = tokio::fs::remove_file(avatar_path(id, suffix)).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(user = id, error = %e, "avatar file removal failed");
        }
    }
    public(&st.db, id).await
}

#[cfg(test)]
mod tests {
    /// 4.x verifies only `$2a$`/`$2b$` hashes, so `$2b$` must keep being written.
    #[tokio::test]
    async fn bcrypt_matches_v4() {
        let h = super::hash("pass".into()).await.unwrap();
        assert!(h.starts_with("$2b$12$") && bcrypt::verify("pass", &h).unwrap());
        let v4_hash = "$2b$12$uz0IJTjIwyn42EOSchUXwuIceXfuXd3h0I9fNbV7SQKT4VkmTuZly";
        assert!(bcrypt::verify("nest-pass", v4_hash).unwrap());
        assert!(bcrypt::verify("nest-pass", &v4_hash.replace("$2b$", "$2a$")).unwrap());
    }
}
