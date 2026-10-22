//! Criteria to SQL (`cleanup.md` rules 9-14): one query per rule, every value bound.
use crate::{http::json::iso_ms, libraries};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, PgPool, Postgres, QueryBuilder};
use std::collections::{HashMap, HashSet};

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
    #[sqlx(rename = "libraryId")]
    #[serde(skip)]
    pub library_id: Option<i32>,
    #[sqlx(rename = "seasonId")]
    #[serde(rename = "seasonId")]
    pub season_id: Option<i32>,
    #[sqlx(rename = "episodeId")]
    #[serde(rename = "episodeId")]
    pub episode_id: Option<i32>,
    #[sqlx(rename = "seasonNumber")]
    #[serde(rename = "seasonNumber")]
    pub season_number: Option<i32>,
    #[sqlx(rename = "episodeNumber")]
    #[serde(rename = "episodeNumber")]
    pub episode_number: Option<i32>,
}

const ONE_GB: f64 = 1_073_741_824.0;
const FILE_SIZE: &str =
    r#"COALESCE((SELECT SUM(f.size) FROM media_files f WHERE f."mediaId" = media.id), 0)"#;
const LAST_PLAYED: &str =
    r#"(SELECT MAX(ps."lastPlayedAt") FROM playback_states ps WHERE ps."mediaId" = media.id)"#;
const REQUESTER: &str = r#"r."mediaId" = media.id AND r.kind = 'add' AND r.status <> 'declined' AND r."userId" IS NOT NULL"#;

fn int(c: &Value, k: &str) -> Option<i64> {
    c.get(k).and_then(Value::as_i64)
}

