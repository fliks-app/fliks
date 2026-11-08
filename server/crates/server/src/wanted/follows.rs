//! Follow and watch routes (`docs/spec/wants-follows.md` rules 5-8).
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    libraries::accessible_library_ids,
    media::{
        wants,
        write::{body::Body, resolve_target_in},
    },
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use chrono::NaiveDate;
use fliks_domain::{
    acl::{Action, Subject},
    media::{
        kind::MediaKind,
        wants::{WantSpec, default_wants, parse_wants},
    },
};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{FromRow, types::Json as Jsonb};

type Res = Result<Json<Value>, AppError>;

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Follow {
    role: String,
    #[sqlx(rename = "newReleases")]
    new_releases: bool,
    #[sqlx(rename = "libraryId")]
    library_id: i32,
    wants: Jsonb<Value>,
    since: NaiveDate,
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Watch {
    #[sqlx(rename = "libraryId")]
    library_id: i32,
    wants: Jsonb<Value>,
    since: NaiveDate,
}

/// The body of a follow or a watch: where discovered titles go and what they are wished with.
struct Put {
    library: i32,
    wants: Option<Vec<WantSpec>>,
    new_releases: Option<bool>,
}

async fn read_put(
    st: &AppState,
    a: &Authed,
    v: Value,
    watch: bool,
    kind: MediaKind,
) -> Result<Put, AppError> {
    a.require(Action::Create, Subject::Media)?;
    let keys: &[&str] = if watch {
        &["libraryId", "wants"]
    } else {
        &["libraryId", "wants", "newReleases", "role"]
    };
    let b = Body::new(v, keys)?;
    let library = b.required(b.id("libraryId")?, "libraryId", "must be an integer number")?;
    let wants =
        b.0.get("wants")
            .map(|w| parse_wants(w, kind))
            .transpose()
            .map_err(|m| AppError::bad_request(vec![m]))?;
    if let Some(w) = &wants {
        wants::check_profiles(&st.db, w).await?;
    }
    let new_releases = b.bool("newReleases")?.flatten();
    let acl = accessible_library_ids(&st.db, a).await?;
    resolve_target_in(st, &acl, kind, Some(library), None).await?;
    Ok(Put {
        library,
        wants,
        new_releases,
    })
}

fn wants_json(w: Option<&[WantSpec]>, kind: MediaKind) -> Jsonb<Value> {
    Jsonb(
        serde_json::to_value(w.map_or_else(|| default_wants(kind), <[_]>::to_vec))
            .expect("wants serialise"),
    )
}

async fn person_name(st: &AppState, id: i32) -> Result<String, AppError> {
    sqlx::query_scalar("SELECT name FROM persons WHERE id = $1")
        .bind(id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Person #{id} not found")))
}

/// The role a person is followed in: `author` with an author credit or an `openlibrary` id, `artist` with an
/// artist credit or a `musicbrainz` id; none for anyone else.
async fn follow_role(
    st: &AppState,
    id: i32,
    requested: Option<&str>,
) -> Result<Option<&'static str>, AppError> {
    let (author, artist): (bool, bool) = sqlx::query_as(
        r#"SELECT EXISTS (SELECT 1 FROM media_credits WHERE "personId" = $1 AND role = 'author')
                OR EXISTS (SELECT 1 FROM person_external_ids WHERE "personId" = $1 AND provider = 'openlibrary'),
                EXISTS (SELECT 1 FROM media_credits WHERE "personId" = $1 AND role = 'artist')
                OR EXISTS (SELECT 1 FROM person_external_ids WHERE "personId" = $1 AND provider = 'musicbrainz')"#,
    )
    .bind(id)
    .fetch_one(&st.db)
    .await?;
    match requested {
        Some("author") => Ok(author.then_some("author")),
        Some("artist") => Ok(artist.then_some("artist")),
        Some(_) => Err(AppError::bad_request(vec!["role must be author or artist"])),
        None => Ok(match (author, artist) {
            (_, true) if !author => Some("artist"),
            (true, _) => Some("author"),
            _ => None,
        }),
    }
}

/// `role`, the query of a read and a delete or the body of a put: a string naming a role, else absent.
#[derive(serde::Deserialize)]
pub struct RoleQuery {
    role: Option<String>,
}

fn kind_of(role: &str) -> MediaKind {
    if role == "artist" {
        MediaKind::Album
    } else {
        MediaKind::Book
    }
}

async fn follow_body(st: &AppState, user: i32, person: i32, requested: Option<&str>) -> Res {
    let role = follow_role(st, person, requested).await?;
    let follow: Option<Follow> = sqlx::query_as(
        r#"SELECT role, "newReleases", "libraryId", wants, since FROM person_follows
           WHERE "userId" = $1 AND "personId" = $2 AND ($3::text IS NULL OR role = $3)"#,
    )
    .bind(user)
    .bind(person)
    .bind(requested)
    .fetch_optional(&st.db)
    .await?;
    Ok(Json(
        json!({"follow": follow, "canFollow": role.is_some(), "role": role}),
    ))
}

#[utoipa::path(get, path = "/api/persons/{id}/follow", responses((status = 200)))]
pub async fn follow_get(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    Query(q): Query<RoleQuery>,
) -> Res {
    a.require(Action::Read, Subject::Media)?;
    let id = id?.0;
    person_name(&st, id).await?;
    follow_body(&st, a.user.id, id, q.role.as_deref()).await
}

#[utoipa::path(put, path = "/api/persons/{id}/follow", responses((status = 200)))]
pub async fn follow_put(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Res {
    let id = id?.0;
    // Held before the checks: the orphan sweep cannot drop the person between them and the insert.
    let mut tx = st.db.begin().await?;
    crate::media::write::orphans::hold(&mut tx).await?;
    person_name(&st, id).await?;
    let requested = match v.get("role") {
        None | Some(Value::Null) => None,
        Some(Value::String(r)) => Some(r.clone()),
        Some(_) => return Err(AppError::bad_request(vec!["role must be a string"])),
    };
    let Some(role) = follow_role(&st, id, requested.as_deref()).await? else {
        return Err(AppError::bad_request(vec![
            "this person cannot be followed in that role",
        ]));
    };
    let kind = kind_of(role);
    let p = read_put(&st, &a, v, false, kind).await?;
    let wants = p.wants.as_deref().map(|w| wants_json(Some(w), kind));
    sqlx::query(
        r#"INSERT INTO person_follows ("userId", "personId", role, "newReleases", "libraryId", wants)
           VALUES ($1, $2, $7, COALESCE($3, true), $4, COALESCE($5::jsonb, $6::jsonb))
           ON CONFLICT ("userId", "personId", role) DO UPDATE SET
             "libraryId" = EXCLUDED."libraryId",
             "newReleases" = COALESCE($3, person_follows."newReleases"),
             wants = COALESCE($5::jsonb, person_follows.wants)"#,
    )
    .bind(a.user.id)
    .bind(id)
    .bind(p.new_releases)
    .bind(p.library)
    .bind(wants)
    .bind(wants_json(None, kind))
    .bind(role)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    follow_body(&st, a.user.id, id, Some(role)).await
}

#[utoipa::path(delete, path = "/api/persons/{id}/follow", responses((status = 204)))]
pub async fn follow_delete(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    Query(q): Query<RoleQuery>,
) -> Result<StatusCode, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let id = id?.0;
    sqlx::query(
        r#"DELETE FROM person_follows
           WHERE "userId" = $1 AND "personId" = $2 AND ($3::text IS NULL OR role = $3)"#,
    )
    .bind(a.user.id)
    .bind(id)
    .bind(q.role)
    .execute(&st.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The series name when the collection holds a readable book.
async fn series_name(st: &AppState, a: &Authed, id: i32) -> Result<String, AppError> {
    let acl = accessible_library_ids(&st.db, a).await?;
    sqlx::query_scalar(
        r#"SELECT c.name FROM collections c WHERE c.id = $1 AND EXISTS (
             SELECT 1 FROM collection_entries e JOIN media m ON m.id = e."mediaId"
             WHERE e."collectionId" = c.id AND m.type = 'book' AND m."libraryId" = ANY($2))"#,
    )
    .bind(id)
    .bind(&acl)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("Collection #{id} not found")))
}

