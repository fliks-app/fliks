//! Identify and refresh (rules 46-58): provider data from the metadata service, rows written here.
use super::{already_running, body::Body, entity_or_404, gate, subject};
use crate::media::items;
use crate::{
    events::{DomainEvent, SseEvent},
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    images::paths::{Target, Variant},
    ingest::{MediaRow, load_media, rescan::rescan_files},
    media::external_ids::{self, Ids},
    metadata::service::{self, Details, EpisodeDetails, Found, SeasonDetails},
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use fliks_domain::acl::Action;
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::collections::HashSet;

/// `downloadMediaImages` (rule 58): local URLs replace the provider's when the store succeeded.
pub async fn download_media_images(st: &AppState, id: i32, d: &Details) {
    let one = async |url: &Option<String>, v: Variant| match url {
        Some(u) if !u.is_empty() => st.images.download_and_store(u, &Target::media(id, v)).await,
        _ => None,
    };
    let poster = one(&d.poster_url, Variant::Poster).await;
    let fanart = one(&d.fanart_url, Variant::Fanart).await;
    let logo = one(&d.logo_url, Variant::Logo).await;
    let mut extra = vec![];
    for (i, u) in d.additional_fanart_urls.iter().enumerate() {
        let t = Target::media(id, Variant::FanartN(i as u32 + 1));
        if let Some(l) = st.images.download_and_store(u, &t).await {
            extra.push(l);
        }
    }
    if let Err(e) = sqlx::query!(
        r#"UPDATE media SET "posterUrl" = COALESCE($2, "posterUrl"), "fanartUrl" = COALESCE($3, "fanartUrl"),
             "logoUrl" = COALESCE($4, "logoUrl"), "additionalFanartUrls" = $5 WHERE id = $1"#,
        id,
        poster,
        fanart,
        logo,
        &extra
    )
    .execute(&st.db)
    .await
    {
        tracing::warn!("images of media #{id}: {e}");
    }
}

/// Episode stills (concurrency 1 here; the store serialises anyway) and the season poster.
pub async fn download_season_images(
    st: &AppState,
    season: i32,
    stills: Vec<(i32, String)>,
    poster: Option<String>,
) {
    for (ep, url) in stills {
        if let Some(local) = st
            .images
            .download_and_store(&url, &Target::episode(ep))
            .await
            && let Err(e) = sqlx::query!(
                r#"UPDATE items SET "stillUrl" = $2 WHERE id = $1"#,
                ep,
                local
            )
            .execute(&st.db)
            .await
        {
            tracing::warn!("still of episode #{ep}: {e}");
        }
    }
    if let Some(p) = poster.filter(|p| !p.is_empty())
        && let Some(local) = st
            .images
            .download_and_store(&p, &Target::season(season))
            .await
        && let Err(e) = sqlx::query!(
            r#"UPDATE item_groups SET "posterUrl" = $2 WHERE id = $1"#,
            season,
            local
        )
        .execute(&st.db)
        .await
    {
        tracing::warn!("poster of season #{season}: {e}");
    }
}

fn day(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(10).collect())
}

