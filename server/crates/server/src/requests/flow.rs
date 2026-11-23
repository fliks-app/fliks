//! The request flows (`requests.md` rules 1-27): gates, create, approve, decline, comments.
use super::{
    Art, ImportSpec, PortError, TitleKey, db,
    dto::{self, CreateRequest, Field, UpdateRequest},
    rules, services,
};
use crate::acquisition::attempts;
use crate::push::ReqRef;
use crate::{
    events::DomainEvent,
    http::{AppError, auth::Authed},
    ingest::KeyedLocks,
    libraries::{accessible_library_ids, paths_visible},
    media::hydrate,
    profiles,
    state::AppState,
};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use fliks_domain::{
    acl::{Action, Subject},
    media::{kind::MediaKind, wants::WantSpec},
};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use std::{sync::LazyLock, time::Duration};

pub type Res<T> = Result<T, AppError>;

static QUOTA_TURNS: LazyLock<KeyedLocks<i32>> = LazyLock::new(KeyedLocks::default);

const ART_WAIT: Duration = Duration::from_secs(5);

impl From<PortError> for AppError {
    fn from(e: PortError) -> Self {
        let status = StatusCode::from_u16(e.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        AppError::with_message(status, e.message)
    }
}

/// `ability.can(Manage, FliksRequest)`: `requests.manage` or `manage:all`.
pub fn can_manage(a: &Authed) -> bool {
    a.perms.can(Action::Manage, &Subject::FliksRequest)
}

/// Every library is reachable: an admin or `manage:all`.
pub fn is_super(a: &Authed) -> bool {
    a.perms.can(Action::Manage, &Subject::All)
}

fn forbidden() -> AppError {
    AppError::bare(StatusCode::FORBIDDEN)
}

pub fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("Request #{id} not found"))
}

/// Only the libraries the caller may reach can be named explicitly (rule 11 step 3).
async fn assert_can_use_library(st: &AppState, a: &Authed, library_id: i32) -> Res<()> {
    if is_super(a)
        || accessible_library_ids(&st.db, a)
            .await?
            .contains(&library_id)
    {
        return Ok(());
    }
    Err(AppError::forbidden(
        "You do not have access to the selected library",
    ))
}

/// Rule 4: a request anchored to a library the caller cannot reach is off limits, except to its owner.
pub async fn assert_can_access_request_library(
    st: &AppState,
    a: &Authed,
    library_id: Option<i32>,
    owner: Option<i32>,
) -> Res<()> {
    let Some(library_id) = library_id else {
        return Ok(());
    };
    if is_super(a)
        || owner == Some(a.user.id)
        || accessible_library_ids(&st.db, a)
            .await?
            .contains(&library_id)
    {
        return Ok(());
    }
    Err(AppError::forbidden(
        "You do not have access to this request's target library",
    ))
}

/// `counts.md` rule 5: pending requests in the kinds of `a`; every request when `all`, else their
/// own. `libraries` limits the others to those a manager may decide (`pending_row`'s library check).
pub async fn pending_count(
    db: &sqlx::PgPool,
    a: &Authed,
    all: bool,
    libraries: Option<&[i32]>,
) -> sqlx::Result<i32> {
    sqlx::query_scalar(
        r#"SELECT count(*)::int FROM requests
           WHERE status = 'pending' AND ($1 OR "userId" = $2) AND "mediaType" = ANY($3)
             AND ($4::int[] IS NULL OR "libraryId" IS NULL OR "libraryId" = ANY($4) OR "userId" = $2)"#,
    )
    .bind(all)
    .bind(a.user.id)
    .bind(a.kinds.names())
    .bind(libraries)
    .fetch_one(db)
    .await
}

/// Rule 3: a non-manager only reaches their own requests.
pub fn owner_or_manager(a: &Authed, owner: Option<i32>) -> Res<()> {
    if can_manage(a) || owner == Some(a.user.id) {
        Ok(())
    } else {
        Err(forbidden())
    }
}

/// `findOne`'s gates: 404, owner or manager, then the library gate.
pub async fn gate(st: &AppState, a: &Authed, id: i32) -> Res<db::Req> {
    let row = db::find(&st.db, id).await?.ok_or_else(|| not_found(id))?;
    owner_or_manager(a, row.user_id)?;
    assert_can_access_request_library(st, a, row.library_id, row.user_id).await?;
    Ok(row)
}

async fn resolve_sole_library(st: &AppState, a: &Authed, media_type: MediaKind) -> Res<i32> {
    let ids = accessible_library_ids(&st.db, a).await?;
    let found = db::libraries_accepting(&st.db, media_type, Some(&ids)).await?;
    match found.as_slice() {
        [one] => Ok(*one),
        [] => Err(AppError::bad_request(format!(
            "No library accepts {media_type}"
        ))),
        _ => Err(AppError::bad_request(format!(
            "Several libraries accept {media_type} — pass libraryId to choose one"
        ))),
    }
}

/// Window length of a user's quota (rule 13): 7 days when unset.
fn quota_period(a: &Authed) -> i32 {
    match a.user.quota_period_days {
        0 => 7,
        n => n,
    }
}

/// Rule 13: the ADD requests of the window still pending or approved count against the limit; the
/// caller holds the user's quota lock, so the count is still true at the insert.
async fn check_quota(tx: &mut PgConnection, a: &Authed, media_type: MediaKind) -> Res<()> {
    let limit = a.user.quotas.limit(media_type);
    if limit == 0 {
        return Ok(());
    }
    let period = quota_period(a);
    let since = Utc::now() - chrono::Duration::days(i64::from(period));
    let count = db::quota_window(&mut *tx, a.user.id, media_type, since)
        .await?
        .len() as i64;
    if count >= i64::from(limit) {
        return Err(AppError::forbidden(format!(
            "Quota exceeded: {count}/{limit} {media_type} requests in last {period} days"
        ))
        .keyed(
            "requests.quotaExceeded",
            json!({ "count": count, "limit": limit, "kind": media_type.as_str(), "days": period }),
        ));
    }
    Ok(())
}

/// When a slot frees: the request whose leaving brings the count under `limit`, a period after it.
/// A non-positive limit never frees.
fn next_free_at(window: &[DateTime<Utc>], limit: i32, period: i32) -> Option<DateTime<Utc>> {
    let limit = usize::try_from(limit).ok().filter(|l| *l > 0)?;
    let leaving = window.get(window.len().checked_sub(limit)?)?;
    Some(*leaving + chrono::Duration::days(i64::from(period)))
}

