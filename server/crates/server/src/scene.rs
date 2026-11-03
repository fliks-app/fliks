//! TheXEM scene mappings: storage, refresh and the per-media loader (`docs/spec/scene-numbering.md`).
use crate::{ingest::KeyedLocks, metadata::Guarded, state::AppState};
use fliks_domain::{
    metadata::limiter::{Limits, Priority},
    release::scene::{SceneMap, parse_havemap},
};
use serde_json::Value;
use sqlx::{PgPool, types::Json};
use std::{collections::BTreeMap, time::Duration};

pub const BASE: &str = "https://thexem.info";

/// What a series' scene numbering is, as far as is known.
#[derive(Clone, Debug, PartialEq)]
pub enum Mapping {
    /// Names carry aired numbers.
    Unmapped,
    Mapped(SceneMap),
    /// TheXEM maps the series but its mapping is not stored: names cannot be read.
    Unknown,
}

/// The TheXEM client and the per-id lock of an on-demand fetch.
pub struct Xem {
    http: Guarded,
    flights: KeyedLocks<i32>,
}

impl Xem {
    pub fn new(base: &str) -> Self {
        Self {
            http: Guarded::new(
                "TheXEM",
                base,
                Duration::from_secs(20),
                vec![],
                Limits::new(1.0, 1),
            ),
            flights: KeyedLocks::default(),
        }
    }

    async fn get(
        &self,
        path: &str,
        query: &[(String, String)],
        p: Priority,
    ) -> Result<Value, String> {
        self.http
            .get_json(path, query, p)
            .await
            .map_err(|e| e.to_string())
    }

    async fn map(&self, tvdb: i32, p: Priority) -> Result<SceneMap, String> {
        let query = [
            ("origin".to_owned(), "tvdb".to_owned()),
            ("id".into(), tvdb.to_string()),
        ];
        SceneMap::from_xem(&self.get("/map/all", &query, p).await?)
    }
}

/// `None` when the series has no row; `Some(None)` when its mapping is not fetched yet.
async fn stored(db: &PgPool, tvdb: i32) -> sqlx::Result<Option<Option<SceneMap>>> {
    let row: Option<(Option<Json<SceneMap>>,)> =
        sqlx::query_as(r#"SELECT entries FROM scene_mappings WHERE "tvdbId" = $1"#)
            .bind(tvdb)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|r| r.0.map(|j| j.0)))
}

async fn tvdb_of(db: &PgPool, media_id: i32) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar(
        r#"SELECT value::int FROM media_external_ids
           WHERE "mediaId" = $1 AND kind = 'series' AND provider = 'tvdb'"#,
    )
    .bind(media_id)
    .fetch_optional(db)
    .await
}

/// A stored mapping when the library's seasons fit the numbering it targets.
async fn applied(db: &PgPool, media_id: i32, map: SceneMap) -> sqlx::Result<Mapping> {
    let counts: Vec<(i32, i64)> = sqlx::query_as(
        r#"SELECT g."number", count(i.id) FROM item_groups g
           LEFT JOIN items i ON i."groupId" = g.id
           WHERE g."mediaId" = $1 GROUP BY g."number""#,
    )
    .bind(media_id)
    .fetch_all(db)
    .await?;
    let library: BTreeMap<i64, i64> = counts.into_iter().map(|(s, n)| (s.into(), n)).collect();
    Ok(if map.fits(&library) {
        Mapping::Mapped(map)
    } else {
        Mapping::Unmapped
    })
}

/// The stored state of a series, with no call to TheXEM.
pub async fn stored_mapping(db: &PgPool, media_id: i32) -> sqlx::Result<Mapping> {
    let Some(tvdb) = tvdb_of(db, media_id).await? else {
        return Ok(Mapping::Unmapped);
    };
    match stored(db, tvdb).await? {
        None => Ok(Mapping::Unmapped),
        Some(None) => Ok(Mapping::Unknown),
        Some(Some(map)) => applied(db, media_id, map).await,
    }
}

