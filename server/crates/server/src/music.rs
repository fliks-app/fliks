//! Track view, composers, recordings and recently played (`docs/spec/music.md` rules 44-49).
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    libraries::{accessible_library_ids, paths_visible},
    media::{
        hydrate,
        music::{attach_list_info, track_rows},
        params::{Reader, paging_of},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
};
use fliks_domain::{
    acl::{Action, Subject},
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::limiter::Priority,
};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tracks", get(tracks))
        .route("/api/music/want-recording", post(want_recording))
        .route("/api/music/albums/tracks", get(album_tracks))
        .route("/api/composers/{id}/works", get(composer_works))
        .route("/api/works/{id}/recordings", get(recordings))
        .route("/api/playback/recently-played", get(recently_played))
}

type Pairs = Query<Vec<(String, String)>>;

#[utoipa::path(get, path = "/api/tracks", responses((status = 200)))]
pub async fn tracks(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Pairs,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let mut r = Reader::new(
        &q,
        &[
            "libraryId",
            "ids",
            "q",
            "favourite",
            "sortBy",
            "sortOrder",
            "page",
            "limit",
            "after",
        ],
    );
    let (library, text) = (r.int("libraryId"), r.string("q"));
    let wanted = r.string("ids");
    let favourite = r.flag("favourite") == Some(true);
    let sort = r.one_of("sortBy", &["title", "album", "added", "played"]);
    let order = r.one_of("sortOrder", &["asc", "desc", "ASC", "DESC"]);
    let (page, limit) = (r.number("page"), r.number("limit"));
    let after = r.int("after");
    if after.is_some() && sort.as_deref().is_some_and(|s| s != "title") {
        r.errors.push("after requires sortBy=title".to_owned());
    }
    r.finish()?;
    let (limit, offset) =
        paging_of(page, Some(limit.unwrap_or(50.0).min(200.0)), 50.0)?.unwrap_or((50, 0));
    let acl = accessible_library_ids(&st.db, &a).await?;
    let uid = a.user.id;
    if let Some(list) = wanted {
        let ids = parse_ids(&list)?;
        return Ok(Json(Value::Array(
            track_rows(&st.db, uid, &acl, &ids).await?,
        )));
    }
    let cursor = match after {
        Some(id) => {
            let key = sqlx::query_scalar!(
                r#"SELECT lower(title) AS "key?" FROM items WHERE id = $1"#,
                id
            )
            .fetch_optional(&st.db)
            .await?
            .ok_or_else(|| AppError::bad_request(vec!["after must be an item id".to_owned()]))?;
            Some((id, key))
        }
        None => None,
    };
    let dir = if order.is_some_and(|o| o.eq_ignore_ascii_case("desc")) {
        "DESC"
    } else {
        "ASC"
    };
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
        r#"SELECT i.id FROM items i JOIN media m ON m.id = i."mediaId" AND m.type = 'album'
JOIN editions e ON e.id = i."editionId" JOIN track_details td ON td."itemId" = i.id
LEFT JOIN LATERAL (SELECT max(h."playedAt") AS at FROM playback_history h
    WHERE h."userId" = "#,
    );
    qb.push_bind(uid)
        .push(
            r#" AND h."itemId" = i.id) lp ON true
WHERE EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = i.id)
  AND COALESCE(e."libraryId", m."libraryId") = ANY("#,
        )
        .push_bind(&acl)
        .push(")");
    if let Some(l) = library {
        qb.push(r#" AND COALESCE(e."libraryId", m."libraryId") = "#)
            .push_bind(l);
    }
    if let Some(t) = text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        let like = fliks_domain::media::search::contains_pattern(t);
        qb.push(r#" AND td."searchText" ILIKE f_unaccent("#)
            .push_bind(like)
            .push(")");
    }
    if favourite {
        qb.push(r#" AND EXISTS (SELECT 1 FROM likes l WHERE l."userId" = "#)
            .push_bind(uid)
            .push(r#" AND l."itemId" = i.id)"#);
    }
    if let Some((id, key)) = cursor {
        push_after(&mut qb, dir, id, key);
    }
    qb.push(" ORDER BY ").push(match sort.as_deref() {
        Some("album") => {
            format!(r#"lower(m.title) {dir}, td."discNumber" {dir}, td.position {dir}"#)
        }
        Some("added") => format!(r#"i."createdAt" {dir}"#),
        Some("played") => format!("lp.at {dir} NULLS LAST"),
        _ => format!("lower(i.title) {dir}"),
    });
    qb.push(", i.id LIMIT ")
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(if after.is_some() { 0 } else { offset });
    let ids: Vec<i32> = qb.build_query_scalar().fetch_all(&st.db).await?;
    Ok(Json(Value::Array(
        track_rows(&st.db, uid, &acl, &ids).await?,
    )))
}

/// The rows after the track `id` (title key `key`) in `ORDER BY lower(i.title) {dir}, i.id`, whose nulls sort last
/// ascending and first descending.
fn push_after(qb: &mut QueryBuilder<Postgres>, dir: &str, id: i32, key: Option<String>) {
    match (dir, key) {
        ("ASC", Some(k)) => qb
            .push(" AND ((lower(i.title), i.id) > (")
            .push_bind(k)
            .push(", ")
            .push_bind(id)
            .push(") OR i.title IS NULL)"),
        ("ASC", None) => qb.push(" AND i.title IS NULL AND i.id > ").push_bind(id),
        (_, Some(k)) => qb
            .push(" AND (lower(i.title) < ")
            .push_bind(k.clone())
            .push(" OR (lower(i.title) = ")
            .push_bind(k)
            .push(" AND i.id > ")
            .push_bind(id)
            .push("))"),
        (_, None) => qb
            .push(" AND (i.title IS NOT NULL OR i.id > ")
            .push_bind(id)
            .push(")"),
    };
}

/// `ids=1,2,3`: at most `IDS_MAX` positive integers.
fn parse_ids(list: &str) -> Result<Vec<i32>, AppError> {
    let ids = list
        .split(',')
        .map(|p| p.trim().parse::<i32>().ok().filter(|i| *i > 0))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| AppError::bad_request("ids must be a list of integers"))?;
    if ids.len() > IDS_MAX {
        return Err(AppError::bad_request(format!(
            "ids must contain no more than {IDS_MAX} elements"
        )));
    }
    Ok(ids)
}

const IDS_MAX: usize = 500;

pub(crate) async fn assert_track(st: &AppState, a: &Authed, item: i32) -> Result<(), AppError> {
    let acl = accessible_library_ids(&st.db, a).await?;
    let ok: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM items i JOIN media m ON m.id = i."mediaId" AND m.type = 'album'
             JOIN editions e ON e.id = i."editionId" JOIN track_details td ON td."itemId" = i.id
             WHERE i.id = $1 AND COALESCE(e."libraryId", m."libraryId") = ANY($2))"#,
    )
    .bind(item)
    .bind(&acl)
    .fetch_one(&st.db)
    .await?;
    ok.then_some(())
        .ok_or_else(|| AppError::not_found(format!("Item #{item} not found")))
}

/// `POST /api/music/want-recording` (`docs/spec/music.md` rule 73).
#[utoipa::path(post, path = "/api/music/want-recording", responses((status = 201)))]
pub async fn want_recording(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Create, Subject::Media)?;
    crate::media::write::album_import::want_recording(&st, &a, v).await
}

/// `GET /api/music/albums/tracks` (`docs/spec/music.md` rule 74): the tracklist an album added to a library would get.
#[utoipa::path(get, path = "/api/music/albums/tracks", responses((status = 200)))]
pub async fn album_tracks(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Pairs,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Create, Subject::Media)?;
    let bad = |m: &str| AppError::bad_request(vec![m.to_owned()]);
    let mut r = Reader::new(&q, &["provider", "externalId", "libraryId"]);
    let (provider, external, library) = (
        r.string("provider"),
        r.string("externalId"),
        r.int("libraryId"),
    );
    r.finish()?;
    let (Some(provider), Some(external), Some(library)) = (provider, external, library) else {
        return Err(bad("provider, externalId and libraryId are required"));
    };
    let known = st.namespaces();
    let ns = known
        .parse(&provider)
        .filter(|n| st.metadata.serves(*n, MediaKind::Album))
        .ok_or_else(|| bad("provider is not a music provider"))?;
    let group = known
        .normalize(ns, &external)
        .ok_or_else(|| bad("externalId is not a provider id"))?;
    if ns != Namespace::MUSICBRAINZ {
        return Ok(Json(Value::Array(vec![])));
    }
    if !accessible_library_ids(&st.db, &a).await?.contains(&library) {
        return Err(AppError::not_found(format!("Library #{library} not found")));
    }
    let tracks =
        crate::metadata::music::tracklist(&st, &group, library, Priority::Interactive).await?;
    Ok(Json(Value::Array(
        tracks
            .iter()
            .map(|t| {
                json!({"recordingId": t.recording_id, "discNumber": t.disc_number, "position": t.position,
                       "number": t.number, "title": t.title, "durationMs": t.duration_ms})
            })
            .collect(),
    )))
}

