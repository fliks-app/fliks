//! Metadata imports (rules 10-17, 19-22): the provider reads happen first, the rows in one
//! transaction; images and credits follow detached.
use super::{body::Body, entity_or_404, metadata, resolve_profile};
use crate::media::external_ids::{self, Ids};
use crate::{
    events::DomainEvent,
    http::{AppError, auth::Authed, validate::ValidJson},
    images::paths::{Target as Art, Variant},
    ingest::load_media,
    libraries::accessible_library_ids,
    metadata::{
        Provider,
        service::{self, Details, Lookup},
    },
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use fliks_domain::{
    acl::{Action, Subject},
    external_id::ExternalProvider,
    media::kind::MediaKind,
    naming::{self, MovieFolder, SeriesFolder, validate_folder_name},
    nfo::NfoData,
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::path::PathBuf;

pub struct Target {
    pub id: i32,
    pub default_quality: Option<i32>,
    pub default_language: Option<i32>,
}

/// Rule 14: the library (or the sole one accepting `type`) among the caller's libraries.
pub async fn resolve_target(
    st: &AppState,
    a: &Authed,
    media_type: MediaKind,
    library_id: Option<i32>,
) -> Result<Target, AppError> {
    let libs = accessible_library_ids(&st.db, a).await?;
    resolve_target_in(st, &libs, media_type, library_id).await
}

/// `resolveImportTarget` among `libs` (every library for a request approval, which has no caller ACL).
pub async fn resolve_target_in(
    st: &AppState,
    libs: &[i32],
    media_type: MediaKind,
    library_id: Option<i32>,
) -> Result<Target, AppError> {
    let rows = sqlx::query!(
        r#"SELECT id, name, path, "mediaTypes" AS types, "defaultQualityProfileId" AS dq,
                  "defaultLanguageProfileId" AS dl
           FROM libraries WHERE id = ANY($1) ORDER BY name ASC, id ASC"#,
        libs
    )
    .fetch_all(&st.db)
    .await?;
    let accepts = |t: &Value| {
        t.as_array().is_some_and(|a| {
            a.iter()
                .any(|v| v.as_str().and_then(MediaKind::parse) == Some(media_type))
        })
    };
    let lib = match library_id {
        Some(id) => match rows.iter().find(|r| r.id == id) {
            Some(r) => r,
            // Unknown and outside the caller's libraries answer alike (no existence oracle).
            None => return Err(AppError::not_found(format!("Library #{id} not found"))),
        },
        None => {
            let ok: Vec<_> = rows.iter().filter(|r| accepts(&r.types)).collect();
            match ok.as_slice() {
                [one] => *one,
                [] => {
                    return Err(AppError::bad_request(format!(
                        "No library accepts {media_type}"
                    )));
                }
                _ => {
                    return Err(AppError::bad_request(format!(
                        "Several libraries accept {media_type} — pass libraryId to choose one"
                    )));
                }
            }
        }
    };
    if !accepts(&lib.types) {
        return Err(AppError::bad_request(format!(
            "Library \"{}\" does not accept {media_type}",
            lib.name
        )));
    }
    if lib.path.as_deref().is_none_or(str::is_empty) {
        return Err(AppError::bad_request(format!(
            "Library \"{}\" has no root path configured",
            lib.name
        )));
    }
    Ok(Target {
        id: lib.id,
        default_quality: lib.dq,
        default_language: lib.dl,
    })
}

async fn duplicate(
    st: &AppState,
    media_type: MediaKind,
    tvdb: bool,
    id: i32,
) -> Result<(), AppError> {
    let p = if tvdb {
        ExternalProvider::Tvdb
    } else {
        ExternalProvider::Tmdb
    };
    let hit = external_ids::find_numeric(&st.db, media_type, p, id).await?;
    match hit {
        Some(_) => Err(AppError::conflict("This title is already in the library")),
        None => Ok(()),
    }
}

/// What an import persists besides the provider data.
pub struct Import {
    pub media_type: MediaKind,
    pub library_id: i32,
    pub quality_profile_id: Option<i32>,
    pub language_profile_id: Option<i32>,
    pub added_by: Option<i32>,
    pub monitored_seasons: Option<Vec<i32>>,
}

/// `importFromTmdb` / `importMedia` after validation (rules 11-17, 21-22), also the request
/// lifecycle's entry point (rule 25).
pub async fn import_title(
    st: &AppState,
    provider: Option<String>,
    external_id: String,
    imp: Import,
) -> Result<i32, AppError> {
    let found = service::import(
        st,
        Lookup {
            media_type: imp.media_type,
            provider,
            external_id,
            library_id: imp.library_id,
        },
    )
    .await?;
    let format = folder_format(&st.db, imp.media_type).await?;
    let d = &found.details;
    let folder = folder_name(&format, imp.media_type, d);
    let folder = validate_folder_name(&folder)
        .map_err(|_| AppError::bad_request(format!("Invalid folder name for \"{}\"", d.title)))?
        .to_owned();
    let mut tx = st.db.begin().await?;
    let (id, free) = insert_media(&mut tx, &imp, d, &folder).await.map_err(|e| {
        if e.as_database_error().and_then(|d| d.code()).as_deref() == Some("23505") {
            AppError::conflict("This title is already in the library")
        } else {
            e.into()
        }
    })?;
    if !free {
        return Err(AppError::conflict("This title is already in the library"));
    }
    let mut stills = vec![];
    if imp.media_type.has_seasons() {
        let scope = imp.monitored_seasons.clone().filter(|s| !s.is_empty());
        for sd in &found.seasons {
            let n = sd.season_number;
            let monitored = scope.as_ref().map_or(n > 0, |s| s.contains(&n));
            let sid = sqlx::query_scalar!(
                r#"INSERT INTO seasons ("mediaId", "seasonNumber", monitored) VALUES ($1, $2, $3) RETURNING id"#,
                id,
                n,
                monitored
            )
            .fetch_one(&mut *tx)
            .await?;
            stills.push((
                sid,
                metadata::apply_season(&mut tx, sid, sd).await?,
                sd.poster_url.clone(),
            ));
        }
    }
    tx.commit().await?;
    tracing::info!(
        "Imported \"{}\" (#{id}) into library #{}",
        d.title,
        imp.library_id
    );
    let (st2, details) = (st.clone(), found.details.clone());
    tokio::spawn(async move {
        metadata::download_media_images(&st2, id, &details).await;
        for (sid, stills, poster) in stills {
            metadata::download_season_images(&st2, sid, stills, poster).await;
        }
    });
    if let Some(m) = load_media(&st.db, id).await? {
        crate::requests::Lifecycle::of(st)
            .on_media_imported(m.lifecycle_ref(), imp.added_by)
            .await;
    }
    st.hub.emit_domain(DomainEvent::MediaImported {
        media_id: i64::from(id),
        tmdb_id: d.tmdb_id.filter(|t| *t != 0).map(i64::from),
        media_type: imp.media_type,
        library_id: Some(i64::from(imp.library_id)),
        added_by_user_id: imp.added_by.map(i64::from),
    });
    let (st2, details) = (st.clone(), d.clone());
    tokio::spawn(async move {
        if let Err(e) = service::persist_credits(&st2, id, &details).await {
            tracing::warn!("cast/metadata persist of media #{id} failed: {e}");
        }
    });
    Ok(id)
}

/// The stored folder format, else the import's own default (not the naming service's, rule 13).
async fn folder_format(db: &sqlx::PgPool, media_type: MediaKind) -> Result<String, sqlx::Error> {
    let (key, default) = match media_type {
        MediaKind::Movie => (
            "naming_movie_folder_format",
            "{Original Title} ({Release Year})",
        ),
        MediaKind::Series => ("naming_series_folder_format", "{Series Title}"),
    };
    let stored = sqlx::query_scalar!(r#"SELECT value FROM app_settings WHERE key = $1"#, key)
        .fetch_optional(db)
        .await?
        .flatten();
    Ok(stored.unwrap_or_else(|| default.to_owned()))
}

fn folder_name(format: &str, media_type: MediaKind, d: &Details) -> String {
    let year = d.year.filter(|y| y.is_finite()).map(|y| y as i64);
    let tmdb_id = d.tmdb_id.map(i64::from);
    match media_type {
        MediaKind::Movie => naming::apply_movie_folder_format(
            format,
            &MovieFolder {
                title: d.title.clone(),
                original_title: d.original_title.clone(),
                year,
                tmdb_id,
            },
        ),
        MediaKind::Series => naming::apply_series_folder_format(
            format,
            &SeriesFolder {
                series_title: d.title.clone(),
                original_title: d.original_title.clone(),
                year,
                tmdb_id,
            },
        ),
    }
}

/// `mapTmdbStatusToMediaStatus`.
pub fn map_status(media_type: MediaKind, status: &str) -> &'static str {
    let s = status.to_lowercase();
    match media_type {
        MediaKind::Movie => match s.as_str() {
            "released" => "released",
            "planned" | "in production" | "post production" => "announced",
            "canceled" | "cancelled" => "ended",
            _ => "tba",
        },
        MediaKind::Series => match s.as_str() {
            "continuing" => "continuing",
            "ended" => "ended",
            "announced" => "announced",
            _ => "tba",
        },
    }
}

fn day(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(10).collect())
}

/// `buildMediaFieldsFromTmdb` plus the import's own columns (rule 21).
async fn insert_media(
    tx: &mut PgConnection,
    imp: &Import,
    d: &Details,
    folder: &str,
) -> Result<(i32, bool), sqlx::Error> {
    let id = sqlx::query_scalar!(
        r#"INSERT INTO media (title, "originalTitle", "alternativeTitles", year, type,
             overview, status, "posterUrl", "fanartUrl", "logoUrl", rating, genres, runtime, "releaseDate",
             "inCinemas", "digitalRelease", "physicalRelease", "tmdbCollectionId", "tmdbCollectionName",
             monitored, "metadataRefreshedAt", "qualityProfileId", "languageProfileId", "libraryId",
             "folderName", "addedById")
           VALUES ($1, $2, $3, $4, $5, $6, $7::text::media_status_enum, $8, $9,
             $10, $11, $12, $13, $14::text::date, $15::text::date, $16::text::date, $17::text::date, $18, $19,
             true, now(), $20, $21, $22, NULLIF($23, ''), $24)
           RETURNING id"#,
        d.title,
        d.original_title.clone().unwrap_or_else(|| d.title.clone()),
        json!(d.alternative_titles),
        d.year.filter(|y| y.is_finite()).map(|y| y as i32),
        imp.media_type.as_str(),
        d.overview,
        map_status(imp.media_type, &d.status),
        d.poster_url,
        d.fanart_url,
        d.logo_url,
        d.rating,
        json!(d.genres),
        d.runtime,
        day(&d.release_date),
        day(&d.in_cinemas),
        day(&d.digital_release),
        day(&d.physical_release),
        d.tmdb_collection_id,
        d.tmdb_collection_name,
        imp.quality_profile_id,
        imp.language_profile_id,
        imp.library_id,
        folder,
        imp.added_by.filter(|u| *u != 0)
    )
    .fetch_one(&mut *tx)
    .await?;
    let ids = Ids {
        tmdb: d.tmdb_id,
        tvdb: d.tvdb_id,
        imdb: d.imdb_id.clone(),
    };
    Ok((id, ids.fill(tx, id, imp.media_type).await?.taken.is_empty()))
}

