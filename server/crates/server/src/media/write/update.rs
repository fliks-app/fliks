//! Create, update, bulk, library, profiles, season and episode patches (rules 18, 26-35).
use super::{body::Body, detail_or_404, entity_or_404, gate};
use crate::{
    events::DomainEvent,
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    ingest::load_media,
    libraries::{accessible_library_ids, assert_media_accessible},
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use fliks_domain::acl::{Action, Subject};
use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder};

const TYPES: [&str; 2] = ["movie", "series"];
const STATUSES: [&str; 6] = [
    "tba",
    "announced",
    "released",
    "ended",
    "continuing",
    "deleted",
];
const MEDIA_FIELDS: [&str; 19] = [
    "title",
    "originalTitle",
    "year",
    "type",
    "tmdbId",
    "imdbId",
    "overview",
    "status",
    "monitored",
    "path",
    "posterUrl",
    "fanartUrl",
    "rating",
    "genres",
    "runtime",
    "releaseDate",
    "qualityProfileId",
    "languageProfileId",
    "preferredProvider",
];

/// One `media` column value read from the body.
enum Col {
    Text(Option<String>),
    Int(Option<i32>),
    Float(Option<f64>),
    Bool(Option<bool>),
    Json(Option<Value>),
    Enum(&'static str, Option<String>),
    Date(Option<String>),
}

/// Columns of `CreateMediaDto` / `UpdateMediaDto` that persist (`path` and the profile ids do not).
fn columns(b: &Body) -> Result<Vec<(&'static str, Col)>, AppError> {
    let mut out = vec![];
    macro_rules! put {
        ($key:literal, $col:literal, $v:expr, $wrap:expr) => {
            if let Some(v) = $v {
                out.push(($col, $wrap(v)));
            }
        };
    }
    put!("title", "title", b.str("title")?, Col::Text);
    put!(
        "originalTitle",
        "originalTitle",
        b.str("originalTitle")?,
        Col::Text
    );
    put!("year", "year", b.int("year")?, Col::Int);
    put!("type", "type", b.one_of("type", &TYPES)?, |v| Col::Enum(
        "media_type_enum",
        v
    ));
    put!("tmdbId", "tmdbId", b.int("tmdbId")?, Col::Int);
    put!("imdbId", "imdbId", b.str("imdbId")?, Col::Text);
    put!("overview", "overview", b.str("overview")?, Col::Text);
    put!("status", "status", b.one_of("status", &STATUSES)?, |v| {
        Col::Enum("media_status_enum", v)
    });
    put!("monitored", "monitored", b.bool("monitored")?, Col::Bool);
    put!("posterUrl", "posterUrl", b.str("posterUrl")?, Col::Text);
    put!("fanartUrl", "fanartUrl", b.str("fanartUrl")?, Col::Text);
    put!("rating", "rating", b.num("rating")?, Col::Float);
    put!("genres", "genres", b.strings("genres")?, |v: Option<
        Vec<String>,
    >| Col::Json(
        v.map(|g| json!(g))
    ));
    put!("runtime", "runtime", b.int("runtime")?, Col::Int);
    put!(
        "releaseDate",
        "releaseDate",
        b.date("releaseDate")?,
        Col::Date
    );
    b.str("path")?;
    b.num("qualityProfileId")?;
    b.num("languageProfileId")?;
    if b.has("preferredProvider") {
        let v = match b.0.get("preferredProvider") {
            Some(Value::Null) => None,
            Some(Value::String(s)) if s == "tmdb" || s == "tvdb" => Some(s.clone()),
            _ => {
                return Err(AppError::bad_request(vec![
                    "preferredProvider must be one of the following values: tmdb, tvdb, "
                        .to_owned(),
                ]));
            }
        };
        out.push(("preferredProvider", Col::Text(v)));
    }
    // C1: a NOT NULL column set to null is a 400, never a database 500.
    for (k, c) in &out {
        let null = matches!(c, Col::Text(None) | Col::Bool(None) | Col::Enum(_, None));
        if null && ["title", "type", "status", "monitored"].contains(k) {
            return Err(AppError::bad_request(vec![format!(
                "{k} should not be empty"
            )]));
        }
    }
    Ok(out)
}

fn push_value(q: &mut QueryBuilder<'_, Postgres>, c: &Col) {
    match c {
        Col::Text(v) => q.push_bind(v.clone()),
        Col::Int(v) => q.push_bind(*v),
        Col::Float(v) => q.push_bind(*v),
        Col::Bool(v) => q.push_bind(*v),
        Col::Json(v) => q.push_bind(v.clone()),
        Col::Enum(t, v) => q.push_bind(v.clone()).push(format!("::{t}")),
        Col::Date(v) => q.push_bind(v.clone()).push("::timestamptz::date"),
    };
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error().and_then(|d| d.code()).as_deref() == Some("23505")
}

fn clash() -> AppError {
    AppError::conflict("This title is already in the library")
}

/// `POST /api/media` (rule 18): columns only, no library, no folder, no hook.
#[utoipa::path(post, path = "/api/media", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Create, Subject::Media)?;
    let b = Body::new(v, &MEDIA_FIELDS)?;
    let cols = columns(&b)?;
    b.required(b.str("title")?, "title", "must be a string")?;
    let media_type = b.required(
        b.one_of("type", &TYPES)?,
        "type",
        "must be one of the following values: movie, series",
    )?;
    let cols: Vec<_> = cols
        .into_iter()
        .filter(|(k, _)| *k != "preferredProvider")
        .collect();
    let mut q = QueryBuilder::new("INSERT INTO media (");
    q.push(
        cols.iter()
            .map(|(k, _)| format!("\"{k}\""))
            .collect::<Vec<_>>()
            .join(", "),
    );
    q.push(") VALUES (");
    for (i, (_, c)) in cols.iter().enumerate() {
        if i > 0 {
            q.push(", ");
        }
        push_value(&mut q, c);
    }
    q.push(") RETURNING id");
    let id: i32 = q
        .build_query_scalar()
        .fetch_one(&st.db)
        .await
        .map_err(|e| {
            if is_unique_violation(&e) {
                clash()
            } else {
                e.into()
            }
        })?;
    let tmdb = cols.iter().find_map(|(k, c)| match (k, c) {
        (&"tmdbId", Col::Int(v)) => *v,
        _ => None,
    });
    st.hub.emit_domain(DomainEvent::MediaImported {
        media_id: i64::from(id),
        tmdb_id: tmdb.map(i64::from),
        media_type,
        library_id: None,
        added_by_user_id: None,
    });
    Ok((StatusCode::CREATED, Json(entity_or_404(&st, &a, id).await?)))
}