/// The tracks of a readable edition that play the work `{W}` or one of its movements.
fn plays(work: &str) -> String {
    format!(
        r#"FROM item_works iw JOIN items i ON i.id = iw."itemId" JOIN media m ON m.id = i."mediaId"
  JOIN editions e ON e.id = i."editionId"
  WHERE iw."workId" IN (SELECT {work} UNION SELECT id FROM works WHERE "parentWorkId" = {work})
    AND COALESCE(e."libraryId", m."libraryId") = ANY($2)
    AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = i.id)"#
    )
}

#[utoipa::path(get, path = "/api/composers/{id}/works", responses((status = 200)))]
pub async fn composer_works(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let id = id?.0;
    let acl = accessible_library_ids(&st.db, &a).await?;
    let sql = format!(
        r#"SELECT jsonb_build_object('workId', w.id, 'title', w.title,
  'children', COALESCE((SELECT jsonb_agg(jsonb_build_object('workId', c.id, 'title', c.title) ORDER BY c.id)
      FROM works c WHERE c."parentWorkId" = w.id), '[]'::jsonb),
  'recordingCount', (SELECT count(DISTINCT i.id) {})) AS j
FROM works w WHERE w."composerPersonId" = $1 AND w."parentWorkId" IS NULL
  AND EXISTS (SELECT 1 {}) ORDER BY w.title, w.id"#,
        plays("w.id"),
        plays("w.id")
    );
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(&acl)
        .fetch_all(&st.db)
        .await?;
    Ok(Json(Value::Array(rows)))
}