/// The state of a series; an unknown mapping is fetched once, on demand.
pub async fn for_media(st: &AppState, media_id: i32) -> sqlx::Result<Mapping> {
    let db = &st.db;
    let state = stored_mapping(db, media_id).await?;
    let (Mapping::Unknown, Some(tvdb)) = (&state, tvdb_of(db, media_id).await?) else {
        return Ok(state);
    };
    let _flight = st.xem.flights.lock(tvdb).await;
    if let Some(Some(map)) = stored(db, tvdb).await? {
        return applied(db, media_id, map).await;
    }
    keep_or_store(db, tvdb, st.xem.map(tvdb, Priority::Interactive).await).await;
    match stored(db, tvdb).await? {
        Some(Some(map)) => applied(db, media_id, map).await,
        _ => Ok(Mapping::Unknown),
    }
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

/// Lists the mapped TVDB ids, then fetches the mapping of each one a library series carries.
pub async fn refresh(st: &AppState) -> sqlx::Result<()> {
    let (db, xem) = (&st.db, &st.xem);
    let origin = ("origin".to_owned(), "tvdb".to_owned());
    let listed = xem.get(
        "/map/havemap",
        std::slice::from_ref(&origin),
        Priority::Background,
    );
    match listed.await.and_then(|v| parse_havemap(&v)) {
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
        let _flight = xem.flights.lock(id).await;
        keep_or_store(db, id, xem.map(id, Priority::Background).await).await;
    }
    Ok(())
}

/// A fresh deploy learns which series are mapped without waiting for the nightly job.
pub fn spawn_boot_refresh(st: &AppState) {
    let st = st.clone();
    tokio::spawn(async move {
        let empty =
            sqlx::query_scalar::<_, bool>("SELECT NOT EXISTS (SELECT 1 FROM scene_mappings)")
                .fetch_one(&st.db)
                .await;
        if empty.unwrap_or(false)
            && let Err(e) = refresh(&st).await
        {
            tracing::warn!("scene mappings boot refresh failed: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const ALL: &str = include_str!("../../../fixtures/scene-numbering/map-all.json");
    const HAVEMAP: &str = include_str!("../../../fixtures/scene-numbering/havemap.json");
    const UNKNOWN: &str = include_str!("../../../fixtures/scene-numbering/map-unknown.json");
    const TVDB: i32 = 375921;

    fn fixture() -> SceneMap {
        SceneMap::from_xem(&serde_json::from_str(ALL).unwrap()).unwrap()
    }

    /// A loopback server answering 200 with the body of the first route its request line holds.
    async fn stub(routes: Vec<(&'static str, &'static str)>) -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move {
            loop {
                let Ok((mut c, _)) = l.accept().await else {
                    return;
                };
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0; 4096];
                    let n = c.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]);
                    let line = head.lines().next().unwrap_or("");
                    let body = routes
                        .iter()
                        .find(|r| line.contains(r.0))
                        .map_or("", |r| r.1);
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = c.write_all(reply.as_bytes()).await;
                });
            }
        });
        url
    }

    fn state(db: &PgPool, xem: &str) -> AppState {
        let xem = xem.to_owned();
        let cfg = Config::from_lookup(move |k| (k == "FLIKS_XEM_API_URL").then(|| xem.clone()));
        AppState::new(db.clone(), cfg, "0123456789abcdef0123456789abcdef")
    }

    /// A series carrying `TVDB` whose library seasons hold `seasons` as (number, episodes).
    async fn series(db: &PgPool, seasons: &[(i32, i32)]) {
        sqlx::raw_sql(
            r#"INSERT INTO libraries (id, name) VALUES (1, 'L');
               INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
               INSERT INTO media (id, title, type, "libraryId") VALUES (1, 'Show', 'series', 1);
               INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES (1, 'series', 'tvdb', '375921')"#,
        )
        .execute(db)
        .await
        .unwrap();
        let mut c = db.acquire().await.unwrap();
        let kind = fliks_domain::media::kind::MediaKind::Series;
        crate::media::items::create_shell(&mut c, 1, kind, Default::default())
            .await
            .unwrap();
        drop(c);
        let edition = crate::media::items::video_edition(db, 1).await.unwrap();
        for (n, eps) in seasons {
            let g: i32 = sqlx::query_scalar(r#"INSERT INTO item_groups ("mediaId", "number", monitored) VALUES (1, $1, true) RETURNING id"#)
                .bind(n)
                .fetch_one(db)
                .await
                .unwrap();
            sqlx::query(r#"INSERT INTO items ("mediaId", "editionId", "groupId", "number", monitored) SELECT 1, $1, $2, e, true FROM generate_series(1, $3) e"#)
                .bind(edition)
                .bind(g)
                .bind(eps)
                .execute(db)
                .await
                .unwrap();
        }
    }

    async fn store(db: &PgPool, with: Option<SceneMap>) {
        sqlx::query(r#"INSERT INTO scene_mappings ("tvdbId", entries) VALUES ($1, $2)"#)
            .bind(TVDB)
            .bind(with.map(Json))
            .execute(db)
            .await
            .unwrap();
    }

    #[sqlx::test(migrations = false)]
    async fn a_failed_fetch_keeps_the_stored_mapping(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        store(&db, None).await;
        assert_eq!(stored(&db, TVDB).await.unwrap(), Some(None));
        keep_or_store(&db, TVDB, Ok(fixture())).await;
        keep_or_store(&db, TVDB, Err("HTTP 503".into())).await;
        assert_eq!(stored(&db, TVDB).await.unwrap(), Some(Some(fixture())));
    }

    #[sqlx::test(migrations = false)]
    async fn refresh_keeps_the_stored_mapping_on_a_failure_body(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        series(&db, &[(1, 10), (2, 7), (3, 8)]).await;
        store(&db, Some(fixture())).await;
        let url = stub(vec![("havemap", HAVEMAP), ("map/all", UNKNOWN)]).await;
        refresh(&state(&db, &url)).await.unwrap();
        assert_eq!(stored(&db, TVDB).await.unwrap(), Some(Some(fixture())));
        let listed: i64 = sqlx::query_scalar("SELECT count(*) FROM scene_mappings")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(listed, 5, "every listed id has a row");
    }

    #[sqlx::test(migrations = false)]
    async fn a_library_that_does_not_fit_is_not_mapped(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        series(&db, &[(1, 5), (2, 7), (3, 8)]).await;
        store(&db, Some(fixture())).await;
        assert_eq!(stored_mapping(&db, 1).await.unwrap(), Mapping::Unmapped);
        sqlx::query(r#"INSERT INTO items ("mediaId", "editionId", "groupId", "number") SELECT 1, "editionId", "groupId", n FROM items, generate_series(6, 10) n WHERE "groupId" = (SELECT min(id) FROM item_groups) AND "number" = 1"#)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            stored_mapping(&db, 1).await.unwrap(),
            Mapping::Mapped(fixture())
        );
    }

    #[sqlx::test(migrations = false)]
    async fn an_unknown_mapping_is_fetched_on_demand_and_refuses_when_it_fails(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        series(&db, &[(1, 10), (2, 7), (3, 8)]).await;
        store(&db, None).await;
        assert_eq!(stored_mapping(&db, 1).await.unwrap(), Mapping::Unknown);
        let down = state(&db, &stub(vec![("map/all", UNKNOWN)]).await);
        assert_eq!(for_media(&down, 1).await.unwrap(), Mapping::Unknown);
        let up = state(&db, &stub(vec![("map/all", ALL)]).await);
        assert_eq!(for_media(&up, 1).await.unwrap(), Mapping::Mapped(fixture()));
        assert_eq!(stored(&db, TVDB).await.unwrap(), Some(Some(fixture())));
    }
}