/// Rule 27: two statements whatever the size; no season hook for the children.
async fn cascade_monitored(
    c: &mut PgConnection,
    ids: &[i32],
    monitored: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"UPDATE seasons SET monitored = $1, "updatedAt" = now() WHERE "mediaId" = ANY($2)"#,
        monitored,
        ids
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE episodes SET monitored = $1, "updatedAt" = now()
           WHERE "seasonId" IN (SELECT id FROM seasons WHERE "mediaId" = ANY($2))"#,
        monitored,
        ids
    )
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// `PUT /api/media/:id` (rules 26-28).
#[utoipa::path(put, path = "/api/media/{id}", responses((status = 200)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    let id = gate(&st, &a, Action::Update, id).await?;
    let b = Body::new(v, &MEDIA_FIELDS)?;
    let cols = columns(&b)?;
    let before = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    let monitored = b.bool("monitored")?.flatten();
    let mut tx = st.db.begin().await?;
    if !cols.is_empty() {
        let mut q = QueryBuilder::new("UPDATE media SET ");
        for (i, (k, c)) in cols.iter().enumerate() {
            if i > 0 {
                q.push(", ");
            }
            q.push(format!("\"{k}\" = "));
            push_value(&mut q, c);
        }
        q.push(" WHERE id = ").push_bind(id).push(" AND (false");
        // `save` writes nothing (and keeps `updatedAt`) when every value is unchanged.
        for (k, c) in &cols {
            q.push(format!(" OR \"{k}\" IS DISTINCT FROM "));
            push_value(&mut q, c);
        }
        q.push(")");
        q.build().execute(&mut *tx).await.map_err(|e| {
            if is_unique_violation(&e) {
                clash()
            } else {
                e.into()
            }
        })?;
    }
    if let Some(m) = monitored {
        cascade_monitored(&mut tx, &[id], m).await?;
    }
    tx.commit().await?;
    if let Some(m) = monitored {
        st.hub.emit_domain(DomainEvent::MediaMonitoredChanged {
            media_id: i64::from(id),
            monitored: m,
        });
    }
    if let Some(after) = load_media(&st.db, id).await? {
        st.seams
            .lifecycle
            .on_media_monitor_change(after.lifecycle_ref(), before.monitored)
            .await;
    }
    Ok(Json(detail_or_404(&st, &a, id).await?))
}

