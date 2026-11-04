//! Reader bookmarks and highlights (`docs/spec/annotations.md`).
use crate::{
    http::{
        AppError,
        auth::Authed,
        json::iso_ms,
        validate::{PathParams, ValidJson},
    },
    libraries::accessible_library_ids,
    state::AppState,
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, patch},
};
use chrono::{DateTime, Utc};
use fliks_domain::acl::{Action, Subject};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const LOCATOR_MAX: usize = 8 * 1024;
const NOTE_MAX: usize = 4000;
const EXCERPT_MAX: usize = 2000;
const PER_ITEM_MAX: i64 = 2000;
const COLOURS: [&str; 4] = ["yellow", "green", "blue", "pink"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/items/{itemId}/annotations", get(list).post(create))
        .route("/api/annotations/{id}", patch(update).delete(remove))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    id: i32,
    item_id: i32,
    kind: String,
    colour: Option<String>,
    note: String,
    locator: Value,
    excerpt: String,
    #[serde(with = "iso_ms")]
    created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewAnnotation {
    kind: String,
    colour: Option<String>,
    note: Option<String>,
    locator: Value,
    excerpt: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Patch {
    colour: Option<String>,
    note: Option<String>,
}

fn item_missing(item: i32) -> AppError {
    AppError::not_found(format!("Item #{item} not found"))
}

fn annotation_missing(id: i32) -> AppError {
    AppError::not_found(format!("Annotation #{id} not found"))
}

/// Rule 5: a text item whose media and edition sit in readable libraries, else a 404 that reads like a missing one.
async fn readable(st: &AppState, a: &Authed, item: i32) -> Result<(), AppError> {
    let libs = accessible_library_ids(&st.db, a).await?;
    let found = sqlx::query_scalar!(
        r#"SELECT i.id FROM items i
           JOIN media m ON m.id = i."mediaId" AND m."libraryId" = ANY($2)
           JOIN editions e ON e.id = i."editionId" AND e.family = 'text'
             AND COALESCE(e."libraryId", m."libraryId") = ANY($2)
           WHERE i.id = $1"#,
        item,
        &libs
    )
    .fetch_optional(&st.db)
    .await?;
    found.map(|_| ()).ok_or_else(|| item_missing(item))
}

fn bad(message: &str) -> AppError {
    AppError::bad_request(vec![message.to_owned()])
}

fn check_colour(colour: &str) -> Result<(), AppError> {
    if COLOURS.contains(&colour) {
        Ok(())
    } else {
        Err(bad(
            "colour must be one of the following values: yellow, green, blue, pink",
        ))
    }
}

fn check_note(note: &str) -> Result<(), AppError> {
    if note.chars().count() > NOTE_MAX {
        return Err(bad(&format!(
            "note must be shorter than or equal to {NOTE_MAX} characters"
        )));
    }
    Ok(())
}

#[utoipa::path(get, path = "/api/items/{itemId}/annotations", responses((status = 200), (status = 404)))]
pub async fn list(
    State(st): State<AppState>,
    a: Authed,
    PathParams(item): PathParams<i32>,
) -> Result<Json<Vec<Annotation>>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    readable(&st, &a, item).await?;
    let rows = sqlx::query_as!(
        Annotation,
        r#"SELECT id, "itemId" AS item_id, kind, colour, note, locator, excerpt,
                  "createdAt" AS created_at, "updatedAt" AS updated_at
           FROM annotations WHERE "userId" = $1 AND "itemId" = $2
           ORDER BY "createdAt", id"#,
        a.user.id,
        item
    )
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows))
}

