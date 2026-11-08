//! The write of a provider's release group and releases (`docs/spec/music.md` rules 11, 26-30). It deletes no
//! edition, item or credit: what a provider stops listing is flagged `orphanedAt`, and a later hit clears it.
use super::{
    Fetched, aliases,
    people::{self, Credited},
    works::{self, WorkSpec},
};
use crate::{
    http::AppError,
    images::paths::{Target, Variant},
    ingest::record::file_records,
    media::{
        external_ids, field_sources,
        items::lock_versions,
        write::{
            fields::{Fields, apply, merge_unmatched},
            orphans,
        },
    },
    state::AppState,
};
use axum::http::StatusCode;
use fliks_domain::{
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::{
        field::Field,
        language::Resolved,
        limiter::Priority,
        merge::{FieldOrder, merge},
    },
    music::{
        matcher::{self, LocalTrack, RemoteTrack},
        provider::{Credit, Edition, Track},
    },
};
use serde_json::{Map, Value};
use std::collections::HashSet;

/// What `write_album` did with the media.
#[derive(Debug, PartialEq, Eq)]
pub enum Written {
    Done,
    /// A merged id made the album a duplicate: it was folded into this album.
    Folded(i32),
}

fn credited(c: &Credit) -> Credited {
    Credited {
        name: c.name.clone(),
        mbid: c.id.clone(),
        sort_name: c.sort_name.clone(),
        credited_name: c.credited_name.clone(),
        join_phrase: c.join_phrase.clone(),
        instrument: c.instrument.clone(),
    }
}

/// The poster a provider names: the album's own record first, then the poster of the other providers of
/// the album order, which are asked only when a download fails. A provider's poster never replaces one
/// that did not come from `ns`.
async fn poster(
    st: &AppState,
    media: i32,
    ns: Namespace,
    f: &Fetched,
    id: &str,
    lang: &Resolved,
    prio: Priority,
) -> Result<Option<String>, AppError> {
    if field_sources::locked_fields(&st.db, media)
        .await?
        .contains(&Field::PosterUrl)
    {
        return Ok(None);
    }
    let own: bool = sqlx::query_scalar(
        r#"SELECT "posterUrl" IS NULL OR EXISTS (SELECT 1 FROM media_field_sources
             WHERE "mediaId" = $1 AND field = 'posterUrl' AND provider = $2)
           FROM media WHERE id = $1"#,
    )
    .bind(media)
    .bind(ns.as_str())
    .fetch_optional(&st.db)
    .await?
    .unwrap_or(false);
    if !own {
        return Ok(None);
    }
    let target = Target::media(media, Variant::Poster);
    if let Some(url) = &f.album.poster_url
        && let Some(stored) = st.images.download_and_store(url, &target).await
    {
        return Ok(Some(stored));
    }
    for other in st.metadata.serving(MediaKind::Album) {
        if other == ns {
            continue;
        }
        let Ok(record) = st
            .metadata
            .work(other, MediaKind::Album, id, lang, prio)
            .await
        else {
            continue;
        };
        // Only the poster: a provider of images answers the artist's name as its title.
        let url = fliks_domain::music::provider::album(&record)
            .ok()
            .and_then(|a| a.poster_url);
        if let Some(url) = url
            && let Some(stored) = st.images.download_and_store(&url, &target).await
        {
            return Ok(Some(stored));
        }
    }
    Ok(None)
}

