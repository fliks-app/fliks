//! Identify and refresh (rules 46-58): provider data from the metadata service, rows written here.
use super::{
    already_running,
    body::Body,
    entity_or_404,
    fields::{Fields, apply, merge_unmatched},
    gate,
};
use crate::media::{
    details::{set_release_dates, set_tmdb_collection},
    field_sources::merge_field_sources,
    items,
};
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
use fliks_domain::{
    acl::Action,
    external_id::Namespace,
    media::{kind::MediaKind, release::ReleaseKind},
    metadata::{field::Field, limiter::Priority},
};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use std::collections::HashSet;

/// `downloadMediaImages` (rule 58): local URLs replace the provider's when the store succeeded.
pub async fn download_media_images(st: &AppState, id: i32, d: &Details, locked: &[Field]) {
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
             "logoUrl" = COALESCE($4, "logoUrl"), "additionalFanartUrls" = COALESCE($5, "additionalFanartUrls")
           WHERE id = $1"#,
        id,
        poster,
        fanart,
        logo,
        (!locked.contains(&Field::FanartUrl)).then_some(&extra[..])
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
pub(crate) async fn apply_seasons(
    st: &AppState,
    media_id: i32,
    seasons: &[SeasonDetails],
) -> Result<i64, AppError> {
    let before: i64 = count_episodes(st, media_id).await?;
    let mut tx = st.db.begin().await?;
    crate::media::items::lock_versions(&mut tx, media_id).await?;
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
            let gone = sqlx::query_scalar!(
                r#"SELECT id FROM items WHERE "groupId" = $1 AND NOT ("number" = ANY($2))"#,
                sid,
                &listed
            )
            .fetch_all(&mut *tx)
            .await?;
            crate::party::end_playing_items(st, &gone).await?;
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
    crate::media::items::cover_ranges(&mut tx, media_id).await?;
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
pub async fn refresh_series_episodes(
    st: &AppState,
    media: &MediaRow,
    prio: Priority,
) -> Result<i64, AppError> {
    let seasons = service::seasons_for_media(st, media.id, prio).await?;
    apply_seasons(st, media.id, &seasons).await
}

/// `refreshMetadata` (rule 53).
pub async fn refresh_metadata(
    st: &AppState,
    id: i32,
    defer_kick: bool,
    prio: Priority,
) -> Result<Found, AppError> {
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    let found = service::for_media(st, id, prio).await?;
    let d = &found.details;
    let free = |f: Field| !found.locked.contains(&f);
    let mut fields = Fields::from_map(media.media_type, d.raw.as_object().unwrap_or(&Map::new()));
    if fields.original_title.is_none() && free(Field::OriginalTitle) && free(Field::Title) {
        fields.original_title = fields.title.clone();
    }
    let mut tx = st.db.begin().await?;
    apply(&mut tx, id, &fields).await?;
    set_release_dates(
        &mut tx,
        id,
        &[
            (ReleaseKind::Release, day(&d.release_date)),
            (ReleaseKind::Cinema, day(&d.in_cinemas)),
            (ReleaseKind::Digital, day(&d.digital_release)),
            (ReleaseKind::Physical, day(&d.physical_release)),
        ],
        true,
    )
    .await?;
    if free(Field::Collection) {
        set_tmdb_collection(&mut tx, id, d.tmdb_collection()).await?;
    }
    merge_field_sources(&mut tx, id, &found.provenance).await?;
    tx.commit().await?;
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
    download_media_images(st, id, d, &found.locked).await;
    service::persist_credits(st, id, media.media_type, found.provider.0, d, &found.locked).await?;
    if media.has_seasons() {
        let inserted = apply_seasons(st, id, &found.seasons).await?;
        if inserted > 0 && !defer_kick {
            st.hub.emit_domain(DomainEvent::MediaAcquisitionRequested {
                media_ids: vec![i64::from(id)],
                reason: "metadata-refresh".into(),
            });
        }
    }
    Ok(found)
}

/// Rule 51: seasons the provider no longer lists; an empty list drops nothing; files survive.
async fn drop_absent(st: &AppState, id: i32, found: &Found) -> Result<(), sqlx::Error> {
    if found.seasons.is_empty() {
        return Ok(());
    }
    let live: Vec<i32> = found.seasons.iter().map(|s| s.season_number).collect();
    let gone = sqlx::query_scalar!(
        r#"SELECT i.id FROM items i JOIN item_groups g ON g.id = i."groupId"
           WHERE g."mediaId" = $1 AND NOT (g."number" = ANY($2))"#,
        id,
        &live
    )
    .fetch_all(&st.db)
    .await?;
    crate::party::end_playing_items(st, &gone).await?;
    sqlx::query!(
        r#"DELETE FROM item_groups WHERE "mediaId" = $1 AND NOT ("number" = ANY($2))"#,
        id,
        &live
    )
    .execute(&st.db)
    .await?;
    Ok(())
}

/// Reads a media again from its provider ids and its files, whatever its kind (`media-write.md`
/// rule 109); the `Found` of a video read from a provider.
pub(crate) async fn refresh_any(
    st: &AppState,
    media: &MediaRow,
    defer_kick: bool,
    prio: Priority,
) -> Result<Option<Found>, AppError> {
    let id = media.id;
    match media.media_type {
        MediaKind::Comic => {
            crate::metadata::comics::refresh(st, id, prio).await?;
        }
        MediaKind::Book => {
            crate::ingest::books::refresh_media(st, id, prio)
                .await
                .map_err(|e| match e.retry {
                    true => AppError::with_message(StatusCode::SERVICE_UNAVAILABLE, e.cause),
                    false => AppError::internal(e.cause),
                })?;
        }
        _ if !external_ids::any(&st.db, id).await? => {
            merge_unmatched(st, id).await?;
        }
        _ => {
            return Ok(Some(refresh_metadata(st, id, defer_kick, prio).await?));
        }
    }
    Ok(None)
}

async fn finish_identify(st: &AppState, id: i32) -> Result<String, AppError> {
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    if let Some(found) = refresh_any(st, &media, true, Priority::Interactive).await?
        && media.has_seasons()
    {
        drop_absent(st, id, &found).await?;
    }
    if media.media_type != MediaKind::Book {
        let guard = st.ingest.media.lock(id).await;
        if let Err(e) = rescan_files(st, &guard, id).await {
            tracing::warn!("identify: rescan of media #{id} failed: {e:?}");
        }
    }
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
    let mut provider = b.namespace("preferredProvider", &st.namespaces())?;
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
            let known = st.namespaces();
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
            (_, pin) => apply_identity(&st, &media, (tmdb, tvdb, imdb), pin, provider).await?,
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
        let r = finish_identify(&st2, id).await;
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
) -> Result<(), AppError> {
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
                st.namespaces().label(p)
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
    if let Some((ns, v)) = &pin
        && external_ids::link(
            &mut tx,
            &st.namespaces(),
            media.id,
            media.media_type,
            *ns,
            v,
        )
        .await?
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
            st.namespaces().label(*p)
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
            .map(|_| title);
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
            .map(|()| media.title.clone());
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
