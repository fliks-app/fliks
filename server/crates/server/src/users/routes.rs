use super::{
    db::{self, PublicUser, not_found},
    dto::{CreateUser, UpdateUser},
};
use crate::{
    http::{
        AppError,
        auth::{Authed, UserRow},
        validate::{PathParams, ValidJson},
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
use serde_json::{Value, json};
use sqlx::{PgPool, types::Json as Jsonb};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

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

/// `ParseIntPipe` on the raw segment, after the policy check as Nest's guards run before pipes.
fn parse_id(raw: &str) -> Result<i32, AppError> {
    let digits = raw.strip_prefix('-').unwrap_or(raw);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::bad_request(
            "Validation failed (numeric string is expected)",
        ));
    }
    // Beyond the column range no row exists, so it is the same 404 as any unknown id.
    raw.parse::<i32>()
        .map_err(|_| AppError::not_found(format!("User #{raw} not found")))
}

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

async fn drop_connections(st: &AppState, id: i32) {
    if let Err(e) = st.bridge.drop_connections(id, None).await {
        tracing::warn!(user = id, error = %e, "dropping SSE connections failed");
    }
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
    let id = parse_id(&id)?;
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
    let id = parse_id(&id)?;
    let dto: UpdateUser = body(req).await?;
    dto.validate()?;
    let is_self = a.user.id == id;
    let is_manager = a.perms.can(Action::Manage, &Subject::User);
    let is_admin = a.user.is_admin;

    let mut tx = st.db.begin().await?;
    let target: UserRow = db::lock_user(&mut tx, id)
        .await?
        .ok_or_else(|| not_found(id))?;
    if !is_self && !is_manager {
        return Err(forbidden());
    }
    // F10
    if target.is_admin && !is_admin {
        return Err(forbidden());
    }
    let role_changing = dto.role_id.is_some_and(|r| r != target.role_id);
    let admin_changing = dto.is_admin.is_some_and(|v| v != target.is_admin);
    let enabled_changing = dto.enabled.is_some_and(|v| v != target.enabled);
    if !is_manager && dto.has_managed_field() {
        return Err(AppError::forbidden(MSG_MANAGED));
    }
    if role_changing && !a.perms.can(Action::Manage, &Subject::Role) {
        return Err(AppError::forbidden(MSG_ROLE_CHANGE));
    }
    if admin_changing && !is_admin {
        return Err(forbidden());
    }
    // F11, C2
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
    let hashed = match dto.password {
        Some(p) => Some(hash(p).await?),
        None => None,
    };
    macro_rules! set {
        ($($f:ident),*) => { $( if let Some(v) = dto.$f { t.$f = v; } )* };
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
    if let Some(v) = dto.library_order {
        t.library_order = Jsonb(v);
    }
    if let Some(v) = dto.hidden_library_ids {
        t.hidden_library_ids = Jsonb(v);
    }
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
    if dto.share_disabled == Some(true) && !target.share_disabled {
        db::social_teardown(&mut tx, id).await?;
    }
    if let Some(ids) = &dto.library_ids {
        db::replace_library_access(&mut tx, id, ids).await?;
    }
    tx.commit().await?;

    if role_changing || enabled_changing || password_changed {
        drop_connections(&st, id).await;
    }
    if password_changed {
        // F9: the caller keeps working on its access token until it expires.
        db::revoke_other_families(&st.db, id, None).await?;
    }
    if dto.enabled == Some(false) || role_changing || admin_changing || dto.library_ids.is_some() {
        revoke_in_background(&st, id);
    }
    public(&st.db, id).await
}

#[utoipa::path(delete, path = "/api/users/{id}", responses((status = 200)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Result<(), AppError> {
    a.require(Action::Manage, Subject::User)?;
    let id = parse_id(&id)?;
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
    // F17
    drop_connections(&st, id).await;
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
    let id = parse_id(&id)?;
    let user = sqlx::query!(
        r#"SELECT "lastLogin", "createdAt" FROM users WHERE id = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| not_found(id))?;
    let (last_login, created) = (user.lastLogin, user.createdAt);
    let p = sqlx::query!(
        r#"SELECT ROUND(COALESCE(SUM(CASE WHEN ps."playedAt" IS NOT NULL THEN ps."positionSeconds" ELSE 0 END), 0)::numeric)::bigint AS "total_watch_time_seconds!",
                  COUNT(DISTINCT CASE WHEN ps.completed AND media.type = 'movie' THEN ps."mediaId" END) AS "movies_watched!",
                  COUNT(DISTINCT CASE WHEN ps.completed AND media.type = 'series' THEN ps."mediaId" END) AS "series_started!",
                  COUNT(DISTINCT CASE WHEN ps.completed AND ps."episodeId" IS NOT NULL THEN ps."episodeId" END) AS "episodes_watched!",
                  MAX(ps."lastPlayedAt") AS last_played_at
           FROM playback_states ps LEFT JOIN media ON media.id = ps."mediaId"
           WHERE ps."userId" = $1"#,
        id
    )
    .fetch_one(&st.db)
    .await?;
    let counts = sqlx::query!(
        r#"SELECT r.status::text AS "status!", COUNT(*) AS "count!" FROM requests r WHERE r."userId" = $1 GROUP BY r.status"#,
        id
    )
    .fetch_all(&st.db)
    .await?;
    let n = |s: &str| counts.iter().find(|c| c.status == s).map_or(0, |c| c.count);
    let iso =
        |d: chrono::DateTime<chrono::Utc>| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Ok(Json(json!({
        "playback": {
            "totalWatchTimeSeconds": p.total_watch_time_seconds,
            "moviesWatched": p.movies_watched,
            "seriesStarted": p.series_started,
            "episodesWatched": p.episodes_watched,
            "lastPlayedAt": p.last_played_at.map(iso),
        },
        "requests": {"pending": n("pending"), "approved": n("approved"), "declined": n("declined")},
        "activity": {"lastActiveAt": last_login.map(iso), "memberSince": iso(created)},
    })))
}

/// `FLIKS_DATA_DIR`, else the deprecated `FLIKS_IMAGES_DIR`, else `./images` when present, else `./data`.
fn intended_data_dir() -> PathBuf {
    let env = |k| {
        std::env::var(k)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    env("FLIKS_DATA_DIR")
        .or_else(|| env("FLIKS_IMAGES_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let legacy = PathBuf::from("images");
            if legacy.exists() {
                legacy
            } else {
                PathBuf::from("data")
            }
        })
}

/// Nest's `getDataDir`: the first candidate a `.probe` file can be written to, else the temp fallback; resolved once.
fn data_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let fallback = std::env::temp_dir().join("fliks-data");
        let writable = |d: &Path| {
            let probe = d.join(".probe");
            std::fs::create_dir_all(d).is_ok()
                && std::fs::File::create(&probe).is_ok()
                && std::fs::remove_file(probe).is_ok()
        };
        let dir = intended_data_dir();
        if writable(&dir) {
            return dir;
        }
        tracing::warn!(dir = %dir.display(), "data directory not writable: avatars go to {}", fallback.display());
        fallback
    })
}