fn int32(c: &Value, k: &str) -> Option<i32> {
    int(c, k).and_then(|n| i32::try_from(n).ok())
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

/// SQL of the per-scope facts a criterion reads: the media at movie and series level, or the episodes
/// (`ep`) of the season (`s`) or episode (`e`) at season and episode level.
struct Scope {
    size: String,
    last_played: String,
    played: String,
    added: String,
    released: String,
    /// `episodes ep` of the scope, for the criteria that walk them.
    episodes: Option<String>,
}

impl Scope {
    fn of(level: &str) -> Self {
        let ep = match level {
            "season" => r#"ep."seasonId" = s.id"#,
            "episode" => "ep.id = e.id",
            _ => {
                return Scope {
                    size: FILE_SIZE.into(),
                    last_played: LAST_PLAYED.into(),
                    played:
                        r#"EXISTS (SELECT 1 FROM playback_states ps WHERE ps."mediaId" = media.id)"#
                            .into(),
                    added: r#"media."createdAt""#.into(),
                    released: r#"media."releaseDate""#.into(),
                    episodes: None,
                };
            }
        };
        let files =
            format!(r#"media_files f JOIN episodes ep ON ep.id = f."episodeId" WHERE {ep}"#);
        Scope {
            size: format!("COALESCE((SELECT SUM(f.size) FROM {files}), 0)"),
            last_played: format!(
                r#"(SELECT MAX(ps."lastPlayedAt") FROM playback_states ps JOIN episodes ep ON ep.id = ps."episodeId" WHERE {ep})"#
            ),
            played: format!(
                r#"EXISTS (SELECT 1 FROM playback_states ps JOIN episodes ep ON ep.id = ps."episodeId" WHERE {ep})"#
            ),
            added: format!(r#"(SELECT MAX(f."createdAt") FROM {files})"#),
            released: format!(r#"(SELECT MAX(ep."airDate") FROM episodes ep WHERE {ep})"#),
            episodes: Some(ep.into()),
        }
    }
}

const EP_FILE: &str = r#"EXISTS (SELECT 1 FROM media_files f WHERE f."episodeId" = ep.id)"#;

/// `disk_libs` are the libraries under `diskFreeBelowPercent`; `unmonitor` skips already unmonitored media.
pub fn compile(
    c: &Value,
    level: &str,
    disk_libs: &[i32],
    unmonitor: bool,
) -> QueryBuilder<'static, Postgres> {
    let sc = Scope::of(level);
    let (ids, from, excluded) = match level {
        "season" => (
            r#"s.id AS "seasonId", NULL::int AS "episodeId", s."seasonNumber" AS "seasonNumber", NULL::int AS "episodeNumber""#,
            r#"media JOIN seasons s ON s."mediaId" = media.id"#,
            r#" AND (x."seasonId" IS NULL OR x."seasonId" = s.id)"#,
        ),
        "episode" => (
            r#"s.id AS "seasonId", e.id AS "episodeId", s."seasonNumber" AS "seasonNumber", e."episodeNumber" AS "episodeNumber""#,
            r#"media JOIN seasons s ON s."mediaId" = media.id JOIN episodes e ON e."seasonId" = s.id"#,
            r#" AND (x."seasonId" IS NULL OR x."seasonId" = s.id) AND (x."episodeId" IS NULL OR x."episodeId" = e.id)"#,
        ),
        _ => (
            r#"NULL::int AS "seasonId", NULL::int AS "episodeId", NULL::int AS "seasonNumber", NULL::int AS "episodeNumber""#,
            "media",
            "",
        ),
    };
    let size = &sc.size;
    let last_played = &sc.last_played;
    let mut q = QueryBuilder::new(format!(
        r#"SELECT media.id, media.title, media."type"::text AS "type", {size}::bigint AS size,
        {last_played} AS "lastPlayedAt", media."libraryId" AS "libraryId", {ids} FROM {from} WHERE NOT EXISTS
        (SELECT 1 FROM cleanup_exclusions x WHERE x."mediaId" = media.id{excluded})"#
    ));
    if let Some(ep) = &sc.episodes {
        q.push(format!(
            r#" AND EXISTS (SELECT 1 FROM media_files f JOIN episodes ep ON ep.id = f."episodeId" WHERE {ep})"#
        ));
    } else if unmonitor {
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
    if let Some(ids) = c.get("excludeLibraryIds").and_then(Value::as_array) {
        let ids: Vec<i32> = ids
            .iter()
            .filter_map(|v| i32::try_from(v.as_i64()?).ok())
            .collect();
        q.push(r#" AND media."libraryId" <> ALL("#)
            .push_bind(ids)
            .push(")");
    }
    if level == "movie" || level == "series" {
        q.push(r#" AND media."type"::text = "#)
            .push_bind(level.to_owned());
    }
    if let Some(d) = int32(c, "addedOlderThanDays") {
        q.push(format!(
            " AND {} < now() - make_interval(days => ",
            sc.added
        ))
        .push_bind(d)
        .push(")");
    }
    if let Some(d) = int32(c, "releasedOlderThanDays") {
        q.push(format!(" AND {} < current_date - ", sc.released))
            .push_bind(d);
    }
    if let Some(d) = int32(c, "lastPlayedOlderThanDays") {
        q.push(format!(
            " AND COALESCE({last_played}, '-infinity') < now() - make_interval(days => "
        ))
        .push_bind(d)
        .push(")");
    }
    if let Some(n) = int(c, "playCountBelow") {
        q.push(r#" AND (SELECT COUNT(*) FROM playback_history h WHERE h."mediaId" = media.id) < "#)
            .push_bind(n);
    }
    if let Some(n) = int(c, "playCountByUsersBelow") {
        q.push(r#" AND (SELECT COUNT(DISTINCT h."userId") FROM playback_history h WHERE h."mediaId" = media.id) < "#)
            .push_bind(n);
    }
    if let Some(d) = int32(c, "notPlayedInLastDays") {
        q.push(
            r#" AND NOT EXISTS (SELECT 1 FROM playback_history h WHERE h."mediaId" = media.id
            AND h."playedAt" >= now() - make_interval(days => "#,
        )
        .push_bind(d)
        .push("))");
    }
    if flag(c, "neverPlayed") {
        q.push(format!(" AND NOT {}", sc.played));
    }
    if flag(c, "watchedByRequester")
        && let Some(ep) = &sc.episodes
    {
        q.push(format!(
            r#" AND EXISTS (SELECT 1 FROM requests r WHERE {REQUESTER})
            AND NOT EXISTS (SELECT 1 FROM requests r WHERE {REQUESTER}
              AND EXISTS (SELECT 1 FROM episodes ep WHERE {ep} AND {EP_FILE}
                AND NOT EXISTS (SELECT 1 FROM playback_states ps WHERE ps."userId" = r."userId"
                  AND ps."episodeId" = ep.id AND ps.completed)))"#
        ));
    } else if flag(c, "watchedByRequester") {
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
    if let Some(v) = int32(c, "minVotes") {
        q.push(r#" AND (SELECT mm."voteCount" FROM media_metadata mm WHERE mm."mediaId" = media.id) >= "#)
            .push_bind(v);
    }
    if let Some(gb) = c.get("sizeAboveGb").and_then(Value::as_f64) {
        q.push(format!(" AND {size} > "))
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
    if let Some(n) = int(c, "keepLatestEpisodes") {
        q.push(
            r#" AND (SELECT COUNT(*) FROM episodes e2 JOIN seasons s2 ON s2.id = e2."seasonId"
            WHERE s2."mediaId" = media.id AND EXISTS (SELECT 1 FROM media_files f WHERE f."episodeId" = e2.id)
            AND (COALESCE(e2."airDate", '-infinity'::date), e2.id) > (COALESCE(e."airDate", '-infinity'::date), e.id)) >= "#,
        )
        .push_bind(n);
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
    q.push(match level {
        "season" => " ORDER BY media.id, s.id",
        "episode" => " ORDER BY media.id, s.id, e.id",
        _ => " ORDER BY media.id",
    });
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
pub async fn matched(
    db: &PgPool,
    criteria: &Value,
    levels: &[String],
    action: &str,
) -> sqlx::Result<Vec<Match>> {
    let disk = match int(criteria, "diskFreeBelowPercent") {
        Some(p) => low_disk_libraries(db, p).await?,
        None => vec![],
    };
    let mut out = vec![];
    for level in levels {
        let mut q = compile(criteria, level, &disk, action == "delete_files_unmonitor");
        out.extend(q.build_query_as::<Match>().fetch_all(db).await?);
    }
    Ok(out)
}

/// Built-in recommendations: reason key, criteria, levels (`cleanup.md` rules 33-36).
const RECOMMENDATIONS: [(&str, &str, &[&str]); 4] = [
    (
        "never_played",
        r#"{"neverPlayed": true, "addedOlderThanDays": 90}"#,
        &["movie", "series"],
    ),
    (
        "watched_by_requester",
        r#"{"watchedByRequester": true, "lastPlayedOlderThanDays": 60}"#,
        &["movie", "series"],
    ),
    (
        "not_played_for_a_year",
        r#"{"notPlayedInLastDays": 365, "addedOlderThanDays": 365}"#,
        &["movie", "series"],
    ),
    (
        "series_ended",
        r#"{"seriesEnded": true, "lastPlayedOlderThanDays": 180, "addedOlderThanDays": 180}"#,
        &["series"],
    ),
];

#[derive(Serialize)]
struct Recommendation {
    #[serde(rename = "mediaId")]
    media_id: i32,
    #[serde(rename = "libraryId")]
    library_id: Option<i32>,
    title: String,
    #[serde(rename = "type")]
    media_type: String,
    size: i64,
    #[serde(rename = "lastPlayedAt", with = "iso_ms::opt")]
    last_played_at: Option<DateTime<Utc>>,
    reasons: Vec<&'static str>,
}

/// `{reasons: {key, criteria, levels}[], items}`: titles matched by a built-in set in the `libraries`,
/// merged by media, without the whole-media candidates, biggest first.
pub async fn recommendations(db: &PgPool, libraries: &[i32]) -> sqlx::Result<Value> {
    let flagged: HashSet<i32> = sqlx::query_scalar(
        r#"SELECT "mediaId" FROM cleanup_candidates WHERE "seasonId" IS NULL AND "episodeId" IS NULL"#,
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .collect();
    let mut reasons = vec![];
    let mut items: HashMap<i32, (Match, Vec<&str>)> = HashMap::new();
    for (key, criteria, levels) in RECOMMENDATIONS {
        let criteria: Value = serde_json::from_str(criteria).expect("built-in criteria");
        let lv: Vec<String> = levels.iter().map(|l| (*l).to_owned()).collect();
        for m in matched(db, &criteria, &lv, "delete").await? {
            if flagged.contains(&m.id) || !m.library_id.is_some_and(|l| libraries.contains(&l)) {
                continue;
            }
            items.entry(m.id).or_insert_with(|| (m, vec![])).1.push(key);
        }
        reasons.push(serde_json::json!({"key": key, "criteria": criteria, "levels": levels}));
    }
    let mut items: Vec<(Match, Vec<&str>)> = items.into_values().collect();
    items.sort_by_key(|(m, _)| (std::cmp::Reverse(m.size), m.id));
    let items: Vec<Recommendation> = items
        .into_iter()
        .map(|(m, reasons)| Recommendation {
            library_id: m.library_id,
            media_id: m.id,
            title: m.title,
            media_type: m.media_type,
            size: m.size,
            last_played_at: m.last_played_at,
            reasons,
        })
        .collect();
    Ok(serde_json::json!({"reasons": reasons, "items": items}))
}