#[utoipa::path(post, path = "/api/items/{itemId}/annotations", responses((status = 201), (status = 400), (status = 404), (status = 409)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    PathParams(item): PathParams<i32>,
    ValidJson(body): ValidJson<NewAnnotation>,
) -> Result<(StatusCode, Json<Annotation>), AppError> {
    a.require(Action::Read, Subject::Media)?;
    readable(&st, &a, item).await?;
    match (body.kind.as_str(), body.colour.as_deref()) {
        ("highlight", Some(c)) => check_colour(c)?,
        ("highlight", None) => return Err(bad("colour should not be empty")),
        ("bookmark", None) => {}
        ("bookmark", Some(_)) => return Err(bad("colour must be absent on a bookmark")),
        _ => {
            return Err(bad(
                "kind must be one of the following values: bookmark, highlight",
            ));
        }
    }
    if !body.locator.is_object() || body.locator.to_string().len() > LOCATOR_MAX {
        return Err(bad("locator must be an object of at most 8192 bytes"));
    }
    let note = body.note.unwrap_or_default();
    check_note(&note)?;
    if body.kind == "bookmark" && !note.is_empty() {
        return Err(bad("note must be absent on a bookmark"));
    }
    let excerpt = body.excerpt.unwrap_or_default();
    if excerpt.chars().count() > EXCERPT_MAX {
        return Err(bad(&format!(
            "excerpt must be shorter than or equal to {EXCERPT_MAX} characters"
        )));
    }
    // The per-(user, item) lock serialises the count and the insert across concurrent posts.
    let mut tx = st.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(a.user.id)
        .bind(item)
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query_as!(
        Annotation,
        r#"INSERT INTO annotations ("userId", "itemId", kind, colour, note, locator, excerpt)
           SELECT $1, $2, $3, $4, $5, $6, $7
           WHERE (SELECT count(*) FROM annotations WHERE "userId" = $1 AND "itemId" = $2) < $8
           RETURNING id, "itemId" AS item_id, kind, colour, note, locator, excerpt,
                     "createdAt" AS created_at, "updatedAt" AS updated_at"#,
        a.user.id,
        item,
        body.kind,
        body.colour,
        note,
        body.locator,
        excerpt,
        PER_ITEM_MAX
    )
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    let row = row.ok_or_else(|| AppError::conflict("Too many annotations"))?;
    Ok((StatusCode::CREATED, Json(row)))
}

/// The caller's own row; its item must still be readable (rule 9).
async fn owned(st: &AppState, a: &Authed, id: i32) -> Result<String, AppError> {
    let row = sqlx::query!(
        r#"SELECT "itemId" AS item_id, kind FROM annotations WHERE id = $1 AND "userId" = $2"#,
        id,
        a.user.id
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| annotation_missing(id))?;
    readable(st, a, row.item_id)
        .await
        .map_err(|_| annotation_missing(id))?;
    Ok(row.kind)
}

#[utoipa::path(patch, path = "/api/annotations/{id}", responses((status = 200), (status = 400), (status = 404)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
    ValidJson(body): ValidJson<Patch>,
) -> Result<Json<Annotation>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let kind = owned(&st, &a, id).await?;
    if body.colour.is_none() && body.note.is_none() {
        return Err(bad("colour or note should not be empty"));
    }
    if kind == "bookmark" {
        return Err(bad("a bookmark has no colour or note"));
    }
    if let Some(c) = &body.colour {
        check_colour(c)?;
    }
    if let Some(n) = &body.note {
        check_note(n)?;
    }
    let row = sqlx::query_as!(
        Annotation,
        r#"UPDATE annotations SET colour = COALESCE($3, colour), note = COALESCE($4, note)
           WHERE id = $1 AND "userId" = $2
           RETURNING id, "itemId" AS item_id, kind, colour, note, locator, excerpt,
                     "createdAt" AS created_at, "updatedAt" AS updated_at"#,
        id,
        a.user.id,
        body.colour,
        body.note
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| annotation_missing(id))?;
    Ok(Json(row))
}

#[utoipa::path(delete, path = "/api/annotations/{id}", responses((status = 204), (status = 404)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    a.require(Action::Read, Subject::Media)?;
    owned(&st, &a, id).await?;
    sqlx::query!(
        r#"DELETE FROM annotations WHERE id = $1 AND "userId" = $2"#,
        id,
        a.user.id
    )
    .execute(&st.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