const TMDB_FIELDS: [&str; 5] = [
    "type",
    "tmdbId",
    "qualityProfileId",
    "languageProfileId",
    "libraryId",
];
const MEDIA_FIELDS: [&str; 7] = [
    "type",
    "externalId",
    "provider",
    "qualityProfileId",
    "languageProfileId",
    "libraryId",
    "monitoredSeasons",
];
struct Common {
    media_type: MediaKind,
    quality: Option<i32>,
    language: Option<i32>,
    library: Option<i32>,
}

fn common(b: &Body) -> Result<Common, AppError> {
    Ok(Common {
        media_type: b.required_kind("type")?,
        quality: b.id("qualityProfileId")?.flatten(),
        language: b.id("languageProfileId")?.flatten(),
        library: b.id("libraryId")?.flatten(),
    })
}

async fn prepare(
    st: &AppState,
    a: &Authed,
    c: &Common,
    seasons: Option<Vec<i32>>,
) -> Result<Import, AppError> {
    let target = resolve_target(st, a, c.media_type, c.library).await?;
    Ok(Import {
        media_type: c.media_type,
        library_id: target.id,
        quality_profile_id: resolve_profile(&st.db, false, c.quality, target.default_quality)
            .await?,
        language_profile_id: resolve_profile(&st.db, true, c.language, target.default_language)
            .await?,
        added_by: Some(a.user.id),
        monitored_seasons: seasons,
    })
}