/// Writes the release group to the album `media` linked to `(ns, asked)`: the fields that are not locked,
/// `album_details`, the album artists and the facts of the releases it already holds. A canonical id other
/// than `asked` is a merge upstream: it moves the id (`aliases`).
pub async fn write_album(
    st: &AppState,
    media: i32,
    ns: Namespace,
    f: &Fetched,
    asked: &str,
    lang: &Resolved,
    prio: Priority,
) -> Result<Written, AppError> {
    let mut asked = asked.to_owned();
    if f.album.external_id != asked {
        match aliases::redirect_album(st, media, &asked, &f.album.external_id).await? {
            (aliases::Moved::Folded(into), refs) => {
                if let Some(r) = refs {
                    orphans::release(st, r);
                }
                return Ok(Written::Folded(into));
            }
            (aliases::Moved::Renamed, _) => asked = f.album.external_id.clone(),
            (aliases::Moved::Gone, _) => {}
        }
    }
    let stored = poster(st, media, ns, f, &asked, lang, prio).await?;
    let a = &f.album;
    let mut tx = st.db.begin().await?;
    lock_versions(&mut tx, media).await?;
    let alive: Option<String> =
        sqlx::query_scalar(r#"SELECT type FROM media WHERE id = $1 FOR UPDATE"#)
            .bind(media)
            .fetch_optional(&mut *tx)
            .await?;
    if alive.as_deref() != Some(MediaKind::Album.as_str()) {
        return Ok(Written::Done);
    }
    let locked = field_sources::locked_fields(&mut *tx, media).await?;
    let files = file_records(st, media).await;
    let tagged = files.iter().any(|r| {
        r.get("genres")
            .and_then(Value::as_array)
            .is_some_and(|g| !g.is_empty())
    });
    let mut provided = Map::new();
    for (k, v) in [
        ("title", Some(Value::from(a.title.clone()))),
        ("overview", a.overview.clone().map(Value::from)),
        ("year", a.year.map(Value::from)),
        ("posterUrl", stored.map(Value::from)),
        (
            "genres",
            Some(a.genres.clone())
                .filter(|g| !g.is_empty() && !tagged)
                .map(Value::from),
        ),
    ] {
        if let Some(v) = v {
            provided.insert(k.into(), v);
        }
    }
    let mut records = vec![(ns, provided)];
    records.extend(files.into_iter().map(|r| (Namespace::FILE, r)));
    let (merged, provenance) = merge(&records, &FieldOrder::new(MediaKind::Album, &[ns]), &locked);
    apply(&mut tx, media, &Fields::from_map(MediaKind::Album, &merged)).await?;
    field_sources::merge_field_sources(&mut tx, media, &provenance).await?;
    sqlx::query(
        r#"INSERT INTO album_details ("mediaId", "primaryType", "secondaryTypes", "firstReleaseDate",
             "isCompilation", popularity, "orphanedAt")
           VALUES ($1, $2, $3, $4, $5, $6, NULL)
           ON CONFLICT ("mediaId") DO UPDATE SET
             "primaryType" = COALESCE(EXCLUDED."primaryType", album_details."primaryType"),
             "secondaryTypes" = EXCLUDED."secondaryTypes",
             "firstReleaseDate" = COALESCE(EXCLUDED."firstReleaseDate", album_details."firstReleaseDate"),
             "isCompilation" = EXCLUDED."isCompilation",
             popularity = COALESCE(EXCLUDED.popularity, album_details.popularity),
             "orphanedAt" = NULL"#,
    )
    .bind(media)
    .bind(a.primary_type)
    .bind(&a.secondary_types)
    .bind(a.first_release_date)
    .bind(a.is_compilation)
    .bind(a.popularity)
    .execute(&mut *tx)
    .await?;
    let artists: Vec<Credited> = a.artists.iter().map(credited).collect();
    people::replace_album_artists(&mut tx, media, &artists).await?;
    release_facts(&mut tx, media, f).await?;
    tx.commit().await?;
    Ok(Written::Done)
}

