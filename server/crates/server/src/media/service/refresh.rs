//! Provider refresh (rules 51-58): provider data from the metadata service, rows written here.
use super::fields::{Fields, apply, merge_unmatched};
use crate::media::{
    details::{drop_details, set_release_dates, set_tmdb_collection},
    field_sources::merge_field_sources,
    items,
};
use crate::{
    events::DomainEvent,
    http::AppError,
    images::paths::{Target, Variant},
    ingest::{MediaRow, load_media},
    media::external_ids::{self, Ids},
    metadata::service::{self, Details, EpisodeDetails, Found, SeasonDetails},
    state::AppState,
};
use axum::http::StatusCode;
use fliks_domain::{
    external_id::Namespace,
    media::{kind::MediaKind, release::ReleaseKind},
    metadata::{field::Field, limiter::Priority},
};
use serde_json::Map;
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
        r#"UPDATE item_groups SET overview = COALESCE($2, overview), "airDate" = COALESCE($3::text::date, "airDate")
           WHERE id = $1 AND (overview IS DISTINCT FROM COALESCE($2, overview)
             OR "airDate" IS DISTINCT FROM COALESCE($3::text::date, "airDate"))"#,
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
           SELECT $1, $7, $8, v.n, v.title, v.overview, v.air::date, v.runtime, g.monitored
           FROM item_groups g, UNNEST($2::int[], $3::text[], $4::text[], $5::text[], $6::int[])
             AS v(n, title, overview, air, runtime)
           WHERE g.id = $1 AND NOT EXISTS (SELECT 1 FROM items e WHERE e."groupId" = $1 AND e."number" = v.n)
           ON CONFLICT ("groupId", "number") DO NOTHING"#,
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
        r#"SELECT id, "number" AS "n!" FROM items WHERE "groupId" = $1 AND "number" = ANY($2)"#,
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
    reset: bool,
) -> Result<i64, AppError> {
    let before: i64 = count_episodes(st, media_id).await?;
    let flag = super::monitored::media_flag(&st.db, media_id).await?;
    let mut tx = st.db.begin().await?;
    crate::media::items::lock_versions(&mut tx, media_id).await?;
    if reset {
        clear_season_values(&mut tx, media_id).await?;
    }
    let mut applied = vec![];
    for sd in seasons {
        let n = sd.season_number;
        let (sid, _) = items::ensure_group(&mut tx, media_id, n).await?;
        let stills = apply_season(&mut tx, sid, sd).await?;
        let live: HashSet<i32> = sd.episodes.iter().map(|e| e.episode_number).collect();
        if !live.is_empty() {
            let listed: Vec<i32> = live.into_iter().collect();
            let gone: Vec<i32> = sqlx::query_scalar!(
                r#"SELECT id FROM items WHERE "groupId" = $1 AND NOT ("number" = ANY($2))"#,
                sid,
                &listed
            )
            .fetch_all(&mut *tx)
            .await?;
            drop_unheld(st, &mut tx, &gone).await?;
        }
        applied.push((sid, stills, sd.poster_url.clone()));
    }
    crate::media::items::cover_ranges(&mut tx, media_id).await?;
    tx.commit().await?;
    super::monitored::announce_flip(st, media_id, flag).await?;
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
    apply_seasons(st, media.id, &seasons, false).await
}

/// `refreshMetadata` (rule 53).
pub async fn refresh_metadata(
    st: &AppState,
    id: i32,
    defer_kick: bool,
    prio: Priority,
) -> Result<Found, AppError> {
    refresh_metadata_with(st, id, defer_kick, prio, false).await
}