#[utoipa::path(get, path = "/api/works/{id}/recordings", responses((status = 200)))]
pub async fn recordings(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let id = id?.0;
    let acl = accessible_library_ids(&st.db, &a).await?;
    let sql = format!(
        r#"SELECT jsonb_build_object('itemId', i.id, 'mediaId', m.id, 'albumTitle', m.title,
  'posterUrl', m."posterUrl", 'title', COALESCE(i.title, ''),
  'performers', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'role', c.role)
      ORDER BY c.role, c.position) FROM item_credits c JOIN persons p ON p.id = c."personId"
      WHERE c."itemId" = i.id AND c.role NOT IN ('composer', 'lyricist')), '[]'::jsonb),
  'year', m.year, 'durationSeconds', (SELECT td."durationMs"::float8 / 1000 FROM track_details td
      WHERE td."itemId" = i.id),
  'gain', (SELECT td.gain FROM track_details td WHERE td."itemId" = i.id),
  'peak', (SELECT td.peak FROM track_details td WHERE td."itemId" = i.id),
  'mediaFileId', (SELECT p."mediaFileId" FROM item_parts p WHERE p."itemId" = i.id
      ORDER BY p.version DESC, p.position LIMIT 1))
{} GROUP BY i.id, m.id ORDER BY m.title, i.id"#,
        plays("$1::int")
    );
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(&acl)
        .fetch_all(&st.db)
        .await?;
    Ok(Json(Value::Array(rows)))
}

#[utoipa::path(get, path = "/api/playback/recently-played", responses((status = 200)))]
pub async fn recently_played(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Pairs,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let limit = q
        .iter()
        .find(|(k, _)| k == "limit")
        .and_then(|(_, v)| v.parse::<i64>().ok())
        .map_or(20, |l| l.clamp(1, 50));
    let acl = accessible_library_ids(&st.db, &a).await?;
    let ids: Vec<i32> = sqlx::query_scalar(
        r#"SELECT m.id FROM playback_history h JOIN items i ON i.id = h."itemId"
           JOIN media m ON m.id = i."mediaId" AND m.type = 'album'
           WHERE h."userId" = $1 AND m."libraryId" = ANY($2)
           GROUP BY m.id ORDER BY max(h."playedAt") DESC, m.id LIMIT $3"#,
    )
    .bind(a.user.id)
    .bind(&acl)
    .bind(limit)
    .fetch_all(&st.db)
    .await?;
    let mut data =
        hydrate::items_view(&st.db, &ids, paths_visible(&a.perms), true, Some(&acl)).await?;
    attach_list_info(&st.db, &mut data, a.user.id, &acl).await?;
    Ok(Json(Value::Array(data)))
}

#[cfg(test)]
mod tests {
    use crate::{auth::testing, config::Config, state::AppState};
    use axum::{body::Body, http::Request};
    use serde_json::Value;
    use sqlx::PgPool;
    use tower::ServiceExt;

