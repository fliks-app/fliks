use super::{
    db::{self, Row},
    dto::*,
    playlist,
    registry::{self, deliver, item_dto, member_dtos, notify_updated},
};
use crate::{
    events::SseEvent,
    http::{
        AppError,
        auth::{Authed, SessionAuthed, load_enabled},
        validate::{PathParams, ValidJson},
    },
    libraries::acl::{accessible_library_ids, assert_media_accessible},
    playlists::{self, Role},
    state::AppState,
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use fliks_domain::{
    acl::Permissions,
    js::now_ms,
    party::{
        ANIMATED_REACTIONS, CloseReason, DEFAULT_REACTIONS, Effect, Error as PartyErr, Intent,
        Item, LOBBY_OPEN_BEFORE_MS, Policy, State as PlayState, noto_code,
    },
};
use serde_json::{Value, json};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/time", get(time))
        .route("/api/parties", get(list).post(create))
        .route("/api/parties/by-token/{token}", get(by_token))
        .route("/api/parties/ice", get(ice))
        .route("/api/parties/reactions", get(reactions))
        .route("/api/parties/{id}", get(show).patch(patch).delete(end))
        .route("/api/parties/{id}/join", post(join))
        .route("/api/parties/{id}/start", post(start))
        .route("/api/parties/{id}/leave", post(leave))
        .route("/api/parties/{id}/intent", post(intent))
        .route("/api/parties/{id}/status", post(status))
        .route("/api/parties/{id}/messages", post(message))
        .route("/api/parties/{id}/reactions", post(reaction))
        .route("/api/parties/{id}/voice", post(voice))
        .route("/api/parties/{id}/signal", post(signal))
        .route("/api/parties/{id}/members/{userId}/kick", post(kick))
        .route("/api/parties/{id}/members/{userId}/host", post(transfer))
        .route("/api/parties/{id}/invitees", post(invite))
        .route("/api/parties/{id}/queue", get(queue))
}

/// An `AppError`, or one that also carries a body field (`party` on 409 stale, `usernames`).
pub enum PartyError {
    App(AppError),
    Extra(StatusCode, &'static str, &'static str, Value),
    /// The body is the value itself (409 stale: the bare `PartyDto`).
    Bare(StatusCode, Value),
}

impl From<AppError> for PartyError {
    fn from(e: AppError) -> Self {
        Self::App(e)
    }
}

impl From<sqlx::Error> for PartyError {
    fn from(e: sqlx::Error) -> Self {
        Self::App(e.into())
    }
}

impl IntoResponse for PartyError {
    fn into_response(self) -> Response {
        match self {
            Self::App(e) => e.into_response(),
            Self::Bare(status, value) => (status, Json(value)).into_response(),
            Self::Extra(status, key, field, value) => (
                status,
                Json(json!({
                    "statusCode": status.as_u16(),
                    "message": key,
                    "error": status.canonical_reason().unwrap_or_default(),
                    field: value,
                })),
            )
                .into_response(),
        }
    }
}

type R<T> = Result<T, PartyError>;

fn fail(status: StatusCode, key: &'static str) -> PartyError {
    AppError::with_message(status, key).into()
}

fn not_found() -> PartyError {
    fail(StatusCode::NOT_FOUND, "party.error_not_found")
}

fn not_live() -> PartyError {
    fail(StatusCode::CONFLICT, "party.error_not_live")
}

fn machine_err(e: PartyErr) -> PartyError {
    match e {
        PartyErr::NotMember => fail(StatusCode::FORBIDDEN, "party.error_not_member"),
        PartyErr::HostOnly => fail(StatusCode::FORBIDDEN, "party.error_host_only"),
        PartyErr::ReactionsOff => fail(StatusCode::FORBIDDEN, "party.error_reactions_off"),
        PartyErr::ChatOff => fail(StatusCode::FORBIDDEN, "party.error_chat_off"),
        PartyErr::RateLimited => fail(StatusCode::TOO_MANY_REQUESTS, "party.error_rate_limited"),
        PartyErr::Invalid(_) => fail(StatusCode::BAD_REQUEST, "party.error_invalid"),
        PartyErr::Stale => fail(StatusCode::CONFLICT, "party.error_stale"),
        PartyErr::VoiceFull => fail(StatusCode::CONFLICT, "party.error_voice_full"),
        PartyErr::VoiceNotJoined => fail(StatusCode::CONFLICT, "party.error_voice_not_joined"),
    }
}