fn library_not_found(id: i32) -> AppError {
    AppError::not_found(format!("Library #{id} not found"))
}

/// The target of a move: in the caller's libraries (F46) and with a root path.
async fn move_target(st: &AppState, a: &Authed, library_id: i32) -> Result<(), AppError> {
    let libs = accessible_library_ids(&st.db, a).await?;
    let lib = sqlx::query!("SELECT name, path FROM libraries WHERE id = $1", library_id)
        .fetch_optional(&st.db)
        .await?
        .filter(|_| libs.contains(&library_id))
        .ok_or_else(|| library_not_found(library_id))?;
    if lib.path.is_none_or(|p| p.is_empty()) {
        return Err(AppError::bad_request(format!(
            "Library \"{}\" has no root path configured",
            lib.name
        )));
    }
    Ok(())
}

/// `PATCH /api/media/:id/library` (rule 29): the row moves, the files do not.
#[utoipa::path(patch, path = "/api/media/{id}/library", responses((status = 200)))]
pub async fn patch_library(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    let id = gate(&st, &a, Action::Update, id).await?;
    let b = Body::new(v, &["libraryId"])?;
    let lib = b.required(b.id("libraryId")?, "libraryId", "must be an integer number")?;
    move_target(&st, &a, lib).await?;
    sqlx::query!(
        r#"UPDATE media SET "libraryId" = $1 WHERE id = $2"#,
        lib,
        id
    )
    .execute(&st.db)
    .await?;
    Ok(Json(detail_or_404(&st, &a, id).await?))
}

async fn profile_exists(st: &AppState, language: bool, id: i32) -> Result<(), AppError> {
    let found = if language {
        sqlx::query_scalar!("SELECT id FROM language_profiles WHERE id = $1", id)
            .fetch_optional(&st.db)
            .await?
    } else {
        sqlx::query_scalar!("SELECT id FROM quality_profiles WHERE id = $1", id)
            .fetch_optional(&st.db)
            .await?
    };
    let what = if language {
        "LanguageProfile"
    } else {
        "QualityProfile"
    };
    found
        .map(drop)
        .ok_or_else(|| AppError::not_found(format!("{what} #{id} not found")))
}

/// `PATCH /api/media/:id/profiles` (rule 30): `media.grab` or `media.edit`.
#[utoipa::path(patch, path = "/api/media/{id}/profiles", responses((status = 200)))]
pub async fn patch_profiles(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    let action = if a.perms.can(Action::Grab, &Subject::Media) {
        Action::Grab
    } else {
        Action::Update
    };
    let id = gate(&st, &a, action, id).await?;
    let b = Body::new(v, &["qualityProfileId", "languageProfileId"])?;
    let (q, l) = (b.id("qualityProfileId")?, b.id("languageProfileId")?);
    if q.is_none() && l.is_none() {
        return Err(AppError::bad_request(
            "Provide at least one of qualityProfileId or languageProfileId",
        ));
    }
    if let Some(Some(p)) = q {
        profile_exists(&st, false, p).await?;
    }
    if let Some(Some(p)) = l {
        profile_exists(&st, true, p).await?;
    }
    sqlx::query!(
        r#"UPDATE media SET
             "qualityProfileId" = CASE WHEN $2 THEN $3 ELSE "qualityProfileId" END,
             "languageProfileId" = CASE WHEN $4 THEN $5 ELSE "languageProfileId" END
           WHERE id = $1"#,
        id,
        q.is_some(),
        q.flatten(),
        l.is_some(),
        l.flatten()
    )
    .execute(&st.db)
    .await?;
    Ok(Json(detail_or_404(&st, &a, id).await?))
}