/// Per kind with a limit: `{limit, used, periodDays, nextFreeAt}`, counted as `check_quota` does.
pub async fn allowance(st: &AppState, a: &Authed) -> Res<Value> {
    let period = quota_period(a);
    let since = Utc::now() - chrono::Duration::days(i64::from(period));
    let mut out = Map::new();
    for kind in MediaKind::ALL {
        let limit = a.user.quotas.limit(kind);
        if limit == 0 {
            continue;
        }
        let window = db::quota_window(&st.db, a.user.id, kind, since).await?;
        let used = window.len() as i64;
        let next_free = match next_free_at(&window, limit, period) {
            Some(t) => json!(fliks_domain::js::iso(t)),
            None => Value::Null,
        };
        out.insert(
            kind.to_string(),
            json!({ "limit": limit, "used": used, "periodDays": period, "nextFreeAt": next_free }),
        );
    }
    Ok(Value::Object(out))
}

/// Rule 12a.
async fn assert_no_active_duplicate(
    tx: &mut PgConnection,
    dto: &CreateRequest,
    keys: &[TitleKey],
) -> Res<()> {
    let existing = db::active_adds_of(&mut *tx, keys).await?;
    if existing.is_empty() {
        return Ok(());
    }
    if dto.media_type == MediaKind::Album {
        return assert_album_unclaimed(dto, &existing);
    }
    if let Some(wants) = &dto.wants {
        let overlap = overlapping_wants(&existing, wants);
        if overlap.is_empty() {
            return Ok(());
        }
        return Err(already_requested(&overlap));
    }
    let wanted = dto.seasons.as_deref().unwrap_or_default();
    if !dto.media_type.has_seasons() || wanted.is_empty() {
        return Err(AppError::conflict("This title has already been requested"));
    }
    let mut taken = vec![];
    for e in &existing {
        match e.scope() {
            None => {
                return Err(AppError::conflict(
                    "The whole series has already been requested",
                ));
            }
            Some(s) => taken.extend_from_slice(s),
        }
    }
    let overlap: Vec<String> = wanted
        .iter()
        .filter(|s| taken.contains(s))
        .map(ToString::to_string)
        .collect();
    if overlap.is_empty() {
        return Ok(());
    }
    Err(AppError::conflict(format!(
        "Season(s) {} have already been requested",
        overlap.join(", ")
    )))
}

/// Rule 52: a track request clashes with a whole-album request and with the tracks another one holds; a whole
/// album clashes with another whole-album request only, so it can widen the tracks already requested.
fn assert_album_unclaimed(dto: &CreateRequest, existing: &[db::Req]) -> Res<()> {
    let Some(asked) = &dto.recordings else {
        let whole: Vec<db::Req> = existing
            .iter()
            .filter(|e| e.recordings.is_none())
            .cloned()
            .collect();
        let overlap = overlapping_wants(&whole, dto.wants.as_deref().unwrap_or_default());
        return if overlap.is_empty() {
            Ok(())
        } else {
            Err(already_requested(&overlap))
        };
    };
    if existing.iter().any(|e| e.recordings.is_none()) {
        return Err(AppError::conflict(
            "The whole album has already been requested",
        ));
    }
    let overlap: Vec<&str> = asked
        .iter()
        .filter(|r| {
            existing
                .iter()
                .any(|e| e.recordings.iter().flatten().any(|t| t == *r))
        })
        .map(String::as_str)
        .collect();
    if overlap.is_empty() {
        return Ok(());
    }
    Err(AppError::conflict(format!(
        "Track(s) {} have already been requested",
        overlap.join(", ")
    )))
}

/// Rule 52: every requested track is already in the library or wanted, so there is nothing to request.
async fn assert_tracks_unclaimed(st: &AppState, key: &TitleKey, recordings: &[String]) -> Res<()> {
    let Some(media) = db::media_by_ref(&st.db, key).await? else {
        return Ok(());
    };
    if db::tracks_claimed(&st.db, media.id, recordings).await? == recordings.len() as i64 {
        return Err(AppError::conflict(
            "Every requested track is already wanted or in the library",
        ));
    }
    Ok(())
}

/// The labels of `wants` that an active request already holds.
fn overlapping_wants(existing: &[db::Req], wants: &[WantSpec]) -> Vec<String> {
    let taken: Vec<&WantSpec> = existing
        .iter()
        .flat_map(|e| e.wants.iter().flat_map(|w| w.0.iter()))
        .collect();
    wants
        .iter()
        .filter(|w| taken.iter().any(|t| overlaps(w, t)))
        .map(want_label)
        .collect()
}

fn already_requested(labels: &[String]) -> AppError {
    AppError::conflict(format!(
        "Edition(s) {} have already been requested",
        labels.join(", ")
    ))
}

/// A book whose every wanted edition is already in the library has nothing left to request.
async fn assert_wants_unsatisfied(st: &AppState, key: &TitleKey, wants: &[WantSpec]) -> Res<()> {
    if let Some(m) = db::media_by_ref(&st.db, key).await?
        && db::wants_covered(&st.db, m.id, wants).await?
    {
        return Err(AppError::conflict(
            "Every requested edition is already in the library",
        ));
    }
    Ok(())
}

/// Two wants clash on one family when their languages are equal or one of them is any.
fn overlaps(a: &WantSpec, b: &WantSpec) -> bool {
    a.family == b.family
        && (a.language.is_none() || b.language.is_none() || a.language == b.language)
}

fn want_label(w: &WantSpec) -> String {
    match &w.language {
        Some(l) => format!("{}-{l}", w.family),
        None => w.family.to_string(),
    }
}

type Profiles = (Option<i32>, Option<i32>);

/// Rule 12b: the profiles of the earliest active request, else of the library row.
async fn existing_series_profiles(
    conn: &mut PgConnection,
    key: &TitleKey,
    keys: &[TitleKey],
) -> Res<Option<Profiles>> {
    if let Some(r) = db::active_adds_of(&mut *conn, keys).await?.first() {
        return Ok(Some((r.quality_profile_id, r.language_profile_id)));
    }
    // a title held twice has no single library row to lock the profiles to
    match db::media_by_ref_on(conn, key).await {
        Ok(m) => Ok(m.map(|m| (m.quality_profile_id, m.language_profile_id))),
        Err(e) if e.status() == StatusCode::CONFLICT => Ok(None),
        Err(e) => Err(e),
    }
}