/// `applySeasonDetails` without the images: returns the episodes whose still is to be fetched.
pub async fn apply_season(
    c: &mut PgConnection,
    sid: i32,
    sd: &SeasonDetails,
) -> Result<Vec<(i32, String)>, sqlx::Error> {
    sqlx::query!(
        r#"UPDATE item_groups SET overview = COALESCE($2, overview), "airDate" = COALESCE($3, "airDate")
           WHERE id = $1 AND (overview IS DISTINCT FROM COALESCE($2, overview)
             OR "airDate" IS DISTINCT FROM COALESCE($3, "airDate"))"#,
        sid,
        sd.overview.clone().filter(|o| !o.is_empty()),
        day(&sd.air_date)
    )
    .execute(&mut *c)
    .await?;
    // One row per episode number, the last listing wins.
    let mut by_number = std::collections::BTreeMap::new();
    for ep in &sd.episodes {
        by_number.insert(ep.episode_number, ep);
    }
    let eps: Vec<&EpisodeDetails> = by_number.into_values().collect();
    let numbers: Vec<i32> = eps.iter().map(|e| e.episode_number).collect();
    let titles: Vec<Option<String>> = eps
        .iter()
        .map(|e| Some(e.title.clone()).filter(|t| !t.is_empty()))
        .collect();
    let overviews: Vec<Option<String>> = eps
        .iter()
        .map(|e| e.overview.clone().filter(|o| !o.is_empty()))
        .collect();
    let airs: Vec<Option<String>> = eps
        .iter()
        .map(|e| e.air_date.clone().filter(|a| !a.is_empty()))
        .collect();
    let runtimes: Vec<Option<i32>> = eps.iter().map(|e| e.runtime).collect();
    sqlx::query!(
        r#"UPDATE items e SET title = COALESCE(v.title, e.title), overview = COALESCE(v.overview, e.overview),
             "airDate" = COALESCE(v.air::date, e."airDate"), runtime = COALESCE(v.runtime, e.runtime)
           FROM UNNEST($2::int[], $3::text[], $4::text[], $5::text[], $6::int[])
             AS v(n, title, overview, air, runtime)
           WHERE e."groupId" = $1 AND e."number" = v.n
             AND (e.title IS DISTINCT FROM COALESCE(v.title, e.title)
               OR e.overview IS DISTINCT FROM COALESCE(v.overview, e.overview)
               OR e."airDate" IS DISTINCT FROM COALESCE(v.air::date, e."airDate")
               OR e.runtime IS DISTINCT FROM COALESCE(v.runtime, e.runtime))"#,
        sid,
        &numbers,
        &titles as &[Option<String>],
        &overviews as &[Option<String>],
        &airs as &[Option<String>],
        &runtimes as &[Option<i32>]
    )
    .execute(&mut *c)
    .await?;
    let media = sqlx::query_scalar!(r#"SELECT "mediaId" FROM item_groups WHERE id = $1"#, sid)
        .fetch_one(&mut *c)
        .await?;
    let edition = items::video_edition(&mut *c, media).await?;
    sqlx::query!(
        r#"INSERT INTO items ("groupId", "mediaId", "editionId", "number", title, overview, "airDate", runtime, monitored)
           SELECT $1, $7, $8, v.n, v.title, v.overview, v.air::date, v.runtime, true
           FROM UNNEST($2::int[], $3::text[], $4::text[], $5::text[], $6::int[])
             AS v(n, title, overview, air, runtime)
           WHERE NOT EXISTS (SELECT 1 FROM items e WHERE e."groupId" = $1 AND e."number" = v.n)"#,
        sid,
        &numbers,
        &titles as &[Option<String>],
        &overviews as &[Option<String>],
        &airs as &[Option<String>],
        &runtimes as &[Option<i32>],
        media,
        edition
    )
    .execute(&mut *c)
    .await?;
    let ids: std::collections::HashMap<i32, i32> = sqlx::query!(
        r#"SELECT min(id) AS "id!", "number" AS "n!" FROM items
           WHERE "groupId" = $1 AND "number" = ANY($2) GROUP BY "number""#,
        sid,
        &numbers
    )
    .fetch_all(&mut *c)
    .await?
    .into_iter()
    .map(|r| (r.n, r.id))
    .collect();
    Ok(eps
        .iter()
        .filter_map(|e| {
            let still = e.still_url.clone().filter(|s| !s.is_empty())?;
            Some((*ids.get(&e.episode_number)?, still))
        })
        .collect())
}

/// `refreshSeriesEpisodes` applied to provider seasons (rule 56); returns the inserted episode count.
async fn apply_seasons(
    st: &AppState,
    media_id: i32,
    seasons: &[SeasonDetails],
) -> Result<i64, AppError> {
    let before: i64 = count_episodes(st, media_id).await?;
    let mut tx = st.db.begin().await?;
    let mut applied = vec![];
    for sd in seasons {
        let n = sd.season_number;
        let sid = match sqlx::query_scalar!(
            r#"SELECT id FROM item_groups WHERE "mediaId" = $1 AND "number" = $2 ORDER BY id LIMIT 1"#,
            media_id,
            n
        )
        .fetch_optional(&mut *tx)
        .await?
        {
            Some(id) => id,
            None => {
                sqlx::query_scalar!(
                    r#"INSERT INTO item_groups ("mediaId", "number", monitored) VALUES ($1, $2, $3) RETURNING id"#,
                    media_id,
                    n,
                    n > 0
                )
                .fetch_one(&mut *tx)
                .await?
            }
        };
        let stills = apply_season(&mut tx, sid, sd).await?;
        let live: HashSet<i32> = sd.episodes.iter().map(|e| e.episode_number).collect();
        if !live.is_empty() {
            let listed: Vec<i32> = live.into_iter().collect();
            sqlx::query!(
                r#"DELETE FROM items WHERE "groupId" = $1 AND NOT ("number" = ANY($2))"#,
                sid,
                &listed
            )
            .execute(&mut *tx)
            .await?;
        }
        applied.push((sid, stills, sd.poster_url.clone()));
    }
    tx.commit().await?;
    let inserted = (count_episodes(st, media_id).await? - before).max(0);
    for (sid, stills, poster) in applied {
        download_season_images(st, sid, stills, poster).await;
    }
    Ok(inserted)
}

async fn count_episodes(st: &AppState, media_id: i32) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM items e JOIN item_groups s ON s.id = e."groupId" WHERE s."mediaId" = $1"#,
        media_id
    )
    .fetch_one(&st.db)
    .await
}

