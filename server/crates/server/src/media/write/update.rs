//! Create, update, bulk, library, profiles, season and episode patches (rules 18, 26-35).
use super::{body::Body, detail_or_404, entity_or_404, gate};
use crate::{
    events::DomainEvent,
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    ingest::{MediaRow, load_media},
    libraries::{accessible_library_ids, assert_media_accessible},
    media::external_ids::{self, Link},
    requests::MediaRef,
    state::AppState,
};
use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use fliks_domain::{
    acl::{Action, Subject},
    external_id::ExternalProvider,
    media::kind::MediaKind,
};
use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder};

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
    Json(Option<Value>),
    Enum(&'static str, Option<String>),
    Date(Option<String>),
}

/// The external ids a `CreateMediaDto` / `UpdateMediaDto` body carries; `None` leaves one alone, `Some(None)` clears it.
struct BodyIds {
    tmdb: Option<Option<i32>>,
    imdb: Option<Option<String>>,
}

fn body_ids(b: &Body) -> Result<BodyIds, AppError> {
    Ok(BodyIds {
        tmdb: b.int("tmdbId")?,
        imdb: b.str("imdbId")?,
    })
}

impl BodyIds {
    /// Whether applying the ids changes what the media holds.
    fn differ(&self, m: &MediaRow) -> bool {
        let tmdb = |t: &Option<i32>| t.filter(|t| *t > 0);
        let imdb = |i: &Option<String>| i.clone().filter(|i| !i.is_empty());
        self.tmdb.as_ref().is_some_and(|t| tmdb(t) != m.tmdb_id)
            || self.imdb.as_ref().is_some_and(|i| imdb(i) != m.imdb_id)
    }

    /// The first write that did not link: a held TMDB id, or a media removed meanwhile.
    async fn apply(
        &self,
        c: &mut PgConnection,
        id: i32,
        kind: MediaKind,
    ) -> Result<Link, sqlx::Error> {
        let tmdb = self.tmdb.as_ref().map(|t| t.map(|t| t.to_string()));
        let imdb = self.imdb.as_ref();
        for (p, v) in [
            (ExternalProvider::Tmdb, tmdb),
            (ExternalProvider::Imdb, imdb.cloned()),
        ] {
            let Some(v) = v else { continue };
            match external_ids::set(c, id, kind, p, v.as_deref()).await? {
                Link::Linked => {}
                other => return Ok(other),
            }
        }
        Ok(Link::Linked)
    }
}

/// Columns of `CreateMediaDto` / `UpdateMediaDto` that persist (`path` and the profile ids do not).
fn columns(b: &Body) -> Result<Vec<(&'static str, Col)>, AppError> {
    let mut out = vec![];
    macro_rules! put {
        ($col:literal, $v:expr, $wrap:expr) => {
            if let Some(v) = $v {
                out.push(($col, $wrap(v)));
            }
        };
    }
    put!("title", b.str("title")?, Col::Text);
    put!("originalTitle", b.str("originalTitle")?, Col::Text);
    put!("year", b.int("year")?, Col::Int);
    put!("type", b.kind("type")?, |v: Option<MediaKind>| Col::Text(
        v.map(|k| k.as_str().to_owned())
    ));
    put!("overview", b.str("overview")?, Col::Text);
    put!("status", b.one_of("status", &STATUSES)?, |v| {
        Col::Enum("media_status_enum", v)
    });
    if let Some(None) = b.bool("monitored")? {
        return Err(AppError::bad_request(vec![
            "monitored should not be empty".to_owned(),
        ]));
    }
    put!("posterUrl", b.str("posterUrl")?, Col::Text);
    put!("fanartUrl", b.str("fanartUrl")?, Col::Text);
    put!("rating", b.num("rating")?, Col::Float);
    put!("genres", b.strings("genres")?, |v: Option<Vec<String>>| {
        Col::Json(v.map(|g| json!(g)))
    });
    put!("runtime", b.int("runtime")?, Col::Int);
    put!("releaseDate", b.date("releaseDate")?, Col::Date);
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
    // A NOT NULL column set to null is a 400, never a database 500.
    for (k, c) in &out {
        let null = matches!(c, Col::Text(None) | Col::Enum(_, None));
        if null && ["title", "type", "status"].contains(k) {
            return Err(AppError::bad_request(vec![format!(
                "{k} should not be empty"
            )]));
        }
    }
    Ok(out)
}