fn avatar_path(id: i32, suffix: &str) -> PathBuf {
    data_dir().join("users").join(format!("{id}{suffix}"))
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

/// Boot seed (rule 7): an empty `users` table gets `admin` / `password` (F1 keeps it).
pub async fn seed_admin(db: &PgPool) -> Result<(), AppError> {
    let empty = sqlx::query_scalar!(r#"SELECT NOT EXISTS(SELECT 1 FROM users) AS "empty!""#)
        .fetch_one(db)
        .await?;
    if !empty {
        return Ok(());
    }
    let password = hash("password".into()).await?;
    sqlx::query!(
        r#"INSERT INTO users (username, "passwordHash", "isAdmin", enabled) VALUES ('admin', $1, true, true)"#,
        password
    )
    .execute(db)
    .await?;
    tracing::warn!("no users: created default admin 'admin' with password 'password'");
    tracing::warn!("change the default admin password now");
    Ok(())
}

#[cfg(test)]
mod tests {
    /// Nest's `bcrypt` 6 verifies only `$2a$`/`$2b$`, so Rust must keep writing `$2b$`.
    #[tokio::test]
    async fn bcrypt_matches_nest() {
        let h = super::hash("pass".into()).await.unwrap();
        assert!(h.starts_with("$2b$12$") && bcrypt::verify("pass", &h).unwrap());
        let nest = "$2b$12$uz0IJTjIwyn42EOSchUXwuIceXfuXd3h0I9fNbV7SQKT4VkmTuZly";
        assert!(bcrypt::verify("nest-pass", nest).unwrap());
        assert!(bcrypt::verify("nest-pass", &nest.replace("$2b$", "$2a$")).unwrap());
    }
}
