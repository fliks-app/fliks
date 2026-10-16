//! The request flows (`requests.md` rules 1-27): gates, create, approve, decline, comments.
use super::{
    Art, ImportSpec, PortError, db,
    dto::{self, CreateRequest, Field, UpdateRequest},
    rules, services,
};
use crate::{
    events::DomainEvent,
    http::{AppError, auth::Authed},
    libraries::{accessible_library_ids, paths_visible},
    media::hydrate,
    profiles,
    state::AppState,
};
use axum::http::StatusCode;
use chrono::{Days, Local};
use fliks_domain::acl::{Action, Subject};
use serde_json::{Map, Value, json};
use std::time::Duration;

pub type Res<T> = Result<T, AppError>;

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

async fn resolve_sole_library(st: &AppState, a: &Authed, media_type: &str) -> Res<i32> {
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

/// Rule 13: the ADD requests of the window still pending or approved count against the limit.
async fn check_quota(st: &AppState, a: &Authed, media_type: &str) -> Res<()> {
    let limit = if media_type == "movie" {
        a.user.movie_quota_limit
    } else {
        a.user.series_quota_limit
    };
    if limit == 0 {
        return Ok(());
    }
    let period = match a.user.quota_period_days {
        0 => 7,
        n => n,
    };
    let now = Local::now();
    let days = Days::new(u64::from(period.unsigned_abs()));
    let since = if period >= 0 {
        now.checked_sub_days(days)
    } else {
        now.checked_add_days(days)
    }
    .unwrap_or_else(|| now - chrono::Duration::days(i64::from(period)))
    .to_utc();
    let count = db::quota_count(&st.db, a.user.id, media_type, since).await?;
    if count >= i64::from(limit) {
        return Err(AppError::forbidden(format!(
            "Quota exceeded: {count}/{limit} {media_type} requests in last {period} days"
        )));
    }
    Ok(())
}

/// Rule 12a.
async fn assert_no_active_duplicate(st: &AppState, dto: &CreateRequest) -> Res<()> {
    let existing = db::active_adds(&st.db, dto.tmdb_id, &dto.media_type).await?;
    if existing.is_empty() {
        return Ok(());
    }
    let wanted = dto.seasons.as_deref().unwrap_or_default();
    if dto.media_type != "series" || wanted.is_empty() {
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

type Profiles = (Option<i32>, Option<i32>);

/// Rule 12b: the profiles of the earliest active request, else of the library row.
async fn existing_series_profiles(st: &AppState, tmdb_id: i32) -> Res<Option<Profiles>> {
    if let Some(r) = db::active_adds(&st.db, tmdb_id, "series").await?.first() {
        return Ok(Some((r.quality_profile_id, r.language_profile_id)));
    }
    Ok(db::media_by_tmdb(&st.db, tmdb_id, "series")
        .await?
        .map(|m| (m.quality_profile_id, m.language_profile_id)))
}

pub async fn title_state(st: &AppState, tmdb_id: i32, media_type: &str) -> Res<Value> {
    let active = db::active_adds(&st.db, tmdb_id, media_type).await?;
    let series = media_type == "series";
    let whole = series && active.iter().any(|r| r.scope().is_none());
    let mut seasons: Vec<i64> = active
        .iter()
        .flat_map(|r| r.scope().unwrap_or_default().to_vec())
        .collect();
    seasons.sort_unstable();
    seasons.dedup();
    let locked = if series {
        existing_series_profiles(st, tmdb_id).await?
    } else {
        None
    };
    Ok(json!({
        "requested": if series { whole } else { !active.is_empty() },
        "wholeSeriesRequested": whole,
        "requestedSeasons": seasons,
        "profilesLocked": locked.is_some(),
        "lockedQualityProfileId": locked.and_then(|l| l.0),
        "lockedLanguageProfileId": locked.and_then(|l| l.1),
    }))
}

/// C114: ids Postgres would reject as a foreign key violation answer 400 instead of 500.
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
    added_by: Option<i32>,
) -> Res<Option<i32>> {
    let media_id = match services::import_from_tmdb(st, spec.clone(), added_by).await {
        Ok(id) => id,
        Err(e) if e.status != 409 => return Err(e.into()),
        Err(_) => {
            let Some(existing) = db::media_by_tmdb(&st.db, spec.tmdb_id, &spec.media_type).await?
            else {
                return Ok(None);
            };
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
            existing.id
        }
    };
    let seasons = spec
        .seasons
        .as_deref()
        .filter(|_| spec.media_type == "series");
    db::monitor_scope(&st.db, media_id, seasons).await?;
    Ok(Some(media_id))
}

fn notify(st: &AppState, event: &'static str, payload: Value) {
    if let Value::Object(m) = payload {
        services::notify(st, event, m);
    }
}

/// The saved row as Nest returns it: relation ids and public identities, `media` joined by title.
async fn row_json(st: &AppState, id: i32) -> Res<Map<String, Value>> {
    let f = db::Filter {
        id: Some(id),
        user_id: None,
        libraries: None,
        status: None,
        kind: None,
        tmdb_id: None,
        media_type: None,
    };
    match db::rows(&st.db, &f, 1, 0).await?.into_iter().next() {
        Some(Value::Object(o)) => Ok(o),
        _ => Err(not_found(id)),
    }
}

/// `media` of a loaded Media entity: its library, profiles and metadata, without files or seasons.
pub async fn media_entity(st: &AppState, a: &Authed, media_id: i32) -> Res<Value> {
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

pub async fn create(st: &AppState, a: &Authed, mut dto: CreateRequest) -> Res<Value> {
    if dto.delete {
        return create_delete(st, a, &dto).await;
    }
    check_quota(st, a, &dto.media_type).await?;
    assert_no_active_duplicate(st, &dto).await?;
    if let Some(l) = dto.library_id {
        assert_can_use_library(st, a, l).await?;
        assert_exist(st, None, None, Some(l)).await?;
    }
    let library_id = match dto.library_id {
        Some(l) => l,
        None => resolve_sole_library(st, a, &dto.media_type).await?,
    };
    if dto.media_type == "series"
        && let Some((q, l)) = existing_series_profiles(st, dto.tmdb_id).await?
    {
        (dto.quality_profile_id, dto.language_profile_id) = (q, l);
    }
    let (quality, language) = (
        some_id(dto.quality_profile_id),
        some_id(dto.language_profile_id),
    );
    assert_exist(st, quality, language, None).await?;

    let auto = rules::should_auto_approve(st, a, &dto, library_id).await?;
    let media_id = if auto {
        let spec = ImportSpec {
            media_type: dto.media_type.clone(),
            tmdb_id: dto.tmdb_id,
            quality_profile_id: dto.quality_profile_id,
            language_profile_id: dto.language_profile_id,
            library_id: Some(library_id),
            seasons: dto.seasons.clone(),
        };
        ensure_media(st, spec, Some(a.user.id)).await?
    } else {
        None
    };
    let id = db::insert(
        &st.db,
        db::New {
            user_id: a.user.id,
            kind: "add",
            media_type: &dto.media_type,
            tmdb_id: dto.tmdb_id,
            title: &dto.title,
            seasons: dto.seasons.as_deref(),
            status: if auto { "approved" } else { "pending" },
            approved_by: auto.then_some(a.user.id),
            quality_profile_id: quality,
            language_profile_id: language,
            library_id: Some(library_id),
            media_id,
            poster_url: None,
            fanart_url: None,
        },
    )
    .await?;

    st.hub.emit_domain(DomainEvent::RequestCreated {
        request_id: i64::from(id),
        media_type: dto.media_type.clone(),
        tmdb_id: i64::from(dto.tmdb_id),
        user_id: Some(i64::from(a.user.id)),
        kind: "add".into(),
        seasons: dto.seasons.clone(),
    });
    if auto {
        st.hub.emit_domain(DomainEvent::RequestApproved {
            request_id: i64::from(id),
            media_id: media_id.map(i64::from),
            media_type: dto.media_type.clone(),
            tmdb_id: i64::from(dto.tmdb_id),
            seasons: dto.seasons.clone(),
            approved_by_user_id: Some(i64::from(a.user.id)),
        });
    }
    let event = if auto {
        "request.approved"
    } else {
        "request.created"
    };
    notify(
        st,
        event,
        json!({"title": dto.title, "mediaType": dto.media_type}),
    );

    let art = art_wait(st, id, &dto.media_type, dto.tmdb_id).await;
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

/// Rule 16: at most 5 s on the art; the download goes on in the background after that.
async fn art_wait(st: &AppState, id: i32, media_type: &str, tmdb_id: i32) -> Option<Art> {
    let (st, media_type) = (st.clone(), media_type.to_owned());
    let task = tokio::spawn(async move {
        match services::request_art(&st, &media_type, tmdb_id).await {
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
    let Some(media) = db::media_by_tmdb(&st.db, dto.tmdb_id, &dto.media_type).await? else {
        return Err(AppError::bad_request(
            "This title is not in the library and cannot be deleted",
        ));
    };
    if db::pending_delete_exists(&st.db, dto.tmdb_id, &dto.media_type).await? {
        return Err(AppError::conflict(
            "A deletion request for this title is already pending",
        ));
    }
    let id = db::insert(
        &st.db,
        db::New {
            user_id: a.user.id,
            kind: "delete",
            media_type: &dto.media_type,
            tmdb_id: dto.tmdb_id,
            title: &dto.title,
            seasons: None,
            status: "pending",
            approved_by: None,
            quality_profile_id: None,
            language_profile_id: None,
            library_id: media.library_id.filter(|l| *l != 0),
            media_id: Some(media.id),
            poster_url: media.poster_url.as_deref(),
            fanart_url: media.fanart_url.as_deref(),
        },
    )
    .await?;
    notify(
        st,
        "request.delete.created",
        json!({"title": dto.title, "mediaType": dto.media_type}),
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
    Ok(json)
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
    if !db::patch(&st.db, id, quality, language, library.map(some_id)).await? {
        return Err(AppError::forbidden("Only pending requests can be updated"));
    }
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
    }
    if !db::delete(&st.db, id, !can_manage(a)).await? && !can_manage(a) {
        return Err(AppError::forbidden(
            "Only pending requests can be cancelled",
        ));
    }
    Ok(())
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

pub async fn approve(st: &AppState, a: &Authed, id: i32) -> Res<Value> {
    let row = pending_row(st, a, id).await?;
    if row.kind == "delete" {
        return approve_delete(st, a, &row).await;
    }
    let existing = db::media_by_tmdb(&st.db, row.tmdb_id, &row.media_type).await?;
    if existing.is_none() {
        services::assert_import_target(st, &row.media_type, row.library_id).await?;
    }
    if !db::claim_approval(&st.db, id, a.user.id, None).await? {
        return Err(AppError::conflict("Request is not pending"));
    }
    let spec = ImportSpec {
        media_type: row.media_type.clone(),
        tmdb_id: row.tmdb_id,
        quality_profile_id: row.quality_profile_id,
        language_profile_id: row.language_profile_id,
        library_id: row.library_id,
        seasons: row.seasons.as_ref().map(|s| s.0.clone()),
    };
    let media = match ensure_media(st, spec, row.user_id).await {
        Ok(m) => m,
        Err(e) => {
            db::rollback_to_pending(&st.db, id, a.user.id).await?;
            return Err(e);
        }
    };
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
        media_type: row.media_type.clone(),
        tmdb_id: i64::from(row.tmdb_id),
        seasons: row.seasons.map(|s| s.0),
        approved_by_user_id: Some(i64::from(a.user.id)),
    });
    notify(st, "request.approved", json!({"title": row.title}));
    Ok(Value::Object(row_json(st, id).await?))
}

/// Rule 26: the request is done once the title is removed.
async fn approve_delete(st: &AppState, a: &Authed, row: &db::Req) -> Res<Value> {
    let media = db::media_by_tmdb(&st.db, row.tmdb_id, &row.media_type).await?;
    let id = row.id;
    if !db::claim_approval(&st.db, id, a.user.id, media.as_ref().map(|m| m.id)).await? {
        return Err(AppError::conflict("Request is not pending"));
    }
    if let Some(m) = media {
        match services::remove_media(st, m.id).await {
            Ok(removed) => {
                if let Some(path) = removed.disk_path {
                    tokio::spawn(async move {
                        let _lock = removed.lock;
                        if let Err(e) = services::delete_media_folder(&path).await {
                            tracing::error!(
                                "Media file deletion failed after delete request #{id} — title=\"{}\" path=\"{path}\" error={e}",
                                removed.title
                            );
                        }
                    });
                }
            }
            Err(e) => {
                db::rollback_to_pending(&st.db, id, a.user.id).await?;
                return Err(e.into());
            }
        }
    }
    notify(
        st,
        "request.delete.approved",
        json!({"title": row.title, "mediaType": row.media_type}),
    );
    Ok(Value::Object(row_json(st, id).await?))
}

pub async fn decline(st: &AppState, a: &Authed, id: i32, reason: Option<String>) -> Res<Value> {
    let row = pending_row(st, a, id).await?;
    if !db::decline(&st.db, id, a.user.id, reason.as_deref()).await? {
        return Err(AppError::conflict("Request is not pending"));
    }
    let event = if row.kind == "delete" {
        "request.delete.declined"
    } else {
        "request.declined"
    };
    notify(
        st,
        event,
        json!({"title": row.title, "reason": reason.unwrap_or_default()}),
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
    let f = db::Filter {
        id: None,
        user_id,
        libraries: libraries.as_deref(),
        status: q.status.as_deref(),
        kind: q.kind.as_deref(),
        tmdb_id: q.tmdb_id.filter(|t| *t != 0),
        media_type: q.media_type.as_deref(),
    };
    let offset = (q.page - 1).saturating_mul(q.limit);
    let data = db::rows(&st.db, &f, q.limit, offset).await?;
    let total = db::count(&st.db, &f).await?;
    Ok(json!({"data": data, "total": total}))
}