pub async fn title_state(st: &AppState, a: &Authed, key: &TitleKey) -> Res<Value> {
    let mut conn = st.db.acquire().await?;
    let keys = db::title_keys(&mut conn, key).await?;
    let active = db::active_adds_of(&mut conn, &keys).await?;
    let series = key.media_type.has_seasons();
    let whole = series && active.iter().any(|r| r.scope().is_none());
    let mut seasons: Vec<i64> = active
        .iter()
        .flat_map(|r| r.scope().unwrap_or_default().to_vec())
        .collect();
    seasons.sort_unstable();
    seasons.dedup();
    let locked = if series {
        existing_series_profiles(&mut conn, key, &keys).await?
    } else {
        None
    };
    let mut state = json!({
        "requested": if series { whole } else { !active.is_empty() },
        "wholeSeriesRequested": whole,
        "requestedSeasons": seasons,
        "profilesLocked": locked.is_some(),
        "lockedQualityProfileId": locked.and_then(|l| l.0),
        "lockedLanguageProfileId": locked.and_then(|l| l.1),
    });
    let ids: Vec<i32> = active.iter().map(|r| r.id).collect();
    let pairs = db::watch_pairs(&mut conn, &ids).await?;
    let mut people: Vec<i32> = active
        .iter()
        .filter_map(|r| r.user_id)
        .chain(pairs.iter().map(|p| p.1))
        .collect();
    people.sort_unstable();
    people.dedup();
    state["requesterCount"] = json!(people.len());
    state["watching"] = json!(pairs.iter().any(|p| p.1 == a.user.id));
    state["requestedByMe"] = json!(active.iter().any(|r| r.user_id == Some(a.user.id)));
    if super::is_work(key.media_type) {
        let wants: Vec<&WantSpec> = active
            .iter()
            .flat_map(|r| r.wants.iter().flat_map(|w| w.0.iter()))
            .collect();
        state["requested"] = json!(!wants.is_empty());
        state["requestedWants"] = json!(wants);
        if key.media_type == MediaKind::Album {
            let mut tracks: Vec<&String> = active
                .iter()
                .flat_map(|r| r.recordings.iter().flatten())
                .collect();
            tracks.sort_unstable();
            tracks.dedup();
            let whole = active.iter().any(|r| r.recordings.is_none());
            state["requested"] = json!(whole);
            state["wholeAlbumRequested"] = json!(whole);
            state["requestedRecordings"] = json!(tracks);
        }
    }
    let makes_requested = |r: &&db::Req| match key.media_type {
        MediaKind::Album => r.recordings.is_none(),
        k if super::is_work(k) => r.wants.as_ref().is_some_and(|w| !w.0.is_empty()),
        k if k.has_seasons() => r.scope().is_none(),
        _ => true,
    };
    state["requestId"] = match state["requested"].as_bool() {
        Some(true) => json!(active.iter().find(makes_requested).map(|r| r.id)),
        _ => Value::Null,
    };
    Ok(state)
}

/// Ids Postgres would reject as a foreign key violation answer 400 instead of 500.
async fn assert_exist(st: &AppState, q: Option<i32>, l: Option<i32>, lib: Option<i32>) -> Res<()> {
    if let Some(lib) = lib
        && !db::library_exists(&st.db, lib).await?
    {
        return Err(AppError::bad_request(format!("Library #{lib} not found")));
    }
    if let Some(q) = q {
        profiles::resolve_quality_profile_id_for_import(&st.db, Some(q), None).await?;
    }
    if let Some(l) = l {
        profiles::resolve_language_profile_id_for_import(&st.db, Some(l), None).await?;
    }
    Ok(())
}

/// `dto.id ? {id} : null`: a falsy id is no id.
fn some_id(id: Option<i32>) -> Option<i32> {
    id.filter(|i| *i != 0)
}

/// Rule 24: import the title, or reuse the library row when its profiles cover the request.
pub async fn ensure_media(
    st: &AppState,
    spec: ImportSpec,
    (added_by, approver): (Option<i32>, i32),
) -> Res<Option<i32>> {
    let (media_id, created) = match services::import_title(st, spec.clone(), (added_by, approver))
        .await
    {
        Ok(imported) => imported,
        Err(e) if e.status != 409 || super::is_work(spec.title.media_type) => {
            return Err(e.into());
        }
        Err(_) => {
            let Some(existing) = db::media_by_ref(&st.db, &spec.title).await? else {
                return Ok(None);
            };
            if let Some(l) = existing.library_id.filter(|l| *l != 0)
                && !services::libraries_of(st, approver).await?.contains(&l)
            {
                return Err(AppError::forbidden(
                    "You do not have access to the library holding this title",
                ));
            }
            let covers = profiles::envelope_covers(
                &st.db,
                (existing.quality_profile_id, existing.language_profile_id),
                (spec.quality_profile_id, spec.language_profile_id),
            )
            .await?;
            if !covers {
                return Err(AppError::conflict(
                    "This title is already in the library with a different profile and can't satisfy the request — decline it or update the library media's profiles.",
                ));
            }
            (existing.id, false)
        }
    };
    let seasons = spec
        .seasons
        .as_deref()
        .filter(|_| spec.title.media_type.has_seasons());
    db::monitor_scope(&st.db, media_id, seasons).await?;
    if spec.title.media_type == MediaKind::Album {
        let held = !created;
        let wanted = match spec.recordings.as_deref() {
            Some(recordings) => want_tracks(st, media_id, recordings, held).await,
            None => crate::metadata::music::want::monitor_all(&st.db, &[media_id])
                .await
                .map_err(Into::into),
        };
        if let Err(e) = wanted {
            if !held {
                crate::media::write::discard(st, media_id, MediaKind::Album).await;
            }
            return Err(e);
        }
    }
    Ok(Some(media_id))
}

/// Wants the requested tracks of an album; a recording no release of the album holds is an error, never dropped.
async fn want_tracks(st: &AppState, media: i32, recordings: &[String], held: bool) -> Res<()> {
    use crate::metadata::music::want::{self, Recording, Refused};
    let refs: Vec<Recording> = recordings.iter().map(|r| Recording::Mbid(r)).collect();
    want::want_many(st, media, &refs, held)
        .await
        .map(drop)
        .map_err(Refused::app_error)
}

/// The saved row as 4.x returns it: relation ids and public identities, `media` joined by title.
async fn row_json(st: &AppState, id: i32) -> Res<Map<String, Value>> {
    let f = db::Filter {
        id: Some(id),
        user_id: None,
        libraries: None,
        status: None,
        kind: None,
        title: None,
        media_type: None,
        kinds: None,
    };
    match db::rows(&st.db, &f, 1, 0).await?.into_iter().next() {
        Some(Value::Object(o)) => Ok(o),
        _ => Err(not_found(id)),
    }
}