async fn refresh_metadata_with(
    st: &AppState,
    id: i32,
    defer_kick: bool,
    prio: Priority,
    reset: bool,
) -> Result<Found, AppError> {
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    let found = match service::for_media(st, id, prio).await {
        Ok(f) => f,
        Err(e) => {
            if reset {
                // The old identity's values are wrong for the new title: leave them empty.
                let mut tx = st.db.begin().await?;
                clear_provider_values(&mut tx, &media).await?;
                tx.commit().await?;
            }
            return Err(e);
        }
    };
    let d = &found.details;
    let free = |f: Field| !found.locked.contains(&f);
    let mut fields = Fields::from_map(media.media_type, d.raw.as_object().unwrap_or(&Map::new()));
    if fields.original_title.is_none() && free(Field::OriginalTitle) && free(Field::Title) {
        fields.original_title = fields.title.clone();
    }
    let mut tx = st.db.begin().await?;
    if reset {
        clear_media_values(&mut tx, id).await?;
    }
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
        let inserted = match apply_seasons(st, id, &found.seasons, reset).await {
            Ok(n) => n,
            Err(e) => {
                if reset {
                    let mut tx = st.db.begin().await?;
                    clear_season_values(&mut tx, id).await?;
                    tx.commit().await?;
                }
                return Err(e);
            }
        };
        if inserted > 0 && !defer_kick {
            st.hub.emit_domain(DomainEvent::MediaAcquisitionRequested {
                media_ids: vec![i64::from(id)],
                reason: "metadata-refresh".into(),
            });
        }
    }
    Ok(found)
}