/// `PATCH /api/media/bulk` (rule 31, F46, C47): all or nothing, in one transaction.
#[utoipa::path(patch, path = "/api/media/bulk", responses((status = 200)))]
pub async fn bulk(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(v): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Update, Subject::Media)?;
    let b = Body::new(
        v,
        &[
            "ids",
            "qualityProfileId",
            "languageProfileId",
            "monitored",
            "libraryId",
        ],
    )?;
    let ids = match b.0.get("ids") {
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| {
                v.as_f64()
                    .filter(|n| n.fract() == 0.0 && n.abs() <= f64::from(i32::MAX))
                    .map(|n| n as i32)
            })
            .collect::<Option<Vec<i32>>>()
            .ok_or_else(|| {
                AppError::bad_request(vec![
                    "each value in ids must be an integer number".to_owned(),
                ])
            })?,
        Some(_) => {
            return Err(AppError::bad_request(vec![
                "ids must be an array".to_owned(),
            ]));
        }
        None => {
            return Err(AppError::bad_request(vec![
                "ids must be an array".to_owned(),
            ]));
        }
    };
    let mut ids: Vec<i32> = ids;
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Err(AppError::bad_request(vec![
            "ids should not be empty".to_owned(),
        ]));
    }
    let (q, l) = (b.id("qualityProfileId")?, b.id("languageProfileId")?);
    let monitored = b.bool("monitored")?;
    let library = b.id("libraryId")?;
    if q.is_none() && l.is_none() && monitored.is_none() && library.is_none() {
        return Err(AppError::bad_request(
            "Provide at least one field to update",
        ));
    }
    let libs = accessible_library_ids(&st.db, &a).await?;
    for id in &ids {
        assert_media_accessible(&st.db, *id, &libs).await?;
    }
    if let Some(Some(p)) = q {
        profile_exists(&st, false, p).await?;
    }
    if let Some(Some(p)) = l {
        profile_exists(&st, true, p).await?;
    }
    let library = match library {
        Some(None) => {
            return Err(AppError::bad_request(vec![
                "libraryId must be an integer number".to_owned(),
            ]));
        }
        Some(Some(lib)) => {
            move_target(&st, &a, lib).await?;
            let with_files = sqlx::query_scalar!(
                r#"SELECT "mediaId" AS "id!" FROM media_files WHERE "mediaId" = ANY($1) ORDER BY "mediaId" LIMIT 1"#,
                &ids
            )
            .fetch_optional(&st.db)
            .await?;
            if let Some(m) = with_files {
                return Err(AppError::bad_request(format!("Media #{m} has files")));
            }
            Some(lib)
        }
        None => None,
    };
    let monitored = match monitored {
        Some(None) => {
            return Err(AppError::bad_request(vec![
                "monitored must be a boolean value".to_owned(),
            ]));
        }
        m => m.flatten(),
    };
    let mut tx = st.db.begin().await?;
    let updated = sqlx::query!(
        r#"UPDATE media SET
             "qualityProfileId" = CASE WHEN $2 THEN $3 ELSE "qualityProfileId" END,
             "languageProfileId" = CASE WHEN $4 THEN $5 ELSE "languageProfileId" END,
             monitored = COALESCE($6, monitored),
             "libraryId" = COALESCE($7, "libraryId"),
             "updatedAt" = now()
           WHERE id = ANY($1)"#,
        &ids,
        q.is_some(),
        q.flatten(),
        l.is_some(),
        l.flatten(),
        monitored,
        library
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if let Some(m) = monitored {
        cascade_monitored(&mut tx, &ids, m).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "updated": updated })))
}

/// Season columns (rule 6) plus `media` (rule 33).
async fn season_json(st: &AppState, a: &Authed, id: i32) -> Result<Value, AppError> {
    let mut s = sqlx::query_scalar!(
        r#"SELECT jsonb_build_object('id', s.id, 'createdAt', iso_ms(s."createdAt"), 'updatedAt', iso_ms(s."updatedAt"),
             'seasonNumber', s."seasonNumber", 'monitored', s.monitored, 'preferredProvider', s."preferredProvider",
             'posterUrl', s."posterUrl", 'overview', s.overview, 'airDate', s."airDate", 'mediaId', s."mediaId")
             AS "j!: Value" FROM seasons s WHERE s.id = $1"#,
        id
    )
    .fetch_one(&st.db)
    .await?;
    if let Some(m) = s["mediaId"].as_i64() {
        let media =
            super::entity(&st.db, m as i32, crate::libraries::paths_visible(&a.perms)).await?;
        s["media"] = media.unwrap_or(Value::Null);
    }
    Ok(s)
}

async fn episode_json(st: &AppState, id: i32) -> Result<Value, AppError> {
    Ok(sqlx::query_scalar!(
        r#"SELECT jsonb_build_object('id', e.id, 'createdAt', iso_ms(e."createdAt"), 'updatedAt', iso_ms(e."updatedAt"),
             'episodeNumber', e."episodeNumber", 'endEpisodeNumber', e."endEpisodeNumber", 'title', e.title,
             'overview', e.overview, 'airDate', e."airDate", 'runtime', e.runtime, 'monitored', e.monitored,
             'hasFile', e."hasFile", 'stillUrl', e."stillUrl", 'markersScannedAt', iso_ms(e."markersScannedAt"),
             'seasonId', e."seasonId") AS "j!: Value" FROM episodes e WHERE e.id = $1"#,
        id
    )
    .fetch_one(&st.db)
    .await?)
}

