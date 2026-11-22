//! The problem-report flows (`problems.md` rules 1-24): gates, create, transitions, comments, counts.
use super::db::{self, ACTIVE, Filter, New, Row, Scope};
use crate::{
    http::{AppError, auth::Authed},
    libraries::{accessible_library_ids, assert_file_accessible, assert_media_visible},
    notifications,
    push::{ProblemRef, problem_event},
    requests::{
        flow::{can_manage, is_super},
        lock_user_quota,
    },
    state::AppState,
};
use axum::http::StatusCode;
use chrono::{Duration, Utc};
use fliks_domain::media::kind::MediaKind;
use serde::Deserialize;
use serde_json::{Value, json};

pub type Res<T> = Result<T, AppError>;

pub const KINDS: [&str; 5] = ["video", "audio", "subtitles", "playback", "other"];
const STATUSES: [&str; 5] = ["active", "open", "acknowledged", "resolved", "closed"];
const MAX_ACTIVE: i64 = 20;
const MAX_TEXT: usize = 2000;
const REPORTER_REOPEN: Duration = Duration::days(14);

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Create {
    pub kind: String,
    pub item_id: Option<i32>,
    pub season_number: Option<i32>,
    pub media_file_id: Option<i32>,
    pub note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resolve {
    pub reply: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Close {
    pub reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reopen {
    pub note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommentBody {
    pub message: String,
}

/// A text field of at most `MAX_TEXT` characters; blank is `None` unless `required`, which is a 400.
fn text(field: &str, v: Option<String>, required: bool) -> Res<Option<String>> {
    match v.filter(|s| !s.trim().is_empty()) {
        Some(s) if s.chars().count() > MAX_TEXT => Err(AppError::bad_request(format!(
            "{field} must be shorter than or equal to {MAX_TEXT} characters"
        ))),
        Some(s) => Ok(Some(s)),
        None if required => Err(AppError::bad_request(format!(
            "{field} should not be empty"
        ))),
        None => Ok(None),
    }
}

fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("Problem #{id} not found"))
}

fn forbidden() -> AppError {
    AppError::bare(StatusCode::FORBIDDEN)
}

/// Libraries a manager reaches: `None` for every library.
async fn manager_libraries(st: &AppState, a: &Authed) -> Res<Option<Vec<i32>>> {
    if is_super(a) {
        return Ok(None);
    }
    let ids = accessible_library_ids(&st.db, a).await?;
    Ok(Some(if ids.is_empty() { vec![0] } else { ids }))
}

/// 404, then the owner, or a manager of the report's library.
async fn gate(st: &AppState, a: &Authed, id: i32) -> Res<Row> {
    let row = db::find(&st.db, id).await?.ok_or_else(|| not_found(id))?;
    if row.user_id == Some(a.user.id) {
        return Ok(row);
    }
    if !can_manage(a) {
        return Err(forbidden());
    }
    if let Some(libs) = manager_libraries(st, a).await?
        && !row.library_id.is_some_and(|l| libs.contains(&l))
    {
        return Err(forbidden());
    }
    Ok(row)
}

async fn manager_gate(st: &AppState, a: &Authed, id: i32) -> Res<Row> {
    if !can_manage(a) {
        return Err(forbidden());
    }
    gate(st, a, id).await
}

#[derive(Clone, Copy)]
pub enum Event {
    Created,
    Resolved,
    Closed,
    Replied,
}

/// The admin notification (`problem.created`, `problem.resolved`) and the push of one transition.
pub fn announce(st: &AppState, row: &Row, event: Event) {
    // A system report has no reporter and `health.corrupt` already told the admins.
    let Some(reporter) = row.user_id else {
        return;
    };
    let (admin, key) = match event {
        Event::Created => (Some("problem.created"), "problem_created"),
        Event::Resolved => (Some("problem.resolved"), "problem_resolved"),
        Event::Closed => (None, "problem_closed"),
        Event::Replied => (None, "problem_replied"),
    };
    if let Some(admin) = admin {
        notifications::dispatch(
            &st.db,
            admin,
            notifications::payload!({
                "title": row.title, "mediaType": row.media_type, "kind": row.kind,
                "seasonNumber": row.season_number, "episodeNumber": row.episode_number,
            }),
        );
    }
    if let Some(media_kind) = MediaKind::parse(&row.media_type) {
        problem_event(
            st,
            key,
            &row.title,
            ProblemRef {
                media: row.media_id,
                media_kind,
                library: row.library_id,
                reporter,
            },
        );
    }
}

async fn one(st: &AppState, id: i32) -> Res<Value> {
    let f = Filter {
        id: Some(id),
        kinds: MediaKind::NAMES.iter().map(|k| (*k).to_owned()).collect(),
        ..Filter::default()
    };
    db::rows(&st.db, &f, 1, 0)
        .await?
        .pop()
        .ok_or_else(|| not_found(id))
}

/// `POST /api/media/{id}/problems`.
pub async fn create(st: &AppState, a: &Authed, media: i32, body: Create) -> Res<Value> {
    if !KINDS.contains(&body.kind.as_str()) {
        return Err(AppError::bad_request(format!(
            "kind must be one of the following values: {}",
            KINDS.join(", ")
        )));
    }
    if body.item_id.is_some() && body.season_number.is_some() {
        return Err(AppError::bad_request(
            "itemId and seasonNumber cannot be sent together",
        ));
    }
    let note = text("note", body.note, false)?;
    let acl = accessible_library_ids(&st.db, a).await?;
    assert_media_visible(&st.db, media, &acl, &a.kinds).await?;
    if let Some(f) = body.media_file_id {
        assert_file_accessible(&st.db, f, &acl).await?;
    }
    let mut scope = Scope {
        item_id: body.item_id,
        season_number: body.season_number,
        episode_number: None,
    };
    if let Some(item) = body.item_id {
        let (season, episode) = db::item_scope(&st.db, media, item)
            .await?
            .ok_or_else(|| AppError::bad_request("itemId does not belong to the media"))?;
        scope.season_number = season;
        scope.episode_number = episode;
    }
    let file = match body.media_file_id {
        Some(f) => {
            let size = db::file_size(&st.db, media, body.item_id, f)
                .await?
                .ok_or_else(|| {
                    AppError::bad_request("mediaFileId is not a file of the media or item")
                })?;
            Some((f, size))
        }
        None => db::sole_file(&st.db, media, scope).await?,
    };
    let mut tx = st.db.begin().await?;
    lock_user_quota(&mut tx, a.user.id).await?;
    if db::duplicate(&mut tx, a.user.id, media, scope, &body.kind, None).await? {
        return Err(AppError::conflict("problem_already_open"));
    }
    if db::active_count(&mut tx, a.user.id).await? >= MAX_ACTIVE {
        return Err(AppError::conflict("problem_cap"));
    }
    let id = db::insert(
        &mut tx,
        &New {
            user: a.user.id,
            media,
            scope,
            file,
            kind: &body.kind,
        },
    )
    .await?;
    if let Some(n) = &note {
        db::comment_insert(&mut tx, id, a.user.id, n).await?;
    }
    tx.commit().await?;
    if let Some(row) = db::find(&st.db, id).await? {
        announce(st, &row, Event::Created);
    }
    one(st, id).await
}

pub struct List {
    pub status: Option<String>,
    pub media: Option<i32>,
    pub page: i64,
    pub limit: i64,
}

pub fn list_query(q: &[(String, String)]) -> Res<List> {
    use crate::http::validate::int_query;
    let get = |k: &str| q.iter().find(|(n, _)| n == k).map(|(_, v)| v);
    let status = get("status").filter(|s| !s.is_empty()).cloned();
    if let Some(s) = &status
        && !STATUSES.contains(&s.as_str())
    {
        return Err(AppError::bad_request(format!(
            "status must be one of the following values: {}",
            STATUSES.join(", ")
        )));
    }
    let bounded = |k: &str, min: i64, max: i64, default: i64| -> Res<i64> {
        let n = int_query(get(k))?.unwrap_or(default);
        if (min..=max).contains(&n) {
            Ok(n)
        } else {
            Err(AppError::bad_request(format!(
                "{k} must be between {min} and {max}"
            )))
        }
    };
    Ok(List {
        status,
        media: int_query(get("mediaId"))?
            .map(i32::try_from)
            .transpose()
            .map_err(|_| AppError::bad_request("mediaId is invalid"))?,
        page: bounded("page", 1, 100_000, 1)?,
        limit: bounded("limit", 1, 100, 20)?,
    })
}

/// `GET /api/problems`: a reporter reads their own, a manager those of the libraries they reach.
pub async fn list(st: &AppState, a: &Authed, q: List) -> Res<Value> {
    let manager = can_manage(a);
    let libraries = if manager {
        manager_libraries(st, a).await?
    } else {
        None
    };
    let statuses = q.status.map(|s| match s.as_str() {
        "active" => ACTIVE.iter().map(|s| (*s).to_owned()).collect(),
        _ => vec![s],
    });
    let f = Filter {
        id: None,
        user: (!manager).then_some(a.user.id),
        libraries: libraries.as_deref(),
        statuses,
        media: q.media,
        kinds: a.kinds.names(),
    };
    let data = db::rows(&st.db, &f, q.limit, (q.page - 1) * q.limit).await?;
    let total = db::count(&st.db, &f).await?;
    Ok(json!({"data": data, "total": total}))
}

/// `GET /api/problems/{id}`: the row, its comments and, for a manager, the reporter's playback.
pub async fn detail(st: &AppState, a: &Authed, id: i32) -> Res<Value> {
    let row = gate(st, a, id).await?;
    let mut v = one(st, id).await?;
    v["comments"] = Value::Array(db::comments(&st.db, id).await?);
    if can_manage(a) {
        let at = db::created_at(&st.db, id).await?;
        v["playback"] = json!(db::playback(&st.db, &row, at).await?);
    }
    Ok(v)
}

fn not_active() -> AppError {
    AppError::conflict("problem_not_active")
}

/// `POST /api/problems/{id}/resolve`: a manager marks it fixed; the reply becomes a comment.
pub async fn resolve(st: &AppState, a: &Authed, id: i32, body: Resolve) -> Res<Value> {
    let row = manager_gate(st, a, id).await?;
    let reply = text("reply", body.reply, false)?;
    finish(st, a, &row, "resolved", reply, Event::Resolved).await
}

/// `POST /api/problems/{id}/close`: a manager closes it with a reason, which becomes a comment.
pub async fn close(st: &AppState, a: &Authed, id: i32, body: Close) -> Res<Value> {
    let row = manager_gate(st, a, id).await?;
    let reason = text("reason", Some(body.reason), true)?;
    finish(st, a, &row, "closed", reason, Event::Closed).await
}

async fn finish(
    st: &AppState,
    a: &Authed,
    row: &Row,
    to: &str,
    note: Option<String>,
    event: Event,
) -> Res<Value> {
    let mut tx = st.db.begin().await?;
    if !db::transition(&mut tx, row.id, &ACTIVE, to, Some(a.user.id)).await? {
        return Err(not_active());
    }
    if let Some(n) = &note {
        db::comment_insert(&mut tx, row.id, a.user.id, n).await?;
    }
    tx.commit().await?;
    announce(st, row, event);
    one(st, row.id).await
}

/// `POST /api/problems/{id}/reopen`: a manager from fixed or closed; the reporter from fixed, within 14 days.
pub async fn reopen(st: &AppState, a: &Authed, id: i32, body: Reopen) -> Res<Value> {
    let row = gate(st, a, id).await?;
    let manager = can_manage(a);
    let note = text("note", body.note, !manager)?;
    let from: &[&str] = if manager {
        &["resolved", "closed"]
    } else {
        &["resolved"]
    };
    if !from.contains(&row.status.as_str()) {
        return Err(AppError::conflict("problem_reopen_denied"));
    }
    if !manager
        && row
            .resolved_at
            .is_none_or(|t| Utc::now() - t > REPORTER_REOPEN)
    {
        return Err(AppError::conflict("problem_reopen_window"));
    }
    let pin = match row.media_file_id {
        Some(f) => db::file_size(&st.db, row.media_id, None, f)
            .await?
            .map(|s| (f, s)),
        None => None,
    };
    let scope = Scope {
        item_id: row.item_id,
        season_number: row.season_number,
        episode_number: row.episode_number,
    };
    let pin = match pin {
        Some(p) => Some(p),
        None => db::sole_file(&st.db, row.media_id, scope).await?,
    };
    let mut tx = st.db.begin().await?;
    if let Some(user) = row.user_id {
        lock_user_quota(&mut tx, user).await?;
        if db::duplicate(&mut tx, user, row.media_id, scope, &row.kind, Some(id)).await? {
            return Err(AppError::conflict("problem_already_open"));
        }
        if db::active_count(&mut tx, user).await? >= MAX_ACTIVE {
            return Err(AppError::conflict("problem_cap"));
        }
    }
    if !db::transition(&mut tx, id, from, "open", None).await? {
        return Err(AppError::conflict("problem_reopen_denied"));
    }
    db::repin(&mut tx, id, pin).await?;
    if let Some(n) = &note {
        db::comment_insert(&mut tx, id, a.user.id, n).await?;
    }
    tx.commit().await?;
    announce(st, &row, Event::Created);
    one(st, id).await
}

/// `DELETE /api/problems/{id}`: the reporter withdraws an active report, a manager deletes any.
pub async fn remove(st: &AppState, a: &Authed, id: i32) -> Res<()> {
    let row = gate(st, a, id).await?;
    if !can_manage(a) && !ACTIVE.contains(&row.status.as_str()) {
        return Err(forbidden());
    }
    Ok(db::delete(&st.db, id).await?)
}

pub async fn comments(st: &AppState, a: &Authed, id: i32) -> Res<Vec<Value>> {
    gate(st, a, id).await?;
    Ok(db::comments(&st.db, id).await?)
}

/// A comment of a manager on an open report acknowledges it and tells the reporter.
pub async fn comment_add(st: &AppState, a: &Authed, id: i32, body: CommentBody) -> Res<Value> {
    let row = gate(st, a, id).await?;
    let message = text("message", Some(body.message), true)?.unwrap_or_default();
    let mut tx = st.db.begin().await?;
    let comment = db::comment_insert(&mut tx, id, a.user.id, &message).await?;
    let reply = row.user_id != Some(a.user.id);
    if reply && can_manage(a) {
        db::transition(&mut tx, id, &["open"], "acknowledged", None).await?;
    }
    tx.commit().await?;
    if reply {
        announce(st, &row, Event::Replied);
    }
    Ok(comment)
}

pub async fn comment_remove(st: &AppState, a: &Authed, comment: i32) -> Res<()> {
    let (author, issue) = db::comment_find(&st.db, comment)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Comment #{comment} not found")))?;
    gate(st, a, issue).await?;
    if !can_manage(a) && author != Some(a.user.id) {
        return Err(forbidden());
    }
    Ok(db::comment_delete(&st.db, comment).await?)
}

/// `openProblems` of `/api/counts`: a manager's open reports in the libraries they reach, else 0.
pub async fn open_count(st: &AppState, a: &Authed) -> Res<i64> {
    if !can_manage(a) {
        return Ok(0);
    }
    let libraries = manager_libraries(st, a).await?;
    Ok(db::open_count(&st.db, libraries.as_deref(), &a.kinds.names()).await?)
}