pub async fn all_library_ids(db: &sqlx::PgPool) -> Result<Vec<i32>, sqlx::Error> {
    sqlx::query_scalar!(r#"SELECT id AS "id!" FROM libraries ORDER BY id"#)
        .fetch_all(db)
        .await
}

/// `importFromTmdb` for a request approval (rules 11, 25): no caller ACL, the requester is `addedBy`.
pub async fn import_for_request(
    st: &AppState,
    media_type: MediaKind,
    tmdb_id: i32,
    profiles: (Option<i32>, Option<i32>),
    library_id: Option<i32>,
    added_by: Option<i32>,
    seasons: Option<Vec<i32>>,
) -> Result<i32, AppError> {
    if !st.metadata.available(Provider::Tmdb) {
        return Err(AppError::bad_request("TMDB API key is not configured"));
    }
    duplicate(st, media_type, false, tmdb_id).await?;
    let all = all_library_ids(&st.db).await?;
    let target = resolve_target_in(st, &all, media_type, library_id).await?;
    let imp = Import {
        media_type,
        library_id: target.id,
        quality_profile_id: resolve_profile(&st.db, false, profiles.0, target.default_quality)
            .await?,
        language_profile_id: resolve_profile(&st.db, true, profiles.1, target.default_language)
            .await?,
        added_by,
        monitored_seasons: seasons,
    };
    import_title(st, Some("tmdb".into()), tmdb_id.to_string(), imp).await
}

/// `POST /api/media/import/tmdb` (rules 10-13).
#[utoipa::path(post, path = "/api/media/import/tmdb", responses((status = 201)))]
pub async fn import_tmdb(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Create, Subject::Media)?;
    let b = Body::new(v, &TMDB_FIELDS)?;
    let c = common(&b)?;
    let tmdb = b.required(b.id("tmdbId")?, "tmdbId", "must be an integer number")?;
    if !st.metadata.available(Provider::Tmdb) {
        return Err(AppError::bad_request("TMDB API key is not configured"));
    }
    duplicate(&st, c.media_type, false, tmdb).await?;
    let imp = prepare(&st, &a, &c, None).await?;
    let id = import_title(&st, Some("tmdb".into()), tmdb.to_string(), imp).await?;
    Ok((StatusCode::CREATED, Json(entity_or_404(&st, &a, id).await?)))
}

