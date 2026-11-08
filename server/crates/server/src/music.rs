//! Track view, ratings, composers, recordings and recently played (`docs/spec/music.md` rules 44-49).
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
    routing::{get, put},
};
use fliks_domain::acl::{Action, Subject};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tracks", get(tracks))
        .route("/api/items/{itemId}/rating", put(rate).delete(unrate))
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
            "q",
            "favourite",
            "rated",
            "sortBy",
            "sortOrder",
            "page",
            "limit",
        ],
    );
    let (library, text) = (r.int("libraryId"), r.string("q"));
    let (favourite, rated) = (
        r.flag("favourite") == Some(true),
        r.flag("rated") == Some(true),
    );
    let sort = r.one_of("sortBy", &["title", "album", "added", "played", "rating"]);
    let order = r.one_of("sortOrder", &["asc", "desc", "ASC", "DESC"]);
    let (page, limit) = (r.number("page"), r.number("limit"));
    r.finish()?;
    let (limit, offset) =
        paging_of(page, Some(limit.unwrap_or(50.0).min(200.0)), 50.0)?.unwrap_or((50, 0));
    let acl = accessible_library_ids(&st.db, &a).await?;
    let uid = a.user.id;
    let dir = if order.is_some_and(|o| o.eq_ignore_ascii_case("desc")) {
        "DESC"
    } else {
        "ASC"
    };
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
        r#"SELECT i.id FROM items i JOIN media m ON m.id = i."mediaId" AND m.type = 'album'
JOIN editions e ON e.id = i."editionId" JOIN track_details td ON td."itemId" = i.id
LEFT JOIN item_ratings r ON r."userId" = "#,
    );
    qb.push_bind(uid)
        .push(
            r#" AND r."itemId" = i.id
LEFT JOIN LATERAL (SELECT max(h."playedAt") AS at FROM playback_history h
    WHERE h."userId" = "#,
        )
        .push_bind(uid)
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
        let like = format!(
            "%{}%",
            t.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        qb.push(" AND (i.title ILIKE ")
            .push_bind(like.clone())
            .push(" OR m.title ILIKE ")
            .push_bind(like)
            .push(")");
    }
    if favourite {
        qb.push(r#" AND EXISTS (SELECT 1 FROM likes l WHERE l."userId" = "#)
            .push_bind(uid)
            .push(r#" AND l."itemId" = i.id)"#);
    }
    if rated {
        qb.push(" AND r.rating IS NOT NULL");
    }
    qb.push(" ORDER BY ").push(match sort.as_deref() {
        Some("album") => {
            format!(r#"lower(m.title) {dir}, td."discNumber" {dir}, td.position {dir}"#)
        }
        Some("added") => format!(r#"i."createdAt" {dir}"#),
        Some("played") => format!("lp.at {dir} NULLS LAST"),
        Some("rating") => format!("r.rating {dir} NULLS LAST"),
        _ => format!("lower(i.title) {dir}"),
    });
    qb.push(", i.id LIMIT ")
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(offset);
    let ids: Vec<i32> = qb.build_query_scalar().fetch_all(&st.db).await?;
    Ok(Json(Value::Array(
        track_rows(&st.db, uid, &acl, &ids).await?,
    )))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RatingDto {
    rating: i32,
}

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

#[utoipa::path(put, path = "/api/items/{itemId}/rating", responses((status = 200)))]
pub async fn rate(
    State(st): State<AppState>,
    a: Authed,
    PathParams(item): PathParams<i32>,
    ValidJson(dto): ValidJson<RatingDto>,
) -> Result<Json<Value>, AppError> {
    if !(1..=5).contains(&dto.rating) {
        return Err(AppError::bad_request(vec![
            "rating must be between 1 and 5".to_owned(),
        ]));
    }
    assert_track(&st, &a, item).await?;
    sqlx::query(
        r#"INSERT INTO item_ratings ("userId", "itemId", rating) VALUES ($1, $2, $3)
           ON CONFLICT ("userId", "itemId") DO UPDATE SET rating = EXCLUDED.rating"#,
    )
    .bind(a.user.id)
    .bind(item)
    .bind(dto.rating as i16)
    .execute(&st.db)
    .await?;
    Ok(Json(json!({"itemId": item, "rating": dto.rating})))
}

#[utoipa::path(delete, path = "/api/items/{itemId}/rating", responses((status = 204)))]
pub async fn unrate(
    State(st): State<AppState>,
    a: Authed,
    PathParams(item): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    assert_track(&st, &a, item).await?;
    sqlx::query(r#"DELETE FROM item_ratings WHERE "userId" = $1 AND "itemId" = $2"#)
        .bind(a.user.id)
        .bind(item)
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
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
        hydrate::items_view(&st.db, &ids, paths_visible(&a.perms), false, Some(&acl)).await?;
    attach_list_info(&st.db, &mut data, a.user.id, &acl).await?;
    Ok(Json(Value::Array(data)))
}
