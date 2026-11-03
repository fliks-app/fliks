//! TheXEM scene mappings: storage, refresh and the per-media loader (`docs/spec/scene-numbering.md`).
use crate::metadata::Guarded;
use fliks_domain::{
    metadata::limiter::{Limits, Priority},
    release::scene::{SceneMap, parse_havemap},
};
use serde_json::Value;
use sqlx::{PgPool, types::Json};
use std::{collections::BTreeMap, time::Duration};

const BASE: &str = "https://thexem.info";

async fn stored(db: &PgPool, tvdb: i32) -> sqlx::Result<Option<SceneMap>> {
    let row: Option<(Option<Json<SceneMap>>,)> =
        sqlx::query_as(r#"SELECT entries FROM scene_mappings WHERE "tvdbId" = $1"#)
            .bind(tvdb)
            .fetch_optional(db)
            .await?;
    Ok(row.and_then(|r| r.0).map(|j| j.0))
}

/// The mapping of a series when its library seasons fit the numbering the mapping targets.
pub async fn for_media(db: &PgPool, media_id: i32) -> sqlx::Result<Option<SceneMap>> {
    let tvdb: Option<i32> = sqlx::query_scalar(
        r#"SELECT value::int FROM media_external_ids
           WHERE "mediaId" = $1 AND kind = 'series' AND provider = 'tvdb'"#,
    )
    .bind(media_id)
    .fetch_optional(db)
    .await?;
    let Some(map) = (match tvdb {
        Some(id) => stored(db, id).await?,
        None => None,
    }) else {
        return Ok(None);
    };
    let counts: Vec<(i32, i64)> = sqlx::query_as(
        r#"SELECT g."number", count(i.id) FROM item_groups g
           LEFT JOIN items i ON i."groupId" = g.id
           WHERE g."mediaId" = $1 GROUP BY g."number""#,
    )
    .bind(media_id)
    .fetch_all(db)
    .await?;
    let library: BTreeMap<i64, i64> = counts.into_iter().map(|(s, n)| (s.into(), n)).collect();
    Ok(map.fits(&library).then_some(map))
}

/// A fetched mapping replaces the stored one; a failure leaves it as it was.
async fn keep_or_store(db: &PgPool, tvdb: i32, fetched: Result<SceneMap, String>) {
    let map = match fetched {
        Ok(m) => m,
        Err(e) => return tracing::warn!("scene mapping {tvdb}: keeping the stored one: {e}"),
    };
    let saved = sqlx::query(
        r#"UPDATE scene_mappings SET entries = $2, "fetchedAt" = now() WHERE "tvdbId" = $1"#,
    )
    .bind(tvdb)
    .bind(Json(&map))
    .execute(db)
    .await;
    if let Err(e) = saved {
        tracing::warn!("scene mapping {tvdb}: cannot store: {e}");
    }
}

async fn get(http: &Guarded, path: &str, query: &[(String, String)]) -> Result<Value, String> {
    http.get_json(path, query, Priority::Background)
        .await
        .map_err(|e| e.to_string())
}

/// Lists the mapped TVDB ids, then fetches the mapping of each one a library series carries.
pub async fn refresh(db: &PgPool) -> sqlx::Result<()> {
    let http = Guarded::new(
        "TheXEM",
        BASE,
        Duration::from_secs(20),
        vec![],
        Limits::new(1.0, 1),
    );
    let origin = ("origin".to_owned(), "tvdb".to_owned());
    match get(&http, "/map/havemap", std::slice::from_ref(&origin))
        .await
        .and_then(|v| parse_havemap(&v))
    {
        Ok(ids) => {
            let ids: Vec<i32> = ids
                .into_iter()
                .filter_map(|i| i32::try_from(i).ok())
                .collect();
            sqlx::query(
                r#"INSERT INTO scene_mappings ("tvdbId") SELECT unnest($1::int[])
                   ON CONFLICT DO NOTHING"#,
            )
            .bind(ids)
            .execute(db)
            .await?;
        }
        Err(e) => tracing::warn!("scene mappings list: keeping the stored one: {e}"),
    }
    let wanted: Vec<i32> = sqlx::query_scalar(
        r#"SELECT DISTINCT s."tvdbId" FROM scene_mappings s
           JOIN media_external_ids x ON x.provider = 'tvdb' AND x.kind = 'series'
             AND x.value = s."tvdbId"::text"#,
    )
    .fetch_all(db)
    .await?;
    for id in wanted {
        let query = [origin.clone(), ("id".into(), id.to_string())];
        let fetched = get(&http, "/map/all", &query)
            .await
            .and_then(|v| SceneMap::from_xem(&v));
        keep_or_store(db, id, fetched).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> SceneMap {
        let body = include_str!("../../../fixtures/scene-numbering/map-all.json");
        SceneMap::from_xem(&serde_json::from_str(body).unwrap()).unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn a_failed_fetch_keeps_the_stored_mapping(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        sqlx::query(r#"INSERT INTO scene_mappings ("tvdbId") VALUES (375921)"#)
            .execute(&db)
            .await
            .unwrap();
        assert!(stored(&db, 375921).await.unwrap().is_none());
        keep_or_store(&db, 375921, Ok(fixture())).await;
        keep_or_store(&db, 375921, Err("HTTP 503".into())).await;
        assert_eq!(stored(&db, 375921).await.unwrap(), Some(fixture()));
    }
}
