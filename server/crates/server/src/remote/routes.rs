use super::{
    db::{self, Grant},
    dto::{Claim, Command, CreateCode, Register},
    fanout::device_id_of,
};
use crate::{
    events::{
        Identity, Num, SseEvent,
        event::{PlayState, RemoteAction},
        uuid_v4,
    },
    http::{
        AppError,
        auth::{Authed, SessionAuthed},
        json::iso_ms,
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{delete, get, post},
};
use chrono::{DateTime, Utc};
use fliks_domain::acl::{Action, Subject};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;

const COMMAND_TTL_MS: i64 = 10_000;
const CODE_TTL_SECS: i64 = 600;
const MAX_CODES_PER_DEVICE: i64 = 3;
const CODE_LEN: usize = 6;
const CODE_DRAWS: usize = 10;
// 32 symbols (no I, O, 0, 1): one random byte masked by 31 is uniform.
const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const OFFLINE: &str = "remote.error_device_offline";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/remote/targets", get(targets))
        .route("/api/remote/register", post(register))
        .route("/api/remote/commands", get(commands))
        .route("/api/remote/grants/code", post(grant_code))
        .route("/api/remote/grants/claim", post(grant_claim))
        .route("/api/remote/grants", get(grants))
        .route("/api/remote/grants/{id}", delete(revoke))
        .route("/api/remote/{targetId}/command", post(command))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub media_file_id: i64,
    pub media_title: Option<String>,
    pub media_type: Option<String>,
    pub poster_url: Option<String>,
    pub position_seconds: Num,
    pub state: PlayState,
}

/// A non-stale presence session bound to an SSE connection (`nowPlaying` is `None` once stale).
pub struct Live {
    pub connection_id: String,
    pub system_name: Option<String>,
    pub now_playing: Option<NowPlaying>,
}

