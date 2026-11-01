//! `Media` entities as JSON (`media-query.md` rules 30-32): built in SQL, absolute paths added or removed in Rust.
use super::external_ids;
use fliks_domain::{media::path::media_path, track_markers};
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;

/// `MLI` for `ids`, in that order; `sizeOnDisk` and `episodeStats` included, `watched`/`progressPercent` not.
pub async fn items(db: &PgPool, ids: &[i32], see_paths: bool) -> Result<Vec<Value>, sqlx::Error> {
    items_view(db, ids, see_paths, false).await
}

/// `items`, or with `grid` the library grid shape: `files` holds only the first file, plus `fileCount`.
pub async fn items_view(
    db: &PgPool,
    ids: &[i32],
    see_paths: bool,
    grid: bool,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT media.id AS "id!", l.path AS lib_path, media."folderName" AS folder_name,
  (jsonb_build_object(
    'id', media.id, 'createdAt', iso_ms(media."createdAt"), 'updatedAt', iso_ms(media."updatedAt"),
    'title', media.title, 'originalTitle', media."originalTitle", 'alternativeTitles', media."alternativeTitles",
    'year', media.year, 'type', media.type, 'tmdbId', ids.tmdb,
    'imdbId', ids.imdb, 'tvdbId', ids.tvdb,
    'overview', media.overview, 'status', media.status::text,
    'monitored', media.monitored, 'preferredProvider', media."preferredProvider", 'folderName', media."folderName",
    'posterUrl', media."posterUrl", 'fanartUrl', media."fanartUrl", 'logoUrl', media."logoUrl")
  || jsonb_build_object(
    'additionalFanartUrls', to_jsonb(media."additionalFanartUrls"),
    'metadataRefreshedAt', iso_ms(media."metadataRefreshedAt"), 'rating', media.rating, 'genres', media.genres,
    'tmdbCollectionId', media."tmdbCollectionId", 'tmdbCollectionName', media."tmdbCollectionName",
    'runtime', media.runtime, 'releaseDate', media."releaseDate", 'inCinemas', media."inCinemas",
    'digitalRelease', media."digitalRelease", 'physicalRelease', media."physicalRelease",
    'minimumAvailability', media."minimumAvailability")
  || jsonb_build_object(
    'libraryId', media."libraryId", 'qualityProfileId', media."qualityProfileId",
    'languageProfileId', media."languageProfileId", 'addedById', media."addedById")
  || jsonb_build_object(
    'library', CASE WHEN l.id IS NULL THEN 'null'::jsonb ELSE
      jsonb_build_object('id', l.id, 'createdAt', iso_ms(l."createdAt"), 'updatedAt', iso_ms(l."updatedAt"),
        'name', l.name, 'icon', l.icon, 'color', l.color, 'mediaTypes', l."mediaTypes",
        'preferredProvider', l."preferredProvider", 'path', l.path, 'label', l.label,
        'metadataLanguage', l."metadataLanguage", 'metadataRegion', l."metadataRegion",
        'defaultQualityProfileId', l."defaultQualityProfileId", 'defaultLanguageProfileId', l."defaultLanguageProfileId") END,
    'qualityProfile', CASE WHEN qp.id IS NULL THEN 'null'::jsonb ELSE
      jsonb_build_object('id', qp.id, 'createdAt', iso_ms(qp."createdAt"), 'updatedAt', iso_ms(qp."updatedAt"),
        'name', qp.name, 'cutoff', qp.cutoff, 'items', qp.items, 'upgradeAllowed', qp."upgradeAllowed",
        'resolutionUpgradeOnly', qp."resolutionUpgradeOnly", 'minCustomFormatScore', qp."minCustomFormatScore") END,
    'languageProfile', CASE WHEN lp.id IS NULL THEN 'null'::jsonb ELSE
      jsonb_build_object('id', lp.id, 'createdAt', iso_ms(lp."createdAt"), 'updatedAt', iso_ms(lp."updatedAt"),
        'name', lp.name, 'audioLanguages', lp."audioLanguages", 'subtitleLanguages', lp."subtitleLanguages") END,
    'files', COALESCE((SELECT jsonb_agg(
        jsonb_build_object('id', f.id, 'createdAt', iso_ms(f."createdAt"), 'updatedAt', iso_ms(f."updatedAt"),
          'relativePath', f."relativePath", 'size', f.size, 'quality', f.quality, 'language', f.language,
          'streamInfo', f."streamInfo", 'osdbHash', f."osdbHash", 'osdbBytesize', f."osdbBytesize",
          'mediaId', f."mediaId", 'episodeId', f."episodeId") ORDER BY f.id)
      FROM media_files f WHERE f."mediaId" = media.id
        AND (NOT $2 OR f.id = (SELECT MIN(g.id) FROM media_files g WHERE g."mediaId" = media.id))), '[]'::jsonb),
    'sizeOnDisk', COALESCE((SELECT SUM(f.size) FROM media_files f WHERE f."mediaId" = media.id), 0))
  || CASE WHEN $2 THEN jsonb_build_object('fileCount',
       (SELECT COUNT(*) FROM media_files f WHERE f."mediaId" = media.id)) ELSE '{}'::jsonb END
  || CASE WHEN media.type = 'series' AND st.total > 0 THEN
       jsonb_build_object('episodeStats', jsonb_build_object('totalEpisodes', st.total, 'downloadedEpisodes', st.downloaded))
     ELSE '{}'::jsonb END) AS "json!: Value"
FROM media
LEFT JOIN libraries l ON l.id = media."libraryId"
LEFT JOIN quality_profiles qp ON qp.id = media."qualityProfileId"
LEFT JOIN language_profiles lp ON lp.id = media."languageProfileId"
LEFT JOIN LATERAL (SELECT max(value) FILTER (WHERE provider = $3)::int AS tmdb,
             max(value) FILTER (WHERE provider = $4)::int AS tvdb,
             max(value) FILTER (WHERE provider = $5) AS imdb
           FROM media_external_ids WHERE "mediaId" = media.id) ids ON true
LEFT JOIN LATERAL (
  SELECT COUNT(e.id) AS total,
         COUNT(e.id) FILTER (WHERE (e."hasFile" = true OR EXISTS (
           SELECT 1 FROM episodes cov WHERE cov."seasonId" = e."seasonId" AND cov."hasFile" = true
             AND cov."endEpisodeNumber" IS NOT NULL AND e."episodeNumber" > cov."episodeNumber"
             AND e."episodeNumber" <= cov."endEpisodeNumber"))) AS downloaded
  FROM seasons s JOIN episodes e ON e."seasonId" = s.id
  WHERE s."mediaId" = media.id AND s."seasonNumber" > 0) st ON media.type = 'series'
WHERE media.id = ANY($1)"#,
        ids,
        grid,
        external_ids::TMDB,
        external_ids::TVDB,
        external_ids::IMDB
    )
    .fetch_all(db)
    .await?;
    let mut by_id: HashMap<i32, _> = rows.into_iter().map(|r| (r.id, r)).collect();
    Ok(ids
        .iter()
        .filter_map(|id| by_id.remove(id))
        .map(|r| {
            let mut v = r.json;
            let Some(obj) = v.as_object_mut() else {
                return v;
            };
            for f in obj
                .get_mut("files")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                if let Some(info) = f.get_mut("streamInfo") {
                    track_markers::annotate(info);
                }
            }
            if see_paths {
                let path = media_path(r.lib_path.as_deref(), r.folder_name.as_deref());
                obj.insert("path".into(), path.into());
            } else if let Some(lib) = obj.get_mut("library").and_then(Value::as_object_mut) {
                lib.remove("path");
            }
            v
        })
        .collect())
}