fn push_value(q: &mut QueryBuilder<Postgres>, c: &Col) {
    match c {
        Col::Text(v) => q.push_bind(v.clone()),
        Col::Int(v) => q.push_bind(*v),
        Col::Float(v) => q.push_bind(*v),
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

fn clash_or(e: sqlx::Error) -> AppError {
    if is_unique_violation(&e) {
        clash()
    } else {
        e.into()
    }
}

/// `POST /api/media` (rule 18): columns only, no library, no folder, no hook.
#[utoipa::path(post, path = "/api/media", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Create, Subject::Media)?;
    // `CreateMediaDto` has no `preferredProvider`, the last field.
    let b = Body::new(v, &MEDIA_FIELDS[..18])?;
    b.required(b.str("title")?, "title", "must be a string")?;
    let media_type = b.required_kind("type")?;
    let ids = body_ids(&b)?;
    let cols = columns(&b)?;
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
    let mut tx = st.db.begin().await?;
    let id: i32 = q.build_query_scalar().fetch_one(&mut *tx).await?;
    if ids.apply(&mut tx, id, media_type).await.map_err(clash_or)? != Link::Linked {
        return Err(clash());
    }
    tx.commit().await?;
    st.hub.emit_domain(DomainEvent::MediaImported {
        media_id: i64::from(id),
        tmdb_id: ids.tmdb.flatten().filter(|t| *t > 0).map(i64::from),
        media_type,
        library_id: None,
        added_by_user_id: None,
    });
    Ok((StatusCode::CREATED, Json(entity_or_404(&st, &a, id).await?)))
}

/// What a monitored write really changed, announced once the transaction has committed.
pub struct MonitoredChange {
    monitored: bool,
    media: Vec<MediaRef>,
    seasons: Vec<(MediaRef, i32)>,
}

impl MonitoredChange {
    /// Rule 38/39 events and request hooks, for every media or season whose flag flipped.
    pub async fn announce(self, st: &AppState) {
        let lifecycle = crate::requests::Lifecycle::of(st);
        for m in self.media {
            st.hub.emit_domain(DomainEvent::MediaMonitoredChanged {
                media_id: i64::from(m.id),
                monitored: self.monitored,
            });
            lifecycle.on_media_monitor_change(m, !self.monitored).await;
        }
        for (m, number) in self.seasons {
            st.hub
                .emit_domain(DomainEvent::MediaSeasonMonitoredChanged {
                    media_id: i64::from(m.id),
                    season_number: i64::from(number),
                    monitored: self.monitored,
                });
            lifecycle
                .on_season_monitor_change(m, number, !self.monitored, self.monitored)
                .await;
        }
    }
}

/// Rule 27: sets `monitored` on the media and, in two statements whatever the size, on their seasons and
/// episodes (no season hook for the children). The prior state is read in one query.
pub async fn apply_media_monitored(
    c: &mut PgConnection,
    ids: &[i32],
    monitored: bool,
) -> Result<MonitoredChange, sqlx::Error> {
    let media = sqlx::query!(
        r#"SELECT m.id, m.type AS "media_type!" FROM media m
           WHERE m.id = ANY($1) AND m.monitored IS DISTINCT FROM $2"#,
        ids,
        monitored
    )
    .fetch_all(&mut *c)
    .await?
    .into_iter()
    .map(|r| {
        Ok(MediaRef {
            id: r.id,
            media_type: crate::db::kind(&r.media_type)?,
            monitored,
        })
    })
    .collect::<Result<Vec<_>, sqlx::Error>>()?;
    let changed: Vec<i32> = media.iter().map(|m| m.id).collect();
    sqlx::query!(
        "UPDATE media SET monitored = $1 WHERE id = ANY($2)",
        monitored,
        &changed
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE seasons SET monitored = $1 WHERE "mediaId" = ANY($2)"#,
        monitored,
        ids
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE episodes SET monitored = $1
           WHERE "seasonId" IN (SELECT id FROM seasons WHERE "mediaId" = ANY($2))"#,
        monitored,
        ids
    )
    .execute(&mut *c)
    .await?;
    Ok(MonitoredChange {
        monitored,
        media,
        seasons: vec![],
    })
}

/// Rules 32-33: sets `monitored` on a season and every episode of it.
pub async fn apply_season_monitored(
    c: &mut PgConnection,
    season_id: i32,
    monitored: bool,
) -> Result<MonitoredChange, sqlx::Error> {
    let was = sqlx::query!(
        r#"SELECT s."seasonNumber" AS number, s.monitored AS was, m.id AS "media_id?",
             m.type AS media_type
           FROM seasons s LEFT JOIN media m ON m.id = s."mediaId"
           WHERE s.id = $1"#,
        season_id
    )
    .fetch_optional(&mut *c)
    .await?;
    let was_kind = match was.as_ref().and_then(|w| w.media_type.as_deref()) {
        Some(t) => Some(crate::db::kind(t)?),
        None => None,
    };
    sqlx::query!(
        "UPDATE seasons SET monitored = $2 WHERE id = $1 AND monitored IS DISTINCT FROM $2",
        season_id,
        monitored
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE episodes SET monitored = $1 WHERE "seasonId" = $2"#,
        monitored,
        season_id
    )
    .execute(&mut *c)
    .await?;
    let seasons = was
        .filter(|w| w.was != monitored)
        .and_then(|w| {
            Some((
                MediaRef {
                    id: w.media_id?,
                    media_type: was_kind?,
                    monitored: true,
                },
                w.number,
            ))
        })
        .into_iter()
        .collect();
    Ok(MonitoredChange {
        monitored,
        media: vec![],
        seasons,
    })
}

/// The single owner of media monitoring outside a larger write: apply, commit, announce.
pub async fn set_media_monitored(
    st: &AppState,
    ids: &[i32],
    monitored: bool,
) -> Result<(), sqlx::Error> {
    let mut tx = st.db.begin().await?;
    let change = apply_media_monitored(&mut tx, ids, monitored).await?;
    tx.commit().await?;
    change.announce(st).await;
    Ok(())
}

pub async fn set_season_monitored(
    st: &AppState,
    season_id: i32,
    monitored: bool,
) -> Result<(), sqlx::Error> {
    let mut tx = st.db.begin().await?;
    let change = apply_season_monitored(&mut tx, season_id, monitored).await?;
    tx.commit().await?;
    change.announce(st).await;
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
    let ids = body_ids(&b)?;
    let cols = columns(&b)?;
    let media = load_media(&st.db, id)
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
        q.build().execute(&mut *tx).await.map_err(clash_or)?;
    }
    let kind = cols
        .iter()
        .find_map(|(k, c)| match (k, c) {
            (&"type", Col::Text(Some(t))) => MediaKind::parse(t),
            _ => None,
        })
        .unwrap_or(media.media_type);
    if ids.differ(&media) {
        match ids.apply(&mut tx, id, kind).await.map_err(clash_or)? {
            Link::Linked => {}
            Link::Taken => return Err(clash()),
            Link::Gone => return Err(crate::libraries::media_not_found(id)),
        }
        sqlx::query!(r#"UPDATE media SET "updatedAt" = now() WHERE id = $1"#, id)
            .execute(&mut *tx)
            .await?;
    }
    let change = match monitored {
        Some(m) => Some(apply_media_monitored(&mut tx, &[id], m).await?),
        None => None,
    };
    tx.commit().await?;
    if let Some(c) = change {
        c.announce(&st).await;
    }
    Ok(Json(detail_or_404(&st, &a, id).await?))
}

fn library_not_found(id: i32) -> AppError {
    AppError::not_found(format!("Library #{id} not found"))
}

/// The target of a move: in the caller's libraries and with a root path.
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

/// `PATCH /api/media/:id/library` (rule 29): 409 for a media with files (`code: media_has_files`), which a move cannot carry.
#[utoipa::path(patch, path = "/api/media/{id}/library", responses((status = 200)))]
pub async fn patch_library(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<Response, AppError> {
    let id = gate(&st, &a, Action::Update, id).await?;
    let b = Body::new(v, &["libraryId"])?;
    let lib = b.required(b.id("libraryId")?, "libraryId", "must be an integer number")?;
    move_target(&st, &a, lib).await?;
    let current = sqlx::query!(
        r#"SELECT "libraryId" AS library_id,
                  EXISTS (SELECT 1 FROM media_files WHERE "mediaId" = $1) AS "has_files!"
           FROM media WHERE id = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await?;
    if current.is_some_and(|c| c.has_files && c.library_id != Some(lib)) {
        let body = json!({"statusCode": 409, "error": "Conflict", "code": "media_has_files",
            "message": "This media has files and cannot be moved to another library"});
        return Ok((StatusCode::CONFLICT, Json(body)).into_response());
    }
    sqlx::query!(
        r#"UPDATE media SET "libraryId" = $1 WHERE id = $2"#,
        lib,
        id
    )
    .execute(&st.db)
    .await?;
    Ok(Json(detail_or_404(&st, &a, id).await?).into_response())
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

/// `PATCH /api/media/bulk` (rule 31): all or nothing, in one transaction.
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
             "libraryId" = COALESCE($6, "libraryId")
           WHERE id = ANY($1)"#,
        &ids,
        q.is_some(),
        q.flatten(),
        l.is_some(),
        l.flatten(),
        library
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let change = match monitored {
        Some(m) => Some(apply_media_monitored(&mut tx, &ids, m).await?),
        None => None,
    };
    tx.commit().await?;
    if let Some(c) = change {
        c.announce(&st).await;
    }
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
) -> Result<i32, AppError> {
    a.require(Action::Update, Subject::Media)?;
    let PathParams(id) = id?;
    let s = sqlx::query!(
        r#"SELECT "mediaId" AS media_id FROM seasons WHERE id = $1"#,
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
    Ok(id)
}

/// `PATCH /api/media/seasons/:seasonId` (rules 32-33).
#[utoipa::path(patch, path = "/api/media/seasons/{seasonId}", responses((status = 200)))]
pub async fn patch_season(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    let id = season_gate(&st, &a, id).await?;
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
    if let Some(p) = provider {
        sqlx::query!(
            r#"UPDATE seasons SET "preferredProvider" = $2
               WHERE id = $1 AND "preferredProvider" IS DISTINCT FROM $2"#,
            id,
            p
        )
        .execute(&mut *tx)
        .await?;
    }
    let change = match monitored {
        Some(m) => Some(apply_season_monitored(&mut tx, id, m).await?),
        None => None,
    };
    tx.commit().await?;
    if let Some(c) = change {
        c.announce(&st).await;
    }
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