// ponytail: presence is not ported yet; this returns no sessions until it exposes its registry.
fn live_sessions(_: &AppState) -> Vec<Live> {
    vec![]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDto {
    target_id: String,
    user_agent: Option<String>,
    device_name: Option<String>,
    system_name: Option<String>,
    form_factor: Option<String>,
    tv_platform: Option<String>,
    owner_username: Option<String>,
    now_playing: Option<NowPlaying>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantDto {
    id: i32,
    device_id: String,
    device_name: String,
    owner_username: Option<String>,
    grantee_username: Option<String>,
    #[serde(with = "iso_ms")]
    created_at: DateTime<Utc>,
}

fn param(q: &[(String, String)], key: &str) -> Option<String> {
    q.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

fn is_admin(a: &Authed) -> bool {
    a.perms.can(Action::Manage, &Subject::Settings)
}

fn offline() -> AppError {
    AppError::not_found(OFFLINE)
}

async fn usernames(st: &AppState, ids: &[i32]) -> Result<HashMap<i32, String>, AppError> {
    Ok(db::users_by_ids(&st.db, ids)
        .await?
        .into_iter()
        .map(|u| (u.id, u.username))
        .collect())
}

fn to_dto(
    t: crate::events::Target,
    live: &mut Vec<Live>,
    owner_username: Option<String>,
) -> TargetDto {
    let i = live.iter().position(|l| l.connection_id == t.connection_id);
    let live = i.map(|i| live.swap_remove(i));
    TargetDto {
        target_id: t.identity.target_id.unwrap_or_default(),
        user_agent: t.identity.user_agent,
        device_name: t.identity.device_name,
        system_name: live.as_ref().and_then(|l| l.system_name.clone()),
        form_factor: t.identity.form_factor,
        tv_platform: t.identity.tv_platform,
        owner_username,
        now_playing: live.and_then(|l| l.now_playing),
    }
}

#[utoipa::path(get, path = "/api/remote/targets", responses((status = 200)))]
pub async fn targets(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Json<Vec<TargetDto>>, AppError> {
    let me = a.user.id;
    let slf = param(&q, "self");
    let keep = |t: &crate::events::Target| t.identity.target_id != slf;
    let mut live = live_sessions(&st);
    let mut rows: Vec<TargetDto> = st
        .hub
        .list_for_user(me)
        .into_iter()
        .filter(keep)
        .map(|t| to_dto(t, &mut live, None))
        .collect();
    if is_admin(&a) {
        let others: Vec<_> = st
            .hub
            .list_all()
            .into_iter()
            .filter(|t| t.user_id != me && keep(t))
            .collect();
        let ids: Vec<i32> = others.iter().map(|t| t.user_id).collect();
        let names = usernames(&st, &ids).await?;
        for t in others {
            let name = names.get(&t.user_id).cloned();
            rows.push(to_dto(t, &mut live, name));
        }
        return Ok(Json(rows));
    }
    let granted = db::held(&st.db, me).await?;
    if granted.is_empty() {
        return Ok(Json(rows));
    }
    let owner_ids: Vec<i32> = granted.iter().map(|g| g.owner_user_id).collect();
    for owner in db::users_by_ids(&st.db, &owner_ids)
        .await?
        .into_iter()
        .filter(|u| u.enabled)
    {
        for t in st.hub.list_for_user(owner.id) {
            // The grant is per device: a second device of the same owner stays invisible.
            let device = device_id_of(t.identity.target_id.as_deref().unwrap_or_default());
            if keep(&t) && granted.iter().any(|g| g.device_id == device) {
                rows.push(to_dto(t, &mut live, Some(owner.username.clone())));
            }
        }
    }
    Ok(Json(rows))
}

#[utoipa::path(post, path = "/api/remote/register", responses((status = 201)))]
pub async fn register(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    ValidJson(dto): ValidJson<Register>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    dto.validate()?;
    let target_id = format!("{}#native", dto.device_id);
    st.hub.register_polled_target(
        a.user.id,
        Identity {
            target_id: Some(target_id.clone()),
            form_factor: Some(dto.form_factor.unwrap_or_else(|| "tv".into())),
            tv_platform: None,
            device_name: dto.name,
            user_agent: None,
        },
    );
    Ok((StatusCode::CREATED, Json(json!({ "targetId": target_id }))))
}

/// `canControl` (spec rule 7): `Ok(reason)` allows, `Err(reason)` denies.
pub async fn can_control(
    st: &AppState,
    me: &Authed,
    target_user: Option<i32>,
    device_id: Option<&str>,
) -> Result<Result<&'static str, &'static str>, sqlx::Error> {
    let admin = is_admin(me);
    let Some(target_user) = target_user else {
        return Ok(if admin {
            Ok("admin")
        } else {
            Err("ownerless_target_requires_admin")
        });
    };
    if target_user == me.user.id {
        return Ok(Ok("self"));
    }
    if admin {
        return Ok(Ok("admin"));
    }
    let Some(owner) = db::users_by_ids(&st.db, &[target_user])
        .await?
        .into_iter()
        .next()
    else {
        return Ok(Err("target_user_missing"));
    };
    let Some(device) = device_id.filter(|d| !d.is_empty()) else {
        return Ok(Err("no_device_id"));
    };
    if !db::is_granted(&st.db, device, me.user.id).await? {
        return Ok(Err("device_not_granted"));
    }
    Ok(if owner.enabled {
        Ok("granted")
    } else {
        Err("target_disabled")
    })
}

/// Who owns the target and on which connection, among what the caller may see (spec rule 10).
async fn find_target_owner(
    st: &AppState,
    me: &Authed,
    target_id: &str,
) -> Result<Option<(i32, String)>, sqlx::Error> {
    if let Some(c) = st.hub.resolve_target(me.user.id, target_id) {
        return Ok(Some((me.user.id, c)));
    }
    let device = device_id_of(target_id);
    for g in db::held(&st.db, me.user.id).await? {
        if g.device_id == device
            && let Some(c) = st.hub.resolve_target(g.owner_user_id, target_id)
        {
            return Ok(Some((g.owner_user_id, c)));
        }
    }
    if is_admin(me) {
        return Ok(st
            .hub
            .list_all()
            .into_iter()
            .find(|t| t.identity.target_id.as_deref() == Some(target_id))
            .map(|t| (t.user_id, t.connection_id)));
    }
    Ok(None)
}

async fn authorize_target(
    st: &AppState,
    me: &Authed,
    target_id: &str,
) -> Result<(i32, String), AppError> {
    let Some((owner, conn)) = find_target_owner(st, me, target_id).await? else {
        tracing::warn!(user = me.user.id, target_id, "remote target not found");
        return Err(offline());
    };
    match can_control(st, me, Some(owner), Some(device_id_of(target_id))).await? {
        Ok(_) => Ok((owner, conn)),
        Err(reason) => {
            tracing::warn!(
                user = me.user.id,
                target_id,
                reason,
                "remote control denied"
            );
            Err(AppError::forbidden(format!("remote.error_{reason}")))
        }
    }
}

#[utoipa::path(get, path = "/api/remote/commands", responses((status = 200)))]
pub async fn commands(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Json<Vec<SseEvent>>, AppError> {
    let target_id = param(&q, "targetId")
        .ok_or_else(|| AppError::bad_request(vec!["targetId must be a string"]))?;
    authorize_target(&st, &a, &target_id).await?;
    st.hub
        .drain_commands(a.user.id, &target_id)
        .map(Json)
        .ok_or_else(offline)
}

#[utoipa::path(post, path = "/api/remote/{targetId}/command", responses((status = 202)))]
pub async fn command(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(target_id): PathParams<String>,
    ValidJson(dto): ValidJson<Command>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    dto.validate()?;
    let (owner, conn) = authorize_target(&st, &a, &target_id).await?;
    if dto.by_target_id.as_deref() == Some(&target_id) {
        return Err(AppError::bad_request("remote.error_self_target"));
    }
    let cmd_id = uuid_v4();
    let claim = (dto.action == RemoteAction::Load)
        .then_some(dto.media_file_id)
        .flatten()
        .filter(|f| *f != 0);
    let ev = SseEvent::RemoteCommand {
        cmd_id: cmd_id.clone(),
        expires_at: Utc::now().timestamp_millis() + COMMAND_TTL_MS,
        by_target_id: dto.by_target_id,
        action: dto.action,
        media_id: dto.media_id,
        media_type: dto.media_type,
        media_file_id: dto.media_file_id,
        episode_id: dto.episode_id,
        position_seconds: dto.position_seconds,
        level: dto.level,
        muted: dto.muted,
        track_id: dto.track_id,
        subtitle_id: dto.subtitle_id,
        quality_id: dto.quality_id,
    };
    // Never `emit_to_user`: a broadcast would let one phone drive every device of the account.
    if !st.hub.emit_to_connection(owner, &conn, ev) {
        return Err(offline());
    }
    if let Some(file) = claim {
        st.hub.claim_attribution(&target_id, a.user.id, file);
    }
    Ok((StatusCode::ACCEPTED, Json(json!({ "cmdId": cmd_id }))))
}

fn announce(st: &AppState, ids: &[Option<i32>]) {
    let mut seen = vec![];
    for id in ids.iter().flatten() {
        if !seen.contains(id) {
            seen.push(*id);
            st.hub.emit_to_user(*id, SseEvent::RemoteTargetsChanged {});
        }
    }
}

async fn grant_dtos(st: &AppState, rows: Vec<Grant>) -> Result<Vec<GrantDto>, AppError> {
    let ids: Vec<i32> = rows
        .iter()
        .flat_map(|g| [Some(g.owner_user_id), g.grantee_user_id])
        .flatten()
        .collect();
    let names = usernames(st, &ids).await?;
    Ok(rows
        .into_iter()
        .map(|g| GrantDto {
            id: g.id,
            device_id: g.device_id,
            device_name: g.device_name,
            owner_username: names.get(&g.owner_user_id).cloned(),
            grantee_username: g.grantee_user_id.and_then(|u| names.get(&u).cloned()),
            created_at: g.created_at,
        })
        .collect())
}

fn mint_code() -> String {
    let mut b = [0u8; CODE_LEN];
    getrandom::fill(&mut b).expect("os rng");
    b.iter()
        .map(|x| ALPHABET[(x & 31) as usize] as char)
        .collect()
}

#[utoipa::path(post, path = "/api/remote/grants/code", responses((status = 201)))]
pub async fn grant_code(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    ValidJson(dto): ValidJson<CreateCode>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    dto.validate()?;
    db::prune_expired_codes(&st.db).await?;
    if db::unclaimed_count(&st.db, &dto.device_id).await? >= MAX_CODES_PER_DEVICE {
        return Err(AppError::bad_request("remote.error_too_many_codes"));
    }
    let mut code = None;
    for _ in 0..CODE_DRAWS {
        let c = mint_code();
        if !db::code_taken(&st.db, &c).await? {
            code = Some(c);
            break;
        }
    }
    let code = code.ok_or_else(|| AppError::bad_request("remote.error_code_unavailable"))?;
    let expires = Utc::now() + chrono::Duration::seconds(CODE_TTL_SECS);
    let id = db::insert_code(
        &st.db,
        &code,
        &dto.device_id,
        a.user.id,
        &dto.device_name,
        expires,
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "id": id, "code": code, "expiresIn": CODE_TTL_SECS })),
    ))
}

#[utoipa::path(post, path = "/api/remote/grants/claim", responses((status = 201)))]
pub async fn grant_claim(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    ValidJson(dto): ValidJson<Claim>,
) -> Result<(StatusCode, Json<GrantDto>), AppError> {
    dto.validate()?;
    let me = a.user.id;
    let code = dto.code.trim().to_uppercase();
    let Some(mut grant) = db::unclaimed_by_code(&st.db, &code).await? else {
        return Err(AppError::not_found("remote.error_unknown_code"));
    };
    if grant.code_expires_at < Utc::now() {
        db::delete(&st.db, grant.id).await?;
        return Err(AppError::not_found("remote.error_expired_code"));
    }
    if grant.owner_user_id == me {
        return Err(AppError::bad_request("remote.error_own_device"));
    }
    if let Some(existing) = db::held_on_device(&st.db, &grant.device_id, me).await? {
        db::delete(&st.db, grant.id).await?;
        return Ok((StatusCode::CREATED, Json(one(&st, existing).await?)));
    }
    db::set_grantee(&st.db, grant.id, me).await?;
    grant.grantee_user_id = Some(me);
    announce(&st, &[Some(me), Some(grant.owner_user_id)]);
    Ok((StatusCode::CREATED, Json(one(&st, grant).await?)))
}

async fn one(st: &AppState, g: Grant) -> Result<GrantDto, AppError> {
    Ok(grant_dtos(st, vec![g]).await?.remove(0))
}

#[utoipa::path(get, path = "/api/remote/grants", responses((status = 200)))]
pub async fn grants(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Json<Value>, AppError> {
    let device = param(&q, "deviceId").filter(|d| !d.is_empty());
    let issued = db::issued(&st.db, a.user.id, device.as_deref()).await?;
    let held = db::held(&st.db, a.user.id).await?;
    Ok(Json(json!({
        "issued": grant_dtos(&st, issued).await?,
        "held": grant_dtos(&st, held).await?,
    })))
}

#[utoipa::path(delete, path = "/api/remote/grants/{id}", responses((status = 204)))]
pub async fn revoke(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    let unknown = || AppError::not_found("remote.error_unknown_grant");
    let g = db::find(&st.db, id).await?.ok_or_else(unknown)?;
    if g.owner_user_id != a.user.id && g.grantee_user_id != Some(a.user.id) {
        return Err(unknown());
    }
    db::delete(&st.db, id).await?;
    announce(&st, &[g.grantee_user_id, Some(g.owner_user_id)]);
    Ok(StatusCode::NO_CONTENT)
}