/// The facts of the releases the album holds as editions; one it holds that the provider no longer lists is
/// flagged, never removed.
async fn release_facts(
    tx: &mut sqlx::PgConnection,
    media: i32,
    f: &Fetched,
) -> Result<(), AppError> {
    for r in &f.releases {
        sqlx::query(
            r#"UPDATE editions e SET country = COALESCE($3, e.country), status = COALESCE($4, e.status),
                 media = COALESCE($5, e.media), barcode = COALESCE($6, e.barcode),
                 "catalogNumber" = COALESCE($7, e."catalogNumber"), publisher = COALESCE($8, e.publisher),
                 "trackCount" = COALESCE($9, e."trackCount"), "discCount" = COALESCE($10, e."discCount"),
                 "orphanedAt" = NULL
               FROM edition_external_ids x
               WHERE x."editionId" = e.id AND x."mediaId" = $1 AND x.provider = 'musicbrainz' AND x.value = $2
                 AND e."mediaId" = $1"#,
        )
        .bind(media)
        .bind(&r.external_id)
        .bind(&r.country)
        .bind(r.status)
        .bind(r.media)
        .bind(&r.barcode)
        .bind(&r.catalog_number)
        .bind(&r.label)
        .bind(r.track_count)
        .bind(r.disc_count)
        .execute(&mut *tx)
        .await?;
    }
    if f.releases.is_empty() {
        return Ok(());
    }
    let listed: Vec<&str> = f.releases.iter().map(|r| r.external_id.as_str()).collect();
    sqlx::query(
        r#"UPDATE editions e SET "orphanedAt" = now()
           WHERE e."mediaId" = $1 AND e."orphanedAt" IS NULL
             AND EXISTS (SELECT 1 FROM edition_external_ids x WHERE x."editionId" = e.id AND x.provider = 'musicbrainz')
             AND NOT EXISTS (SELECT 1 FROM edition_external_ids x WHERE x."editionId" = e.id
                              AND x.provider = 'musicbrainz' AND x.value = ANY($2))"#,
    )
    .bind(media)
    .bind(&listed)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

struct Held {
    item: i32,
    local: LocalTrack,
    release_track: Option<String>,
}

fn remote_track(t: &Track) -> RemoteTrack {
    RemoteTrack {
        title: t.title.clone(),
        artist: t
            .credits
            .iter()
            .filter(|c| c.role == "artist")
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        disc: Some(t.disc_number),
        number: t.number,
        duration_ms: t.duration_ms,
        recording: t.recording_id.clone(),
    }
}

/// The track of `tracks` each item is, by its release track id, then its recording id, then the distance
/// of the rest; an item that no track is near stays `None`.
fn pair(held: &[Held], tracks: &[Track]) -> Vec<Option<usize>> {
    let mut out: Vec<Option<usize>> = vec![None; held.len()];
    let mut taken = HashSet::new();
    for (i, h) in held.iter().enumerate() {
        let id = h.release_track.as_deref();
        if let Some(j) = id.and_then(|id| {
            tracks
                .iter()
                .position(|t| t.release_track_id.as_deref() == Some(id))
        }) && taken.insert(j)
        {
            out[i] = Some(j);
        }
    }
    for (i, h) in held.iter().enumerate() {
        if out[i].is_some() {
            continue;
        }
        let id = h.local.recording.as_deref();
        if let Some(j) = id.and_then(|id| {
            tracks
                .iter()
                .enumerate()
                .position(|(j, t)| !taken.contains(&j) && t.recording_id.as_deref() == Some(id))
        }) {
            taken.insert(j);
            out[i] = Some(j);
        }
    }
    let rows: Vec<usize> = (0..held.len()).filter(|i| out[*i].is_none()).collect();
    let cols: Vec<usize> = (0..tracks.len()).filter(|j| !taken.contains(j)).collect();
    let remote: Vec<RemoteTrack> = cols.iter().map(|j| remote_track(&tracks[*j])).collect();
    let cost: Vec<Vec<f64>> = rows
        .iter()
        .map(|i| {
            remote
                .iter()
                .map(|r| matcher::track_distance(&held[*i].local, r))
                .collect()
        })
        .collect();
    for (r, assigned) in matcher::assign(&cost).into_iter().enumerate() {
        if let Some(c) = assigned.filter(|c| cost[r][*c] <= NEAR) {
            out[rows[r]] = Some(cols[c]);
        }
    }
    out
}

/// A track further than this from every remaining item is a track the files do not have.
const NEAR: f64 = 0.5;

/// Credits of a track by role, the artists of the line first.
fn credit_roles(t: &Track) -> Vec<(&'static str, Vec<Credited>)> {
    let mut out = vec![];
    for role in fliks_domain::music::provider::CREDIT_ROLES {
        let list: Vec<Credited> = t
            .credits
            .iter()
            .filter(|c| c.role == role)
            .map(credited)
            .collect();
        if !list.is_empty() {
            out.push((role, list));
        }
    }
    out
}

fn work_specs(t: &Track) -> Vec<WorkSpec> {
    t.works
        .iter()
        .map(|w| WorkSpec {
            mbid: w.external_id.clone(),
            title: w.title.clone(),
            parent_mbid: w.parent_id.clone(),
            parent_title: w.parent_title.clone(),
            composer: w.composer.as_ref().map(credited),
        })
        .collect()
}

async fn write_track(tx: &mut sqlx::PgConnection, item: i32, t: &Track) -> Result<(), AppError> {
    sqlx::query(r#"UPDATE items SET title = $2 WHERE id = $1"#)
        .bind(item)
        .bind(&t.title)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"UPDATE track_details SET position = $2, "discNumber" = $3, "discTitle" = COALESCE($4, "discTitle"),
             "trackNumber" = COALESCE($5, "trackNumber"), label = COALESCE($6, label),
             "recordingMbid" = COALESCE($7::uuid, "recordingMbid"),
             "releaseTrackMbid" = COALESCE($8::uuid, "releaseTrackMbid"), isrc = COALESCE($9, isrc),
             "durationMs" = COALESCE("durationMs", $10), explicit = $11, gain = COALESCE(gain, $12),
             peak = COALESCE(peak, $13), popularity = COALESCE($14, popularity), "orphanedAt" = NULL
           WHERE "itemId" = $1"#,
    )
    .bind(item)
    .bind(t.position)
    .bind(t.disc_number)
    .bind(&t.disc_title)
    .bind(t.number)
    .bind(&t.label)
    .bind(&t.recording_id)
    .bind(&t.release_track_id)
    .bind(&t.isrc)
    .bind(t.duration_ms)
    .bind(t.explicit)
    .bind(t.gain.map(|g| g as f32))
    .bind(t.peak.map(|g| g as f32))
    .bind(t.popularity)
    .execute(&mut *tx)
    .await?;
    for (role, list) in credit_roles(t) {
        people::replace_track_credits(tx, item, role, &list).await?;
    }
    works::set_track_works(tx, item, &work_specs(t)).await?;
    Ok(())
}

/// Writes the release `ed` to the edition `edition` of `media`: its facts, and its tracklist onto the tracks
/// the files made (matched by id, then by distance). A track the files do not have is created only when
/// `create_missing` (the target edition of a wanted album); a track of the edition that the release does not
/// list is flagged. The caller holds the media's lock.
pub async fn write_edition(
    st: &AppState,
    media: i32,
    edition: i32,
    ed: &Edition,
    create_missing: bool,
) -> Result<(), AppError> {
    let mut tx = st.db.begin().await?;
    lock_versions(&mut tx, media).await?;
    let alive: Option<i32> = sqlx::query_scalar(
        r#"SELECT id FROM editions WHERE id = $1 AND "mediaId" = $2 FOR UPDATE"#,
    )
    .bind(edition)
    .bind(media)
    .fetch_optional(&mut *tx)
    .await?;
    if alive.is_none() {
        return Ok(());
    }
    let known = st.namespaces();
    external_ids::link_edition(
        &mut tx,
        &known,
        edition,
        media,
        Namespace::MUSICBRAINZ,
        &ed.release.external_id,
    )
    .await?;
    let r = &ed.release;
    sqlx::query(
        r#"UPDATE editions SET country = COALESCE($2, country), status = COALESCE($3, status),
             media = COALESCE($4, media), barcode = COALESCE($5, barcode),
             "catalogNumber" = COALESCE($6, "catalogNumber"), publisher = COALESCE($7, publisher),
             "trackCount" = COALESCE($8, $9), "discCount" = COALESCE($10, "discCount"),
             "albumGain" = COALESCE($11, "albumGain"), "albumPeak" = COALESCE($12, "albumPeak"),
             language = COALESCE(language, $13), title = $14, "orphanedAt" = NULL
           WHERE id = $1"#,
    )
    .bind(edition)
    .bind(&r.country)
    .bind(r.status)
    .bind(r.media)
    .bind(&r.barcode)
    .bind(&r.catalog_number)
    .bind(&r.label)
    .bind(r.track_count)
    .bind(ed.tracks.len() as i32)
    .bind(r.disc_count)
    .bind(ed.album_gain.map(|g| g as f32))
    .bind(ed.album_peak.map(|g| g as f32))
    .bind(&ed.language)
    .bind(&r.title)
    .execute(&mut *tx)
    .await?;
    if let Some(d) = r.release_date {
        sqlx::query(
            r#"INSERT INTO media_release_dates ("mediaId", "editionId", kind, date) VALUES ($1, $2, 'release', $3)
               ON CONFLICT ("mediaId", "editionId", kind) DO UPDATE SET date = EXCLUDED.date"#,
        )
        .bind(media)
        .bind(edition)
        .bind(d)
        .execute(&mut *tx)
        .await?;
    }

    type Row = (
        i32,
        Option<String>,
        Option<i32>,
        Option<i32>,
        Option<String>,
        Option<String>,
        Option<i32>,
        Option<String>,
    );
    let rows: Vec<Row> =
        sqlx::query_as(
            r#"SELECT i.id, i.title, td."discNumber", td."trackNumber", td."recordingMbid"::text,
                      td."releaseTrackMbid"::text, td."durationMs",
                      (SELECT string_agg(p.name, ', ' ORDER BY c.position) FROM item_credits c
                         JOIN persons p ON p.id = c."personId" WHERE c."itemId" = i.id AND c.role = 'artist')
               FROM items i JOIN track_details td ON td."itemId" = i.id
               WHERE i."editionId" = $1 ORDER BY i.id"#,
        )
        .bind(edition)
        .fetch_all(&mut *tx)
        .await?;
    let held: Vec<Held> = rows
        .into_iter()
        .map(
            |(item, title, disc, number, recording, release_track, duration, artist)| Held {
                item,
                release_track,
                local: LocalTrack {
                    title: title.unwrap_or_default(),
                    artist: artist.unwrap_or_default(),
                    disc,
                    number,
                    duration_ms: duration,
                    recording,
                },
            },
        )
        .collect();
    let paired = pair(&held, &ed.tracks);
    let mut used = HashSet::new();
    for (h, p) in held.iter().zip(&paired) {
        match p {
            Some(j) => {
                used.insert(*j);
                write_track(&mut tx, h.item, &ed.tracks[*j]).await?;
            }
            None => {
                sqlx::query(r#"UPDATE track_details SET "orphanedAt" = COALESCE("orphanedAt", now()) WHERE "itemId" = $1"#)
                    .bind(h.item)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    if create_missing {
        for t in ed
            .tracks
            .iter()
            .enumerate()
            .filter(|(j, _)| !used.contains(j))
            .map(|(_, t)| t)
        {
            let item: i32 = sqlx::query_scalar(
                r#"INSERT INTO items ("mediaId", "editionId", monitored, title)
                   VALUES ($1, $2, (SELECT monitored FROM media WHERE id = $1), $3) RETURNING id"#,
            )
            .bind(media)
            .bind(edition)
            .bind(&t.title)
            .fetch_one(&mut *tx)
            .await?;
            sqlx::query(
                r#"INSERT INTO track_details ("itemId", "mediaId", position) VALUES ($1, $2, $3)"#,
            )
            .bind(item)
            .bind(media)
            .bind(t.position)
            .execute(&mut *tx)
            .await?;
            write_track(&mut tx, item, t).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

/// The id the album is linked to, if any.
async fn linked(st: &AppState, media: i32) -> Result<Option<String>, AppError> {
    Ok(sqlx::query_scalar(
        r#"SELECT value FROM media_external_ids WHERE "mediaId" = $1 AND kind = 'album' AND provider = 'musicbrainz'"#,
    )
    .bind(media)
    .fetch_optional(&st.db)
    .await?)
}

async fn orphan_album(st: &AppState, media: i32) -> Result<(), AppError> {
    sqlx::query(
        r#"INSERT INTO album_details ("mediaId", "orphanedAt") VALUES ($1, now())
           ON CONFLICT ("mediaId") DO UPDATE SET "orphanedAt" = COALESCE(album_details."orphanedAt", now())"#,
    )
    .bind(media)
    .execute(&st.db)
    .await?;
    Ok(())
}

/// Reads the provider the album is linked to again and writes it (rule 30); `false` when the album holds no
/// id, its files are merged alone then. A release group the provider no longer knows is flagged, and so is a
/// release; an outage fails the refresh and changes nothing.
pub async fn refresh(st: &AppState, media: i32, prio: Priority) -> Result<bool, AppError> {
    let Some(id) = linked(st, media).await? else {
        merge_unmatched(st, media).await?;
        return Ok(false);
    };
    let ns = Namespace::MUSICBRAINZ;
    let library: Option<i32> = sqlx::query_scalar(r#"SELECT "libraryId" FROM media WHERE id = $1"#)
        .bind(media)
        .fetch_optional(&st.db)
        .await?
        .flatten();
    let lang = match library {
        Some(l) => crate::metadata::library_language(st, l).await?,
        None => st.metadata.lang.resolve(None).await?,
    };
    let fetched = match super::fetch(st, ns, &id, &lang, prio).await {
        Ok(f) => f,
        Err(e) if e.status() == StatusCode::NOT_FOUND => {
            orphan_album(st, media).await?;
            return Ok(true);
        }
        Err(e) => return Err(e),
    };
    if write_album(st, media, ns, &fetched, &id, &lang, prio).await? != Written::Done {
        return Ok(true);
    }
    let editions: Vec<(i32, String)> = sqlx::query_as(
        r#"SELECT e.id, x.value FROM editions e JOIN edition_external_ids x ON x."editionId" = e.id
           WHERE e."mediaId" = $1 AND x.provider = 'musicbrainz' AND e."orphanedAt" IS NULL ORDER BY e.id"#,
    )
    .bind(media)
    .fetch_all(&st.db)
    .await?;
    for (edition, release) in editions {
        match super::fetch_edition(st, ns, &release, &lang, prio).await {
            Ok(ed) => write_edition(st, media, edition, &ed, false).await?,
            Err(e) if e.status() == StatusCode::NOT_FOUND => {
                sqlx::query(
                    r#"UPDATE editions SET "orphanedAt" = COALESCE("orphanedAt", now()) WHERE id = $1"#,
                )
                .bind(edition)
                .execute(&st.db)
                .await?;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}