/// `media` of a loaded Media entity: its library, profiles and metadata, without files or seasons.
pub async fn media_entity(st: &AppState, a: &Authed, media_id: i32) -> Res<Value> {
    let libs = crate::libraries::accessible_library_ids(&st.db, a).await?;
    if crate::libraries::assert_media_accessible(&st.db, media_id, &libs)
        .await
        .is_err()
    {
        return Ok(Value::Null);
    }
    let mut m = hydrate::detail(&st.db, media_id, paths_visible(&a.perms))
        .await?
        .unwrap_or(Value::Null);
    if let Some(o) = m.as_object_mut() {
        o.remove("files");
        o.remove("seasons");
    }
    Ok(m)
}

fn put(o: &mut Map<String, Value>, k: &str, v: Value) {
    o.insert(k.into(), v);
}

fn id_obj(id: Option<i32>) -> Value {
    id.map_or(Value::Null, |i| json!({ "id": i }))
}

/// A lock wait past `lock_timeout` answers busy (409 for the title lock, else 503), not a database fault.
pub(super) fn lock_err(e: sqlx::Error, title: bool) -> AppError {
    if e.as_database_error().and_then(|d| d.code()).as_deref() != Some("55P03") {
        return e.into();
    }
    if title {
        AppError::conflict("Another request for this title is being processed, try again shortly")
    } else {
        AppError::with_message(
            StatusCode::SERVICE_UNAVAILABLE,
            "Your other requests are still being processed, try again shortly",
        )
    }
}

/// What a create leaves to do once its row is committed.
struct Added {
    id: i32,
    user: i32,
    key: TitleKey,
    title: String,
    seasons: Option<Vec<i64>>,
}

/// A request handler is dropped when its client leaves; the post-commit work runs in a task so it completes.
async fn settled<T>(task: tokio::task::JoinHandle<Res<T>>) -> Res<T> {
    task.await
        .map_err(|e| AppError::internal(format!("request task failed: {e}")))?
}

/// The media an import that failed late had already linked to the request (`on_media_imported` adopts it).
async fn adopted(st: &AppState, id: i32) -> Option<i32> {
    match db::find(&st.db, id).await {
        Ok(Some(r)) if r.status != "declined" => r.media_id,
        _ => None,
    }
}

/// Rule 14: the import of an auto-approved create, then its events and notification.
async fn finish_create(st: AppState, n: Added, spec: Option<ImportSpec>) -> Res<Option<i32>> {
    let auto = spec.is_some();
    let mut media_id = None;
    if let Some(spec) = spec {
        media_id = match ensure_media(&st, spec, (Some(n.user), n.user)).await {
            Ok(m) => m,
            Err(e) => match adopted(&st, n.id).await {
                Some(m) => Some(m),
                None => {
                    if let Err(d) = db::delete_claimed(&st.db, n.id, n.user).await {
                        tracing::warn!("Request #{}: failed import left its row: {d}", n.id);
                    }
                    return Err(e);
                }
            },
        };
        if let Some(m) = media_id {
            db::link_if_unlinked(&st.db, n.id, m).await?;
        }
    }
    if db::find(&st.db, n.id).await?.is_none() {
        return Err(not_found(n.id));
    }
    let media_type = n.key.media_type;
    st.hub.emit_domain(DomainEvent::RequestCreated {
        request_id: i64::from(n.id),
        media_type,
        external_ids: n.key.refs(),
        user_id: Some(i64::from(n.user)),
        kind: "add".into(),
        seasons: n.seasons.clone(),
    });
    if auto {
        if let Some(m) = media_id.filter(|_| super::is_work(media_type)) {
            // the book import runs no request hook, which is what asks the acquisition for a video title
            st.hub.emit_domain(DomainEvent::MediaAcquisitionRequested {
                media_ids: vec![i64::from(m)],
                reason: "request-approved".into(),
            });
        }
        st.hub.emit_domain(DomainEvent::RequestApproved {
            request_id: i64::from(n.id),
            media_id: media_id.map(i64::from),
            media_type,
            external_ids: n.key.refs(),
            seasons: n.seasons,
            approved_by_user_id: Some(i64::from(n.user)),
        });
    }
    services::announce(&st, &[n.id]).await;
    let event = if auto {
        "request.approved"
    } else {
        "request.created"
    };
    let user = (!auto).then_some(ReqRef {
        id: n.id,
        requester: Some(n.user),
        media: None,
    });
    services::notify(
        &st,
        event,
        crate::notifications::payload!({"title": n.title, "mediaType": media_type}),
        user,
    );
    Ok(media_id)
}