/// `POST /api/media/import` (rule 17: a numeric `externalId` and a known `provider`).
#[utoipa::path(post, path = "/api/media/import", responses((status = 201)))]
pub async fn import_media(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Create, Subject::Media)?;
    let b = Body::new(v, &MEDIA_FIELDS)?;
    let c = common(&b)?;
    let external = b.required(b.str("externalId")?, "externalId", "must be a string")?;
    let provider = b.one_of("provider", &["tmdb", "tvdb"])?.flatten();
    let seasons = match b.0.get("monitoredSeasons") {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => Some(
            a.iter()
                .map(|v| {
                    v.as_i64()
                        .filter(|n| *n >= 0 && *n <= i64::from(i32::MAX))
                        .map(|n| n as i32)
                })
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| {
                    AppError::bad_request(vec![
                        "each value in monitoredSeasons must not be less than 0".to_owned(),
                    ])
                })?,
        ),
        Some(_) => {
            return Err(AppError::bad_request(vec![
                "monitoredSeasons must be an array".to_owned(),
            ]));
        }
    };
    let n: i32 = external
        .trim()
        .parse()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| {
            AppError::bad_request(vec!["externalId must be a number string".to_owned()])
        })?;
    duplicate(&st, c.media_type, provider.as_deref() == Some("tvdb"), n).await?;
    let imp = prepare(&st, &a, &c, seasons).await?;
    let id = import_title(&st, provider, external, imp).await?;
    Ok((StatusCode::CREATED, Json(entity_or_404(&st, &a, id).await?)))
}

