//! Criteria to SQL (`cleanup.md` rules 9-14): one query per rule, every value bound.
use crate::{http::json::iso_ms, libraries};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, PgPool, Postgres, QueryBuilder};

#[derive(Debug, FromRow, Serialize)]
pub struct Match {
    pub id: i32,
    pub title: String,
    #[sqlx(rename = "type")]
    #[serde(rename = "type")]
    pub media_type: String,
    pub size: i64,
    #[sqlx(rename = "lastPlayedAt")]
    #[serde(rename = "lastPlayedAt", with = "iso_ms::opt")]
    pub last_played_at: Option<DateTime<Utc>>,
}

const ONE_GB: f64 = 1_073_741_824.0;
const FILE_SIZE: &str =
    r#"COALESCE((SELECT SUM(f.size) FROM media_files f WHERE f."mediaId" = media.id), 0)"#;
const LAST_PLAYED: &str =
    r#"(SELECT MAX(ps."lastPlayedAt") FROM playback_states ps WHERE ps."mediaId" = media.id)"#;
const REQUESTER: &str = r#"r."mediaId" = media.id AND r.kind = 'add' AND r."userId" IS NOT NULL"#;

fn int(c: &Value, k: &str) -> Option<i64> {
    c.get(k).and_then(Value::as_i64)
}

fn flag(c: &Value, k: &str) -> bool {
    c.get(k).and_then(Value::as_bool) == Some(true)
}

fn strings(c: &Value, k: &str) -> Option<Vec<String>> {
    c.get(k).and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(|s| s.as_str().map(str::to_owned))
            .collect()
    })
}

/// `disk_libs` are the libraries under `diskFreeBelowPercent`; `unmonitor` skips already unmonitored media.
pub fn compile(c: &Value, disk_libs: &[i32], unmonitor: bool) -> QueryBuilder<'static, Postgres> {
    let mut q = QueryBuilder::new(format!(
        r#"SELECT media.id, media.title, media."type"::text AS "type", {FILE_SIZE}::bigint AS size,
        {LAST_PLAYED} AS "lastPlayedAt" FROM media WHERE NOT EXISTS
        (SELECT 1 FROM cleanup_exclusions x WHERE x."mediaId" = media.id)"#
    ));
    if unmonitor {
        q.push(" AND media.monitored");
    }
    if let Some(ids) = c.get("libraryIds").and_then(Value::as_array) {
        let ids: Vec<i32> = ids
            .iter()
            .filter_map(|v| i32::try_from(v.as_i64()?).ok())
            .collect();
        q.push(r#" AND media."libraryId" = ANY("#)
            .push_bind(ids)
            .push(")");
    }
    if let Some(t) = c.get("mediaType").and_then(Value::as_str) {
        q.push(r#" AND media."type"::text = "#)
            .push_bind(t.to_owned());
    }
    if let Some(d) = int(c, "addedOlderThanDays") {
        q.push(r#" AND media."createdAt" < now() - make_interval(days => "#)
            .push_bind(d as i32)
            .push(")");
    }
    if let Some(d) = int(c, "releasedOlderThanDays") {
        q.push(r#" AND media."releaseDate" < current_date - "#)
            .push_bind(d as i32);
    }
    if let Some(d) = int(c, "lastPlayedOlderThanDays") {
        q.push(format!(
            " AND COALESCE({LAST_PLAYED}, '-infinity') < now() - make_interval(days => "
        ))
        .push_bind(d as i32)
        .push(")");
    }
    if flag(c, "neverPlayed") {
        q.push(
            r#" AND NOT EXISTS (SELECT 1 FROM playback_states ps WHERE ps."mediaId" = media.id)"#,
        );
    }
    if flag(c, "watchedByRequester") {
        q.push(format!(
            r#" AND EXISTS (SELECT 1 FROM requests r WHERE {REQUESTER})
            AND NOT EXISTS (SELECT 1 FROM requests r WHERE {REQUESTER}
              AND media.id NOT IN ({}))"#,
            crate::media::list::watched_sql(r#"r."userId""#)
        ));
    }
    if let Some(r) = c.get("ratingBelow").and_then(Value::as_f64) {
        q.push(" AND media.rating > 0 AND media.rating < ")
            .push_bind(r);
    }
    if let Some(v) = int(c, "minVotes") {
        q.push(r#" AND (SELECT mm."voteCount" FROM media_metadata mm WHERE mm."mediaId" = media.id) >= "#)
            .push_bind(v as i32);
    }
    if let Some(gb) = c.get("sizeAboveGb").and_then(Value::as_f64) {
        q.push(format!(" AND {FILE_SIZE} > "))
            .push_bind((gb * ONE_GB) as i64);
    }
    if let Some(g) = strings(c, "genres") {
        q.push(" AND jsonb_exists_any(media.genres, ")
            .push_bind(g)
            .push(")");
    }
    if let Some(g) = strings(c, "excludeGenres") {
        q.push(" AND NOT COALESCE(jsonb_exists_any(media.genres, ")
            .push_bind(g)
            .push("), false)");
    }
    if flag(c, "seriesEnded") {
        q.push(r#" AND media."type" = 'series' AND media.status = 'ended'"#);
    }
    if flag(c, "notLiked") {
        q.push(r#" AND NOT EXISTS (SELECT 1 FROM likes l WHERE l."mediaId" = media.id)"#);
    }
    if let Some(n) = int(c, "likedByFewerThan") {
        q.push(r#" AND (SELECT COUNT(DISTINCT l."userId") FROM likes l WHERE l."mediaId" = media.id) < "#)
            .push_bind(n);
    }
    if flag(c, "notLikedByRequester") {
        q.push(format!(
            r#" AND NOT EXISTS (SELECT 1 FROM likes l JOIN requests r ON r."userId" = l."userId"
            WHERE l."mediaId" = media.id AND {REQUESTER})"#
        ));
    }
    if int(c, "diskFreeBelowPercent").is_some() {
        q.push(r#" AND media."libraryId" = ANY("#)
            .push_bind(disk_libs.to_vec())
            .push(")");
    }
    q.push(" ORDER BY media.id");
    q
}

/// Libraries whose free space is under `percent`; an unreadable or pathless library never qualifies.
async fn low_disk_libraries(db: &PgPool, percent: i64) -> sqlx::Result<Vec<i32>> {
    let libs: Vec<(i32, String)> = sqlx::query_as(
        r#"SELECT id, path FROM libraries WHERE path IS NOT NULL AND path <> '' ORDER BY id"#,
    )
    .fetch_all(db)
    .await?;
    let mut out = vec![];
    for (id, path) in libs {
        let d = libraries::disk(&path).await;
        if d.accessible && d.total_space > 0 && d.free_space * 100 < percent * d.total_space {
            out.push(id);
        }
    }
    Ok(out)
}

/// What a rule matches now, exclusions applied; read-only.
pub async fn matched(db: &PgPool, criteria: &Value, action: &str) -> sqlx::Result<Vec<Match>> {
    let disk = match int(criteria, "diskFreeBelowPercent") {
        Some(p) => low_disk_libraries(db, p).await?,
        None => vec![],
    };
    compile(criteria, &disk, action == "delete_files_unmonitor")
        .build_query_as()
        .fetch_all(db)
        .await
}
