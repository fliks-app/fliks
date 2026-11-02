//! `GET /api/media` and `recently-added` (`media-query.md` rules 14-27, 33-34, 67-72).
use super::{
    books, hydrate,
    params::{Recent, Search},
    wants::video_want_join,
};
use chrono::{NaiveDate, Utc};
use fliks_domain::{
    media::{kind::MediaKind, search::prefix_tsquery},
    release::parsing::quality::{APP_QUALITIES, rank_from_quality_string},
};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, QueryBuilder};
use std::collections::HashMap;

/// Rule 22's `<ME>`: a monitored season holds a monitored, aired, not-on-disk episode.
const MISSING_EPISODE: &str = r#"EXISTS (
  SELECT 1 FROM item_groups ms JOIN items me ON me."groupId" = ms.id
  WHERE ms."mediaId" = media.id AND ms."number" > 0
    AND ms.monitored = true AND me.monitored = true
    AND me."airDate" <= "#;
const MISSING_EPISODE_TAIL: &str = r#" AND NOT EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = me.id)
)"#;

/// Distinct stored qualities with their rank, for the cutoff filter in SQL.
struct QualityMap {
    names: Vec<String>,
    ranks: Vec<i32>,
}

async fn quality_map(db: &PgPool) -> Result<QualityMap, sqlx::Error> {
    let names = sqlx::query_scalar!(r#"SELECT DISTINCT quality AS "quality!" FROM media_files"#)
        .fetch_all(db)
        .await?;
    let ranks = names
        .iter()
        .map(|q| rank_from_quality_string(Some(q)) as i32)
        .collect();
    Ok(QualityMap { names, ranks })
}

fn letter_filter(raw: &str) -> Option<String> {
    let up = raw.to_uppercase();
    let mut cs = up.chars();
    match (cs.next(), cs.next()) {
        (Some('#'), None) => Some("#".into()),
        (Some(c), None) if c.is_ascii_uppercase() => Some(up),
        _ => None,
    }
}

/// `FROM` and `WHERE` shared by the page and the count; binds restart at `$1` in each builder.
fn push_scope(
    qb: &mut QueryBuilder<Postgres>,
    p: &Search,
    ids: &[i32],
    uid: i32,
    cutoff: Option<&QualityMap>,
    today: NaiveDate,
) {
    qb.push(" FROM media");
    if cutoff.is_some() || p.quality_profile_id.is_some_and(|v| v != 0) {
        qb.push(" ").push(video_want_join("media"));
    }
    if cutoff.is_some() {
        qb.push(" JOIN quality_profiles qp ON qp.id = w.\"qualityProfileId\" JOIN LATERAL (SELECT t.rank AS cr FROM unnest(");
        qb.push_bind(
            APP_QUALITIES
                .iter()
                .map(|q| q.id as i32)
                .collect::<Vec<_>>(),
        );
        qb.push("::int4[], ");
        qb.push_bind(
            APP_QUALITIES
                .iter()
                .map(|q| q.rank as i32)
                .collect::<Vec<_>>(),
        );
        qb.push("::int4[]) AS t(id, rank) WHERE t.id = qp.cutoff) c ON true");
    }
    qb.push(" WHERE media.\"libraryId\" = ANY(")
        .push_bind(ids.to_vec())
        .push(")");
    if let Some(l) = p.library_id.filter(|l| *l != 0) {
        qb.push(" AND media.\"libraryId\" = ").push_bind(l);
    }
    if let Some(t) = &p.media_type {
        qb.push(" AND media.type = ").push_bind(t.as_str());
    }
    if let Some(s) = &p.status {
        qb.push(" AND media.status::text = ").push_bind(s.clone());
    }
    if let Some(m) = p.monitored {
        qb.push(" AND media.monitored = ").push_bind(m);
    }
    if let Some(y) = p.year.filter(|y| *y != 0) {
        qb.push(" AND media.year = ").push_bind(y);
    }
    if let Some(y) = p.year_min {
        qb.push(" AND media.year >= ").push_bind(y);
    }
    if let Some(y) = p.year_max {
        qb.push(" AND media.year <= ").push_bind(y);
    }
    if let Some(v) = p.vote_min {
        qb.push(" AND media.rating >= ").push_bind(v);
    }
    if let Some(g) = p.genre.as_deref().filter(|g| !g.is_empty()) {
        qb.push(" AND media.genres @> ").push_bind(json!([g]));
    }
    if !p.genres.is_empty() {
        qb.push(" AND media.genres @> ").push_bind(json!(p.genres));
    }
    if let Some(v) = p.collection_id.filter(|v| *v != 0) {
        qb.push(" AND EXISTS (SELECT 1 FROM collection_entries e JOIN collection_external_ids x ON x.\"collectionId\" = e.\"collectionId\" AND x.provider = 'tmdb' WHERE e.\"mediaId\" = media.id AND e.\"itemId\" IS NULL AND x.value = ")
            .push_bind(v.to_string())
            .push(")");
    }
    push_book_filters(qb, p, ids, uid);
    for (table, col, v) in [
        ("w", "qualityProfileId", p.quality_profile_id),
        ("media", "languageProfileId", p.language_profile_id),
    ] {
        if let Some(v) = v.filter(|v| *v != 0) {
            qb.push(format!(" AND {table}.\"{col}\" = ")).push_bind(v);
        }
    }
    match p.missing {
        Some(true) => {
            qb.push(
                " AND (NOT EXISTS (SELECT 1 FROM media_files f WHERE f.\"mediaId\" = media.id) OR ",
            );
            qb.push(MISSING_EPISODE)
                .push_bind(today)
                .push(MISSING_EPISODE_TAIL)
                .push(")");
        }
        Some(false) => {
            qb.push(" AND (EXISTS (SELECT 1 FROM media_files f WHERE f.\"mediaId\" = media.id) AND NOT ");
            qb.push(MISSING_EPISODE)
                .push_bind(today)
                .push(MISSING_EPISODE_TAIL)
                .push(")");
        }
        None => {}
    }
    if p.unidentified {
        qb.push(
            " AND NOT EXISTS (SELECT 1 FROM media_external_ids x WHERE x.\"mediaId\" = media.id)",
        );
    }
    match p
        .letter
        .as_deref()
        .filter(|l| !l.is_empty())
        .and_then(letter_filter)
    {
        Some(l) if l == "#" => {
            qb.push(" AND media.title !~ '^[A-Za-z]'");
        }
        Some(l) => {
            qb.push(" AND UPPER(LEFT(media.title, 1)) = ").push_bind(l);
        }
        None => {}
    }
    if p.exclude_watched || p.only_watched {
        let not = if p.only_watched { "" } else { "NOT " };
        qb.push(format!(
            " AND {not}({})",
            super::watched::predicate(uid, "media")
        ));
    }
    if p.requested_by_me {
        qb.push(" AND media.\"addedById\" = ").push_bind(uid);
    }
    if let Some(q) = p.q.as_deref().filter(|q| !q.is_empty()) {
        push_search(qb, q);
    }
    if let Some(map) = cutoff {
        push_cutoff(qb, map);
    }
}

/// ` AND` an edition `e` readable through its own library, else the work's (`books.md` rule 22).
fn push_visible(qb: &mut QueryBuilder<Postgres>, ids: &[i32]) {
    qb.push(" AND COALESCE(e.\"libraryId\", media.\"libraryId\") = ANY(")
        .push_bind(ids.to_vec())
        .push(")");
}

/// `books-api.md` A1; `Search::parse` already refused these keys for any other type.
fn push_book_filters(qb: &mut QueryBuilder<Postgres>, p: &Search, ids: &[i32], uid: i32) {
    if let Some(f) = &p.format {
        qb.push(" AND EXISTS (SELECT 1 FROM editions e JOIN items i ON i.\"editionId\" = e.id JOIN item_parts ip ON ip.\"itemId\" = i.id WHERE e.\"mediaId\" = media.id AND e.family = ")
            .push_bind(f.clone());
        push_visible(qb, ids);
        qb.push(")");
    }
    if let Some(l) = &p.language {
        qb.push(" AND EXISTS (SELECT 1 FROM editions e WHERE e.\"mediaId\" = media.id AND lower(e.language) = lower(")
            .push_bind(l.clone())
            .push(")");
        push_visible(qb, ids);
        qb.push(")");
    }
    if let Some(a) = p.author_id {
        qb.push(" AND EXISTS (SELECT 1 FROM media_credits c WHERE c.\"mediaId\" = media.id AND c.role = 'author' AND c.\"editionId\" IS NULL AND c.\"personId\" = ")
            .push_bind(a)
            .push(")");
    }
    if let Some(n) = p.narrator_id {
        qb.push(" AND EXISTS (SELECT 1 FROM media_credits c JOIN editions e ON e.id = c.\"editionId\" WHERE c.\"mediaId\" = media.id AND c.role = 'narrator' AND c.\"personId\" = ")
            .push_bind(n);
        push_visible(qb, ids);
        qb.push(")");
    }
    if let Some(s) = p.series_id {
        qb.push(" AND EXISTS (SELECT 1 FROM collection_entries ce WHERE ce.\"mediaId\" = media.id AND ce.\"itemId\" IS NULL AND ce.\"collectionId\" = ")
            .push_bind(s)
            .push(")");
    }
    if p.in_progress {
        qb.push(format!(
            " AND NOT ({}) AND EXISTS (SELECT 1 FROM playback_states ps JOIN items i ON i.id = ps.\"itemId\" JOIN editions e ON e.id = i.\"editionId\" WHERE ps.\"userId\" = ",
            super::watched::predicate(uid, "media")
        ));
        qb.push_bind(uid).push(
            " AND i.\"mediaId\" = media.id AND ps.completed = false AND ps.\"positionSeconds\" > 0",
        );
        push_visible(qb, ids);
        qb.push(")");
    }
}

fn push_tsquery(qb: &mut QueryBuilder<Postgres>, q: &str) {
    let tsq = prefix_tsquery(q);
    if tsq.is_empty() {
        qb.push("plainto_tsquery('french', ")
            .push_bind(q.to_owned())
            .push(")");
    } else {
        qb.push("to_tsquery('french', ").push_bind(tsq).push(")");
    }
}

fn push_search(qb: &mut QueryBuilder<Postgres>, q: &str) {
    qb.push(" AND (media.\"searchVector\" @@ ");
    push_tsquery(qb, q);
    let like = format!("%{q}%");
    qb.push(" OR media.title ILIKE ").push_bind(like.clone());
    qb.push(" OR media.\"originalTitle\" ILIKE ")
        .push_bind(like);
    qb.push(" OR similarity(media.title, ")
        .push_bind(q.to_owned())
        .push(") > 0.8)");
}

/// Rule 26 in SQL: a media without a known cutoff never reaches here (inner join); a kind without seasons compares
/// its best file, a seasonal kind each monitored episode of seasons > 0 not shadowed by a range (pooled across seasons).
fn push_cutoff(qb: &mut QueryBuilder<Postgres>, map: &QualityMap) {
    let rank = |qb: &mut QueryBuilder<Postgres>, files_on: &str| {
        qb.push("COALESCE((SELECT MAX(qr.rank) FROM media_files f JOIN unnest(");
        qb.push_bind(map.names.clone())
            .push("::text[], ")
            .push_bind(map.ranks.clone());
        qb.push(format!(
            "::int4[]) AS qr(q, rank) ON qr.q = f.quality WHERE {files_on}), 0)"
        ));
    };
    qb.push(" AND CASE WHEN media.type = ANY(")
        .push_bind(MediaKind::seasonal_names())
        .push(") THEN EXISTS (SELECT 1 FROM item_groups s JOIN items e ON e.\"groupId\" = s.id WHERE s.\"mediaId\" = media.id AND s.\"number\" > 0 AND e.monitored = true AND ");
    rank(
        qb,
        "EXISTS (SELECT 1 FROM item_parts p WHERE p.\"mediaFileId\" = f.id AND p.\"itemId\" = e.id)",
    );
    qb.push(" < c.cr AND NOT EXISTS (SELECT 1 FROM item_groups s2 JOIN items o ON o.\"groupId\" = s2.id WHERE s2.\"mediaId\" = media.id AND s2.\"number\" > 0 AND o.monitored = true AND o.\"endNumber\" IS NOT NULL AND e.\"number\" > o.\"number\" AND e.\"number\" <= o.\"endNumber\")) ELSE ");
    rank(qb, "f.\"mediaId\" = media.id");
    qb.push(" < c.cr END ");
}

/// The first series of a work (lowest collection id), as `books-api.md` A3 reads it.
const FIRST_SERIES: &str = r#"(SELECT {col} FROM collection_entries se JOIN collections sc ON sc.id = se."collectionId"
  WHERE se."mediaId" = media.id AND se."itemId" IS NULL ORDER BY sc.id LIMIT 1)"#;

