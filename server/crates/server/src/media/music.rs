//! The `album` objects of media payloads and the track rows (`docs/spec/music.md` rules 44-49).
use fliks_domain::media::kind::MediaKind;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::HashMap;

fn album_ids(data: &[Value]) -> Vec<i32> {
    data.iter()
        .filter(|v| v["type"] == MediaKind::Album.as_str())
        .filter_map(|v| v["id"].as_i64().and_then(|n| i32::try_from(n).ok()))
        .collect()
}

const ARTISTS: &str = r#"SELECT jsonb_build_object('id', p.id, 'name', p.name, 'sortName', p."sortName",
    'avatarUrl', p."avatarUrl", 'creditedName', NULL, 'joinPhrase', NULL) AS j, c.position
  FROM media_credits c JOIN persons p ON p.id = c."personId"
  WHERE c."mediaId" = m.id AND c.role = 'artist' AND c."editionId" IS NULL"#;

/// Adds `album: AlbumListInfo` to the album items of `data`.
pub(crate) async fn attach_list_info(
    db: &PgPool,
    data: &mut [Value],
    uid: i32,
    acl: &[i32],
) -> Result<(), sqlx::Error> {
    let ids = album_ids(data);
    if ids.is_empty() {
        return Ok(());
    }
    let sql = format!(
        r#"SELECT m.id, jsonb_build_object(
  'artists', COALESCE((SELECT jsonb_agg(a.j ORDER BY a.position) FROM (
      {ARTISTS} ORDER BY c.position LIMIT 3) a), '[]'::jsonb),
  'primaryType', ad."primaryType", 'secondaryTypes', COALESCE(to_jsonb(ad."secondaryTypes"), '[]'::jsonb),
  'firstReleaseDate', ad."firstReleaseDate"::text, 'isCompilation', COALESCE(ad."isCompilation", false),
  'releaseGroupId', ad."releaseGroupMbid", 'disambiguation', te.disambiguation,
  'trackCount', CASE WHEN t.n > 0 THEN t.n ELSE COALESCE(te."trackCount", 0) END,
  'discCount', COALESCE(NULLIF(t.discs, 0), te."discCount", 0),
  'durationSeconds', t.secs,
  'playCount', (SELECT count(*) FROM playback_history h JOIN items i ON i.id = h."itemId"
      WHERE h."userId" = $2 AND i."mediaId" = m.id)) AS j
FROM media m
LEFT JOIN album_details ad ON ad."mediaId" = m.id
LEFT JOIN editions te ON te."mediaId" = m.id AND te.family = 'audio'
CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM items i JOIN editions e ON e.id = i."editionId"
      WHERE i."mediaId" = m.id AND track_file(i.id) IS NOT NULL
        AND COALESCE(e."libraryId", m."libraryId") = ANY($3)) AS owned) o
CROSS JOIN LATERAL (SELECT count(*) AS n, count(DISTINCT td."discNumber") AS discs,
      COALESCE(sum(td."durationMs"), 0)::float8 / 1000 AS secs
  FROM items i JOIN track_details td ON td."itemId" = i.id JOIN editions e ON e.id = i."editionId"
  WHERE i."mediaId" = m.id AND COALESCE(e."libraryId", m."libraryId") = ANY($3)
    AND (NOT o.owned OR track_file(i.id) IS NOT NULL)) t
WHERE m.id = ANY($1)"#
    );
    let rows: Vec<(i32, Value)> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(&ids)
        .bind(uid)
        .bind(acl)
        .fetch_all(db)
        .await?;
    let mut info: HashMap<i32, Value> = rows.into_iter().collect();
    for item in data.iter_mut() {
        let id = item["id"].as_i64().and_then(|n| i32::try_from(n).ok());
        if let (Some(o), Some(album)) = (item.as_object_mut(), id.and_then(|i| info.remove(&i))) {
            o.insert("album".into(), album);
        }
    }
    Ok(())
}