/// Rescan and relink entry point: the bare rows a walk invented gain titles and stills.
pub async fn refresh_series_episodes(st: &AppState, media: &MediaRow) -> Result<i64, AppError> {
    let seasons = service::seasons_for_media(st, media.id).await?;
    apply_seasons(st, media.id, &seasons).await
}

/// `refreshMetadata` (rule 53).
pub async fn refresh_metadata(st: &AppState, id: i32, defer_kick: bool) -> Result<Found, AppError> {
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    let found = service::for_media(st, id).await?;
    let d = &found.details;
    sqlx::query!(
        r#"UPDATE media SET title = $2, "originalTitle" = $3, "alternativeTitles" = $4,
             year = COALESCE($5, year), overview = COALESCE($6, overview),
             status = $7::text::media_status_enum, "posterUrl" = COALESCE($8, "posterUrl"),
             "fanartUrl" = COALESCE($9, "fanartUrl"), "logoUrl" = COALESCE($10, "logoUrl"),
             rating = COALESCE($11, rating), genres = $12, runtime = COALESCE($13, runtime),
             "releaseDate" = COALESCE($14::text::date, "releaseDate"), "inCinemas" = COALESCE($15::text::date, "inCinemas"),
             "digitalRelease" = COALESCE($16::text::date, "digitalRelease"),
             "physicalRelease" = COALESCE($17::text::date, "physicalRelease"),
             "tmdbCollectionId" = $18, "tmdbCollectionName" = $19
           WHERE id = $1"#,
        id,
        d.title,
        d.original_title.clone().unwrap_or_else(|| d.title.clone()),
        json!(d.alternative_titles),
        d.year.filter(|y| y.is_finite()).map(|y| y as i32),
        d.overview,
        super::map_status(media.media_type, &d.status),
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
        d.tmdb_collection_name
    )
    .execute(&st.db)
    .await?;
    let ids = Ids {
        tmdb: d.tmdb_id,
        tvdb: d.tvdb_id,
        imdb: d.imdb_id.clone(),
    };
    let written = ids
        .fill(&mut *st.db.acquire().await?, id, media.media_type)
        .await?;
    if written.gone {
        return Err(crate::libraries::media_not_found(id));
    }
    for p in written.taken {
        tracing::warn!(
            "refresh of \"{}\" (#{id}): the {p} id belongs to another title",
            media.title
        );
    }
    download_media_images(st, id, d).await;
    service::persist_credits(st, id, d).await?;
    if media.has_seasons() {
        let inserted = apply_seasons(st, id, &found.seasons).await?;
        if inserted > 0 && !defer_kick {
            st.hub.emit_domain(DomainEvent::MediaAcquisitionRequested {
                media_ids: vec![i64::from(id)],
                reason: "metadata-refresh".into(),
            });
        }
    }
    sqlx::query!(
        r#"UPDATE media SET "metadataRefreshedAt" = now() WHERE id = $1"#,
        id
    )
    .execute(&st.db)
    .await?;
    Ok(found)
}

/// Rule 51: seasons the provider no longer lists; an empty list drops nothing; files survive.
async fn drop_absent(st: &AppState, id: i32, found: &Found) -> Result<(), sqlx::Error> {
    if found.seasons.is_empty() {
        return Ok(());
    }
    let live: Vec<i32> = found.seasons.iter().map(|s| s.season_number).collect();
    sqlx::query!(
        r#"DELETE FROM item_groups WHERE "mediaId" = $1 AND NOT ("number" = ANY($2))"#,
        id,
        &live
    )
    .execute(&st.db)
    .await?;
    Ok(())
}

