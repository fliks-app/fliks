//! The other releases of an album's release group (`docs/spec/music.md` rule 45): those the library holds as
//! albums, then the ones only the provider lists.
use super::fetch;
use crate::{http::AppError, ingest::music::identify, state::AppState};
use fliks_domain::{
    external_id::Namespace,
    metadata::limiter::Priority,
    music::target::{version_key, versions as collapse},
};
use serde_json::{Value, json};

#[derive(sqlx::FromRow)]
struct Held {
    media: i32,
    release: String,
    title: String,
    disambiguation: Option<String>,
    country: Option<String>,
    date: Option<String>,
    tracks: Option<i32>,
    discs: Option<i32>,
}

/// The versions of the group of album `media`: held ones with their album id (the album itself included), the
/// others read from the provider's snapshot, collapsed by title, size and disambiguation. A provider that
/// cannot answer leaves the others out.
pub async fn versions(st: &AppState, media: i32, readable: &[i32]) -> Result<Vec<Value>, AppError> {
    let group: Option<(String, i32)> = sqlx::query_as(
        r#"SELECT ad."releaseGroupMbid"::text, m."libraryId" FROM album_details ad JOIN media m ON m.id = ad."mediaId"
            WHERE ad."mediaId" = $1 AND ad."releaseGroupMbid" IS NOT NULL AND m."libraryId" IS NOT NULL"#,
    )
    .bind(media)
    .fetch_optional(&st.db)
    .await?;
    let Some((group, library)) = group else {
        return Ok(vec![]);
    };
    let held: Vec<Held> = sqlx::query_as(
        r#"SELECT m.id AS media, x.value AS release, COALESCE(e.title, m.title) AS title, e.disambiguation,
                  e.country, (SELECT min(d.date)::text FROM media_release_dates d
                               WHERE d."editionId" = e.id) AS date,
                  e."trackCount" AS tracks, e."discCount" AS discs
             FROM media m JOIN album_details ad ON ad."mediaId" = m.id
             JOIN media_external_ids x ON x."mediaId" = m.id AND x.kind = 'album' AND x.provider = 'musicbrainz'
             LEFT JOIN editions e ON e."mediaId" = m.id AND e.family = 'audio'
            WHERE ad."releaseGroupMbid" = $1::uuid AND m."libraryId" = ANY($2)
            ORDER BY 6 NULLS LAST, m.id"#,
    )
    .bind(&group)
    .bind(readable)
    .fetch_all(&st.db)
    .await?;
    let keys: Vec<String> = held
        .iter()
        .map(|h| version_key(&h.title, h.tracks, h.disambiguation.as_deref()))
        .collect();
    let mut out: Vec<Value> = held
        .iter()
        .map(|h| {
            json!({"releaseId": h.release, "title": h.title, "disambiguation": h.disambiguation,
                   "country": h.country, "releaseDate": h.date, "trackCount": h.tracks,
                   "discCount": h.discs, "mediaId": h.media})
        })
        .collect();
    let ns = Namespace::MUSICBRAINZ;
    let lang = crate::metadata::library_language(st, library).await?;
    let fetched = match fetch(st, ns, &group, &lang, Priority::Interactive).await {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(
                "versions of album #{media}: the group's releases not read: {}",
                e.text()
            );
            return Ok(out);
        }
    };
    let profile = crate::libraries::metadata_profile(&st.db, library).await?;
    let cfg = identify::config(st).await;
    for r in collapse(&fetched.releases, &profile, &cfg) {
        let key = version_key(&r.title, r.track_count, r.disambiguation.as_deref());
        if keys.contains(&key) || held.iter().any(|h| h.release == r.external_id) {
            continue;
        }
        out.push(json!({"releaseId": r.external_id, "title": r.title,
            "disambiguation": r.disambiguation, "country": r.country,
            "releaseDate": r.release_date.map(|d| d.to_string()), "trackCount": r.track_count,
            "discCount": r.disc_count, "mediaId": null}));
    }
    out.sort_by(|a, b| {
        (a["releaseDate"].as_str(), a["releaseId"].as_str())
            .cmp(&(b["releaseDate"].as_str(), b["releaseId"].as_str()))
    });
    Ok(out)
}