/// `AlbumDetail` of an album, but for its `versions` (`metadata::music::versions`); `acl` decides the tracks listed.
pub(crate) async fn detail(
    db: &PgPool,
    id: i32,
    uid: i32,
    acl: &[i32],
) -> Result<Value, sqlx::Error> {
    let sql = format!(
        r#"SELECT jsonb_build_object(
  'primaryType', ad."primaryType", 'secondaryTypes', COALESCE(to_jsonb(ad."secondaryTypes"), '[]'::jsonb),
  'firstReleaseDate', ad."firstReleaseDate"::text, 'isCompilation', COALESCE(ad."isCompilation", false),
  'releaseGroupId', ad."releaseGroupMbid", 'orphaned', ad."orphanedAt" IS NOT NULL,
  'artists', COALESCE((SELECT jsonb_agg(a.j ORDER BY a.position) FROM ({ARTISTS}) a), '[]'::jsonb),
  'release', (SELECT jsonb_build_object(
      'title', e.title, 'country', e.country, 'status', e.status, 'media', e.media,
      'barcode', e.barcode, 'catalogNumber', e."catalogNumber", 'label', e.publisher,
      'disambiguation', e.disambiguation,
      'releaseDate', (SELECT min(d.date) FROM media_release_dates d
          WHERE d."mediaId" = m.id AND d."editionId" = e.id)::text,
      'trackCount', COALESCE(e."trackCount", (SELECT count(*) FROM items i WHERE i."editionId" = e.id)),
      'discCount', COALESCE(e."discCount", (SELECT count(DISTINCT td."discNumber") FROM track_details td
          JOIN items i ON i.id = td."itemId" WHERE i."editionId" = e.id), 1),
      'albumGain', e."albumGain", 'albumPeak', e."albumPeak", 'coverUrl', e."coverUrl")
    FROM editions e WHERE e."mediaId" = m.id AND e.family = 'audio'
      AND COALESCE(e."libraryId", m."libraryId") = ANY($2) ORDER BY e.id LIMIT 1),
  'sharedTracks', (SELECT count(*) FROM track_details o
      WHERE o."mediaId" <> m.id
        AND (o."recordingMbid" IN (SELECT x."recordingMbid" FROM track_details x WHERE x."mediaId" = m.id)
             OR o.isrc IN (SELECT x.isrc FROM track_details x WHERE x."mediaId" = m.id))
        AND NOT EXISTS (SELECT 1 FROM item_parts op WHERE op."itemId" = o."itemId")
        AND track_file(o."itemId") IN (SELECT p."mediaFileId" FROM item_parts p WHERE p."mediaId" = m.id))) AS j
FROM media m LEFT JOIN album_details ad ON ad."mediaId" = m.id WHERE m.id = $1"#
    );
    let mut detail: Value = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(acl)
        .fetch_one(db)
        .await?;
    let items: Vec<i32> = sqlx::query_scalar(
        r#"SELECT i.id FROM items i JOIN media m ON m.id = i."mediaId"
           JOIN editions e ON e.id = i."editionId" JOIN track_details td ON td."itemId" = i.id
           WHERE i."mediaId" = $1 AND COALESCE(e."libraryId", m."libraryId") = ANY($2)
           ORDER BY td."discNumber", td.position, i.id"#,
    )
    .bind(id)
    .bind(acl)
    .fetch_all(db)
    .await?;
    let tracks = track_rows(db, uid, acl, &items).await?;
    detail["tracks"] = tracks
        .into_iter()
        .map(|mut t| {
            for k in ["mediaId", "albumTitle", "posterUrl"] {
                t.as_object_mut().map(|o| o.remove(k));
            }
            t
        })
        .collect();
    Ok(detail)
}