#[utoipa::path(get, path = "/api/time", responses((status = 200)))]
pub async fn time(SessionAuthed(_): SessionAuthed) -> Json<Value> {
    let t1 = now_ms();
    Json(json!({ "t1": t1, "t2": now_ms() }))
}

async fn media_ok(st: &AppState, user: &Authed, media: i32) -> Result<bool, AppError> {
    let ids = accessible_library_ids(&st.db, user).await?;
    match assert_media_accessible(&st.db, media, &ids).await {
        Ok(()) => Ok(true),
        Err(e) if e.status() == StatusCode::NOT_FOUND => Ok(false),
        Err(e) => Err(e),
    }
}

/// Same test for another user, loaded like a request would.
pub(super) async fn user_media_ok(st: &AppState, user: i32, media: i32) -> Result<bool, AppError> {
    let Some((u, role)) = load_enabled(&st.db, user).await? else {
        return Ok(false);
    };
    let perms = Permissions::from(
        role.as_ref().map_or(&[][..], |r| &r.permissions),
        u.is_admin,
    );
    media_ok(
        st,
        &Authed {
            user: u,
            role,
            perms,
            scope: None,
        },
        media,
    )
    .await
}

/// The SSE connection whose target id is `device` (a web tab), else the newest of that bare
/// device id; a polled target cannot hold a party.
fn connection_for(st: &AppState, user: i32, device: &str) -> Option<String> {
    let live: Vec<_> = st
        .hub
        .list_for_user(user)
        .into_iter()
        .filter(|t| !t.connection_id.starts_with("polled:"))
        .collect();
    live.iter()
        .find(|t| t.identity.target_id.as_deref() == Some(device))
        .or_else(|| {
            live.iter().find(|t| {
                t.identity
                    .target_id
                    .as_deref()
                    .is_some_and(|id| id.split('#').next() == Some(device))
            })
        })
        .map(|t| t.connection_id.clone())
}

fn lobby_open(row: &Row) -> bool {
    let at = row.scheduled_at.map_or(i64::MAX, |t| t.timestamp_millis());
    now_ms() >= at - LOBBY_OPEN_BEFORE_MS
}

async fn row_of(st: &AppState, id: i32) -> R<Row> {
    db::get(&st.db, id).await?.ok_or_else(not_found)
}

#[derive(PartialEq)]
enum Access {
    Member,
    TokenOnly,
}

async fn access(st: &AppState, row: &Row, me: i32, token: Option<&str>) -> R<Access> {
    if row.owner_id == me || db::is_invitee(&st.db, row.id, me).await? {
        return Ok(Access::Member);
    }
    if token.is_some_and(|t| t == row.invite_token) {
        return Ok(Access::TokenOnly);
    }
    Err(not_found())
}

fn host_of(st: &AppState, row: &Row) -> i32 {
    st.parties.view(row.id).map_or(row.owner_id, |v| v.host_id)
}

fn require_host(st: &AppState, row: &Row, me: i32) -> R<()> {
    if host_of(st, row) == me {
        Ok(())
    } else {
        Err(fail(StatusCode::FORBIDDEN, "party.error_not_host"))
    }
}

fn require_open(row: &Row) -> R<()> {
    if row.status == "ended" {
        return Err(fail(StatusCode::CONFLICT, "party.error_ended"));
    }
    Ok(())
}