/// `MD`: the `MLI` shape without the derived fields, plus seasons (specials last) and metadata.
pub async fn detail(db: &PgPool, id: i32, see_paths: bool) -> Result<Option<Value>, sqlx::Error> {
    let Some(mut media) = items(db, &[id], see_paths).await?.pop() else {
        return Ok(None);
    };
    let metadata = metadata(db, &[id]).await?.remove(&id);
    let extra = sqlx::query!(
        r#"SELECT
  COALESCE((SELECT jsonb_agg(
      jsonb_build_object('id', s.id, 'createdAt', iso_ms(s."createdAt"), 'updatedAt', iso_ms(s."updatedAt"),
        'seasonNumber', s."seasonNumber", 'monitored', s.monitored, 'preferredProvider', s."preferredProvider",
        'posterUrl', s."posterUrl", 'overview', s.overview, 'airDate', s."airDate", 'mediaId', s."mediaId",
        'episodes', COALESCE((SELECT jsonb_agg(
            jsonb_build_object('id', e.id, 'createdAt', iso_ms(e."createdAt"), 'updatedAt', iso_ms(e."updatedAt"),
              'episodeNumber', e."episodeNumber", 'endEpisodeNumber', e."endEpisodeNumber", 'title', e.title,
              'overview', e.overview, 'airDate', e."airDate", 'runtime', e.runtime, 'monitored', e.monitored,
              'hasFile', (e."hasFile" OR EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = $1 AND f."episodeId" = e.id)),
              'stillUrl', e."stillUrl", 'markersScannedAt', iso_ms(e."markersScannedAt"), 'seasonId', e."seasonId")
            ORDER BY e."episodeNumber", e.id)
          FROM episodes e WHERE e."seasonId" = s.id), '[]'::jsonb))
      ORDER BY (s."seasonNumber" = 0), s."seasonNumber", s.id)
    FROM seasons s WHERE s."mediaId" = $1), '[]'::jsonb) AS "seasons!: Value""#,
        id
    )
    .fetch_one(db)
    .await?;
    if let Some(obj) = media.as_object_mut() {
        obj.remove("sizeOnDisk");
        obj.remove("episodeStats");
        let mut seasons = extra.seasons;
        for (scope, at) in crate::cleanup::scoped_delete_at(db, id).await? {
            let season = seasons
                .as_array_mut()
                .and_then(|a| a.iter_mut().find(|s| s["id"] == scope.season.unwrap_or(0)));
            let target = match (season, scope.episode) {
                (Some(s), None) => Some(s),
                (Some(s), Some(e)) => s["episodes"]
                    .as_array_mut()
                    .and_then(|a| a.iter_mut().find(|x| x["id"] == e)),
                _ => None,
            };
            if let Some(t) = target {
                t["deleteAt"] = at.into();
            }
        }
        obj.insert("seasons".into(), seasons);
        obj.insert("metadata".into(), metadata.unwrap_or(Value::Null));
        if let Some(at) = crate::cleanup::delete_at(db, id).await? {
            obj.insert("deleteAt".into(), at.into());
        }
    }
    Ok(Some(media))
}