/// `TrackRow` of each readable track of `items`, in that order; the caller's favourite and plays.
pub(crate) async fn track_rows(
    db: &PgPool,
    uid: i32,
    acl: &[i32],
    items: &[i32],
) -> Result<Vec<Value>, sqlx::Error> {
    if items.is_empty() {
        return Ok(vec![]);
    }
    let rows: Vec<(i32, Value)> = sqlx::query_as(
        r#"SELECT i.id, jsonb_build_object(
  'itemId', i.id, 'mediaFileId', pf.id, 'hasFile', pf.id IS NOT NULL, 'monitored', i.monitored,
  'orphaned', td."orphanedAt" IS NOT NULL, 'discNumber', td."discNumber", 'discTitle', td."discTitle",
  'position', td.position, 'trackNumber', td."trackNumber", 'recordingId', td."recordingMbid", 'label', td.label, 'title', COALESCE(i.title, ''),
  'durationSeconds', COALESCE(td."durationMs"::float8 / 1000, pf.dur), 'explicit', td.explicit,
  'gain', td.gain, 'peak', td.peak,
  'lastAttempt', (SELECT q.state FROM acquisition_queue q
      WHERE q."mediaId" = m.id AND q."finishedAt" IS NOT NULL AND q."deletedAt" IS NULL
        AND (q."itemIds" IS NULL OR i.id = ANY(q."itemIds"))
      ORDER BY q."finishedAt" DESC, q.id DESC LIMIT 1),
  'artists', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('id', c."personId", 'name', p.name, 'creditedName', c."creditedName",
        'joinPhrase', c."joinPhrase") ORDER BY c.position)
       FROM item_credits c JOIN persons p ON p.id = c."personId" WHERE c."itemId" = i.id AND c.role = 'artist'),
    (SELECT jsonb_agg(jsonb_build_object('id', c."personId", 'name', p.name, 'creditedName', NULL,
        'joinPhrase', NULL) ORDER BY c.position)
       FROM media_credits c JOIN persons p ON p.id = c."personId"
       WHERE c."mediaId" = m.id AND c.role = 'artist' AND c."editionId" IS NULL), '[]'::jsonb),
  'credits', COALESCE((SELECT jsonb_agg(jsonb_build_object('personId', c."personId", 'name', p.name,
        'role', c.role, 'instrument', c.instrument) ORDER BY c.role, c.position)
       FROM item_credits c JOIN persons p ON p.id = c."personId"
       WHERE c."itemId" = i.id AND c.role <> 'artist'), '[]'::jsonb),
  'works', COALESCE((SELECT jsonb_agg(jsonb_build_object('workId', w.id, 'title', w.title,
        'parentWorkId', w."parentWorkId", 'composerPersonId', w."composerPersonId", 'composerName', cp.name,
        'position', iw.position) ORDER BY iw.position)
       FROM item_works iw JOIN works w ON w.id = iw."workId"
       LEFT JOIN persons cp ON cp.id = w."composerPersonId" WHERE iw."itemId" = i.id), '[]'::jsonb),
  'favourite', EXISTS (SELECT 1 FROM likes l WHERE l."userId" = $1 AND l."itemId" = i.id),
  'playCount', (SELECT count(*) FROM playback_history h WHERE h."userId" = $1 AND h."itemId" = i.id),
  'lastPlayedAt', (SELECT iso_ms(max(h."playedAt")) FROM playback_history h
      WHERE h."userId" = $1 AND h."itemId" = i.id),
  'mediaId', m.id, 'albumTitle', m.title, 'posterUrl', m."posterUrl")
FROM items i JOIN media m ON m.id = i."mediaId" AND m.type = 'album'
JOIN editions e ON e.id = i."editionId" JOIN track_details td ON td."itemId" = i.id
LEFT JOIN LATERAL (SELECT f.id, (f."streamInfo"->>'durationSeconds')::float8 AS dur
    FROM media_files f WHERE f.id = track_file(i.id)) pf ON true
WHERE i.id = ANY($3) AND COALESCE(e."libraryId", m."libraryId") = ANY($2)"#,
    )
    .bind(uid)
    .bind(acl)
    .bind(items)
    .fetch_all(db)
    .await?;
    let by_id: HashMap<i32, Value> = rows.into_iter().collect();
    Ok(items.iter().filter_map(|i| by_id.get(i).cloned()).collect())
}

/// The `track` object of a playlist item, by track item id.
pub(crate) async fn playlist_tracks(
    db: &PgPool,
    uid: i32,
    acl: &[i32],
    items: &[i32],
) -> Result<HashMap<i32, Value>, sqlx::Error> {
    let rows = track_rows(db, uid, acl, items).await?;
    Ok(rows
        .into_iter()
        .filter_map(|t| {
            let artists: Vec<Value> = t["artists"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|a| a["name"].clone())
                .collect();
            Some((
                t["itemId"].as_i64()? as i32,
                json!({
                    "itemId": t["itemId"], "title": t["title"], "artists": artists,
                    "albumTitle": t["albumTitle"], "mediaId": t["mediaId"], "posterUrl": t["posterUrl"],
                    "durationSeconds": t["durationSeconds"], "mediaFileId": t["mediaFileId"],
                    "gain": t["gain"], "peak": t["peak"],
                }),
            ))
        })
        .collect())
}