async fn summary(st: &AppState, row: &Row) -> sqlx::Result<PartySummaryDto> {
    let view = st.parties.view(row.id);
    let host = view.as_ref().map_or(row.owner_id, |v| v.host_id);
    let item = view.as_ref().map_or_else(|| row.item(), |v| v.item.clone());
    let names = db::usernames(&st.db, &[host]).await?;
    let playlist = match row.playlist_id {
        Some(id) => db::playlist_name(&st.db, id)
            .await?
            .map(|name| PlaylistRef { id, name }),
        None => None,
    };
    Ok(PartySummaryDto {
        id: row.id,
        name: row.name.clone(),
        status: row.status.clone(),
        scheduled_at: row.scheduled_at,
        host: UserRef {
            user_id: host,
            username: names.get(&host).cloned().unwrap_or_default(),
        },
        item: item_dto(st, &item).await?,
        playlist,
        member_count: view.map_or(0, |v| v.members.len()),
    })
}

async fn dto(st: &AppState, row: &Row, viewer: i32) -> sqlx::Result<PartyDto> {
    if row.status == "live" {
        st.parties.ensure(row, false);
    }
    let summary = summary(st, row).await?;
    let view = st.parties.view(row.id);
    let guests = db::guests(&st.db, row.id).await?;
    let ids: Vec<i32> = guests.iter().map(|g| g.0).collect();
    let names = db::usernames(&st.db, &ids).await?;
    let sees_token = viewer == summary.host.user_id
        || (row.link_sharing
            && view
                .as_ref()
                .is_some_and(|v| v.members.iter().any(|m| m.user_id == viewer)));
    let live = view.map(|v| PartyLive {
        rev: v.rev,
        state: v.state,
        anchor: v.anchor,
        members: member_dtos(st, v.host_id, &v.members),
        messages: v.messages,
    });
    Ok(PartyDto {
        summary,
        policy: if row.policy == "host_only" {
            Policy::HostOnly
        } else {
            Policy::Everyone
        },
        reactions_enabled: row.reactions_enabled,
        chat_enabled: row.chat_enabled,
        link_sharing: row.link_sharing,
        invite_token: sees_token.then(|| row.invite_token.clone()),
        guests: guests
            .into_iter()
            .map(|(id, source)| GuestDto {
                user_id: id,
                username: names.get(&id).cloned().unwrap_or_default(),
                source,
            })
            .collect(),
        live,
    })
}

async fn announce_invited(st: &AppState, row: &Row, users: &[i32]) -> sqlx::Result<()> {
    if users.is_empty() {
        return Ok(());
    }
    let s = summary(st, row).await?;
    st.hub.emit_to_users(
        users,
        SseEvent::PartyInvited {
            party_id: row.id.into(),
            name: row.name.clone(),
            scheduled_at: s.scheduled_at.map(fliks_domain::js::iso),
            host: serde_json::to_value(&s.host).expect("typed dto"),
            item: serde_json::to_value(&s.item).expect("typed dto"),
        },
    );
    Ok(())
}

/// Only users the owner follows (accepted) may be invited.
async fn check_followed(st: &AppState, owner: i32, users: &[i32]) -> R<Vec<i32>> {
    let mut users: Vec<i32> = users.iter().copied().filter(|u| *u != owner).collect();
    users.sort_unstable();
    users.dedup();
    let ok = db::followed(&st.db, owner, &users).await?;
    if ok.len() != users.len() {
        return Err(fail(
            StatusCode::BAD_REQUEST,
            "party.error_invitee_not_followed",
        ));
    }
    Ok(users)
}

async fn check_item(st: &AppState, item: &Item) -> R<()> {
    if db::item_valid(&st.db, item).await? {
        Ok(())
    } else {
        Err(fail(StatusCode::BAD_REQUEST, "party.error_invalid_item"))
    }
}

/// The item a party opens on: the requested one, else the playlist's first the owner can play.
async fn first_item(st: &AppState, a: &Authed, b: &Create) -> R<Item> {
    let requested = b.media_id.map(|media_id| Item {
        media_id,
        media_file_id: b.media_file_id,
        episode_id: b.episode_id,
    });
    let Some(playlist) = b.playlist_id else {
        let item =
            requested.ok_or_else(|| fail(StatusCode::BAD_REQUEST, "party.error_invalid_item"))?;
        let ids = accessible_library_ids(&st.db, a).await?;
        assert_media_accessible(&st.db, item.media_id, &ids).await?;
        return Ok(item);
    };
    playlists::assert_role(&st.db, a.user.id, playlist, Role::Viewer).await?;
    let rows = db::playlist_rows(&st.db, playlist).await?;
    for row in rows {
        let wanted = requested
            .as_ref()
            .is_none_or(|r| r.media_id == row.item.media_id && r.episode_id == row.item.episode_id);
        if wanted && row.playable && media_ok(st, a, row.item.media_id).await? {
            return Ok(Item {
                media_file_id: b.media_file_id,
                ..row.item
            });
        }
    }
    Err(fail(StatusCode::BAD_REQUEST, "party.error_invalid_item"))
}