const PUBLISHED: &str = r#"COALESCE((SELECT d.date FROM media_release_dates d
  WHERE d."mediaId" = media.id AND d."editionId" IS NULL AND d.kind = 'release'),
  CASE WHEN media.year BETWEEN 1 AND 9999 THEN make_date(media.year, 1, 1) END)"#;

/// `books-api.md` A2: the book sorts put works without the data last in either direction.
fn order_sql(p: &Search, dir: &str) -> String {
    let nulls_last = |e: &str| format!("{e} {dir} NULLS LAST");
    match p.sort_by.as_deref() {
        Some("year") => format!("media.year {dir}"),
        Some("added") | Some("createdAt") => format!("media.\"createdAt\" {dir}"),
        Some("rating") => format!("media.rating {dir}"),
        Some("author") => format!("{}, media.title ASC", nulls_last("media.\"sortCreator\"")),
        Some("series") => format!(
            "{}, {}, media.title ASC",
            nulls_last(&FIRST_SERIES.replace("{col}", "sc.name")),
            nulls_last(&FIRST_SERIES.replace("{col}", "se.position"))
        ),
        Some("published") => format!("{}, media.title ASC", nulls_last(PUBLISHED)),
        _ => format!("media.title {dir}"),
    }
}

pub struct Page {
    pub data: Vec<Value>,
    pub total: i64,
}