pub async fn create(st: &AppState, a: &Authed, mut dto: CreateRequest) -> Res<Value> {
    if dto.delete {
        return create_delete(st, a, &dto).await;
    }
    if !can_manage(a) {
        dto.quality_profile_id = None;
        dto.language_profile_id = None;
    }
    let key = dto.key();
    if let Some(p) = st.metadata.get(key.provider)
        && key.media_type.is_video()
        && !p.supports(key.media_type)
    {
        return Err(AppError::bad_request(format!(
            "The {} provider does not serve {}",
            key.provider, key.media_type
        )));
    }
    let keys = db::title_keys(&mut *st.db.acquire().await?, &key).await?;
    // network first: no lock, no connection held while TMDB answers
    let candidates = rules::candidates(st, a, &dto).await?;
    let limited = a.user.quotas.limit(dto.media_type) != 0;
    // waiters queue here without a connection, so the lock holder can always get the ones it needs
    let turn = match limited {
        true => Some(QUOTA_TURNS.lock(a.user.id).await),
        false => None,
    };
    let mut tx = st.db.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '10s'")
        .execute(&mut *tx)
        .await?;
    if limited {
        db::lock_user_quota(&mut tx, a.user.id)
            .await
            .map_err(|e| lock_err(e, false))?;
    }
    // A merge adds no request: no quota, unless the pending one is gone once the title is locked.
    let skipped_quota = dto.media_type == MediaKind::Album
        && db::active_adds_of(&mut tx, &keys)
            .await?
            .iter()
            .any(|r| r.user_id == Some(a.user.id) && r.status == "pending");
    if !skipped_quota {
        check_quota(&mut tx, a, dto.media_type).await?;
    }
    db::lock_titles(&mut tx, &keys)
        .await
        .map_err(|e| lock_err(e, true))?;
    assert_no_active_duplicate(&mut tx, &dto, &keys).await?;
    if let Some(l) = dto.library_id {
        assert_can_use_library(st, a, l).await?;
        assert_exist(st, None, None, Some(l)).await?;
        if let Some(name) = db::library_refusing(&st.db, l, dto.media_type).await? {
            return Err(AppError::bad_request(format!(
                "Library \"{name}\" does not accept {}",
                dto.media_type
            )));
        }
    }
    let library_id = match dto.library_id {
        Some(l) => l,
        None => resolve_sole_library(st, a, dto.media_type).await?,
    };
    if let Some(f) = dto.folder_id {
        crate::libraries::assert_folder_in_library(&mut *tx, library_id, f).await?;
    }
    if dto.media_type.has_seasons()
        && let Some((q, l)) = existing_series_profiles(&mut tx, &key, &keys).await?
    {
        dto.quality_profile_id = q.or(dto.quality_profile_id);
        dto.language_profile_id = l.or(dto.language_profile_id);
    }
    if dto.media_type.is_video() && dto.quality_profile_id.is_none() {
        let library_default = crate::libraries::default_quality_profile(&st.db, library_id).await?;
        dto.quality_profile_id =
            profiles::resolve_quality_profile_id_for_import(&st.db, None, library_default).await?;
    }
    let (quality, language) = (
        some_id(dto.quality_profile_id),
        some_id(dto.language_profile_id),
    );
    assert_exist(st, quality, language, None).await?;
    if let Some(w) = &dto.wants {
        crate::media::wants::check_profiles(&st.db, w).await?;
        assert_wants_unsatisfied(st, &key, w).await?;
    }
    if let Some(r) = &dto.recordings {
        assert_tracks_unclaimed(st, &key, r).await?;
    }

    let own = match dto.media_type {
        MediaKind::Album => db::active_adds_of(&mut tx, &keys)
            .await?
            .into_iter()
            .find(|r| r.user_id == Some(a.user.id) && r.status == "pending"),
        _ => None,
    };
    if own.is_none() && skipped_quota {
        check_quota(&mut tx, a, dto.media_type).await?;
    }
    let auto = candidates.approves(a, &dto, library_id);
    let merged = own.is_some();
    let id = match own {
        // The caller's pending album request grows instead of a second row.
        Some(own) => {
            let wants_of = |w: &Option<Vec<WantSpec>>| serde_json::to_value(w).ok();
            if dto.library_id.is_some_and(|l| own.library_id != Some(l))
                || dto.wants.is_some()
                    && wants_of(&dto.wants) != wants_of(&own.wants.as_ref().map(|w| w.0.clone()))
            {
                return Err(AppError::conflict(
                    "A pending request for this album already exists with another library or wants",
                ));
            }
            match (&dto.recordings, &own.recordings) {
                (Some(r), Some(_)) => db::add_recordings(&mut *tx, own.id, r).await?,
                (None, Some(_)) => db::widen(&mut *tx, own.id).await?,
                _ => {}
            }
            own.id
        }
        None => db::insert(
            &mut *tx,
            db::New {
                user_id: a.user.id,
                kind: "add",
                title_key: &key,
                title: &dto.title,
                seasons: dto.seasons.as_deref(),
                status: if auto { "approved" } else { "pending" },
                approved_by: auto.then_some(a.user.id),
                quality_profile_id: quality,
                language_profile_id: language,
                library_id: Some(library_id),
                folder_id: dto.folder_id,
                media_id: None,
                poster_url: None,
                fanart_url: None,
                wants: dto.wants.as_deref(),
                recordings: dto.recordings.as_deref(),
            },
        )
        .await
        .map_err(|e| lock_err(e, false))?,
    };
    tx.commit().await?;
    drop(turn);
    if dto.recordings.is_some() && !merged {
        remember_track_count(st, id, &key, library_id).await;
    }

    let spec = (auto && !merged).then(|| ImportSpec {
        title: key.clone(),
        quality_profile_id: dto.quality_profile_id,
        language_profile_id: dto.language_profile_id,
        library_id: Some(library_id),
        folder_id: dto.folder_id,
        seasons: dto.seasons.clone(),
        wants: dto.wants.clone(),
        recordings: dto.recordings.clone(),
    });
    let added = Added {
        id,
        user: a.user.id,
        key: key.clone(),
        title: dto.title.clone(),
        seasons: dto.seasons.clone(),
    };
    let media_id = if merged {
        None
    } else {
        settled(tokio::spawn(finish_create(st.clone(), added, spec))).await?
    };

    let art = art_wait(st, id, key).await;
    let mut row = row_json(st, id).await?;
    put(&mut row, "qualityProfile", id_obj(quality));
    put(&mut row, "languageProfile", id_obj(language));
    put(&mut row, "library", id_obj(Some(library_id)));
    put(
        &mut row,
        "media",
        match media_id {
            Some(m) => media_entity(st, a, m).await?,
            None => Value::Null,
        },
    );
    let art = art.unwrap_or_default();
    put(&mut row, "posterUrl", json!(art.poster));
    put(&mut row, "fanartUrl", json!(art.fanart));
    Ok(Value::Object(row))
}