    #[sqlx::test(migrations = false)]
    async fn after_walks_the_title_sort_like_one_page(pool: PgPool) {
        crate::db::migrate(&pool).await.unwrap();
        let st = AppState::new(
            pool.clone(),
            Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        );
        sqlx::raw_sql(
            r#"
            INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL);
            INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'L1', '["album"]');
            INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
            INSERT INTO media (id, title, year, type, "libraryId", "folderName") VALUES (10, 'Alpha', 1973, 'album', 1, 'a');
            INSERT INTO editions (id, "mediaId", family) VALUES (1, 10, 'audio');
            INSERT INTO items (id, "mediaId", "editionId", title) VALUES (1, 10, 1, 'b'), (2, 10, 1, 'A'), (3, 10, 1, NULL), (4, 10, 1, 'a');
            INSERT INTO track_details ("itemId", "mediaId", position) VALUES (1, 10, 1), (2, 10, 2), (3, 10, 3), (4, 10, 4);
            INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality)
              SELECT n, 10, 1, n || '.flac', 1, 'FLAC' FROM generate_series(1, 4) n;
            INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
              SELECT n, n, 10, 0, 0 FROM generate_series(1, 4) n;
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let t = testing::token(&st, 1, "admin").await;
        let app = super::router().with_state(st);
        let get = |uri: String| {
            let (app, t) = (app.clone(), t.clone());
            async move {
                let req = Request::get(uri)
                    .header("authorization", format!("Bearer {t}"))
                    .body(Body::empty())
                    .unwrap();
                let res = app.oneshot(req).await.unwrap();
                let status = res.status().as_u16();
                let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
                    .await
                    .unwrap();
                let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                let ids: Vec<i64> = body
                    .as_array()
                    .map(|a| a.iter().map(|r| r["itemId"].as_i64().unwrap()).collect())
                    .unwrap_or_default();
                (status, ids)
            }
        };
        for (order, want) in [("asc", vec![2, 4, 1, 3]), ("desc", vec![3, 1, 2, 4])] {
            assert_eq!(get(format!("/api/tracks?sortOrder={order}")).await.1, want);
            let mut walked = vec![];
            let mut uri = format!("/api/tracks?sortOrder={order}&limit=1");
            while let (200, page) = get(uri.clone()).await {
                let Some(&last) = page.last() else { break };
                walked.extend(page);
                assert!(walked.len() <= want.len(), "{order}: {walked:?}");
                uri = format!("/api/tracks?sortOrder={order}&limit=1&after={last}");
            }
            assert_eq!(walked, want, "{order}");
        }
        assert_eq!(get("/api/tracks?sortBy=added&after=1".into()).await.0, 400);
        assert_eq!(get("/api/tracks?after=999".into()).await.0, 400);
    }

    #[sqlx::test(migrations = false)]
    async fn a_shared_recording_is_listed_once_and_plays_through_both_albums(pool: PgPool) {
        crate::db::migrate(&pool).await.unwrap();
        let st = AppState::new(
            pool.clone(),
            Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        );
        sqlx::raw_sql(
            r#"
            INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL);
            INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'L1', '["album"]');
            INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
            INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES
              (10, 'Alpha', 'album', 1, 'a'), (11, 'Alpha Deluxe', 'album', 1, 'b');
            INSERT INTO editions (id, "mediaId", family) VALUES (1, 10, 'audio'), (2, 11, 'audio');
            INSERT INTO items (id, "mediaId", "editionId", title) VALUES (1, 10, 1, 'One'), (2, 11, 2, 'One');
            INSERT INTO track_details ("itemId", "mediaId", position, "recordingMbid") VALUES
              (1, 10, 1, 'b0000000-0000-4000-8000-000000000001'), (2, 11, 1, 'b0000000-0000-4000-8000-000000000001');
            INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality)
              VALUES (1, 10, 1, '1.flac', 1, 'FLAC');
            INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES (1, 1, 10, 0, 0);
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let t = testing::token(&st, 1, "admin").await;
        let app = super::router().with_state(st);
        let get = |uri: &'static str| {
            let (app, t) = (app.clone(), t.clone());
            async move {
                let req = Request::get(uri)
                    .header("authorization", format!("Bearer {t}"))
                    .body(Body::empty())
                    .unwrap();
                let res = app.oneshot(req).await.unwrap();
                let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
                    .await
                    .unwrap();
                serde_json::from_slice::<Value>(&bytes).unwrap()
            }
        };
        let listed = get("/api/tracks").await;
        assert_eq!(listed.as_array().unwrap().len(), 1, "one row per recording");
        assert_eq!(listed[0]["itemId"], 1);
        let both = get("/api/tracks?ids=1,2").await;
        assert_eq!(
            (&both[1]["hasFile"], &both[1]["mediaFileId"]),
            (&Value::Bool(true), &Value::from(1)),
            "the deluxe track plays the first album's file"
        );
    }
}