/// `createUnmatched` input (rule 19): a title found on disk with no provider id.
pub struct Unmatched {
    pub title: String,
    pub year: Option<i32>,
    pub media_type: MediaKind,
    pub library_id: i32,
    pub folder_name: String,
    pub quality_profile_id: Option<i32>,
    pub language_profile_id: Option<i32>,
    pub library_default_quality: Option<i32>,
    pub library_default_language: Option<i32>,
    pub nfo: Option<NfoData>,
    pub artwork: Artwork,
}

#[derive(Default)]
pub struct Artwork {
    pub poster: Option<PathBuf>,
    pub fanart: Option<PathBuf>,
    pub logo: Option<PathBuf>,
}

/// `createUnmatched` (rules 19-20): `monitored = false`, no lifecycle hook (no `tmdbId`).
pub async fn create_unmatched(st: &AppState, u: Unmatched, added_by: i32) -> Result<i32, AppError> {
    let q = resolve_profile(
        &st.db,
        false,
        u.quality_profile_id,
        u.library_default_quality,
    )
    .await?;
    let l = resolve_profile(
        &st.db,
        true,
        u.language_profile_id,
        u.library_default_language,
    )
    .await?;
    let nfo = u.nfo.unwrap_or_default();
    let title = match nfo.title.clone() {
        Some(t) if !t.is_empty() && (u.title.is_empty() || u.title == u.folder_name) => t,
        _ => u.title.clone(),
    };
    let original = nfo
        .original_title
        .clone()
        .filter(|o| !o.is_empty())
        .unwrap_or_else(|| title.clone());
    let id = sqlx::query_scalar!(
        r#"INSERT INTO media (title, "originalTitle", year, type, status, monitored, "alternativeTitles", overview,
             genres, runtime, rating, "releaseDate", "libraryId", "folderName", "qualityProfileId",
             "languageProfileId", "addedById")
           VALUES ($1, $2, $3, $4, 'released', false, '[]', $5, $6, $7, $8, $9::text::date,
             $10, $11, $12, $13, $14)
           RETURNING id"#,
        title,
        original,
        u.year.or(nfo.year.and_then(|y| i32::try_from(y).ok())),
        u.media_type.as_str(),
        nfo.plot,
        json!(nfo.genres.clone().unwrap_or_default()),
        nfo.runtime.and_then(|r| i32::try_from(r).ok()),
        nfo.rating,
        nfo.premiered,
        u.library_id,
        u.folder_name,
        q,
        l,
        Some(added_by).filter(|u| *u != 0)
    )
    .fetch_one(&st.db)
    .await?;
    store_local_artwork(st, id, &u.artwork).await;
    st.hub.emit_domain(DomainEvent::MediaImported {
        media_id: i64::from(id),
        tmdb_id: None,
        media_type: u.media_type,
        library_id: Some(i64::from(u.library_id)),
        added_by_user_id: Some(i64::from(added_by)).filter(|u| *u != 0),
    });
    Ok(id)
}

/// Rule 20: copies found beside the files go to the data dir (never a library write).
async fn store_local_artwork(st: &AppState, id: i32, a: &Artwork) {
    let mut urls: [Option<String>; 3] = Default::default();
    for (i, (p, v)) in [
        (&a.poster, Variant::Poster),
        (&a.fanart, Variant::Fanart),
        (&a.logo, Variant::Logo),
    ]
    .into_iter()
    .enumerate()
    {
        if let Some(p) = p {
            urls[i] = st.images.store_from_disk(p, &Art::media(id, v)).await;
            if urls[i].is_none() {
                tracing::warn!("local {v} of media #{id} not stored: \"{}\"", p.display());
            }
        }
    }
    if urls.iter().all(Option::is_none) {
        return;
    }
    let [p, f, l] = urls;
    if let Err(e) = sqlx::query!(
        r#"UPDATE media SET "posterUrl" = COALESCE($2, "posterUrl"), "fanartUrl" = COALESCE($3, "fanartUrl"),
             "logoUrl" = COALESCE($4, "logoUrl") WHERE id = $1"#,
        id,
        p,
        f,
        l
    )
    .execute(&st.db)
    .await
    {
        tracing::warn!("local artwork of media #{id}: {e}");
    }
}