pub async fn find_all(
    db: &PgPool,
    p: &Search,
    ids: &[i32],
    uid: i32,
    see_paths: bool,
) -> Result<Page, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Page {
            data: vec![],
            total: 0,
        });
    }
    let today = Utc::now().date_naive();
    let map = if p.cutoff_unmet {
        Some(quality_map(db).await?)
    } else {
        None
    };
    let paging = p.paging().ok().flatten();

    let mut qb = QueryBuilder::new("SELECT media.id");
    push_scope(&mut qb, p, ids, uid, map.as_ref(), today);
    let query = p.q.as_deref().filter(|q| !q.is_empty());
    match (query, p.sort_by.is_some()) {
        (Some(q), false) => {
            qb.push(" ORDER BY ts_rank(media.\"searchVector\", ");
            push_tsquery(&mut qb, q);
            qb.push(") DESC NULLS LAST, media.title ASC, media.id ASC");
        }
        _ => {
            let dir = if p.sort_order.as_deref() == Some("DESC") {
                "DESC"
            } else {
                "ASC"
            };
            qb.push(format!(" ORDER BY {}, media.id ASC", order_sql(p, dir)));
        }
    }
    if let Some((limit, offset)) = paging {
        qb.push(" LIMIT ")
            .push_bind(limit)
            .push(" OFFSET ")
            .push_bind(offset);
    }
    let page_ids: Vec<i32> = qb.build_query_scalar().fetch_all(db).await?;

    let total = if paging.is_none() {
        page_ids.len() as i64
    } else {
        let mut qb = QueryBuilder::new("SELECT COUNT(*)");
        push_scope(&mut qb, p, ids, uid, map.as_ref(), today);
        qb.build_query_scalar().fetch_one(db).await?
    };

    let mut data = hydrate::items_view(db, &page_ids, see_paths, p.grid, Some(ids)).await?;
    attach_watched(db, &mut data, &page_ids, uid).await?;
    books::attach_list_info(db, &mut data, uid, ids).await?;
    Ok(Page { data, total })
}