#[utoipa::path(post, path = "/api/parties", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    ValidJson(b): ValidJson<Create>,
) -> R<(StatusCode, Json<PartyDto>)> {
    b.validate()?;
    let me = a.user.id;
    let item = first_item(&st, &a, &b).await?;
    check_item(&st, &item).await?;
    let invitees = check_followed(&st, me, b.invitee_ids.as_deref().unwrap_or_default()).await?;
    let now = Utc::now();
    let at = b.scheduled_at.filter(|t| *t > now).unwrap_or(now);
    let policy = if b.policy == Some(Policy::HostOnly) {
        "host_only"
    } else {
        "everyone"
    };
    let (inherit_reactions, inherit_chat, inherit_link) = db::owner_switches(&st.db, me)
        .await?
        .unwrap_or((true, true, true));
    let row = db::insert(
        &st.db,
        &db::New {
            reactions_enabled: b.reactions_enabled.unwrap_or(inherit_reactions),
            chat_enabled: b.chat_enabled.unwrap_or(inherit_chat),
            link_sharing: b.link_sharing.unwrap_or(inherit_link),
            name: &valid_name(&b.name)?,
            owner: me,
            item: &item,
            playlist_id: b.playlist_id,
            policy,
            scheduled_at: at,
        },
        &invitees,
    )
    .await?;
    announce_invited(&st, &row, &invitees).await?;
    if lobby_open(&row) {
        registry::open_lobby(&st, &row).await?;
    }
    Ok((StatusCode::CREATED, Json(dto(&st, &row, me).await?)))
}

#[utoipa::path(get, path = "/api/parties", responses((status = 200)))]
pub async fn list(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
) -> R<Json<Vec<PartySummaryDto>>> {
    let mut out = vec![];
    for row in db::listed(&st.db, a.user.id).await? {
        if row.status == "live" {
            st.parties.ensure(&row, false);
        }
        out.push(summary(&st, &row).await?);
    }
    Ok(Json(out))
}