/// The size of the release the album would be, kept on the request so a list can say "2 of 12".
async fn remember_track_count(st: &AppState, id: i32, key: &TitleKey, library: i32) {
    use fliks_domain::metadata::limiter::Priority;
    let tracks =
        crate::metadata::music::tracklist(st, &key.external_id, library, Priority::Interactive)
            .await;
    match tracks {
        Ok(t) if !t.is_empty() => {
            if let Err(e) = db::set_track_count(&st.db, id, t.len() as i32).await {
                tracing::warn!("Request #{id}: track count not kept: {e}");
            }
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("Request #{id}: track count not read: {}", e.text()),
    }
}

/// Rule 16: at most 5 s on the art; the download goes on in the background after that.
async fn art_wait(st: &AppState, id: i32, key: TitleKey) -> Option<Art> {
    let st = st.clone();
    let task = tokio::spawn(async move {
        match services::request_art(&st, &key).await {
            Ok(art) if art.poster.is_none() && art.fanart.is_none() => None,
            Ok(art) => {
                match db::set_art(&st.db, id, art.poster.as_deref(), art.fanart.as_deref()).await {
                    Ok(()) => Some(art),
                    Err(e) => {
                        tracing::warn!("Request #{id}: art prefetch failed: {e}");
                        None
                    }
                }
            }
            Err(e) => {
                tracing::warn!("Request #{id}: art prefetch failed: {e}");
                None
            }
        }
    });
    tokio::time::timeout(ART_WAIT, task).await.ok()?.ok()?
}

/// Rule 19.
async fn create_delete(st: &AppState, a: &Authed, dto: &CreateRequest) -> Res<Value> {
    let key = dto.key();
    let libs = crate::libraries::accessible_library_ids(&st.db, a).await?;
    let media = db::media_by_ref(&st.db, &key)
        .await?
        .filter(|m| m.library_id.is_some_and(|l| libs.contains(&l)));
    let Some(media) = media else {
        return Err(AppError::bad_request(
            "This title is not in the library and cannot be deleted",
        ));
    };
    if db::pending_delete_exists(&st.db, &key).await? {
        return Err(AppError::conflict(
            "A deletion request for this title is already pending",
        ));
    }
    let id = db::insert(
        &st.db,
        db::New {
            user_id: a.user.id,
            kind: "delete",
            title_key: &key,
            title: &dto.title,
            seasons: None,
            status: "pending",
            approved_by: None,
            quality_profile_id: None,
            language_profile_id: None,
            library_id: media.library_id.filter(|l| *l != 0),
            folder_id: None,
            media_id: Some(media.id),
            poster_url: media.poster_url.as_deref(),
            fanart_url: media.fanart_url.as_deref(),
            wants: None,
            recordings: None,
        },
    )
    .await?;
    services::announce(st, &[id]).await;
    services::notify(
        st,
        "request.delete.created",
        crate::notifications::payload!({"title": dto.title, "mediaType": dto.media_type}),
        None,
    );
    let mut row = row_json(st, id).await?;
    row.remove("qualityProfileId");
    row.remove("languageProfileId");
    put(
        &mut row,
        "library",
        id_obj(media.library_id.filter(|l| *l != 0)),
    );
    put(&mut row, "media", json!({"id": media.id, "path": null}));
    Ok(Value::Object(row))
}

/// `GET /api/requests/:id` and the shape `PATCH` returns: the row with its FK media and comments.
pub async fn detail(st: &AppState, a: &Authed, row: &db::Req) -> Res<Map<String, Value>> {
    let mut json = row_json(st, row.id).await?;
    let last = match row.media_id {
        Some(m) => attempts::latest_of(&st.db, &[m], attempts::show_failed(a))
            .await?
            .remove(&m),
        None => None,
    };
    put(&mut json, "lastSearch", last.unwrap_or_default());
    let media = match row.media_id {
        Some(m) => media_entity(st, a, m).await?,
        None => Value::Null,
    };
    put(&mut json, "media", media);
    put(
        &mut json,
        "comments",
        json!(db::comments(&st.db, row.id).await?),
    );
    if can_manage(a) {
        put(
            &mut json,
            "watchers",
            json!(db::watchers(&st.db, row.id).await?),
        );
    }
    Ok(json)
}

/// Replaces a pending book request's wants, refusing editions another active request holds.
/// Replaces the wants inside a transaction the caller commits.
async fn set_wants(
    st: &AppState,
    row: &db::Req,
    wants: &[WantSpec],
) -> Res<sqlx::Transaction<'static, sqlx::Postgres>> {
    let key = row.key();
    crate::media::wants::check_profiles(&st.db, wants).await?;
    assert_wants_unsatisfied(st, &key, wants).await?;
    let mut tx = st.db.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '10s'")
        .execute(&mut *tx)
        .await?;
    db::lock_title(&mut tx, &key)
        .await
        .map_err(|e| lock_err(e, true))?;
    let others: Vec<db::Req> = db::active_adds(&mut *tx, &key)
        .await?
        .into_iter()
        .filter(|r| r.id != row.id)
        .collect();
    let overlap = overlapping_wants(&others, wants);
    if !overlap.is_empty() {
        return Err(already_requested(&overlap));
    }
    if !db::set_wants(&mut tx, row.id, wants).await? {
        return Err(AppError::forbidden("Only pending requests can be updated"));
    }
    Ok(tx)
}

pub async fn update(st: &AppState, a: &Authed, id: i32, dto: UpdateRequest) -> Res<Value> {
    let row = gate(st, a, id).await?;
    if row.status != "pending" {
        return Err(AppError::forbidden("Only pending requests can be updated"));
    }
    let falsy = |f: &Field<i32>| f.touched().map(some_id);
    let (quality, language, library) = (
        falsy(&dto.quality_profile_id),
        falsy(&dto.language_profile_id),
        dto.library_id.touched(),
    );
    if super::is_work(row.media_type) && (quality.is_some() || language.is_some()) {
        return Err(AppError::bad_request(
            "A book or album request takes its profiles per want",
        ));
    }
    if dto.wants.is_some() && !super::is_work(row.media_type) {
        return Err(AppError::bad_request(
            "Only a book or album request has wants",
        ));
    }
    if row.media_type == MediaKind::Album
        && dto
            .wants
            .iter()
            .flatten()
            .any(|w| w.family != fliks_domain::media::family::Family::Audio)
    {
        return Err(AppError::bad_request(
            "An album request wants the audio family",
        ));
    }
    if let Some(Some(l)) = library {
        assert_can_use_library(st, a, l).await?;
    }
    assert_exist(
        st,
        quality.flatten(),
        language.flatten(),
        library.flatten().filter(|l| *l != 0),
    )
    .await?;
    let mut tx = match &dto.wants {
        Some(w) => set_wants(st, &row, w).await?,
        None => st.db.begin().await?,
    };
    if !db::patch(&mut *tx, id, quality, language, library.map(some_id)).await? {
        return Err(AppError::forbidden("Only pending requests can be updated"));
    }
    tx.commit().await?;
    let row = db::find(&st.db, id).await?.ok_or_else(|| not_found(id))?;
    let mut json = detail(st, a, &row).await?;
    if quality.is_some() {
        put(&mut json, "qualityProfile", id_obj(row.quality_profile_id));
    }
    if language.is_some() {
        put(
            &mut json,
            "languageProfile",
            id_obj(row.language_profile_id),
        );
    }
    if library.is_some() {
        put(&mut json, "library", id_obj(row.library_id));
    }
    Ok(Value::Object(json))
}

pub async fn remove(st: &AppState, a: &Authed, id: i32) -> Res<()> {
    let row = gate(st, a, id).await?;
    if !can_manage(a) {
        if row.status != "pending" {
            return Err(AppError::forbidden(
                "Only pending requests can be cancelled",
            ));
        }
        owner_or_manager(a, row.user_id)?;
        return cancel_own(st, &row).await;
    }
    db::delete(&st.db, id, false).await?;
    Ok(())
}

/// Rule 53: the owner's cancel of a pending row hands it to the earliest watcher, else deletes it.
async fn cancel_own(st: &AppState, row: &db::Req) -> Res<()> {
    let mut tx = st.db.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '10s'")
        .execute(&mut *tx)
        .await?;
    db::lock_title(&mut tx, &row.key())
        .await
        .map_err(|e| lock_err(e, true))?;
    let pending = db::find(&mut *tx, row.id)
        .await?
        .is_some_and(|r| r.status == "pending" && r.user_id == row.user_id);
    let owner = row.user_id.unwrap_or_default();
    let handed = pending && db::promote_watcher(&mut tx, row.id, owner).await?;
    if !handed && !db::delete(&mut *tx, row.id, true).await? {
        return Err(AppError::forbidden(
            "Only pending requests can be cancelled",
        ));
    }
    tx.commit().await?;
    Ok(())
}