async fn finish_identify(st: &AppState, id: i32) -> Result<String, AppError> {
    let found = refresh_metadata(st, id, true).await?;
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    if media.has_seasons() {
        drop_absent(st, id, &found).await?;
    }
    let guard = st.ingest.media.lock(id).await;
    if let Err(e) = rescan_files(st, &guard, id).await {
        tracing::warn!("identify: rescan of media #{id} failed: {e:?}");
    }
    drop(guard);
    st.hub.emit_domain(DomainEvent::MediaAcquisitionRequested {
        media_ids: vec![i64::from(id)],
        reason: "metadata-refresh".into(),
    });
    Ok(media.title)
}

fn settle(st: &AppState, key: String, id: i32, old_title: String, r: Result<String, AppError>) {
    st.hub.activity().remove(&key);
    match r {
        Ok(title) => st.hub.emit(SseEvent::MetadataRefreshed {
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

/// `POST /api/media/:id/identify` (rules 47-50).
#[utoipa::path(post, path = "/api/media/{id}/identify", responses((status = 201)))]
pub async fn identify(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let id = gate(&st, &a, Action::Update, id).await?;
    let b = Body::new(v, &["tmdbId", "tvdbId", "imdbId", "preferredProvider"])?;
    let (tmdb, tvdb) = (b.id("tmdbId")?.flatten(), b.id("tvdbId")?.flatten());
    let imdb = b.str("imdbId")?.flatten();
    let provider = b.one_of("preferredProvider", &["tmdb", "tvdb"])?;
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    let key = format!("Identify:{id}");
    let subj = subject(id, &media.title, media.media_type);
    if !st
        .hub
        .activity()
        .claim(&key, "Identify", Some(subj.clone()), None, None, None)
    {
        return Err(already_running());
    }
    let applied = async {
        apply_identity(&st, &media, tmdb, tvdb, imdb, provider).await?;
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
        let r = finish_identify(&st2, id).await;
        settle(&st2, key, id, media.title, r);
    });
    Ok((StatusCode::CREATED, Json(body)))
}

async fn apply_identity(
    st: &AppState,
    media: &MediaRow,
    tmdb: Option<i32>,
    tvdb: Option<i32>,
    imdb: Option<String>,
    provider: Option<Option<String>>,
) -> Result<(), AppError> {
    if tmdb.is_none() && tvdb.is_none() && imdb.as_deref().is_none_or(str::is_empty) {
        return Err(AppError::bad_request(
            "Provide at least one external id to identify this media against",
        ));
    }
    let ids = Ids { tmdb, tvdb, imdb };
    let mut tx = st.db.begin().await?;
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
                p.label()
            )));
        }
    }
    let written = ids.replace(&mut tx, media.id, media.media_type).await?;
    if written.gone {
        return Err(crate::libraries::media_not_found(media.id));
    }
    if let Some(p) = written.taken.first() {
        return Err(AppError::conflict(format!(
            "Another title already uses this {} id in this library",
            p.label()
        )));
    }
    sqlx::query!(
        r#"UPDATE media SET "preferredProvider" = CASE WHEN $2 THEN $3 ELSE "preferredProvider" END
           WHERE id = $1"#,
        media.id,
        provider.is_some(),
        provider.flatten()
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

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
    let subj = subject(id, &media.title, media.media_type);
    if !st
        .hub
        .activity()
        .claim(&key, "RefreshMetadata", Some(subj), None, None, None)
    {
        return Err(already_running());
    }
    let st2 = st.clone();
    tokio::spawn(async move {
        let r = refresh_metadata(&st2, id, false)
            .await
            .map(|_| media.title.clone());
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
    let subj = subject(id, &media.title, media.media_type);
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
            .map(|()| media.title.clone());
        settle(&st2, key, id, media.title, r);
    });
    Ok((StatusCode::CREATED, Json(json!({"ok": true}))))
}

async fn refresh_one_episode(st: &AppState, episode: i32) -> Result<(), AppError> {
    let Some(ep) = service::episode(st, episode).await? else {
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