#[utoipa::path(get, path = "/api/parties/{id}", responses((status = 200)))]
pub async fn show(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> R<Json<PartyDto>> {
    let row = member_row(&st, id, a.user.id).await?;
    Ok(Json(dto(&st, &row, a.user.id).await?))
}

#[utoipa::path(get, path = "/api/parties/by-token/{token}", responses((status = 200)))]
pub async fn by_token(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(token): PathParams<String>,
) -> R<Json<PartyDto>> {
    let row = db::by_token(&st.db, &token).await?.ok_or_else(not_found)?;
    Ok(Json(dto(&st, &row, a.user.id).await?))
}

#[utoipa::path(patch, path = "/api/parties/{id}", responses((status = 200)))]
pub async fn patch(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<Patch>,
) -> R<Json<PartyDto>> {
    let me = a.user.id;
    let mut row = row_of(&st, id).await?;
    access(&st, &row, me, None).await?;
    require_host(&st, &row, me)?;
    require_open(&row)?;
    let name = b.name.as_deref().map(valid_name).transpose()?;
    if let Some(at) = b.scheduled_at {
        if row.status != "scheduled" {
            return Err(fail(StatusCode::CONFLICT, "party.error_not_scheduled"));
        }
        row.scheduled_at = Some(at.max(Utc::now()));
        st.parties.forget_notice(id);
    }
    if let Some(n) = &name {
        row.name.clone_from(n);
    }
    if let Some(p) = b.policy {
        row.policy = if p == Policy::HostOnly {
            "host_only"
        } else {
            "everyone"
        }
        .into();
    }
    row.reactions_enabled = b.reactions_enabled.unwrap_or(row.reactions_enabled);
    row.chat_enabled = b.chat_enabled.unwrap_or(row.chat_enabled);
    row.link_sharing = b.link_sharing.unwrap_or(row.link_sharing);
    let regenerate = b.regenerate_token == Some(true);
    if regenerate {
        row.invite_token = db::new_token();
    }
    db::update_settings(
        &st.db,
        id,
        &row.name,
        &row.policy,
        (row.reactions_enabled, row.chat_enabled, row.link_sharing),
        row.scheduled_at,
        &row.invite_token,
    )
    .await?;
    if (name.is_some()
        || b.policy.is_some()
        || b.reactions_enabled.is_some()
        || b.chat_enabled.is_some()
        || b.link_sharing.is_some())
        && let Some((_, d)) = st.parties.act(id, |l| {
            (
                (),
                l.set_settings(
                    name.clone(),
                    b.policy,
                    b.reactions_enabled,
                    b.chat_enabled,
                    b.link_sharing,
                ),
            )
        })
    {
        deliver(&st, id, d).await;
    }
    if regenerate {
        st.parties.act(id, |l| {
            l.blocked.clear();
            ((), vec![])
        });
    }
    if b.scheduled_at.is_some() && lobby_open(&row) {
        registry::open_lobby(&st, &row).await?;
    }
    notify_updated(&st, &row).await?;
    Ok(Json(dto(&st, &row, me).await?))
}

#[utoipa::path(delete, path = "/api/parties/{id}", responses((status = 204)))]
pub async fn end(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> R<StatusCode> {
    let row = row_of(&st, id).await?;
    access(&st, &row, a.user.id, None).await?;
    require_host(&st, &row, a.user.id)?;
    if row.status != "ended" {
        registry::end(&st, &row, CloseReason::HostEnded).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/parties/{id}/join", responses((status = 200)))]
pub async fn join(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<Join>,
) -> R<Json<PartyDto>> {
    let me = a.user.id;
    let row = row_of(&st, id).await?;
    let how = access(&st, &row, me, b.token.as_deref()).await?;
    require_open(&row)?;
    if row.status == "scheduled" && !lobby_open(&row) {
        return Err(fail(StatusCode::CONFLICT, "party.error_not_open"));
    }
    st.parties.ensure(&row, false);
    let view = st.parties.view(id).ok_or_else(not_live)?;
    if how == Access::TokenOnly && view.blocked.contains(&me) {
        return Err(fail(StatusCode::FORBIDDEN, "party.error_kicked"));
    }
    if !media_ok(&st, &a, view.item.media_id).await? {
        return Err(fail(StatusCode::FORBIDDEN, "party.error_no_access"));
    }
    let conn = connection_for(&st, me, &b.device_id)
        .ok_or_else(|| fail(StatusCode::CONFLICT, "party.error_no_connection"))?;
    if how == Access::TokenOnly {
        db::add_link_guest(&st.db, id, me).await?;
        notify_updated(&st, &row).await?;
    }
    let name = a.user.username.clone();
    if let Some((_, d)) = st.parties.act(id, |l| {
        ((), l.join(me, &name, &b.device_id, &conn, now_ms()))
    }) {
        deliver(&st, id, d).await;
    }
    Ok(Json(dto(&st, &row, me).await?))
}

#[utoipa::path(post, path = "/api/parties/{id}/start", responses((status = 200)))]
pub async fn start(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> R<Json<PartyDto>> {
    let me = a.user.id;
    let mut row = row_of(&st, id).await?;
    access(&st, &row, me, None).await?;
    require_host(&st, &row, me)?;
    require_open(&row)?;
    if row.status == "scheduled" {
        db::set_live(&st.db, id).await?;
        row.status = "live".into();
        st.parties.ensure(&row, true);
        if let Some((_, d)) = st.parties.act(id, |l| ((), l.go_live(now_ms()))) {
            deliver(&st, id, d).await;
        }
        let guests = db::guest_ids(&st.db, id).await?;
        st.hub.emit_to_users(
            &guests,
            SseEvent::PartyStarting {
                party_id: id.into(),
                name: row.name.clone(),
            },
        );
        notify_updated(&st, &row).await?;
    }
    Ok(Json(dto(&st, &row, me).await?))
}

#[utoipa::path(post, path = "/api/parties/{id}/leave", responses((status = 204)))]
pub async fn leave(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<Device>,
) -> R<StatusCode> {
    let me = a.user.id;
    member_row(&st, id, me).await?;
    if let Some((_, d)) = st
        .parties
        .act(id, |l| match l.leave(me, &b.device_id, now_ms()) {
            Ok(e) => ((), e),
            Err(_) => ((), vec![]),
        })
    {
        deliver(&st, id, d).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The row for a member, owner or invitee; anyone else gets the 404 of an unknown party.
async fn member_row(st: &AppState, id: i32, me: i32) -> R<Row> {
    let row = row_of(st, id).await?;
    let member = st
        .parties
        .view(id)
        .is_some_and(|v| v.members.iter().any(|m| m.user_id == me));
    if !member {
        access(st, &row, me, None).await?;
    }
    Ok(row)
}

#[utoipa::path(post, path = "/api/parties/{id}/intent", responses((status = 202)))]
pub async fn intent(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<IntentIn>,
) -> R<(StatusCode, Json<Value>)> {
    let me = a.user.id;
    let row = member_row(&st, id, me).await?;
    if row.status != "live" {
        return Err(not_live());
    }
    st.parties.ensure(&row, false);
    let item: Option<Item> = b.item.map(Into::into);
    let mut title = None;
    if let (IntentAction::SetItem, Some(it)) = (b.action, item.as_ref()) {
        check_item(&st, it).await?;
        let view = st.parties.view(id).ok_or_else(not_live)?;
        let mut denied = vec![];
        let mut checked = vec![];
        for m in &view.members {
            if checked.contains(&m.user_id) {
                continue;
            }
            checked.push(m.user_id);
            if !user_media_ok(&st, m.user_id, it.media_id).await? {
                denied.push(m.username.clone());
            }
        }
        if !denied.is_empty() {
            return Err(PartyError::Extra(
                StatusCode::CONFLICT,
                "party.error_member_no_access",
                "usernames",
                json!(denied),
            ));
        }
        title = Some(item_dto(&st, it).await?.title);
    }
    let step = match b.action {
        IntentAction::Next | IntentAction::Previous => {
            let Some(playlist) = row.playlist_id.filter(|_| item.is_none()) else {
                return Err(fail(StatusCode::BAD_REQUEST, "party.error_invalid"));
            };
            Some(playlist_step(&st, id, playlist, b.action == IntentAction::Next).await?)
        }
        // A host's `ended` that idles the party moves a playlist party on.
        IntentAction::Ended if row.playlist_id.is_some() => {
            let view = st.parties.view(id).ok_or_else(not_live)?;
            match row.playlist_id {
                Some(playlist) if view.host_id == me && view.state != PlayState::Idle => {
                    Some(playlist_step(&st, id, playlist, true).await?)
                }
                _ => None,
            }
        }
        _ => None,
    };
    let (res, d) = st
        .parties
        .act(id, |l| {
            let result = match (b.action.machine(), step) {
                (_, Some(step)) => playlist::apply(
                    l,
                    me,
                    &b.device_id,
                    b.action == IntentAction::Ended,
                    b.base_rev,
                    step,
                    now_ms(),
                ),
                (Some(action), None) => l.intent(
                    me,
                    &b.device_id,
                    Intent {
                        action,
                        position: b.position,
                        item,
                        item_title: title,
                        base_rev: b.base_rev,
                    },
                    now_ms(),
                ),
                (None, None) => Err(PartyErr::Invalid("action")),
            };
            match result {
                Ok((rev, e)) => (Ok(rev), e),
                Err(e) => (Err(e), vec![]),
            }
        })
        .ok_or_else(not_live)?;
    deliver(&st, id, d).await;
    match res {
        Ok(rev) => Ok((StatusCode::ACCEPTED, Json(json!({ "rev": rev })))),
        Err(PartyErr::Stale) => {
            let snap = dto(&st, &row, me).await?;
            Err(PartyError::Bare(
                StatusCode::CONFLICT,
                serde_json::to_value(snap).expect("typed dto"),
            ))
        }
        Err(e) => Err(machine_err(e)),
    }
}

/// The playlist row to move to, judged for every user in the party right now.
async fn playlist_step(
    st: &AppState,
    party: i32,
    playlist: i32,
    forward: bool,
) -> R<playlist::Step> {
    let view = st.parties.view(party).ok_or_else(not_live)?;
    let mut users: Vec<i32> = view.members.iter().map(|m| m.user_id).collect();
    users.sort_unstable();
    users.dedup();
    Ok(playlist::step(st, playlist, &view.item, forward, &users).await?)
}

async fn run(
    st: &AppState,
    id: i32,
    f: impl FnOnce(&mut fliks_domain::party::Live) -> Result<Vec<Effect>, PartyErr>,
) -> R<Result<(), PartyErr>> {
    let (res, d) = st
        .parties
        .act(id, |l| match f(l) {
            Ok(e) => (Ok(()), e),
            Err(e) => (Err(e), vec![]),
        })
        .ok_or_else(not_live)?;
    deliver(st, id, d).await;
    Ok(res)
}

#[utoipa::path(post, path = "/api/parties/{id}/status", responses((status = 204)))]
pub async fn status(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<StatusIn>,
) -> R<StatusCode> {
    member_row(&st, id, a.user.id).await?;
    run(&st, id, |l| {
        l.status(
            a.user.id,
            &b.device_id,
            b.status,
            b.position,
            b.rtt_ms,
            now_ms(),
        )
    })
    .await?
    .map_err(machine_err)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/parties/{id}/messages", responses((status = 201)))]
pub async fn message(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<MessageIn>,
) -> R<(StatusCode, Json<Value>)> {
    let text = b.text()?;
    member_row(&st, id, a.user.id).await?;
    let (res, d) = st
        .parties
        .act(id, |l| {
            match l.post_message(a.user.id, &b.device_id, text, now_ms()) {
                Ok((m, e)) => (Ok(m), e),
                Err(e) => (Err(e), vec![]),
            }
        })
        .ok_or_else(not_live)?;
    deliver(&st, id, d).await;
    let m = res.map_err(machine_err)?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(m).expect("typed dto")),
    ))
}

#[utoipa::path(post, path = "/api/parties/{id}/reactions", responses((status = 204)))]
pub async fn reaction(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<ReactionIn>,
) -> R<StatusCode> {
    if emojis::get(&b.emoji).is_none() {
        return Err(fail(StatusCode::BAD_REQUEST, "party.error_invalid"));
    }
    member_row(&st, id, a.user.id).await?;
    run(&st, id, |l| {
        l.react(a.user.id, &b.device_id, &b.emoji, now_ms())
    })
    .await?
    .map_err(machine_err)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/parties/{id}/voice", responses((status = 204)))]
pub async fn voice(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<VoiceIn>,
) -> R<StatusCode> {
    member_row(&st, id, a.user.id).await?;
    run(&st, id, |l| {
        l.set_voice(a.user.id, &b.device_id, b.joined, b.muted, now_ms())
    })
    .await?
    .map_err(machine_err)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/parties/{id}/signal", responses((status = 204)))]
pub async fn signal(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<SignalIn>,
) -> R<StatusCode> {
    b.validate()?;
    member_row(&st, id, a.user.id).await?;
    let (to_user, to_conn) = st
        .parties
        .act(id, |l| {
            (
                l.signal_target(a.user.id, &b.device_id, &b.to, now_ms()),
                vec![],
            )
        })
        .ok_or_else(not_live)?
        .0
        .map_err(machine_err)?;
    st.hub.emit_to_connection(
        to_user,
        &to_conn,
        SseEvent::PartySignal {
            party_id: id.into(),
            from: json!({ "userId": a.user.id, "deviceId": b.device_id }),
            kind: json!(b.kind).as_str().unwrap_or_default().to_owned(),
            data: b.data,
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

const DEFAULT_ICE: &str = "stun:stun.l.google.com:19302";

/// The `party_voice_ice_servers` array when it parses, else the public STUN default.
#[utoipa::path(get, path = "/api/parties/ice", responses((status = 200)))]
pub async fn ice(State(st): State<AppState>, SessionAuthed(_): SessionAuthed) -> R<Json<Value>> {
    let stored = db::setting(&st.db, "party_voice_ice_servers").await?;
    let servers = stored
        .and_then(|s| serde_json::from_str::<Vec<IceServer>>(&s).ok())
        .map_or_else(|| json!([{ "urls": DEFAULT_ICE }]), |v| json!(v));
    Ok(Json(json!({ "iceServers": servers })))
}

/// The animated assets under `/api/emoji` keyed by emoji, and the default bar; any other emoji is static.
#[utoipa::path(get, path = "/api/parties/reactions", responses((status = 200)))]
pub async fn reactions(SessionAuthed(_): SessionAuthed) -> Json<Value> {
    let animations: serde_json::Map<String, Value> = ANIMATED_REACTIONS
        .iter()
        .map(|&e| {
            (
                e.to_owned(),
                json!(format!("/api/emoji/{}.webp", noto_code(e))),
            )
        })
        .collect();
    Json(json!({ "animations": animations, "defaults": DEFAULT_REACTIONS }))
}

#[utoipa::path(post, path = "/api/parties/{id}/members/{userId}/kick", responses((status = 204)))]
pub async fn kick(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams((id, user)): PathParams<(i32, i32)>,
) -> R<StatusCode> {
    let row = member_row(&st, id, a.user.id).await?;
    require_host(&st, &row, a.user.id)?;
    run(&st, id, |l| l.kick(user, &a.user.username, now_ms()))
        .await?
        .map_err(target_err)?;
    db::remove_guest(&st.db, id, user).await?;
    notify_updated(&st, &row).await?;
    st.hub.emit_to_users(
        &[user],
        SseEvent::PartyUpdated {
            party_id: id.into(),
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

/// A kick or transfer aimed at someone who is not in the party is a 404, not a 403.
fn target_err(e: PartyErr) -> PartyError {
    if e == PartyErr::NotMember {
        not_found()
    } else {
        machine_err(e)
    }
}

#[utoipa::path(post, path = "/api/parties/{id}/members/{userId}/host", responses((status = 204)))]
pub async fn transfer(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams((id, user)): PathParams<(i32, i32)>,
) -> R<StatusCode> {
    let row = member_row(&st, id, a.user.id).await?;
    require_host(&st, &row, a.user.id)?;
    run(&st, id, |l| l.transfer(user, &a.user.username, now_ms()))
        .await?
        .map_err(target_err)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/parties/{id}/invitees", responses((status = 200)))]
pub async fn invite(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<InviteesIn>,
) -> R<Json<PartyDto>> {
    b.validate()?;
    let me = a.user.id;
    let row = member_row(&st, id, me).await?;
    require_host(&st, &row, me)?;
    require_open(&row)?;
    let users = check_followed(&st, row.owner_id, &b.user_ids).await?;
    let added = db::add_invitees(&st.db, id, &users).await?;
    announce_invited(&st, &row, &added).await?;
    if row.status == "live" || lobby_open(&row) {
        st.hub.emit_to_users(
            &added,
            SseEvent::PartyStarting {
                party_id: id.into(),
                name: row.name.clone(),
            },
        );
    }
    Ok(Json(dto(&st, &row, me).await?))
}

#[utoipa::path(get, path = "/api/parties/{id}/queue", responses((status = 200)))]
pub async fn queue(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> R<Json<Vec<PartyItem>>> {
    let row = member_row(&st, id, a.user.id).await?;
    let mut out = vec![];
    if let Some(playlist) = row.playlist_id {
        for r in db::playlist_rows(&st.db, playlist).await? {
            if media_ok(&st, &a, r.item.media_id).await? {
                out.push(item_dto(&st, &r.item).await?);
            }
        }
    }
    Ok(Json(out))
}