async fn watch_body(st: &AppState, user: i32, series: i32) -> Res {
    let watch: Option<Watch> = sqlx::query_as(
        r#"SELECT "libraryId", wants, since FROM series_watches WHERE "userId" = $1 AND "collectionId" = $2"#,
    )
    .bind(user)
    .bind(series)
    .fetch_optional(&st.db)
    .await?;
    Ok(Json(json!({ "watch": watch })))
}

#[utoipa::path(get, path = "/api/collections/{id}/watch", responses((status = 200)))]
pub async fn watch_get(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Res {
    a.require(Action::Read, Subject::Media)?;
    let id = id?.0;
    series_name(&st, &a, id).await?;
    watch_body(&st, a.user.id, id).await
}

#[utoipa::path(put, path = "/api/collections/{id}/watch", responses((status = 200)))]
pub async fn watch_put(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Res {
    let id = id?.0;
    let mut tx = st.db.begin().await?;
    crate::media::write::orphans::hold(&mut tx).await?;
    series_name(&st, &a, id).await?;
    let p = read_put(&st, &a, v, true, MediaKind::Book).await?;
    let wants = p
        .wants
        .as_deref()
        .map(|w| wants_json(Some(w), MediaKind::Book));
    sqlx::query(
        r#"INSERT INTO series_watches ("userId", "collectionId", "libraryId", wants)
           VALUES ($1, $2, $3, COALESCE($4::jsonb, $5::jsonb))
           ON CONFLICT ("userId", "collectionId") DO UPDATE SET
             "libraryId" = EXCLUDED."libraryId", wants = COALESCE($4::jsonb, series_watches.wants)"#,
    )
    .bind(a.user.id)
    .bind(id)
    .bind(p.library)
    .bind(wants)
    .bind(wants_json(None, MediaKind::Book))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    watch_body(&st, a.user.id, id).await
}

#[utoipa::path(delete, path = "/api/collections/{id}/watch", responses((status = 204)))]
pub async fn watch_delete(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<StatusCode, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let id = id?.0;
    sqlx::query(r#"DELETE FROM series_watches WHERE "userId" = $1 AND "collectionId" = $2"#)
        .bind(a.user.id)
        .bind(id)
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct PersonRow {
    #[sqlx(rename = "personId")]
    person_id: i32,
    name: String,
    role: String,
    #[sqlx(rename = "newReleases")]
    new_releases: bool,
    #[sqlx(rename = "libraryId")]
    library_id: i32,
    wants: Jsonb<Value>,
    since: NaiveDate,
    #[serde(with = "crate::http::json::iso_ms::opt")]
    #[sqlx(rename = "refreshedAt")]
    refreshed_at: Option<chrono::DateTime<chrono::Utc>>,
    #[sqlx(rename = "failedAdds")]
    failed_adds: i32,
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct SeriesRow {
    #[sqlx(rename = "collectionId")]
    collection_id: i32,
    name: String,
    #[sqlx(rename = "libraryId")]
    library_id: i32,
    wants: Jsonb<Value>,
    since: NaiveDate,
    #[serde(with = "crate::http::json::iso_ms::opt")]
    #[sqlx(rename = "refreshedAt")]
    refreshed_at: Option<chrono::DateTime<chrono::Utc>>,
    #[sqlx(rename = "failedAdds")]
    failed_adds: i32,
}

#[utoipa::path(get, path = "/api/follows", responses((status = 200)))]
pub async fn follows(State(st): State<AppState>, a: Authed) -> Res {
    a.require(Action::Read, Subject::Media)?;
    let persons: Vec<PersonRow> = sqlx::query_as(
        r#"SELECT f."personId", p.name, f.role, f."newReleases", f."libraryId", f.wants, f.since, f."refreshedAt", f."failedAdds"
           FROM person_follows f JOIN persons p ON p.id = f."personId"
           WHERE f."userId" = $1 ORDER BY p.name, p.id"#,
    )
    .bind(a.user.id)
    .fetch_all(&st.db)
    .await?;
    let series: Vec<SeriesRow> = sqlx::query_as(
        r#"SELECT w."collectionId", c.name, w."libraryId", w.wants, w.since, w."refreshedAt", w."failedAdds"
           FROM series_watches w JOIN collections c ON c.id = w."collectionId"
           WHERE w."userId" = $1 ORDER BY c.name, c.id"#,
    )
    .bind(a.user.id)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(json!({"persons": persons, "series": series})))
}
