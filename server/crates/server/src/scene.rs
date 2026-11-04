//! Scene mappings: storage, refresh and the per-media loader (`docs/spec/scene-numbering.md`). The
//! mappings come from the scene provider plugin, never from the core.
use crate::{ingest::KeyedLocks, metadata::MetadataProvider, state::AppState, sync::MutexExt};
use fliks_domain::{metadata::limiter::Priority, release::scene::SceneMap};
use sqlx::{PgPool, types::Json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// What a series' scene numbering is, as far as is known.
#[derive(Clone, Debug, PartialEq)]
pub enum Mapping {
    /// Names carry aired numbers.
    Unmapped,
    Mapped(SceneMap),
    /// The scene provider lists the series but its mapping is not stored: names cannot be read.
    Unknown,
}

/// The per-id lock of an on-demand fetch and the failures it remembers.
#[derive(Default)]
pub struct Xem {
    flights: KeyedLocks<i32>,
    /// The last failed on-demand fetch per id, so a down provider is asked once per window.
    failed: Mutex<HashMap<i32, Instant>>,
}

const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(30 * 60);

async fn fetched(
    provider: &Arc<dyn MetadataProvider>,
    tvdb: i32,
    p: Priority,
) -> Result<SceneMap, String> {
    let pairs = provider
        .scene_mapping(&tvdb.to_string(), p)
        .await
        .map_err(|e| e.to_string())?;
    pairs
        .map(|entries| SceneMap { entries })
        .ok_or_else(|| "the provider has no mapping for it".to_owned())
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

/// The stored state of a series and its tvdb id, with no call to TheXEM.
async fn lookup(db: &PgPool, media_id: i32) -> sqlx::Result<(Mapping, Option<i32>)> {
    let Some(tvdb) = tvdb_of(db, media_id).await? else {
        return Ok((Mapping::Unmapped, None));
    };
    let state = match stored(db, tvdb).await? {
        None => Mapping::Unmapped,
        Some(None) => Mapping::Unknown,
        Some(Some(map)) => applied(db, media_id, map).await?,
    };
    Ok((state, Some(tvdb)))
}

pub async fn stored_mapping(db: &PgPool, media_id: i32) -> sqlx::Result<Mapping> {
    Ok(lookup(db, media_id).await?.0)
}

/// The state of a series; an unknown mapping is fetched on demand, at most once per window
/// when the provider does not answer.
pub async fn for_media(st: &AppState, media_id: i32) -> sqlx::Result<Mapping> {
    let db = &st.db;
    let (state, Some(tvdb)) = lookup(db, media_id).await? else {
        return Ok(Mapping::Unmapped);
    };
    if state != Mapping::Unknown {
        return Ok(state);
    }
    let Some(provider) = st.metadata.scene_provider() else {
        return Ok(Mapping::Unmapped);
    };
    let _flight = st.xem.flights.lock(tvdb).await;
    if let Some(Some(map)) = stored(db, tvdb).await? {
        return applied(db, media_id, map).await;
    }
    let held_off = st
        .xem
        .failed
        .lock_clean()
        .get(&tvdb)
        .is_some_and(|at| at.elapsed() < RETRY_AFTER_FAILURE);
    if held_off {
        return Ok(Mapping::Unknown);
    }
    let got = fetched(&provider, tvdb, Priority::Interactive).await;
    let failed = got.is_err();
    keep_or_store(db, tvdb, got).await;
    if failed {
        st.xem.failed.lock_clean().insert(tvdb, Instant::now());
        return Ok(Mapping::Unknown);
    }
    st.xem.failed.lock_clean().remove(&tvdb);
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
    let Some(provider) = st.metadata.scene_provider() else {
        return Ok(());
    };
    match provider.scene_mapped_ids(Priority::Background).await {
        Ok(listed) => {
            let ids: Vec<i32> = listed
                .iter()
                .filter_map(|i| i.parse::<i32>().ok())
                .filter(|i| *i > 0)
                .collect();
            sqlx::query(
                r#"INSERT INTO scene_mappings ("tvdbId") SELECT unnest($1::int[])
                   ON CONFLICT DO NOTHING"#,
            )
            .bind(&ids)
            .execute(db)
            .await?;
            sqlx::query(
                r#"DELETE FROM scene_mappings WHERE entries IS NULL AND NOT ("tvdbId" = ANY($1))"#,
            )
            .bind(&ids)
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
        keep_or_store(db, id, fetched(&provider, id, Priority::Background).await).await;
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
    use crate::metadata::stub::scene::SceneStub;
    use std::sync::atomic::Ordering;

    const TVDB: i32 = 375921;

    fn fixture() -> SceneMap {
        serde_json::from_str(include_str!("../../../fixtures/scene-numbering/map.json")).unwrap()
    }

    fn state(db: &PgPool) -> AppState {
        let cfg = Config::from_lookup(|_| None);
        AppState::new(db.clone(), cfg, "0123456789abcdef0123456789abcdef")
    }

    /// A state with a scene provider answering `maps` (the TVDB id as a string to its mapping).
    fn with_provider(db: &PgPool, stub: &Arc<SceneStub>) -> AppState {
        let st = state(db);
        st.metadata.add_plugin(stub.clone());
        st
    }

    fn stub(ids: &[&str], mapped: bool) -> Arc<SceneStub> {
        let s = Arc::new(SceneStub::default());
        *s.ids.lock().unwrap() = ids.iter().map(|i| (*i).to_owned()).collect();
        if mapped {
            s.maps
                .lock()
                .unwrap()
                .insert(TVDB.to_string(), fixture().entries);
        }
        s
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
    async fn refresh_keeps_the_stored_mapping_when_the_provider_has_none(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        series(&db, &[(1, 10), (2, 7), (3, 8)]).await;
        store(&db, Some(fixture())).await;
        let s = stub(&["70668", "375921", "x"], false);
        refresh(&with_provider(&db, &s)).await.unwrap();
        assert_eq!(stored(&db, TVDB).await.unwrap(), Some(Some(fixture())));
        let listed: i64 = sqlx::query_scalar("SELECT count(*) FROM scene_mappings")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(listed, 2, "every valid listed id has a row");
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
        let down = stub(&[], true);
        down.down.store(true, Ordering::SeqCst);
        let st = with_provider(&db, &down);
        assert_eq!(for_media(&st, 1).await.unwrap(), Mapping::Unknown);
        assert_eq!(for_media(&st, 1).await.unwrap(), Mapping::Unknown);
        assert_eq!(
            down.mapping_calls.load(Ordering::SeqCst),
            1,
            "a failed id is not asked again at once"
        );
        let up = stub(&[], true);
        let st = with_provider(&db, &up);
        assert_eq!(for_media(&st, 1).await.unwrap(), Mapping::Mapped(fixture()));
        assert_eq!(stored(&db, TVDB).await.unwrap(), Some(Some(fixture())));
    }

    #[sqlx::test(migrations = false)]
    async fn no_scene_provider_means_unmapped(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        series(&db, &[(1, 10), (2, 7), (3, 8)]).await;
        store(&db, None).await;
        let st = state(&db);
        assert_eq!(for_media(&st, 1).await.unwrap(), Mapping::Unmapped);
        refresh(&st).await.unwrap();
        assert_eq!(stored(&db, TVDB).await.unwrap(), Some(None));
    }

    #[sqlx::test(migrations = false)]
    async fn refresh_drops_unfetched_rows_that_are_no_longer_listed(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        series(&db, &[(1, 10), (2, 7), (3, 8)]).await;
        store(&db, Some(fixture())).await;
        sqlx::query(r#"INSERT INTO scene_mappings ("tvdbId") VALUES (5)"#)
            .execute(&db)
            .await
            .unwrap();
        let s = stub(&["375921"], true);
        let st = with_provider(&db, &s);
        refresh(&st).await.unwrap();
        assert_eq!(stored(&db, 5).await.unwrap(), None);
        assert_eq!(stored(&db, TVDB).await.unwrap(), Some(Some(fixture())));
        sqlx::query(r#"INSERT INTO scene_mappings ("tvdbId", entries) VALUES (6, $1)"#)
            .bind(Json(fixture()))
            .execute(&db)
            .await
            .unwrap();
        refresh(&st).await.unwrap();
        assert!(
            stored(&db, 6).await.unwrap().is_some(),
            "a stored mapping is kept"
        );
    }
}
