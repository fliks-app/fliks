//! Works and movements of classical music (`docs/spec/music.md` rule 13): from tags and from provider relations.
use super::people::{self, Credited};
use sqlx::PgConnection;

/// A work as tags or a provider name it: a movement names its parent.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WorkSpec {
    pub mbid: Option<String>,
    pub title: String,
    pub parent_mbid: Option<String>,
    pub parent_title: Option<String>,
    pub composer: Option<Credited>,
}

async fn upsert(
    c: &mut PgConnection,
    mbid: Option<&str>,
    title: &str,
    parent: Option<i32>,
    composer: Option<i32>,
) -> sqlx::Result<i32> {
    let held: Option<i32> = match mbid {
        Some(m) => {
            sqlx::query_scalar("SELECT id FROM works WHERE mbid = $1::uuid")
                .bind(m)
                .fetch_optional(&mut *c)
                .await?
        }
        None => {
            sqlx::query_scalar(
                r#"SELECT id FROM works WHERE mbid IS NULL AND name_key(title) = name_key($1)
                     AND "parentWorkId" IS NOT DISTINCT FROM $2 AND "composerPersonId" IS NOT DISTINCT FROM $3
                   ORDER BY id LIMIT 1"#,
            )
            .bind(title)
            .bind(parent)
            .bind(composer)
            .fetch_optional(&mut *c)
            .await?
        }
    };
    if let Some(id) = held {
        sqlx::query(
            r#"UPDATE works SET "parentWorkId" = COALESCE("parentWorkId", $2), "composerPersonId" = COALESCE("composerPersonId", $3)
               WHERE id = $1 AND $2::int IS DISTINCT FROM id"#,
        )
        .bind(id)
        .bind(parent)
        .bind(composer)
        .execute(&mut *c)
        .await?;
        return Ok(id);
    }
    sqlx::query_scalar(
        r#"INSERT INTO works (mbid, title, "parentWorkId", "composerPersonId") VALUES ($1::uuid, $2, $3, $4)
           ON CONFLICT (mbid) DO UPDATE SET title = works.title RETURNING id"#,
    )
    .bind(mbid)
    .bind(title)
    .bind(parent)
    .bind(composer)
    .fetch_one(&mut *c)
    .await
}

/// The work row of `w` (its parent first): the leaf is what a track plays.
pub async fn work(c: &mut PgConnection, w: &WorkSpec) -> sqlx::Result<i32> {
    let composer = match &w.composer {
        Some(p) => {
            Some(people::person(c, &p.name, p.mbid.as_deref(), p.sort_name.as_deref()).await?)
        }
        None => None,
    };
    let parent = match (
        &w.parent_mbid,
        w.parent_title.as_deref().filter(|t| !t.is_empty()),
    ) {
        (None, None) => None,
        (m, Some(title)) => Some(upsert(c, m.as_deref(), title, None, composer).await?),
        // A parent known by its id only is linked when its row exists.
        (Some(m), None) => {
            sqlx::query_scalar("SELECT id FROM works WHERE mbid = $1::uuid")
                .bind(m)
                .fetch_optional(&mut *c)
                .await?
        }
    };
    upsert(c, w.mbid.as_deref(), &w.title, parent, composer).await
}

/// Replaces the works a track plays, in order.
pub async fn set_track_works(
    c: &mut PgConnection,
    item: i32,
    works: &[WorkSpec],
) -> sqlx::Result<()> {
    if works.is_empty() {
        return Ok(());
    }
    crate::media::write::orphans::hold(c).await?;
    let mut ids: Vec<i32> = vec![];
    for w in works {
        let id = work(c, w).await?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    sqlx::query(r#"DELETE FROM item_works WHERE "itemId" = $1"#)
        .bind(item)
        .execute(&mut *c)
        .await?;
    for (position, id) in ids.into_iter().enumerate() {
        sqlx::query(r#"INSERT INTO item_works ("itemId", "workId", position) VALUES ($1, $2, $3)"#)
            .bind(item)
            .bind(id)
            .bind(position as i32)
            .execute(&mut *c)
            .await?;
    }
    Ok(())
}

use crate::{
    http::{AppError, auth::Authed, validate::PathParams},
    libraries::accessible_library_ids,
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use serde_json::Value;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/works", get(search))
        .route("/api/works/{id}", get(detail))
}

const MAX_LIMIT: i64 = 100;

/// A work as the API shows it: its parent, its composer and the tracks that play it in the libraries the
/// caller can read (a movement counts for its parent).
const SELECT: &str = r#"SELECT jsonb_build_object('id', w.id, 'mbid', w.mbid::text, 'title', w.title,
    'parent', CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id', p.id, 'title', p.title) END,
    'composer', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id', c.id, 'name', c.name) END,
    'trackCount', t.n)
  FROM works w LEFT JOIN works p ON p.id = w."parentWorkId" LEFT JOIN persons c ON c.id = w."composerPersonId"
  CROSS JOIN LATERAL (SELECT count(DISTINCT iw."itemId") AS n FROM item_works iw
      JOIN items i ON i.id = iw."itemId" JOIN media m ON m.id = i."mediaId"
     WHERE m."libraryId" = ANY($1)
       AND (iw."workId" = w.id OR iw."workId" IN (SELECT ch.id FROM works ch WHERE ch."parentWorkId" = w.id))) t
  WHERE t.n > 0"#;

/// `GET /api/works?q=&limit=`: works by title, prefix terms ANDed, those a readable track plays.
#[utoipa::path(get, path = "/api/works", responses((status = 200)))]
pub async fn search(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Json<Value>, AppError> {
    let text = q
        .iter()
        .find(|(k, _)| k == "q")
        .map_or("", |(_, v)| v.trim());
    let limit = q
        .iter()
        .find(|(k, _)| k == "limit")
        .and_then(|(_, v)| v.parse::<i64>().ok())
        .map_or(50, |l| l.clamp(1, MAX_LIMIT));
    let acl = accessible_library_ids(&st.db, &a).await?;
    let tsq = fliks_domain::persons::tsquery(text);
    if !text.is_empty() && tsq.is_none() {
        return Ok(Json(Value::Array(vec![])));
    }
    let sql = format!(
        "{SELECT} AND ($2::text IS NULL OR w.\"searchVector\" @@ to_tsquery('simple', $2)) \
         ORDER BY CASE WHEN $2::text IS NULL THEN 0 ELSE -ts_rank(w.\"searchVector\", to_tsquery('simple', $2)) END, w.title, w.id LIMIT $3"
    );
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(&acl)
        .bind(tsq)
        .bind(limit)
        .fetch_all(&st.db)
        .await?;
    Ok(Json(Value::Array(rows)))
}

/// `GET /api/works/:id`: 404 for a work no readable track plays.
#[utoipa::path(get, path = "/api/works/{id}", responses((status = 200), (status = 404)))]
pub async fn detail(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Json<Value>, AppError> {
    let id = id?.0;
    let acl = accessible_library_ids(&st.db, &a).await?;
    let sql = format!("{SELECT} AND w.id = $2");
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(&acl)
        .bind(id)
        .fetch_optional(&st.db)
        .await?;
    row.map(Json)
        .ok_or_else(|| AppError::not_found(format!("Work #{id} not found")))
}