/// Rule 1: 403, the id's 400, then `Season #<id> not found`, then the media gate.
async fn season_gate(
    st: &AppState,
    a: &Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<(i32, i32, i32, bool), AppError> {
    a.require(Action::Update, Subject::Media)?;
    let PathParams(id) = id?;
    let s = sqlx::query!(
        r#"SELECT "mediaId" AS media_id, "seasonNumber" AS number, monitored FROM seasons WHERE id = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("Season #{id} not found")))?;
    let media = s
        .media_id
        .ok_or_else(|| AppError::not_found(format!("Season #{id} not found")))?;
    let libs = accessible_library_ids(&st.db, a).await?;
    assert_media_accessible(&st.db, media, &libs).await?;
    Ok((id, media, s.number, s.monitored))
}

/// `PATCH /api/media/seasons/:seasonId` (rules 32-33).
#[utoipa::path(patch, path = "/api/media/seasons/{seasonId}", responses((status = 200)))]
pub async fn patch_season(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    let (id, media_id, number, was) = season_gate(&st, &a, id).await?;
    let b = Body::new(v, &["monitored", "preferredProvider"])?;
    let monitored = match b.bool("monitored")? {
        Some(None) => {
            return Err(AppError::bad_request(vec![
                "monitored must be a boolean value".to_owned(),
            ]));
        }
        m => m.flatten(),
    };
    let provider = match b.0.get("preferredProvider") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) if s == "tmdb" || s == "tvdb" => Some(Some(s.clone())),
        _ => {
            return Err(AppError::bad_request(vec![
                "preferredProvider must be one of the following values: tmdb, tvdb, ".to_owned(),
            ]));
        }
    };
    let mut tx = st.db.begin().await?;
    sqlx::query!(
        r#"UPDATE seasons SET monitored = COALESCE($2, monitored),
             "preferredProvider" = CASE WHEN $3 THEN $4 ELSE "preferredProvider" END
           WHERE id = $1 AND (monitored IS DISTINCT FROM COALESCE($2, monitored)
             OR ($3 AND "preferredProvider" IS DISTINCT FROM $4))"#,
        id,
        monitored,
        provider.is_some(),
        provider.clone().flatten()
    )
    .execute(&mut *tx)
    .await?;
    if let Some(m) = monitored {
        sqlx::query!(
            r#"UPDATE episodes SET monitored = $1, "updatedAt" = now() WHERE "seasonId" = $2"#,
            m,
            id
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    let now = monitored.unwrap_or(was);
    if let Some(media) = load_media(&st.db, media_id).await? {
        st.seams
            .lifecycle
            .on_season_monitor_change(media.lifecycle_ref(), number, was, now)
            .await;
    }
    st.hub
        .emit_domain(DomainEvent::MediaSeasonMonitoredChanged {
            media_id: i64::from(media_id),
            season_number: i64::from(number),
            monitored: now,
        });
    Ok(Json(season_json(&st, &a, id).await?))
}

/// `PATCH /api/media/episodes/:episodeId` (rule 34): no hook, no event.
#[utoipa::path(patch, path = "/api/media/episodes/{episodeId}", responses((status = 200)))]
pub async fn patch_episode(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Update, Subject::Media)?;
    let PathParams(id) = id?;
    let media = sqlx::query_scalar!(
        r#"SELECT s."mediaId" FROM episodes e JOIN seasons s ON s.id = e."seasonId" WHERE e.id = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await?
    .flatten()
    .ok_or_else(|| AppError::not_found(format!("Episode #{id} not found")))?;
    let libs = accessible_library_ids(&st.db, &a).await?;
    assert_media_accessible(&st.db, media, &libs).await?;
    let b = Body::new(v, &["monitored"])?;
    let m = b.required(b.bool("monitored")?, "monitored", "must be a boolean value")?;
    sqlx::query!(
        r#"UPDATE episodes SET monitored = $1 WHERE id = $2 AND monitored IS DISTINCT FROM $1"#,
        m,
        id
    )
    .execute(&st.db)
    .await?;
    Ok(Json(episode_json(&st, id).await?))
}
