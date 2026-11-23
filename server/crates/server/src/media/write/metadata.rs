//! Identify and refresh routes (rules 47-55): the provider reads are in `media::service`.
use super::{entity_or_404, gate};
use crate::ingest::music::identify::Outcome;
use crate::media::{
    external_ids::{self, Ids},
    service::{already_running, body::Body, drop_absent, refresh_any, refresh_any_with},
};
use crate::{
    events::{DomainEvent, SseEvent},
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    images::paths::Target,
    ingest::{MediaRow, load_media, rescan::rescan_files},
    metadata::service,
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use fliks_domain::{
    acl::Action, external_id::Namespace, media::kind::MediaKind, metadata::limiter::Priority,
};
use serde_json::{Value, json};
use sqlx::PgConnection;

async fn finish_identify(
    st: &AppState,
    id: i32,
    changed: bool,
    group: Option<String>,
) -> Result<(i32, String), AppError> {
    let mut id = id;
    if let Some(group) = group {
        // The pick also matches the files to a release of the group (`music.md` rule 41).
        match crate::ingest::music::identify::identify(
            st,
            id,
            Some(&group),
            Priority::Interactive,
            true,
        )
        .await?
        {
            Outcome::Merged(into) => id = into,
            Outcome::Applied => {}
            _ => {
                return Err(AppError::conflict(
                    "No release of this group could be applied to the album",
                ));
            }
        }
    }
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    if let Some(found) = refresh_any_with(st, &media, true, Priority::Interactive, changed).await?
        && media.has_seasons()
    {
        drop_absent(st, id, &found.seasons).await?;
    }
    if media.media_type != MediaKind::Book {
        let guard = st.ingest.media.lock(id).await;
        if let Err(e) = rescan_files(st, &guard, id, false).await {
            tracing::warn!("identify: rescan of media #{id} failed: {e:?}");
        }
    }
    st.hub.emit_domain(DomainEvent::MediaAcquisitionRequested {
        media_ids: vec![i64::from(id)],
        reason: "metadata-refresh".into(),
    });
    Ok((id, media.title))
}

fn settle(
    st: &AppState,
    key: String,
    id: i32,
    old_title: String,
    r: Result<(i32, String), AppError>,
) {
    st.hub.activity().remove(&key);
    match r {
        Ok((id, title)) => st.hub.emit(SseEvent::MetadataRefreshed {
            media_id: i64::from(id),
            title,
        }),
        Err(e) => {
            tracing::error!("metadata of media #{id} failed: {e:?}");
            st.hub.emit(SseEvent::MetadataFailed {
                media_id: i64::from(id),
                title: old_title,
                error: e.text(),
            });
        }
    }
}

/// `GET /api/media/:id/music/candidates`: the releases the files of an album may be (`music.md` rule 33).
#[utoipa::path(get, path = "/api/media/{id}/music/candidates", responses((status = 200)))]
pub async fn album_candidates(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Json<Value>, AppError> {
    let id = gate(&st, &a, Action::Update, id).await?;
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    if media.media_type != MediaKind::Album {
        return Err(AppError::bad_request("Candidates are read for an album"));
    }
    let list = crate::ingest::music::identify::candidates(&st, id).await?;
    Ok(Json(
        serde_json::to_value(list).map_err(|e| AppError::internal(e.to_string()))?,
    ))
}

/// `POST /api/media/:id/identify` (rules 47-50).
#[utoipa::path(post, path = "/api/media/{id}/identify", responses((status = 201)))]
pub async fn identify(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let id = gate(&st, &a, Action::Update, id).await?;
    let b = Body::new(
        v,
        &[
            "tmdbId",
            "tvdbId",
            "imdbId",
            "preferredProvider",
            "provider",
            "externalId",
        ],
    )?;
    let (mut tmdb, mut tvdb) = (b.id("tmdbId")?.flatten(), b.id("tvdbId")?.flatten());
    let imdb = b.str("imdbId")?.flatten();
    let known = st.namespaces();
    let mut provider = b.namespace("preferredProvider", &known)?;
    let named = (b.str("provider")?.flatten(), b.str("externalId")?.flatten());
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    let mut pin = None;
    match named {
        (Some(_), Some(_)) if provider.is_some() => {
            return Err(AppError::bad_request(
                "provider and externalId replace preferredProvider",
            ));
        }
        (Some(p), Some(ext)) => {
            let ns = known
                .parse(&p)
                .filter(|n| st.metadata.answers(*n) && st.metadata.serves(*n, media.media_type))
                .ok_or_else(|| AppError::bad_request(format!("Unknown provider: {p}")))?;
            let value = known
                .normalize(ns, ext.trim())
                .ok_or_else(|| AppError::bad_request(format!("Invalid id for provider: {p}")))?;
            match ns {
                Namespace::TMDB | Namespace::TVDB => {
                    let slot = if ns == Namespace::TMDB {
                        &mut tmdb
                    } else {
                        &mut tvdb
                    };
                    let id = value.parse().ok();
                    if slot.is_some() && *slot != id {
                        return Err(AppError::bad_request(format!(
                            "externalId contradicts {}",
                            ns.as_str()
                        )));
                    }
                    *slot = id;
                }
                _ => {
                    provider = Some(Some(p));
                    pin = Some((ns, value));
                }
            }
        }
        (None, None) => {}
        _ => {
            return Err(AppError::bad_request("provider and externalId go together"));
        }
    }
    if media.media_type == MediaKind::Comic && pin.is_none() {
        return Err(AppError::bad_request(
            "Provide the id of a comic provider (provider and externalId) to identify this media against",
        ));
    }
    if media.media_type == MediaKind::Album {
        let Some((ns, value)) = &pin else {
            return Err(AppError::bad_request(
                "Provide the id of an album provider (provider and externalId) to identify this media against",
            ));
        };
        let other = match *ns == Namespace::MUSICBRAINZ {
            true => crate::metadata::music::aliases::album_of(&st.db, value).await?,
            false => external_ids::find(&st.db, MediaKind::Album, *ns, value).await?,
        }
        .filter(|o| *o != id);
        if let Some(o) = other {
            return Err(AppError::conflict(format!(
                "Album #{o} already uses this {} id",
                known.label(*ns)
            )));
        }
    }
    let key = format!("Identify:{id}");
    let subj = crate::events::Subject::media(id, &media.title, Some(media.media_type));
    if !st
        .hub
        .activity()
        .claim(&key, "Identify", Some(subj.clone()), None, None, None)
    {
        return Err(already_running());
    }
    let acl = crate::libraries::accessible_library_ids(&st.db, &a).await?;
    let mut changed = false;
    let group = (media.media_type == MediaKind::Album)
        .then(|| pin.as_ref().filter(|(ns, _)| *ns == Namespace::MUSICBRAINZ))
        .flatten()
        .map(|(_, v)| v.clone());
    let applied = async {
        match (media.media_type, pin) {
            (MediaKind::Book, Some((ns, value))) => {
                crate::metadata::books::routes::identify_to(&st, id, ns, &value, &acl).await?;
            }
            (MediaKind::Book, None) => {
                return Err(AppError::bad_request(
                    "Provide the id of a book provider (provider and externalId) to identify this media against",
                ));
            }
            (_, pin) => {
                changed = apply_identity(&st, &media, (tmdb, tvdb, imdb), pin, provider).await?
            }
        }
        entity_or_404(&st, &a, id).await
    };
    let body = match applied.await {
        Ok(b) => b,
        Err(e) => {
            st.hub.activity().remove(&key);
            return Err(e);
        }
    };
    st.hub.emit(SseEvent::MetadataStarted {
        media_id: i64::from(id),
        title: media.title.clone(),
    });
    st.hub
        .activity()
        .upsert_running(&key, "Identify", Some(subj), None, None, None);
    let st2 = st.clone();
    tokio::spawn(async move {
        let r = finish_identify(&st2, id, changed, group).await;
        settle(&st2, key, id, media.title, r);
    });
    Ok((StatusCode::CREATED, Json(body)))
}

async fn apply_identity(
    st: &AppState,
    media: &MediaRow,
    (tmdb, tvdb, imdb): (Option<i32>, Option<i32>, Option<String>),
    pin: Option<(Namespace, String)>,
    provider: Option<Option<String>>,
) -> Result<bool, AppError> {
    if pin.is_none()
        && tmdb.is_none()
        && tvdb.is_none()
        && imdb.as_deref().is_none_or(str::is_empty)
    {
        return Err(AppError::bad_request(
            "Provide at least one external id to identify this media against",
        ));
    }
    let ids = Ids { tmdb, tvdb, imdb };
    let known = st.namespaces();
    let mut tx = st.db.begin().await?;
    let before = identity(&mut tx, media.id).await?;
    for (p, v) in ids.entries() {
        let Some(v) = v.filter(|_| p.is_unique()) else {
            continue;
        };
        let other = external_ids::find(&mut *tx, media.media_type, p, &v)
            .await?
            .filter(|o| *o != media.id);
        if let Some(o) = other {
            let title = sqlx::query_scalar!("SELECT title FROM media WHERE id = $1", o)
                .fetch_one(&mut *tx)
                .await?;
            return Err(AppError::conflict(format!(
                "\"{title}\" (#{o}) already uses {} id {v} in this library",
                known.label(p)
            )));
        }
    }
    // A new identity: the plugin pins go, and the id of the media pin's namespace with them, unless
    // an explicit pin names it.
    let keep = provider.clone().flatten();
    sqlx::query(
        r#"DELETE FROM media_external_ids
           WHERE "mediaId" = $1 AND provider LIKE '%:%' AND provider IS DISTINCT FROM $2
             AND provider = (SELECT "preferredProvider" FROM media WHERE id = $1)"#,
    )
    .bind(media.id)
    .bind(&keep)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"UPDATE item_groups SET "preferredProvider" = NULL
           WHERE "mediaId" = $1 AND "preferredProvider" LIKE '%:%'
             AND "preferredProvider" IS DISTINCT FROM $2"#,
    )
    .bind(media.id)
    .bind(&keep)
    .execute(&mut *tx)
    .await?;
    let mut written = ids.replace(&mut tx, media.id, media.media_type).await?;
    // An album's MusicBrainz pin is a release group: `identify` links the release it resolves.
    if let Some((ns, v)) = &pin
        && !(media.media_type == MediaKind::Album && *ns == Namespace::MUSICBRAINZ)
        && external_ids::link(&mut tx, &known, media.id, media.media_type, *ns, v).await?
            == external_ids::Link::Gone
    {
        written.gone = true;
    }
    if written.gone {
        return Err(crate::libraries::media_not_found(media.id));
    }
    if let Some(p) = written.taken.first() {
        return Err(AppError::conflict(format!(
            "Another title already uses this {} id in this library",
            known.label(*p)
        )));
    }
    sqlx::query!(
        r#"UPDATE media SET "preferredProvider" = CASE WHEN $2 THEN $3
             WHEN "preferredProvider" LIKE '%:%' THEN NULL ELSE "preferredProvider" END
           WHERE id = $1"#,
        media.id,
        provider.is_some(),
        provider.flatten()
    )
    .execute(&mut *tx)
    .await?;
    let changed = identity(&mut tx, media.id).await? != before;
    tx.commit().await?;
    Ok(changed)
}

/// The ids, the media pin and the season pins that make up a media's identity.
async fn identity(c: &mut PgConnection, id: i32) -> Result<Identity, AppError> {
    let ids = external_ids::refs(&mut *c, id)
        .await?
        .into_iter()
        .map(|e| (e.provider, e.value))
        .collect();
    let pin = sqlx::query_scalar(r#"SELECT "preferredProvider" FROM media WHERE id = $1"#)
        .bind(id)
        .fetch_optional(&mut *c)
        .await?
        .flatten();
    let seasons = sqlx::query_scalar(
        r#"SELECT "preferredProvider" FROM item_groups WHERE "mediaId" = $1 ORDER BY id"#,
    )
    .bind(id)
    .fetch_all(&mut *c)
    .await?;
    Ok((ids, pin, seasons))
}

type Identity = (Vec<(String, String)>, Option<String>, Vec<Option<String>>);

/// `POST /api/media/:id/refresh` (rule 52): `metadata.started` goes out before the claim.
#[utoipa::path(post, path = "/api/media/{id}/refresh", responses((status = 201)))]
pub async fn refresh(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let id = gate(&st, &a, Action::Update, id).await?;
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    st.hub.emit(SseEvent::MetadataStarted {
        media_id: i64::from(id),
        title: media.title.clone(),
    });
    let key = format!("RefreshMetadata:{id}");
    let subj = crate::events::Subject::media(id, &media.title, Some(media.media_type));
    if !st
        .hub
        .activity()
        .claim(&key, "RefreshMetadata", Some(subj), None, None, None)
    {
        return Err(already_running());
    }
    let st2 = st.clone();
    tokio::spawn(async move {
        let title = media.title.clone();
        let r = refresh_any(&st2, &media, false, Priority::Interactive)
            .await
            .map(|_| (id, title));
        settle(&st2, key, id, media.title, r);
    });
    Ok((StatusCode::CREATED, Json(json!({"ok": true}))))
}

/// `POST /api/media/:id/episodes/:episodeId/refresh` (rules 54-55: the episode is under `:id`).
#[utoipa::path(post, path = "/api/media/{id}/episodes/{episodeId}/refresh", responses((status = 201)))]
pub async fn refresh_episode(
    State(st): State<AppState>,
    a: Authed,
    ids: Result<PathParams<(i32, i32)>, AppError>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Update, fliks_domain::acl::Subject::Media)?;
    let PathParams((id, episode)) = ids?;
    let libs = crate::libraries::accessible_library_ids(&st.db, &a).await?;
    crate::libraries::assert_media_accessible(&st.db, id, &libs).await?;
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    if crate::ingest::library::episode_of_media(&st.db, id, episode)
        .await?
        .is_none()
    {
        return Err(AppError::not_found(format!("Episode #{episode} not found")));
    }
    st.hub.emit(SseEvent::MetadataStarted {
        media_id: i64::from(id),
        title: media.title.clone(),
    });
    let key = format!("RefreshEpisodeMetadata:{episode}");
    let subj = crate::events::Subject::media(id, &media.title, Some(media.media_type));
    if !st
        .hub
        .activity()
        .claim(&key, "RefreshEpisodeMetadata", Some(subj), None, None, None)
    {
        return Err(already_running());
    }
    let st2 = st.clone();
    tokio::spawn(async move {
        let r = refresh_one_episode(&st2, episode)
            .await
            .map(|()| (id, media.title.clone()));
        settle(&st2, key, id, media.title, r);
    });
    Ok((StatusCode::CREATED, Json(json!({"ok": true}))))
}

async fn refresh_one_episode(st: &AppState, episode: i32) -> Result<(), AppError> {
    let Some(ep) = service::episode(st, episode, Priority::Interactive).await? else {
        return Ok(());
    };
    sqlx::query!(
        r#"UPDATE items SET title = COALESCE($2, title), overview = COALESCE($3, overview),
             "airDate" = COALESCE($4::text::date, "airDate"), runtime = COALESCE($5, runtime)
           WHERE id = $1 AND (title IS DISTINCT FROM COALESCE($2, title)
             OR overview IS DISTINCT FROM COALESCE($3, overview)
             OR "airDate" IS DISTINCT FROM COALESCE($4::text::date, "airDate")
             OR runtime IS DISTINCT FROM COALESCE($5, runtime))"#,
        episode,
        Some(ep.title.clone()).filter(|t| !t.is_empty()),
        ep.overview.clone().filter(|o| !o.is_empty()),
        ep.air_date.clone().filter(|a| !a.is_empty()),
        ep.runtime
    )
    .execute(&st.db)
    .await?;
    if let Some(s) = ep.still_url.filter(|s| !s.is_empty())
        && let Some(local) = st
            .images
            .download_and_store(&s, &Target::episode(episode))
            .await
    {
        sqlx::query!(
            r#"UPDATE items SET "stillUrl" = $2 WHERE id = $1"#,
            episode,
            local
        )
        .execute(&st.db)
        .await?;
    }
    Ok(())
}