/// Rule 53: follow an in-flight request of someone else; a joiner whose auto-approval rule matches approves it.
pub async fn watch(st: &AppState, a: &Authed, id: i32) -> Res<Value> {
    let row = db::find(&st.db, id).await?.ok_or_else(|| not_found(id))?;
    assert_can_access_request_library(st, a, row.library_id, row.user_id).await?;
    if !a.kinds.has(row.media_type) {
        return Err(not_found(id));
    }
    if row.kind != "add" || !db::IN_FLIGHT.contains(&row.status.as_str()) {
        return Err(AppError::conflict("This request is no longer in flight"));
    }
    if row.user_id == Some(a.user.id) {
        return Err(AppError::conflict("You made this request"));
    }
    let dto = CreateRequest {
        media_type: row.media_type,
        delete: false,
        key: row.key(),
        title: row.title.clone(),
        seasons: row.seasons.as_ref().map(|s| s.0.clone()),
        wants: row.wants.as_ref().map(|w| w.0.clone()),
        recordings: row.recordings.clone(),
        quality_profile_id: row.quality_profile_id,
        language_profile_id: row.language_profile_id,
        library_id: row.library_id,
        folder_id: row.folder_id,
    };
    let candidates = rules::candidates(st, a, &dto).await?;
    let mut tx = st.db.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '10s'")
        .execute(&mut *tx)
        .await?;
    db::lock_title(&mut tx, &row.key())
        .await
        .map_err(|e| lock_err(e, true))?;
    let row = match db::find(&mut *tx, id).await? {
        Some(r) if db::IN_FLIGHT.contains(&r.status.as_str()) && r.user_id != Some(a.user.id) => r,
        _ => return Err(AppError::conflict("This request is no longer in flight")),
    };
    db::watch_add(&mut *tx, id, a.user.id).await?;
    tx.commit().await?;
    if row.status == "pending" && candidates.approves(a, &dto, row.library_id.unwrap_or_default()) {
        match settled(tokio::spawn(approve_add(
            st.clone(),
            a.user.id,
            id,
            row,
            false,
        )))
        .await
        {
            Err(e) if e.status() == StatusCode::CONFLICT => {}
            other => drop(other?),
        }
    }
    Ok(json!({"requestId": id, "watching": true}))
}

/// Rule 53: stop following; idempotent.
pub async fn unwatch(st: &AppState, a: &Authed, id: i32) -> Res<()> {
    db::find(&st.db, id).await?.ok_or_else(|| not_found(id))?;
    Ok(db::watch_remove(&st.db, id, a.user.id).await?)
}

/// Rule 23 steps 1-4, shared with `decline`.
async fn pending_row(st: &AppState, a: &Authed, id: i32) -> Res<db::Req> {
    if !can_manage(a) {
        return Err(forbidden());
    }
    let row = db::find(&st.db, id).await?.ok_or_else(|| not_found(id))?;
    assert_can_access_request_library(st, a, row.library_id, row.user_id).await?;
    if row.status != "pending" {
        return Err(AppError::conflict("Request is not pending"));
    }
    Ok(row)
}

/// `whole` widens a track request of an album to the whole album (rule 52).
pub async fn approve(st: &AppState, a: &Authed, id: i32, whole: bool) -> Res<Value> {
    let row = pending_row(st, a, id).await?;
    if row.kind == "delete" {
        return approve_delete(st, a, &row).await;
    }
    if whole && row.media_type != MediaKind::Album {
        return Err(AppError::bad_request(
            "wholeAlbum applies to an album request",
        ));
    }
    settled(tokio::spawn(approve_add(
        st.clone(),
        a.user.id,
        id,
        row,
        whole,
    )))
    .await
}

/// Rule 23 steps 5-11: the title lock covers the claim only, not the import. In a task so a client that leaves cannot strand the claimed row.
async fn approve_add(st: AppState, by: i32, id: i32, mut row: db::Req, whole: bool) -> Res<Value> {
    let st = &st;
    let key = row.key();
    let mut lock = st.db.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '10s'")
        .execute(&mut *lock)
        .await?;
    db::lock_title(&mut lock, &key)
        .await
        .map_err(|e| lock_err(e, true))?;
    let existing = db::media_by_ref(&st.db, &key).await?;
    if existing.is_none() {
        services::assert_import_target(st, row.media_type, row.library_id).await?;
    }
    if !db::claim_approval(&st.db, id, by, None).await? {
        return Err(AppError::conflict("Request is not pending"));
    }
    let widen = whole && row.recordings.take().is_some();
    lock.commit().await?;
    services::announce(st, &[id]).await;
    let spec = ImportSpec {
        title: key.clone(),
        quality_profile_id: row.quality_profile_id,
        language_profile_id: row.language_profile_id,
        library_id: row.library_id,
        folder_id: row.folder_id,
        seasons: row.seasons.as_ref().map(|s| s.0.clone()),
        wants: row.wants.as_ref().map(|w| w.0.clone()),
        recordings: row.recordings.clone(),
    };
    let media = match ensure_media(st, spec, (row.user_id, by)).await {
        Ok(m) => m,
        Err(e) => match adopted(st, id).await {
            Some(m) => Some(m),
            None => {
                if let Err(d) = db::rollback_to_pending(&st.db, id, by).await {
                    tracing::warn!("Request #{id}: failed approval left its row: {d}");
                }
                services::announce(st, &[id]).await;
                return Err(e);
            }
        },
    };
    if db::find(&st.db, id).await?.is_none() {
        return Err(not_found(id));
    }
    if widen {
        db::widen(&st.db, id).await?;
    }
    if let Some(m) = media {
        db::link_if_unlinked(&st.db, id, m).await?;
        st.hub.emit_domain(DomainEvent::MediaAcquisitionRequested {
            media_ids: vec![i64::from(m)],
            reason: "request-approved".into(),
        });
    }
    st.hub.emit_domain(DomainEvent::RequestApproved {
        request_id: i64::from(id),
        media_id: media.map(i64::from),
        media_type: row.media_type,
        external_ids: key.refs(),
        seasons: row.seasons.map(|s| s.0),
        approved_by_user_id: Some(i64::from(by)),
    });
    let user = ReqRef {
        id,
        requester: row.user_id,
        media: media.map(|m| (m, row.media_type)),
    };
    services::notify(
        st,
        "request.approved",
        crate::notifications::payload!({"title": row.title}),
        Some(user),
    );
    Ok(Value::Object(row_json(st, id).await?))
}