/// Rule 51: seasons the provider no longer lists; an empty list drops nothing; an item that holds a
/// file stays, and so does its season.
pub(crate) async fn drop_absent(
    st: &AppState,
    id: i32,
    seasons: &[SeasonDetails],
) -> Result<(), sqlx::Error> {
    if seasons.is_empty() {
        return Ok(());
    }
    let live: Vec<i32> = seasons.iter().map(|s| s.season_number).collect();
    let mut tx = st.db.begin().await?;
    items::lock_versions(&mut tx, id).await?;
    let gone: Vec<i32> = sqlx::query_scalar!(
        r#"SELECT i.id FROM items i JOIN item_groups g ON g.id = i."groupId"
           WHERE g."mediaId" = $1 AND NOT (g."number" = ANY($2))"#,
        id,
        &live
    )
    .fetch_all(&mut *tx)
    .await?;
    let held = drop_unheld(st, &mut tx, &gone).await?;
    if held > 0 {
        tracing::warn!("media #{id}: {held} item(s) the provider no longer lists are kept");
    }
    sqlx::query!(
        r#"DELETE FROM item_groups g WHERE g."mediaId" = $1 AND NOT (g."number" = ANY($2))
             AND NOT EXISTS (SELECT 1 FROM items i WHERE i."groupId" = g.id)"#,
        id,
        &live
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

/// Deletes the `candidates` nobody holds and returns how many stay: an item with a file or a row of
/// a user stays, unmonitored when it has no file, since only a user could ask for it back.
async fn drop_unheld(
    st: &AppState,
    tx: &mut PgConnection,
    candidates: &[i32],
) -> Result<usize, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT i.id,
                  EXISTS (SELECT 1 FROM item_parts p WHERE p."itemId" = i.id) AS "file!",
                  (EXISTS (SELECT 1 FROM playback_states x WHERE x."itemId" = i.id)
                   OR EXISTS (SELECT 1 FROM playback_history x WHERE x."itemId" = i.id)
                   OR EXISTS (SELECT 1 FROM likes x WHERE x."itemId" = i.id)
                   OR EXISTS (SELECT 1 FROM annotations x WHERE x."itemId" = i.id)
                   OR EXISTS (SELECT 1 FROM playlist_items x WHERE x."itemId" = i.id)) AS "user!"
           FROM items i WHERE i.id = ANY($1) FOR UPDATE OF i"#,
        candidates
    )
    .fetch_all(&mut *tx)
    .await?;
    let (held, free): (Vec<_>, Vec<_>) = rows.into_iter().partition(|r| r.file || r.user);
    let free: Vec<i32> = free.into_iter().map(|r| r.id).collect();
    let unfiled: Vec<i32> = held.iter().filter(|r| !r.file).map(|r| r.id).collect();
    crate::party::end_playing_items(st, &free).await?;
    sqlx::query!(r#"DELETE FROM items WHERE id = ANY($1)"#, &free)
        .execute(&mut *tx)
        .await?;
    sqlx::query!(
        r#"UPDATE items SET monitored = false WHERE id = ANY($1)"#,
        &unfiled
    )
    .execute(&mut *tx)
    .await?;
    Ok(held.len())
}

/// Reads a media again from its provider ids and its files, whatever its kind (`media-write.md`
/// rule 109); the `Found` of a video read from a provider.
pub(crate) async fn refresh_any(
    st: &AppState,
    media: &MediaRow,
    defer_kick: bool,
    prio: Priority,
) -> Result<Option<Found>, AppError> {
    refresh_any_with(st, media, defer_kick, prio, false).await
}

/// `reset`: the identity changed, so the provider-written values of the old one are cleared as the
/// new ones are written.
pub(crate) async fn refresh_any_with(
    st: &AppState,
    media: &MediaRow,
    defer_kick: bool,
    prio: Priority,
    reset: bool,
) -> Result<Option<Found>, AppError> {
    let id = media.id;
    match media.media_type {
        MediaKind::Comic => {
            crate::metadata::comics::refresh(st, id, prio).await?;
        }
        MediaKind::Album => {
            crate::metadata::music::refresh(st, id, prio).await?;
        }
        MediaKind::Book => {
            crate::ingest::books::refresh_media(st, id, prio)
                .await
                .map_err(|e| match e.retry {
                    true => AppError::with_message(StatusCode::SERVICE_UNAVAILABLE, e.cause),
                    false => AppError::internal_shown(e.cause),
                })?;
        }
        _ if !external_ids::any(&st.db, id).await? => {
            merge_unmatched(st, id).await?;
        }
        _ => {
            return Ok(Some(
                refresh_metadata_with(st, id, defer_kick, prio, reset).await?,
            ));
        }
    }
    Ok(None)
}

/// A new identity starts empty: what the old one's providers wrote goes, so the refresh COALESCE
/// cannot keep it. Locked and hand-edited fields, and the title and status, stay.
async fn clear_provider_values(c: &mut PgConnection, media: &MediaRow) -> Result<(), AppError> {
    clear_media_values(c, media.id).await?;
    if media.has_seasons() {
        clear_season_values(c, media.id).await?;
    }
    Ok(())
}

async fn clear_media_values(c: &mut PgConnection, id: i32) -> Result<(), AppError> {
    let fields: Vec<String> = sqlx::query_scalar(
        r#"DELETE FROM media_field_sources
           WHERE "mediaId" = $1 AND NOT locked AND provider IS NOT NULL AND provider <> $2
           RETURNING field"#,
    )
    .bind(id)
    .bind(Namespace::FILE.as_str())
    .fetch_all(&mut *c)
    .await?;
    let sourced = |f: Field| fields.iter().any(|n| n == f.as_str());
    let columns = [
        (Field::OriginalTitle, r#""originalTitle""#),
        (Field::Overview, "overview"),
        (Field::Year, "year"),
        (Field::PosterUrl, r#""posterUrl""#),
        (
            Field::FanartUrl,
            r#""fanartUrl" = NULL, "additionalFanartUrls""#,
        ),
        (Field::LogoUrl, r#""logoUrl""#),
        (Field::Rating, "rating"),
        (Field::Genres, "genres"),
        (Field::Runtime, "runtime"),
        (Field::AlternativeTitles, r#""alternativeTitles""#),
    ];
    let set: Vec<String> = columns
        .into_iter()
        .filter(|(f, _)| sourced(*f))
        .map(|(_, col)| format!("{col} = NULL"))
        .collect();
    if !set.is_empty() {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE media SET {} WHERE id = $1",
            set.join(", ")
        )))
        .bind(id)
        .execute(&mut *c)
        .await?;
    }
    if sourced(Field::ReleaseDates) {
        sqlx::query(
            r#"DELETE FROM media_release_dates WHERE "mediaId" = $1 AND "editionId" IS NULL"#,
        )
        .bind(id)
        .execute(&mut *c)
        .await?;
    }
    if sourced(Field::Details) {
        drop_details(c, id).await?;
    }
    Ok(())
}

async fn clear_season_values(c: &mut PgConnection, id: i32) -> Result<(), AppError> {
    sqlx::query(
        r#"UPDATE item_groups SET overview = NULL, "airDate" = NULL, "posterUrl" = NULL
           WHERE "mediaId" = $1"#,
    )
    .bind(id)
    .execute(&mut *c)
    .await?;
    sqlx::query(
        r#"UPDATE items SET title = NULL, overview = NULL, "airDate" = NULL, runtime = NULL,
             "stillUrl" = NULL
           WHERE "mediaId" = $1"#,
    )
    .bind(id)
    .execute(&mut *c)
    .await?;
    Ok(())
}