/// The `media_metadata` rows of `ids` (`media-query.md` rule 31), by media id.
pub async fn metadata(db: &PgPool, ids: &[i32]) -> Result<HashMap<i32, Value>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT mm."mediaId" AS "media_id!",
  jsonb_build_object('id', mm.id, 'createdAt', iso_ms(mm."createdAt"), 'updatedAt', iso_ms(mm."updatedAt"),
      'budget', mm.budget::text, 'revenue', mm.revenue::text, 'tagline', mm.tagline, 'popularity', mm.popularity,
      'voteCount', mm."voteCount", 'originalLanguage', mm."originalLanguage",
      'productionCountries', mm."productionCountries", 'productionCompanies', mm."productionCompanies",
      'videos', mm.videos, 'keywords', mm.keywords) AS "json!: Value"
FROM media_metadata mm WHERE mm."mediaId" = ANY($1)"#,
        ids
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|r| (r.media_id, r.json)).collect())
}

/// `Media` rows of credits (`persons.md` rule 17): the list shape without files, sizes and stats, plus metadata.
pub async fn credit_media(
    db: &PgPool,
    ids: &[i32],
    see_paths: bool,
) -> Result<HashMap<i32, Value>, sqlx::Error> {
    let mut meta = metadata(db, ids).await?;
    let mut out = HashMap::new();
    for mut m in items(db, ids, see_paths).await? {
        let Some(obj) = m.as_object_mut() else {
            continue;
        };
        for k in ["files", "sizeOnDisk", "episodeStats"] {
            obj.remove(k);
        }
        let id = obj
            .get("id")
            .and_then(Value::as_i64)
            .and_then(|n| i32::try_from(n).ok());
        let Some(id) = id else { continue };
        obj.insert("metadata".into(), meta.remove(&id).unwrap_or(Value::Null));
        out.insert(id, m);
    }
    Ok(out)
}