/// Rule 26: the request is done once the title is removed.
async fn approve_delete(st: &AppState, a: &Authed, row: &db::Req) -> Res<Value> {
    let id = row.id;
    let media = row.media_id;
    let mut tx = st.db.begin().await?;
    if let Some(m) = media
        && !db::lock_media_holding(&mut tx, m, &row.key()).await?
    {
        return Err(AppError::conflict(
            "The title of this request changed, decline it and ask again",
        ));
    }
    if !db::claim_approval(&mut *tx, id, a.user.id, media).await? {
        return Err(AppError::conflict("Request is not pending"));
    }
    tx.commit().await?;
    services::announce(st, &[id]).await;
    if let Some(m) = media {
        match services::remove_media(st, m).await {
            Ok(removed) => {
                if !removed.disk_paths.is_empty() {
                    tokio::spawn(async move {
                        let _lock = removed.lock;
                        for path in removed.disk_paths {
                            let shown = path.dir.display().to_string();
                            if let Err(e) = crate::media::write::remove_media_folder(path).await {
                                tracing::error!(
                                    "Media file deletion failed after delete request #{id}: title=\"{}\" path=\"{}\" error={e}",
                                    removed.title,
                                    shown
                                );
                            }
                        }
                    });
                }
            }
            Err(e) => {
                db::rollback_to_pending(&st.db, id, a.user.id).await?;
                services::announce(st, &[id]).await;
                return Err(e.into());
            }
        }
    }
    services::notify(
        st,
        "request.delete.approved",
        crate::notifications::payload!({"title": row.title, "mediaType": row.media_type}),
        None,
    );
    Ok(Value::Object(row_json(st, id).await?))
}

pub async fn decline(st: &AppState, a: &Authed, id: i32, reason: Option<String>) -> Res<Value> {
    let row = pending_row(st, a, id).await?;
    if !db::decline(&st.db, id, a.user.id, reason.as_deref()).await? {
        return Err(AppError::conflict("Request is not pending"));
    }
    services::announce(st, &[id]).await;
    let event = if row.kind == "delete" {
        "request.delete.declined"
    } else {
        "request.declined"
    };
    services::notify(
        st,
        event,
        crate::notifications::payload!({"title": row.title, "reason": reason.unwrap_or_default()}),
        Some(ReqRef {
            id,
            requester: row.user_id,
            media: row.media_id.map(|m| (m, row.media_type)),
        }),
    );
    let mut json = row_json(st, id).await?;
    json.remove("media");
    Ok(Value::Object(json))
}

pub async fn comment_add(st: &AppState, a: &Authed, id: i32, message: &str) -> Res<Value> {
    let row = gate(st, a, id).await?;
    let mut comment = db::comment_insert(&st.db, row.id, a.user.id, message).await?;
    let full = row_json(st, row.id).await?;
    let mut request = Map::new();
    for k in [
        "id",
        "createdAt",
        "updatedAt",
        "user",
        "mediaType",
        "kind",
        "tmdbId",
        "provider",
        "externalId",
        "title",
        "status",
        "declinedReason",
        "seasons",
        "posterUrl",
        "fanartUrl",
    ] {
        if let Some(v) = full.get(k) {
            put(&mut request, k, v.clone());
        }
    }
    put(&mut request, "approvedBy", Value::Null);
    if let Some(o) = comment.as_object_mut() {
        o.insert("request".into(), Value::Object(request));
        o.insert("user".into(), db::identity(&st.db, a.user.id).await?);
    }
    Ok(comment)
}

pub async fn comments(st: &AppState, a: &Authed, id: i32) -> Res<Vec<Value>> {
    let row = gate(st, a, id).await?;
    Ok(db::comments(&st.db, row.id).await?)
}

pub async fn comment_remove(st: &AppState, a: &Authed, comment_id: i32) -> Res<()> {
    let c = db::comment_find(&st.db, comment_id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Comment #{comment_id} not found")))?;
    if !can_manage(a) && c.user_id != Some(a.user.id) {
        return Err(forbidden());
    }
    if let Some(r) = c.request_id
        && let Some(row) = db::find(&st.db, r).await?
    {
        assert_can_access_request_library(st, a, row.library_id, row.user_id).await?;
    }
    Ok(db::comment_delete(&st.db, c.id).await?)
}

fn linked_media(row: &Value) -> Option<i32> {
    i32::try_from(row["mediaId"].as_i64()?).ok()
}

/// `GET /api/requests` scoping (rule 9).
pub async fn list(st: &AppState, a: &Authed, q: dto::List) -> Res<Value> {
    let (user_id, libraries) = if !can_manage(a) {
        (Some(a.user.id), None)
    } else {
        let libraries = if is_super(a) {
            None
        } else {
            let ids = accessible_library_ids(&st.db, a).await?;
            Some(if ids.is_empty() { vec![0] } else { ids })
        };
        (q.user_id.filter(|u| *u != 0), libraries)
    };
    let kinds = a.kinds.names();
    let f = db::Filter {
        id: None,
        user_id,
        libraries: libraries.as_deref(),
        status: q.status.as_deref(),
        kind: q.kind.as_deref(),
        title: q.title.as_ref().map(|(p, e)| (p.as_str(), e.as_str())),
        media_type: q.media_type,
        kinds: Some(&kinds),
    };
    let offset = (q.page - 1).saturating_mul(q.limit);
    let mut data = db::rows(&st.db, &f, q.limit, offset).await?;
    let ids: Vec<i32> = data.iter().filter_map(linked_media).collect();
    let mut found = attempts::latest_of(&st.db, &ids, attempts::show_failed(a)).await?;
    for r in &mut data {
        r["lastSearch"] = linked_media(r)
            .and_then(|m| found.remove(&m))
            .unwrap_or_default();
    }
    let total = db::count(&st.db, &f).await?;
    Ok(json!({"data": data, "total": total}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slot_frees_when_the_count_drops_under_the_limit() {
        let t0 = Utc::now();
        let w: Vec<_> = (0..4).map(|i| t0 + chrono::Duration::hours(i)).collect();
        let day = chrono::Duration::days(1);
        assert_eq!(next_free_at(&w, 4, 1), Some(w[0] + day));
        assert_eq!(
            next_free_at(&w, 2, 1),
            Some(w[2] + day),
            "limit lowered under the count"
        );
        assert_eq!(next_free_at(&w, 5, 1), None);
        assert_eq!(next_free_at(&w, -1, 1), None);
    }
}