/// Rule 27 verbatim: the percentage stays in SQL (`round(float8)` is half-to-even).
async fn attach_watched(
    db: &PgPool,
    data: &mut [Value],
    ids: &[i32],
    uid: i32,
) -> Result<(), sqlx::Error> {
    let by_id = watched_map(db, ids, uid).await?;
    for (item, id) in data.iter_mut().zip(ids) {
        let (watched, progress) = by_id.get(id).copied().unwrap_or((false, 0));
        if let Some(o) = item.as_object_mut() {
            o.insert("watched".into(), watched.into());
            o.insert("progressPercent".into(), progress.into());
        }
    }
    Ok(())
}

/// `(watched, progressPercent)` of `ids` for `uid` (rule 27).
pub(crate) async fn watched_map(
    db: &PgPool,
    ids: &[i32],
    uid: i32,
) -> Result<HashMap<i32, (bool, i32)>, sqlx::Error> {
    let rows: Vec<(i32, bool, i32)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT m.id::int, ({}), ({}) FROM media m WHERE m.id = ANY($2::int[])",
        super::watched::predicate("$1", "m"),
        super::watched::progress("$1", "m")
    )))
    .bind(uid)
    .bind(ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, watched, progress)| (id, (watched, progress)))
        .collect())
}

/// Rule 33, Q-R: newest additions by media, by file, or both; `id ASC` breaks ties.
pub async fn recently_added(
    db: &PgPool,
    p: &Recent,
    ids: &[i32],
    uid: i32,
    see_paths: bool,
) -> Result<Vec<Value>, sqlx::Error> {
    if ids.is_empty() || p.limit == 0 {
        return Ok(vec![]);
    }
    let mut qb = QueryBuilder::new("SELECT media.id FROM media");
    if p.mode != "media" {
        qb.push(" LEFT JOIN (SELECT mf.\"mediaId\" AS \"mediaId\", MAX(mf.\"createdAt\") AS added FROM media_files mf GROUP BY mf.\"mediaId\") lf ON lf.\"mediaId\" = media.id");
    }
    qb.push(" WHERE media.\"libraryId\" = ANY(")
        .push_bind(ids.to_vec())
        .push(")");
    if let Some(l) = p.library_id.filter(|l| *l != 0) {
        qb.push(" AND media.\"libraryId\" = ").push_bind(l);
    }
    if p.exclude_watched {
        qb.push(format!(
            " AND NOT ({})",
            super::watched::predicate(uid, "media")
        ));
    }
    if p.requested_by_me {
        qb.push(" AND media.\"addedById\" = ").push_bind(uid);
    }
    qb.push(match p.mode.as_str() {
        "file" => " AND lf.added IS NOT NULL ORDER BY lf.added DESC",
        "media" => " ORDER BY media.\"createdAt\" DESC",
        _ => {
            " ORDER BY GREATEST(media.\"createdAt\", COALESCE(lf.added, media.\"createdAt\")) DESC"
        }
    });
    qb.push(", media.id ASC LIMIT ").push_bind(p.limit);
    let page_ids: Vec<i32> = qb.build_query_scalar().fetch_all(db).await?;
    let mut data = hydrate::items_view(db, &page_ids, see_paths, false, Some(ids)).await?;
    books::attach_list_info(db, &mut data, uid, ids).await?;
    Ok(data)
}
