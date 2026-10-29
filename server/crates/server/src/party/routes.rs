use super::{
    cover::{self, Cover, CoverDto},
    db::{self, Row, can_open},
    dto::*,
    queue as steps,
    registry::{
        self, Brief, View, hold, item_dtos, member_dtos, mutate, mutate_held, notify_updated,
        opt_item_dtos, reveal,
    },
};
use crate::{
    events::SseEvent,
    http::{
        AppError,
        auth::{Authed, SessionAuthed},
        validate::{PathParams, ValidJson},
    },
    images::upload,
    libraries::acl::{accessible_library_ids, assert_media_accessible},
    playlists::{self, Role},
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Multipart, State, multipart::MultipartRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::Utc;
use fliks_domain::{
    acl::{Action, Subject},
    js::now_ms,
    party::{
        ANIMATED_REACTIONS, CloseReason, DEFAULT_REACTIONS, Effect, Error as PartyErr, Intent,
        Item, LOBBY_OPEN_BEFORE_MS, Policy, noto_code, same_row,
    },
};
use serde_json::{Value, json};
use std::collections::HashMap;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/time", get(time))
        .route("/api/parties", get(list).post(create))
        .route("/api/parties/by-token/{token}", get(by_token))
        .route("/api/parties/ice", get(ice))
        .route("/api/parties/reactions", get(reactions))
        .route("/api/parties/{id}", get(show).patch(patch).delete(end))
        .route(
            "/api/parties/{id}/cover",
            post(set_cover)
                .delete(clear_cover)
                .layer(upload::body_limit()),
        )
        .route("/api/parties/{id}/join", post(join))
        .route("/api/parties/{id}/select", post(select))
        .route("/api/parties/{id}/programme", put(programme))
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
        .route("/api/parties/{id}/quit", post(quit))
        .route("/api/parties/{id}/queue", get(queue))
        .merge(super::proposals::proposal_router())
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

pub(super) type R<T> = Result<T, PartyError>;

pub(super) fn fail(status: StatusCode, key: &'static str) -> PartyError {
    AppError::with_message(status, key).into()
}

pub(super) fn not_found() -> PartyError {
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
        PartyErr::NoItem => fail(StatusCode::CONFLICT, "party.error_no_item"),
        PartyErr::NotStarted => not_live(),
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

/// The libraries another user can open; `None` for a user who is disabled or gone.
pub(super) async fn user_libraries(st: &AppState, user: i32) -> Result<Option<Vec<i32>>, AppError> {
    let Some(authed) = Authed::load(&st.db, user).await? else {
        return Ok(None);
    };
    Ok(Some(accessible_library_ids(&st.db, &authed).await?))
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

/// Whether `party.starting` is due: the party is within `LOBBY_OPEN_BEFORE_MS` of its start.
fn starting_due(row: &Row) -> bool {
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

async fn try_access(st: &AppState, row: &Row, me: i32, token: Option<&str>) -> R<Option<Access>> {
    if row.owner_id == me || db::is_invitee(&st.db, row.id, me).await? {
        return Ok(Some(Access::Member));
    }
    Ok(token
        .is_some_and(|t| t == row.invite_token)
        .then_some(Access::TokenOnly))
}

async fn access(st: &AppState, row: &Row, me: i32, token: Option<&str>) -> R<Access> {
    try_access(st, row, me, token).await?.ok_or_else(not_found)
}

fn manages(a: &Authed) -> bool {
    a.perms.can(Action::Manage, &Subject::Party)
}

/// `access` plus Manage Party (any party) and Read Party (a public party, like a token holder).
async fn access_as(st: &AppState, row: &Row, a: &Authed, token: Option<&str>) -> R<Access> {
    if let Some(how) = try_access(st, row, a.user.id, token).await? {
        return Ok(how);
    }
    if manages(a) {
        return Ok(Access::Member);
    }
    if row.public && a.perms.can(Action::Read, &Subject::Party) {
        return Ok(Access::TokenOnly);
    }
    Err(not_found())
}

/// The owner until the start, then whoever the machine says.
pub(super) fn host_of(st: &AppState, row: &Row) -> i32 {
    if row.status == "scheduled" {
        return row.owner_id;
    }
    st.parties.brief(row.id).map_or(row.host(), |b| b.host_id)
}

/// The host, or a Manage Party holder.
fn require_host_or_manager(st: &AppState, row: &Row, a: &Authed) -> R<()> {
    if manages(a) {
        return Ok(());
    }
    require_host(st, row, a.user.id)
}

pub(super) fn require_host(st: &AppState, row: &Row, me: i32) -> R<()> {
    if host_of(st, row) == me {
        Ok(())
    } else {
        Err(fail(StatusCode::FORBIDDEN, "party.error_not_host"))
    }
}

pub(super) fn require_open(row: &Row) -> R<()> {
    if row.status == "ended" {
        return Err(fail(StatusCode::CONFLICT, "party.error_ended"));
    }
    Ok(())
}

/// Summaries of `rows` in three batched queries, whatever their number.
async fn summaries(st: &AppState, rows: &[Row]) -> sqlx::Result<Vec<PartySummaryDto>> {
    let rows: Vec<_> = rows.iter().map(|r| (r, st.parties.brief(r.id))).collect();
    summaries_with(st, &rows).await
}

async fn summaries_with(
    st: &AppState,
    rows: &[(&Row, Option<Brief>)],
) -> sqlx::Result<Vec<PartySummaryDto>> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let hosts: Vec<i32> = rows
        .iter()
        .map(|(r, b)| b.as_ref().map_or(r.host(), |b| b.host_id))
        .collect();
    let names = db::usernames(&st.db, &hosts).await?;
    let playlist_ids: Vec<i32> = rows.iter().filter_map(|(r, _)| r.playlist_id).collect();
    let playlists = if playlist_ids.is_empty() {
        HashMap::new()
    } else {
        db::playlist_names(&st.db, &playlist_ids).await?
    };
    let items: Vec<Option<Item>> = rows
        .iter()
        .map(|(r, b)| b.as_ref().and_then(|b| b.item.clone()).or_else(|| r.item()))
        .collect();
    let dtos = opt_item_dtos(st, &items).await?;
    let covers: Vec<&Cover> = rows
        .iter()
        .filter_map(|(r, _)| r.cover.as_deref())
        .collect();
    let cover_items: Vec<Item> = covers.iter().flat_map(|c| c.items()).collect();
    let mut resolved = item_dtos(st, &cover_items).await?.into_iter();
    Ok(rows
        .iter()
        .zip(hosts)
        .zip(dtos)
        .map(|(((row, brief), host), item)| PartySummaryDto {
            id: row.id,
            name: row.name.clone(),
            status: row.status.clone(),
            scheduled_at: row.scheduled_at,
            host: UserRef {
                user_id: host,
                username: names.get(&host).cloned().unwrap_or_default(),
            },
            item,
            playlist: row.playlist_id.and_then(|id| {
                playlists.get(&id).map(|name| PlaylistRef {
                    id,
                    name: name.clone(),
                })
            }),
            member_count: brief.as_ref().map_or(0, |b| b.member_count),
            public: row.public,
            cover: row.cover.as_deref().map(|c| c.dto(row.id, &mut resolved)),
        })
        .collect())
}

/// The snapshot for `viewer`; without `full` (a token holder who has not joined) only the summary
/// and the switches, no guests, members, messages or anchor.
pub(super) async fn dto(st: &AppState, row: &Row, viewer: i32, full: bool) -> R<PartyDto> {
    if row.status != "ended" {
        registry::ensure(st, row).await?;
    }
    let view = st.parties.view(row.id);
    let brief = view.as_ref().map(Brief::of);
    let mut summary = summaries_with(st, &[(row, brief)])
        .await?
        .pop()
        .expect("one row, one summary");
    conceal(st, viewer, std::slice::from_mut(&mut summary)).await?;
    let guests = if full {
        db::guests(&st.db, row.id).await?
    } else {
        vec![]
    };
    let sees_token = viewer == summary.host.user_id
        || (row.link_sharing
            && view
                .as_ref()
                .is_some_and(|v| v.members.iter().any(|m| m.user_id == viewer)));
    let proposals = if full {
        super::proposals::snapshot(st, row.id, viewer).await?
    } else {
        vec![]
    };
    let mut live = view.filter(|_| full).map(|v: View| PartyLive {
        rev: v.rev,
        playback: v.playback,
        members: member_dtos(st, v.host_id, &v.members),
        messages: v.messages,
    });
    if let Some(l) = &mut live {
        reveal(st, viewer, &mut l.messages).await?;
    }
    Ok(PartyDto {
        summary,
        policy: row.policy,
        reactions_enabled: row.reactions_enabled,
        chat_enabled: row.chat_enabled,
        link_sharing: row.link_sharing,
        invite_token: sees_token.then(|| row.invite_token.clone()),
        guests: guests
            .into_iter()
            .map(|(user_id, username, source)| GuestDto {
                user_id,
                username,
                source,
            })
            .collect(),
        proposals,
        live,
    })
}

async fn announce_invited(st: &AppState, row: &Row, users: &[i32]) -> Result<(), AppError> {
    if users.is_empty() {
        return Ok(());
    }
    let s = summaries(st, std::slice::from_ref(row))
        .await?
        .pop()
        .expect("one row, one summary");
    for user in users {
        let mut s = s.clone();
        conceal(st, *user, std::slice::from_mut(&mut s)).await?;
        st.hub.emit_to_users(
            &[*user],
            SseEvent::PartyInvited {
                party_id: row.id.into(),
                name: row.name.clone(),
                scheduled_at: s.scheduled_at.map(fliks_domain::js::iso),
                host: serde_json::to_value(&s.host).expect("typed dto"),
                item: serde_json::to_value(&s.item).expect("typed dto"),
            },
        );
    }
    Ok(())
}

/// Blanks the title and artwork of an item `viewer` cannot open, so a party never tells a user
/// what their libraries hide.
async fn conceal(st: &AppState, viewer: i32, sums: &mut [PartySummaryDto]) -> Result<(), AppError> {
    let mut items: Vec<&mut PartyItem> = sums
        .iter_mut()
        .flat_map(|s| {
            let covered = s.cover.iter_mut().flat_map(CoverDto::items_mut);
            s.item.iter_mut().chain(covered)
        })
        .collect();
    conceal_items(st, viewer, &mut items).await
}

pub(super) async fn conceal_items(
    st: &AppState,
    viewer: i32,
    items: &mut [&mut PartyItem],
) -> Result<(), AppError> {
    let mut medias: Vec<i32> = items.iter().map(|i| i.media_id).collect();
    medias.sort_unstable();
    medias.dedup();
    let libraries = db::media_libraries(&st.db, &medias).await?;
    let allowed = user_libraries(st, viewer).await?.unwrap_or_default();
    for item in items.iter_mut() {
        if !can_open(&libraries, &allowed, item.media_id) {
            item.title = String::new();
            item.poster_url = None;
            item.fanart_url = None;
            item.additional_fanart_urls = vec![];
            item.still_url = None;
            item.series_title = None;
            item.season_number = None;
            item.episode_number = None;
            item.episode_title = None;
            item.hidden = true;
        }
    }
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

/// The programme a party opens with: the requested item or items, or a playlist's rows from the first
/// one the owner can play (the requested one when given); empty for a party with neither.
async fn initial_programme(st: &AppState, a: &Authed, b: &Create) -> R<Vec<Item>> {
    if let Some(items) = &b.items {
        let items: Vec<Item> = items.iter().cloned().map(Item::from).collect();
        if distinct(items.clone()).len() != items.len() {
            return Err(fail(StatusCode::BAD_REQUEST, "party.error_invalid_item"));
        }
        let ids = accessible_library_ids(&st.db, a).await?;
        for item in &items {
            assert_media_accessible(&st.db, item.media_id, &ids).await?;
            check_item(st, item).await?;
        }
        return Ok(items);
    }
    let requested = |media_id| Item {
        media_id,
        media_file_id: b.media_file_id,
        episode_id: b.episode_id,
    };
    let invalid_item = || fail(StatusCode::BAD_REQUEST, "party.error_invalid_item");
    let (media_id, playlist) = match (b.media_id, b.playlist_id) {
        (None, None) if b.media_file_id.is_none() && b.episode_id.is_none() => return Ok(vec![]),
        (None, None) => return Err(invalid_item()),
        (Some(media_id), None) => {
            let item = requested(media_id);
            let ids = accessible_library_ids(&st.db, a).await?;
            assert_media_accessible(&st.db, media_id, &ids).await?;
            return Ok(vec![item]);
        }
        (media_id, Some(playlist)) => (media_id, playlist),
    };
    let requested = media_id.map(requested);
    playlists::assert_role(&st.db, a.user.id, playlist, Role::Viewer).await?;
    let rows = db::playlist_rows(&st.db, playlist).await?;
    for (at, row) in rows.iter().enumerate() {
        let wanted = requested
            .as_ref()
            .is_none_or(|r| r.media_id == row.item.media_id && r.episode_id == row.item.episode_id);
        if wanted && row.playable && media_ok(st, a, row.item.media_id).await? {
            let mut items = distinct(rows[at..].iter().map(|r| r.item.clone()).collect());
            items[0].media_file_id = b.media_file_id;
            return Ok(items);
        }
    }
    Err(invalid_item())
}

/// The items in order, a later copy of one already there dropped.
fn distinct(items: Vec<Item>) -> Vec<Item> {
    let mut out: Vec<Item> = vec![];
    for it in items {
        if !out.iter().any(|o| same_row(o, &it)) {
            out.push(it);
        }
    }
    out
}

#[utoipa::path(post, path = "/api/parties", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    ValidJson(b): ValidJson<Create>,
) -> R<(StatusCode, Json<PartyDto>)> {
    a.require(Action::Create, Subject::Party)?;
    b.validate()?;
    let me = a.user.id;
    let programme = initial_programme(&st, &a, &b).await?;
    if let Some(item) = programme.first() {
        check_item(&st, item).await?;
    }
    if let Some(c) = &b.cover {
        c.check(&programme)?;
    }
    let invitees = check_followed(&st, me, b.invitee_ids.as_deref().unwrap_or_default()).await?;
    let now = Utc::now();
    let scheduled = b.scheduled_at.filter(|t| *t > now);
    let at = scheduled.unwrap_or(now);
    let policy = b.policy.unwrap_or(Policy::Everyone);
    let (inherit_reactions, inherit_chat, inherit_link) = db::owner_switches(&st.db, me)
        .await?
        .unwrap_or((true, true, true));
    let (row, created) = db::insert(
        &st.db,
        &db::New {
            reactions_enabled: b.reactions_enabled.unwrap_or(inherit_reactions),
            chat_enabled: b.chat_enabled.unwrap_or(inherit_chat),
            link_sharing: b.link_sharing.unwrap_or(inherit_link),
            public: b.public.unwrap_or(false),
            name: &valid_name(&b.name)?,
            owner: me,
            programme: &programme,
            playlist_id: b.playlist_id,
            policy,
            scheduled_at: at,
            cover: b.cover.as_ref(),
        },
        &invitees,
        scheduled.is_none(),
    )
    .await?;
    if created {
        announce_invited(&st, &row, &invitees).await?;
        if row.public {
            notify_updated(&st, &row).await?;
        }
        if starting_due(&row) {
            registry::announce_lobby(&st, &row).await?;
        }
    }
    Ok((StatusCode::CREATED, Json(dto(&st, &row, me, true).await?)))
}

#[utoipa::path(get, path = "/api/parties", responses((status = 200)))]
pub async fn list(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
) -> R<Json<Vec<PartySummaryDto>>> {
    let public = a.perms.can(Action::Read, &Subject::Party);
    let rows = db::listed(&st.db, a.user.id, public, manages(&a)).await?;
    for row in rows.iter().filter(|r| r.status == "live") {
        registry::ensure(&st, row).await?;
    }
    let mut sums = summaries(&st, &rows).await?;
    conceal(&st, a.user.id, &mut sums).await?;
    Ok(Json(sums))
}

#[utoipa::path(get, path = "/api/parties/{id}", responses((status = 200)))]
pub async fn show(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> R<Json<PartyDto>> {
    let me = a.user.id;
    let row = row_of(&st, id).await?;
    let full = if st.parties.has_user(id, me) {
        true
    } else {
        let how = access_as(&st, &row, &a, None).await?;
        if how == Access::TokenOnly && db::is_kicked(&st.db, id, me).await? {
            return Err(fail(StatusCode::FORBIDDEN, "party.error_kicked"));
        }
        how == Access::Member
    };
    Ok(Json(dto(&st, &row, me, full).await?))
}

#[utoipa::path(get, path = "/api/parties/by-token/{token}", responses((status = 200)))]
pub async fn by_token(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(token): PathParams<String>,
) -> R<Json<PartyDto>> {
    let row = db::by_token(&st.db, &token).await?.ok_or_else(not_found)?;
    let me = a.user.id;
    let how = access(&st, &row, me, Some(&token)).await?;
    if how == Access::TokenOnly && db::is_kicked(&st.db, row.id, me).await? {
        return Err(fail(StatusCode::FORBIDDEN, "party.error_kicked"));
    }
    Ok(Json(dto(&st, &row, me, how == Access::Member).await?))
}

#[utoipa::path(patch, path = "/api/parties/{id}", responses((status = 200)))]
pub async fn patch(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<Patch>,
) -> R<Json<PartyDto>> {
    let row = row_of(&st, id).await?;
    access_as(&st, &row, &a, None).await?;
    require_host_or_manager(&st, &row, &a)?;
    require_open(&row)?;
    let name = b.name.as_deref().map(valid_name).transpose()?;
    let row = apply_patch(&st, &a, id, &b, name).await?;
    Ok(Json(dto(&st, &row, a.user.id, true).await?))
}

/// The patch under the party's gate, on the row as it is now: every field is checked before the
/// first write, and two patches cannot overwrite each other's columns.
async fn apply_patch(
    st: &AppState,
    a: &Authed,
    id: i32,
    b: &Patch,
    name: Option<String>,
) -> R<Row> {
    let _held = hold(st, id).await;
    let mut row = row_of(st, id).await?;
    require_open(&row)?;
    require_host_or_manager(st, &row, a)?;
    if b.scheduled_at.is_some() && row.status != "scheduled" {
        return Err(fail(StatusCode::CONFLICT, "party.error_not_scheduled"));
    }
    if let Some(Some(cover)) = &b.cover {
        check_cover(st, id, cover).await?;
    }
    if let Some(cover) = &b.cover {
        change_cover_held(st, a, &mut row, cover.clone(), None).await?;
    }
    let was_public = row.public;
    let was_scheduled = row.scheduled_at;
    let renamed = name.as_ref().is_some_and(|n| *n != row.name);
    if let Some(at) = b.scheduled_at {
        row.scheduled_at = Some(at.max(Utc::now()));
        st.parties.forget_notice(id);
    }
    if let Some(n) = &name {
        row.name.clone_from(n);
    }
    row.policy = b.policy.unwrap_or(row.policy);
    row.reactions_enabled = b.reactions_enabled.unwrap_or(row.reactions_enabled);
    row.chat_enabled = b.chat_enabled.unwrap_or(row.chat_enabled);
    row.link_sharing = b.link_sharing.unwrap_or(row.link_sharing);
    row.public = b.public.unwrap_or(row.public);
    let regenerate = b.regenerate_token == Some(true);
    if regenerate {
        row.invite_token = db::new_token();
    }
    db::update_settings(
        &st.db,
        id,
        &row.name,
        row.policy,
        (
            row.reactions_enabled,
            row.chat_enabled,
            row.link_sharing,
            row.public,
        ),
        row.scheduled_at,
        &row.invite_token,
    )
    .await?;
    if name.is_some()
        || b.policy.is_some()
        || b.reactions_enabled.is_some()
        || b.chat_enabled.is_some()
        || b.link_sharing.is_some()
        || b.public.is_some()
    {
        registry::ensure_held(st, &row).await?;
        mutate_held(st, id, |l| {
            (
                (),
                l.room.set_settings(
                    &a.user.username,
                    name.clone(),
                    b.policy,
                    [
                        b.reactions_enabled,
                        b.chat_enabled,
                        b.link_sharing,
                        b.public,
                    ],
                    now_ms(),
                ),
            )
        })
        .await;
    }
    if b.scheduled_at.is_some() && row.scheduled_at != was_scheduled {
        let at = row.scheduled_at.map(fliks_domain::js::iso);
        registry::note_held(
            st,
            &row,
            "rescheduled",
            &a.user.username,
            json!({ "scheduledAt": at }),
        )
        .await?;
    }
    let went_private = was_public && !row.public;
    if regenerate || went_private {
        revoke_guests(st, a, &row, regenerate).await?;
    }
    if b.scheduled_at.is_some() && starting_due(&row) {
        registry::announce_lobby(st, &row).await?;
    }
    if b.scheduled_at.is_some() || renamed || row.public != was_public {
        notify_updated(st, &row).await?;
    }
    if went_private {
        st.hub.emit(SseEvent::PartyUpdated {
            party_id: id.into(),
        });
    }
    Ok(row)
}

/// Drops the guests a new token (`link`, `public`) or a private party (`public`) no longer admits,
/// except the live host, from the room too.
async fn revoke_guests(st: &AppState, a: &Authed, row: &Row, regenerate: bool) -> R<()> {
    let id = row.id;
    let sources: &[&str] = if regenerate {
        db::clear_kicked(&st.db, id).await?;
        &["link", "public"]
    } else {
        &["public"]
    };
    let gone = db::drop_guests(&st.db, id, sources, host_of(st, row)).await?;
    super::proposals::forget_users(st, row, &gone).await?;
    mutate_held(st, id, |l| {
        let fx = gone
            .iter()
            .filter_map(|u| l.kick(*u, &a.user.username, now_ms()).ok())
            .flatten()
            .collect();
        ((), fx)
    })
    .await;
    st.hub.emit_to_users(
        &gone,
        SseEvent::PartyUpdated {
            party_id: id.into(),
        },
    );
    Ok(())
}

#[utoipa::path(delete, path = "/api/parties/{id}", responses((status = 204)))]
pub async fn end(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> R<StatusCode> {
    let row = row_of(&st, id).await?;
    access_as(&st, &row, &a, None).await?;
    require_host_or_manager(&st, &row, &a)?;
    if row.status != "ended" {
        registry::end(
            &st,
            id,
            CloseReason::HostEnded,
            Some(a.user.username.clone()),
        )
        .await?;
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
    let how = access_as(&st, &row, &a, b.token.as_deref()).await?;
    require_open(&row)?;
    if !registry::ensure(&st, &row).await? {
        return Err(fail(StatusCode::CONFLICT, "party.error_ended"));
    }
    let item = st
        .parties
        .brief(id)
        .ok_or_else(not_live)?
        .item
        .or_else(|| row.item());
    if how == Access::TokenOnly && db::is_kicked(&st.db, id, me).await? {
        return Err(fail(StatusCode::FORBIDDEN, "party.error_kicked"));
    }
    if let Some(item) = &item
        && !media_ok(&st, &a, item.media_id).await?
    {
        return Err(fail(StatusCode::FORBIDDEN, "party.error_no_access"));
    }
    let conn = connection_for(&st, me, &b.device_id)
        .ok_or_else(|| fail(StatusCode::CONFLICT, "party.error_no_connection"))?;
    if how == Access::TokenOnly {
        let via = if b.token.as_deref() == Some(row.invite_token.as_str()) {
            db::JoinedVia::Link
        } else {
            db::JoinedVia::Public
        };
        db::add_joined_guest(&st.db, id, me, via).await?;
        notify_updated(&st, &row).await?;
    }
    let name = a.user.username.clone();
    mutate(&st, id, |l| {
        ((), l.join(me, &name, &b.device_id, &conn, now_ms()))
    })
    .await;
    Ok(Json(dto(&st, &row, me, true).await?))
}

/// A cover a client may set must fit the programme as it is now.
async fn check_cover(st: &AppState, id: i32, cover: &Cover) -> R<()> {
    let programme: Vec<Item> = db::programme_rows(&st.db, id)
        .await?
        .into_iter()
        .map(|r| r.item)
        .collect();
    cover.check(&programme)?;
    Ok(())
}

/// Sets the cover (`jpeg`: the upload that becomes it) or resets it (`None`); the caller holds the
/// party's gate. `false` when it was already so.
async fn write_cover_held(
    st: &AppState,
    row: &mut Row,
    cover: Option<Cover>,
    jpeg: Option<&[u8]>,
) -> R<bool> {
    let id = row.id;
    *row = row_of(st, id).await?;
    require_open(row)?;
    if jpeg.is_none() && row.cover.as_deref() == cover.as_ref() {
        return Ok(false);
    }
    if let (Some(c), None) = (&cover, jpeg) {
        check_cover(st, id, c).await?;
    }
    let stem = cover.as_ref().and_then(|c| c.upload_stem(id));
    if let (Some(bytes), Some(stem)) = (jpeg, &stem) {
        upload::write(cover::DIR, stem, bytes).await?;
    }
    db::set_cover(&st.db, id, cover.as_ref()).await?;
    let old = row.cover.as_deref().and_then(|c| c.upload_stem(id));
    if let Some(old) = old.filter(|o| Some(o) != stem.as_ref()) {
        upload::remove(cover::DIR, old).await;
    }
    row.cover = cover.map(Into::into);
    Ok(true)
}

async fn change_cover_held(
    st: &AppState,
    a: &Authed,
    row: &mut Row,
    cover: Option<Cover>,
    jpeg: Option<&[u8]>,
) -> R<()> {
    if write_cover_held(st, row, cover, jpeg).await? {
        registry::note_held(st, row, "cover_changed", &a.user.username, json!({})).await?;
        notify_updated(st, row).await?;
    }
    Ok(())
}

async fn change_cover(
    st: &AppState,
    a: &Authed,
    row: &mut Row,
    cover: Option<Cover>,
    jpeg: Option<&[u8]>,
) -> R<()> {
    let _held = hold(st, row.id).await;
    change_cover_held(st, a, row, cover, jpeg).await
}

#[utoipa::path(post, path = "/api/parties/{id}/cover", responses((status = 200)))]
pub async fn set_cover(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    multipart: Result<Multipart, MultipartRejection>,
) -> R<Json<PartyDto>> {
    let mut row = row_of(&st, id).await?;
    access_as(&st, &row, &a, None).await?;
    require_host_or_manager(&st, &row, &a)?;
    require_open(&row)?;
    let bytes = upload::read_image(multipart, "Cover").await?;
    let v = Utc::now().timestamp_millis();
    let key = Some(db::new_token());
    change_cover(
        &st,
        &a,
        &mut row,
        Some(Cover::Upload { v, key }),
        Some(&bytes),
    )
    .await?;
    Ok(Json(dto(&st, &row, a.user.id, true).await?))
}

#[utoipa::path(delete, path = "/api/parties/{id}/cover", responses((status = 200)))]
pub async fn clear_cover(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> R<Json<PartyDto>> {
    let mut row = row_of(&st, id).await?;
    access_as(&st, &row, &a, None).await?;
    require_host_or_manager(&st, &row, &a)?;
    require_open(&row)?;
    change_cover(&st, &a, &mut row, None, None).await?;
    Ok(Json(dto(&st, &row, a.user.id, true).await?))
}

/// The host replaces the programme by one item.
#[utoipa::path(post, path = "/api/parties/{id}/select", responses((status = 200)))]
pub async fn select(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<ItemIn>,
) -> R<Json<PartyDto>> {
    let mut row = host_row(&st, id, a.user.id).await?;
    edit_programme(&st, &a, &mut row, Edit::Replace(vec![Item::from(b)])).await?;
    Ok(Json(dto(&st, &row, a.user.id, true).await?))
}

/// The host replaces the programme: reorder, remove and add are one list.
#[utoipa::path(put, path = "/api/parties/{id}/programme", responses((status = 200)))]
pub async fn programme(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<ProgrammeIn>,
) -> R<Json<PartyDto>> {
    let mut row = host_row(&st, id, a.user.id).await?;
    let items = b.items.into_iter().map(Item::from).collect();
    edit_programme(&st, &a, &mut row, Edit::Replace(items)).await?;
    Ok(Json(dto(&st, &row, a.user.id, true).await?))
}

async fn host_row(st: &AppState, id: i32, me: i32) -> R<Row> {
    let row = row_of(st, id).await?;
    access(st, &row, me, None).await?;
    require_host(st, &row, me)?;
    require_open(&row)?;
    Ok(row)
}

pub(super) enum Edit {
    Replace(Vec<Item>),
    /// The item joins the end, unless it is already there.
    Append(Item),
}

/// The one path that writes the programme, under the party's gate so edits and their events keep
/// their order.
pub(super) async fn edit_programme(st: &AppState, a: &Authed, row: &mut Row, edit: Edit) -> R<()> {
    let _held = hold(st, row.id).await;
    edit_held(st, a, row, edit).await
}

/// The system message of a programme edit: what was added and removed, or only a reorder.
fn programme_note(current: &[db::QueueRow], items: &[Item]) -> Option<(&'static str, Value)> {
    let added = items
        .iter()
        .filter(|i| !current.iter().any(|r| same_row(&r.item, i)))
        .count();
    let removed = current
        .iter()
        .filter(|r| !items.iter().any(|i| same_row(&r.item, i)))
        .count();
    if added + removed > 0 {
        return Some((
            "programme_changed",
            json!({ "added": added, "removed": removed }),
        ));
    }
    let same_order = current.iter().zip(items).all(|(r, i)| same_row(&r.item, i));
    (!same_order).then(|| ("programme_reordered", json!({})))
}

/// `edit_programme` for a caller that holds the gate; the items added, and the head before the
/// start, must be open to every member.
async fn edit_held(st: &AppState, a: &Authed, row: &mut Row, edit: Edit) -> R<()> {
    let id = row.id;
    *row = row_of(st, id).await?;
    require_open(row)?;
    let current = db::programme_rows(&st.db, id).await?;
    let replaced = matches!(edit, Edit::Replace(_));
    let items = match edit {
        Edit::Replace(items) => items,
        Edit::Append(item) => {
            let mut items: Vec<Item> = current.iter().map(|r| r.item.clone()).collect();
            if !items.iter().any(|i| same_row(i, &item)) {
                items.push(item);
            }
            items
        }
    };
    if items.len() > MAX_PROGRAMME || distinct(items.clone()).len() != items.len() {
        return Err(fail(StatusCode::BAD_REQUEST, "party.error_invalid_item"));
    }
    let mut vetted: Vec<Item> = items
        .iter()
        .filter(|i| !current.iter().any(|r| same_row(&r.item, i)))
        .cloned()
        .collect();
    if row.status == "scheduled"
        && let Some(head) = items.first()
        && current.first().is_none_or(|c| !same_row(&c.item, head))
        && !vetted.iter().any(|i| same_row(i, head))
    {
        vetted.push(head.clone());
    }
    let ids = accessible_library_ids(&st.db, a).await?;
    for item in &vetted {
        assert_media_accessible(&st.db, item.media_id, &ids).await?;
    }
    if !vetted.is_empty() {
        vet_items(st, id, &vetted).await?;
    }
    let cover = row.cover.as_deref().and_then(|c| c.prune(&items));
    db::set_programme(&st.db, id, &items, cover.as_ref()).await?;
    let head = items.first().cloned();
    // An append is `choose` (which posts `proposal_chosen`) or the start on the top vote.
    let note = replaced.then(|| programme_note(&current, &items)).flatten();
    registry::ensure_held(st, row).await?;
    mutate_held(st, id, |l| {
        let mut fx = l.programme(head);
        if let Some((kind, args)) = note {
            fx.extend(l.room.note(kind, &a.user.username, args, now_ms()));
        }
        ((), fx)
    })
    .await;
    *row = row_of(st, id).await?;
    // Owner and guests on the party page are not in the room once it is live: they refetch on this.
    notify_updated(st, row).await?;
    Ok(())
}

/// Takes a `scheduled` party live on the head of its programme. The gate makes it the only start:
/// a second one, or one that lost to an end, finds the row already moved.
#[utoipa::path(post, path = "/api/parties/{id}/start", responses((status = 200)))]
pub async fn start(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> R<Json<PartyDto>> {
    let me = a.user.id;
    let row = row_of(&st, id).await?;
    access(&st, &row, me, None).await?;
    require_host(&st, &row, me)?;
    require_open(&row)?;
    if row.status == "scheduled" {
        let _held = hold(&st, id).await;
        go_live(&st, &a, id).await?;
    }
    let row = row_of(&st, id).await?;
    Ok(Json(dto(&st, &row, me, true).await?))
}

/// The start, under the gate. An empty programme takes the top vote; a head nobody can play, or a
/// member cannot open, is refused as a `setItem` would.
async fn go_live(st: &AppState, a: &Authed, id: i32) -> R<()> {
    let mut row = row_of(st, id).await?;
    require_open(&row)?;
    if row.status != "scheduled" {
        return Ok(());
    }
    registry::ensure_held(st, &row).await?;
    if row.item().is_none() {
        let top = super::proposals::top(&st.db, id).await?;
        let item = top.ok_or_else(|| machine_err(PartyErr::NoItem))?;
        edit_held(st, a, &mut row, Edit::Append(item)).await?;
    }
    let head = db::programme_rows(&st.db, id)
        .await?
        .into_iter()
        .next()
        .filter(|r| r.playable)
        .ok_or_else(|| machine_err(PartyErr::NoItem))?
        .item;
    let ids = accessible_library_ids(&st.db, a).await?;
    assert_media_accessible(&st.db, head.media_id, &ids).await?;
    vet_items(st, id, std::slice::from_ref(&head)).await?;
    let item = db::set_live(&st.db, id)
        .await?
        .ok_or_else(|| machine_err(PartyErr::NoItem))?;
    mutate_held(st, id, |l| ((), l.go_live(item, now_ms())))
        .await
        .ok_or_else(not_live)?;
    let guests = db::guest_ids(&st.db, id).await?;
    st.hub.emit_to_users(
        &guests,
        SseEvent::PartyStarting {
            party_id: id.into(),
            name: row.name.clone(),
        },
    );
    notify_updated(st, &row).await?;
    Ok(())
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
    mutate(&st, id, |l| match l.leave(me, &b.device_id, now_ms()) {
        Ok(e) => ((), e),
        Err(_) => ((), vec![]),
    })
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// The row for a member, owner or invitee; anyone else gets the 404 of an unknown party.
pub(super) async fn member_row(st: &AppState, id: i32, me: i32) -> R<Row> {
    let row = row_of(st, id).await?;
    if !st.parties.has_user(id, me) {
        access(st, &row, me, None).await?;
    }
    Ok(row)
}

/// Each item belongs to its media and every current member can open them, else 409
/// `party.error_member_no_access` naming those who cannot.
async fn vet_items(st: &AppState, id: i32, items: &[Item]) -> R<()> {
    for it in items {
        check_item(st, it).await?;
    }
    let members = st.parties.view(id).map_or_else(Vec::new, |v| v.members);
    let mut medias: Vec<i32> = items.iter().map(|i| i.media_id).collect();
    medias.sort_unstable();
    medias.dedup();
    let libraries = db::media_libraries(&st.db, &medias).await?;
    let mut denied = vec![];
    let mut checked = vec![];
    for m in &members {
        if checked.contains(&m.user_id) {
            continue;
        }
        checked.push(m.user_id);
        let open = user_libraries(st, m.user_id)
            .await?
            .is_some_and(|ids| medias.iter().all(|m| can_open(&libraries, &ids, *m)));
        if !open {
            denied.push(m.username.clone());
        }
    }
    if denied.is_empty() {
        return Ok(());
    }
    Err(PartyError::Extra(
        StatusCode::CONFLICT,
        "party.error_member_no_access",
        "usernames",
        json!(denied),
    ))
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
    if !registry::ensure(&st, &row).await? {
        return Err(not_live());
    }
    let item: Option<Item> = b.item.map(Into::into);
    if let (IntentAction::SetItem, Some(it)) = (b.action, item.as_ref()) {
        vet_items(&st, id, std::slice::from_ref(it)).await?;
    }
    let plan = match b.action {
        IntentAction::Next | IntentAction::Previous if item.is_none() => Some(
            queue_step(&st, &row, b.action == IntentAction::Next)
                .await?
                .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "party.error_invalid"))?,
        ),
        IntentAction::Next | IntentAction::Previous => {
            return Err(fail(StatusCode::BAD_REQUEST, "party.error_invalid"));
        }
        // An `ended` that takes effect moves the programme on.
        IntentAction::Ended if st.parties.can_end(id, me, &b.device_id, item.as_ref()) => {
            queue_step(&st, &row, true).await?
        }
        _ => None,
    };
    let ended = b.action == IntentAction::Ended;
    let res = mutate(&st, id, |l| {
        let result = match (b.action.machine(), plan) {
            (_, Some((step, from))) if ended => {
                l.advance_after_ended(me, &b.device_id, item.as_ref(), &from, step, now_ms())
            }
            (_, Some((step, _))) => l.advance(me, &b.device_id, b.base_rev, step, now_ms()),
            (Some(action), None) => l.intent(
                me,
                &b.device_id,
                Intent {
                    action,
                    position: b.position,
                    item,
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
    .await
    .ok_or_else(not_live)?;
    match res {
        Ok(rev) => Ok((StatusCode::ACCEPTED, Json(json!({ "rev": rev })))),
        Err(PartyErr::Stale) => {
            let snap = dto(&st, &row, me, true).await?;
            Err(PartyError::Bare(
                StatusCode::CONFLICT,
                serde_json::to_value(snap).expect("typed dto"),
            ))
        }
        Err(e) => Err(machine_err(e)),
    }
}

/// The step to take in the programme, judged for every user in the party right now, and the item
/// it was computed from; `None` when the programme is empty.
async fn queue_step(
    st: &AppState,
    row: &Row,
    forward: bool,
) -> R<Option<(fliks_domain::party::Step, Item)>> {
    let view = st.parties.view(row.id).ok_or_else(not_live)?;
    let current = view.item.clone().ok_or_else(not_live)?;
    let rows = db::programme_rows(&st.db, row.id).await?;
    if rows.is_empty() {
        return Ok(None);
    }
    let mut users: Vec<i32> = view.members.iter().map(|m| m.user_id).collect();
    users.sort_unstable();
    users.dedup();
    let step = steps::step(st, rows, &current, forward, &users).await?;
    Ok(Some((step, current)))
}

async fn run(
    st: &AppState,
    id: i32,
    f: impl FnOnce(&mut fliks_domain::party::Live) -> Result<Vec<Effect>, PartyErr>,
) -> R<Result<(), PartyErr>> {
    mutate(st, id, |l| match f(l) {
        Ok(e) => (Ok(()), e),
        Err(e) => (Err(e), vec![]),
    })
    .await
    .ok_or_else(not_live)
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
    let m = mutate(&st, id, |l| {
        match l.room.post_message(a.user.id, &b.device_id, text, now_ms()) {
            Ok((m, e)) => (Ok(m), e),
            Err(e) => (Err(e), vec![]),
        }
    })
    .await
    .ok_or_else(not_live)?
    .map_err(machine_err)?;
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
        l.room.react(a.user.id, &b.device_id, &b.emoji, now_ms())
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
        l.room
            .set_voice(a.user.id, &b.device_id, b.joined, b.muted, now_ms())
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
                l.room
                    .signal_target(a.user.id, &b.device_id, &b.to, b.to_user_id, now_ms()),
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
    let _held = hold(&st, id).await;
    if user == row.owner_id || user == host_of(&st, &row) {
        return Err(machine_err(PartyErr::Invalid("host")));
    }
    // A guest who is not connected is kicked too; only a user who is neither is a 404.
    if !st.parties.has_user(id, user) && !db::is_invitee(&st.db, id, user).await? {
        return Err(not_found());
    }
    db::kick_guest(&st.db, id, user).await?;
    mutate_held(&st, id, |l| {
        match l.kick(user, &a.user.username, now_ms()) {
            Ok(e) => ((), e),
            Err(_) => ((), vec![]),
        }
    })
    .await;
    super::proposals::forget_users(&st, &row, &[user]).await?;
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
    let _held = hold(&st, id).await;
    let (res, delivery) = st
        .parties
        .act(id, |l| match l.transfer(user, &a.user.username, now_ms()) {
            Ok(e) => (Ok(()), e),
            Err(e) => (Err(e), vec![]),
        })
        .ok_or_else(not_live)?;
    res.map_err(target_err)?;
    if let Err(err) = db::set_host(&st.db, id, user).await {
        tracing::warn!(error = %err, party = id, "party host not saved");
    }
    registry::deliver(&st, id, delivery).await;
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
    if !added.is_empty() {
        let mut names: Vec<_> = db::usernames(&st.db, &added).await?.into_values().collect();
        names.sort();
        let args = json!({ "usernames": names });
        registry::note(&st, &row, "people_added", &a.user.username, args).await?;
    }
    if row.status == "live" || starting_due(&row) {
        st.hub.emit_to_users(
            &added,
            SseEvent::PartyStarting {
                party_id: id.into(),
                name: row.name.clone(),
            },
        );
    }
    Ok(Json(dto(&st, &row, me, true).await?))
}

/// A guest leaves the party for good; the host cannot, and anyone who is not a guest gets the 404.
#[utoipa::path(post, path = "/api/parties/{id}/quit", responses((status = 204)))]
pub async fn quit(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> R<StatusCode> {
    let me = a.user.id;
    let row = row_of(&st, id).await?;
    require_open(&row)?;
    if host_of(&st, &row) == me || row.owner_id == me {
        return Err(machine_err(PartyErr::Invalid("host")));
    }
    if !db::drop_guest(&st.db, id, me).await? {
        return Err(not_found());
    }
    super::proposals::forget_users(&st, &row, &[me]).await?;
    let _held = hold(&st, id).await;
    registry::ensure_held(&st, &row).await?;
    mutate_held(&st, id, |l| {
        let devices: Vec<String> = l
            .room
            .members
            .iter()
            .filter(|m| m.user_id == me)
            .map(|m| m.device_id.clone())
            .collect();
        let mut fx: Vec<Effect> = devices
            .iter()
            .filter_map(|d| l.leave(me, d, now_ms()).ok())
            .flatten()
            .collect();
        fx.extend(l.room.note("quit", &a.user.username, json!({}), now_ms()));
        ((), fx)
    })
    .await;
    notify_updated(&st, &row).await?;
    st.hub.emit_to_users(
        &[me],
        SseEvent::PartyUpdated {
            party_id: id.into(),
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(get, path = "/api/parties/{id}/queue", responses((status = 200)))]
pub async fn queue(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> R<Json<Vec<PartyItem>>> {
    let row = member_row(&st, id, a.user.id).await?;
    let items: Vec<Item> = db::programme_rows(&st.db, row.id)
        .await?
        .into_iter()
        .map(|r| r.item)
        .collect();
    let mut dtos = item_dtos(&st, &items).await?;
    let mut refs: Vec<&mut PartyItem> = dtos.iter_mut().collect();
    conceal_items(&st, a.user.id, &mut refs).await?;
    Ok(Json(dtos))
}
