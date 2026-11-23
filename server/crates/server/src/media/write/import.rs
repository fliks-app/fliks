//! `POST /api/media/import` and `POST /api/media/import/tmdb` (rules 10-17).
use super::entity_or_404;
use crate::{
    http::{AppError, auth::Authed, validate::ValidJson},
    media::service::{
        self, Creation, body::Body, create_identified, duplicate_ref, resolve_target, search_added,
    },
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use fliks_domain::{
    acl::{Action, Subject},
    external_id::Namespace,
    media::{kind::MediaKind, wants::PROFILE_REQUIRED},
    metadata::limiter::Priority,
};
use serde_json::Value;

const TMDB_FIELDS: [&str; 6] = [
    "type",
    "tmdbId",
    "qualityProfileId",
    "languageProfileId",
    "libraryId",
    "folderId",
];
const MEDIA_FIELDS: [&str; 8] = [
    "type",
    "externalId",
    "provider",
    "qualityProfileId",
    "languageProfileId",
    "libraryId",
    "folderId",
    "monitoredSeasons",
];
struct Common {
    media_type: MediaKind,
    quality: Option<i32>,
    language: Option<i32>,
    library: Option<i32>,
    folder: Option<i32>,
}

fn common(b: &Body) -> Result<Common, AppError> {
    let media_type = b.required_kind("type")?;
    if !media_type.is_video() {
        return Err(AppError::bad_request(format!(
            "tmdb does not support {media_type}"
        )));
    }
    let quality = b.id("qualityProfileId")?.flatten();
    if quality.is_none() {
        return Err(AppError::bad_request(vec![PROFILE_REQUIRED]));
    }
    Ok(Common {
        media_type,
        quality,
        language: b.id("languageProfileId")?.flatten(),
        library: b.id("libraryId")?.flatten(),
        folder: b.id("folderId")?.flatten(),
    })
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
    crate::profiles::resolve_quality_profile_id_for_import(&st.db, c.quality, None).await?;
    let tmdb = b.required(b.id("tmdbId")?, "tmdbId", "must be an integer number")?;
    st.metadata.require(&st.namespaces(), None)?;
    duplicate_ref(&st, c.media_type, Namespace::TMDB, &tmdb.to_string()).await?;
    let target = resolve_target(&st, &a, c.media_type, c.library, c.folder).await?;
    let id = create_identified(
        &st,
        &Creation {
            kind: c.media_type,
            id: (Namespace::TMDB, &tmdb.to_string()),
            target: &target,
            profiles: (c.quality, c.language),
            user: Some(a.user.id),
            links: vec![],
            seasons: None,
            wants: None,
            prio: Priority::Interactive,
        },
    )
    .await?;
    search_added(&st, id).await;
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
    if v.get("type").and_then(Value::as_str) == Some(MediaKind::Book.as_str()) {
        return service::book_import::import_book(&st, &a, v).await;
    }
    if v.get("type").and_then(Value::as_str) == Some(MediaKind::Album.as_str()) {
        return service::album_import::import_album(&st, &a, v).await;
    }
    if v.get("type").and_then(Value::as_str) == Some(MediaKind::Comic.as_str()) {
        return service::comic_import::import_comic(&st, &a, v).await;
    }
    let b = Body::new(v, &MEDIA_FIELDS)?;
    let c = common(&b)?;
    crate::profiles::resolve_quality_profile_id_for_import(&st.db, c.quality, None).await?;
    let external = b.required(b.str("externalId")?, "externalId", "must be a string")?;
    let known = st.namespaces();
    let plugin =
        b.0.get("provider")
            .and_then(Value::as_str)
            .and_then(|p| known.parse(p))
            .filter(|p| p.core().is_none());
    let provider = match plugin {
        Some(p) => Some(p.as_str().to_owned()),
        None => b.one_of("provider", &["tmdb", "tvdb"])?.flatten(),
    };
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
    let external = match plugin {
        Some(p) => {
            let id = known.normalize(p, &external).ok_or_else(|| {
                AppError::bad_request(vec![format!("externalId is not a {} id", p.as_str())])
            })?;
            duplicate_ref(&st, c.media_type, p, &id).await?;
            id
        }
        None => {
            let n: i32 = external
                .trim()
                .parse()
                .ok()
                .filter(|n| *n > 0)
                .ok_or_else(|| {
                    AppError::bad_request(vec!["externalId must be a number string".to_owned()])
                })?;
            let ns = if provider.as_deref() == Some("tvdb") {
                Namespace::TVDB
            } else {
                Namespace::TMDB
            };
            duplicate_ref(&st, c.media_type, ns, &n.to_string()).await?;
            external
        }
    };
    let target = resolve_target(&st, &a, c.media_type, c.library, c.folder).await?;
    let ns = match plugin {
        Some(p) => p,
        None if provider.as_deref() == Some("tvdb") => Namespace::TVDB,
        None => Namespace::TMDB,
    };
    let id = create_identified(
        &st,
        &Creation {
            kind: c.media_type,
            id: (ns, &external),
            target: &target,
            profiles: (c.quality, c.language),
            user: Some(a.user.id),
            links: vec![],
            seasons,
            wants: None,
            prio: Priority::Interactive,
        },
    )
    .await?;
    search_added(&st, id).await;
    Ok((StatusCode::CREATED, Json(entity_or_404(&st, &a, id).await?)))
}
