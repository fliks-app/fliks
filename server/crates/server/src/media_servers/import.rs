//! Emby watch-history import (`docs/spec/media-servers.md` rules 13-21, C43-C45).
use super::{
    db::Server,
    emby::{Conn, Item, Mode},
};
use crate::users::imported_user;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};

const TICKS_PER_SECOND: f64 = 10_000_000.0;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub users: i64,
    pub users_created: i64,
    pub imported: i64,
    pub skipped: i64,
}

#[derive(Default)]
struct Caches {
    movies: HashMap<i32, Option<i32>>,
    series: HashMap<i32, Option<i32>>,
    series_tmdb: HashMap<String, Option<i32>>,
}

/// What one item writes (rule 18).
#[derive(Debug, PartialEq)]
pub struct Plan {
    pub position: f64,
    pub duration: f64,
    pub completed: bool,
    pub hidden: bool,
    pub date: DateTime<Utc>,
}

/// `new Date(raw)` for the shapes Emby sends; an unparsable value is skipped.
fn parse_date(raw: Option<&str>) -> Option<DateTime<Utc>> {
    let raw = raw?.trim();
    DateTime::parse_from_rfc3339(raw)
        .map(|d| d.to_utc())
        .ok()
        .or_else(|| {
            let naive = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f")
                .ok()
                .or_else(|| {
                    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
                        .ok()?
                        .and_hms_opt(0, 0, 0)
                })?;
            Some(naive.and_utc())
        })
}

pub fn plan(item: &Item, in_resume: bool, now: DateTime<Utc>) -> Plan {
    let date = parse_date(item.last_played.as_deref())
        .or_else(|| parse_date(item.date_created.as_deref()))
        .or_else(|| parse_date(item.premiere.as_deref()))
        .unwrap_or(now);
    Plan {
        position: (item.position_ticks / TICKS_PER_SECOND).floor(),
        duration: (item.run_ticks / TICKS_PER_SECOND).floor(),
        completed: !in_resume && item.played,
        hidden: !in_resume && !item.played && item.position_ticks > 0.0,
        date,
    }
}

/// Imports every Emby user's history; a `listUsers` failure is the error (C45).
pub async fn import_server(db: &PgPool, server: &Server) -> Result<Stats, String> {
    let conn = Conn::new(&server.url, server.api_key.as_deref());
    let users = conn
        .users()
        .await
        .map_err(|e| format!("listUsers failed: {e}"))?;
    let mut stats = Stats::default();
    let mut caches = Caches::default();
    for user in users {
        stats.users += 1;
        let name = user.name.as_deref().map(str::trim).unwrap_or_default();
        if name.is_empty() {
            tracing::warn!("watch-history import: user \"\": missing name");
            continue;
        }
        match import_user(db, &conn, &user.id, name, &mut caches).await {
            Ok((created, imported, skipped)) => {
                stats.users_created += i64::from(created);
                stats.imported += imported;
                stats.skipped += skipped;
            }
            Err(e) => tracing::warn!(error = %e, "watch-history import: user \"{name}\""),
        }
    }
    Ok(stats)
}

/// Pages of 500 until an empty page or the reported total.
async fn fetch_all(conn: &Conn, user: &str, mode: Mode) -> Result<Vec<Item>, String> {
    let (mut out, mut offset) = (vec![], 0);
    loop {
        let (items, total) = conn.page(user, mode, offset).await?;
        if items.is_empty() {
            break;
        }
        offset += items.len();
        out.extend(items);
        if offset >= total {
            break;
        }
    }
    Ok(out)
}

async fn import_user(
    db: &PgPool,
    conn: &Conn,
    emby_id: &str,
    name: &str,
    caches: &mut Caches,
) -> Result<(bool, i64, i64), String> {
    let (user_id, created) = imported_user(db, name, "emby")
        .await
        .map_err(|e| e.to_string())?;
    let resume = fetch_all(conn, emby_id, Mode::Resume).await?;
    let resume_ids: HashSet<String> = resume.iter().map(|i| i.id.clone()).collect();
    let played = fetch_all(conn, emby_id, Mode::Played).await?;
    let resumable = fetch_all(conn, emby_id, Mode::Resumable).await?;
    let (mut seen, mut imported, mut skipped) = (HashSet::new(), 0, 0);
    for item in resume.iter().chain(&played).chain(&resumable) {
        if !seen.insert(item.id.clone()) {
            continue;
        }
        let in_resume = resume_ids.contains(&item.id);
        if !item.played && item.position_ticks == 0.0 && !in_resume {
            skipped += 1;
            continue;
        }
        match apply(db, conn, emby_id, user_id, item, in_resume, caches).await {
            Ok(true) => imported += 1,
            Ok(false) => skipped += 1,
            Err(e) => tracing::warn!(error = %e, "watch-history import: item \"{}\"", item.id),
        }
    }
    Ok((created, imported, skipped))
}

fn tmdb_of(raw: Option<&str>) -> Option<i32> {
    raw?.trim()
        .parse::<i64>()
        .ok()
        .filter(|n| *n >= 1)?
        .try_into()
        .ok()
}

async fn media_id(db: &PgPool, kind: &str, tmdb: i32) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar!(
        r#"SELECT id FROM media WHERE type::text = $1 AND "tmdbId" = $2 ORDER BY id LIMIT 1"#,
        kind,
        tmdb
    )
    .fetch_optional(db)
    .await
}

/// `true` when a row was written, `false` for an unmatched item or one Fliks played more recently.
async fn apply(
    db: &PgPool,
    conn: &Conn,
    emby_user: &str,
    user_id: i32,
    item: &Item,
    in_resume: bool,
    c: &mut Caches,
) -> Result<bool, String> {
    let sql = |e: sqlx::Error| e.to_string();
    let p = plan(item, in_resume, Utc::now());
    if item.kind == "Movie" {
        let Some(tmdb) = tmdb_of(item.tmdb.as_deref()) else {
            return Ok(false);
        };
        if !c.movies.contains_key(&tmdb) {
            c.movies
                .insert(tmdb, media_id(db, "movie", tmdb).await.map_err(sql)?);
        }
        let Some(media) = c.movies[&tmdb] else {
            return Ok(false);
        };
        return write(db, user_id, media, None, &p).await.map_err(sql);
    }
    let Some(series_emby) = &item.series_id else {
        return Ok(false);
    };
    if !c.series_tmdb.contains_key(series_emby) {
        let raw = conn.item(emby_user, series_emby).await.and_then(|i| i.tmdb);
        let tmdb = raw
            .filter(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|r| r.parse::<i32>().ok());
        c.series_tmdb.insert(series_emby.clone(), tmdb);
    }
    let Some(tmdb) = c.series_tmdb[series_emby].filter(|t| *t != 0) else {
        return Ok(false);
    };
    if !c.series.contains_key(&tmdb) {
        c.series
            .insert(tmdb, media_id(db, "series", tmdb).await.map_err(sql)?);
    }
    let Some(series) = c.series[&tmdb] else {
        return Ok(false);
    };
    let (Some(season), Some(number)) = (item.season, item.episode) else {
        return Ok(false);
    };
    let episode = sqlx::query_scalar!(
        r#"SELECT e.id FROM episodes e JOIN seasons s ON s.id = e."seasonId"
           WHERE s."mediaId" = $1 AND s."seasonNumber" = $2 AND e."episodeNumber" = $3
           ORDER BY e.id LIMIT 1"#,
        series,
        i32::try_from(season).map_err(|e| e.to_string())?,
        i32::try_from(number).map_err(|e| e.to_string())?
    )
    .fetch_optional(db)
    .await
    .map_err(sql)?;
    let Some(episode) = episode else {
        return Ok(false);
    };
    write(db, user_id, series, Some(episode), &p)
        .await
        .map_err(sql)
}

/// One statement per key shape; the database decides whether Fliks' newer state wins (C44).
async fn write(
    db: &PgPool,
    user: i32,
    media: i32,
    episode: Option<i32>,
    p: &Plan,
) -> sqlx::Result<bool> {
    let row = match episode {
        None => {
            sqlx::query_scalar!(
                r#"INSERT INTO playback_states ("userId", "mediaId", "episodeId", "positionSeconds",
                       "durationSeconds", completed, "hiddenFromContinueWatching", "lastPlayedAt", "playedAt")
                   VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $7)
                   ON CONFLICT ("userId", "mediaId") WHERE "episodeId" IS NULL DO UPDATE SET
                       "positionSeconds" = EXCLUDED."positionSeconds",
                       "durationSeconds" = CASE WHEN EXCLUDED."durationSeconds" > 0
                           THEN EXCLUDED."durationSeconds" ELSE playback_states."durationSeconds" END,
                       completed = EXCLUDED.completed,
                       "hiddenFromContinueWatching" = EXCLUDED."hiddenFromContinueWatching",
                       "lastPlayedAt" = EXCLUDED."lastPlayedAt", "playedAt" = EXCLUDED."playedAt"
                   WHERE playback_states."lastPlayedAt" <= EXCLUDED."lastPlayedAt"
                   RETURNING id"#,
                user,
                media,
                p.position,
                p.duration,
                p.completed,
                p.hidden,
                p.date
            )
            .fetch_optional(db)
            .await?
        }
        Some(ep) => {
            sqlx::query_scalar!(
                r#"INSERT INTO playback_states ("userId", "mediaId", "episodeId", "positionSeconds",
                       "durationSeconds", completed, "hiddenFromContinueWatching", "lastPlayedAt", "playedAt")
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
                   ON CONFLICT ("userId", "episodeId") WHERE "episodeId" IS NOT NULL DO UPDATE SET
                       "positionSeconds" = EXCLUDED."positionSeconds",
                       "durationSeconds" = CASE WHEN EXCLUDED."durationSeconds" > 0
                           THEN EXCLUDED."durationSeconds" ELSE playback_states."durationSeconds" END,
                       completed = EXCLUDED.completed,
                       "hiddenFromContinueWatching" = EXCLUDED."hiddenFromContinueWatching",
                       "lastPlayedAt" = EXCLUDED."lastPlayedAt", "playedAt" = EXCLUDED."playedAt"
                   WHERE playback_states."lastPlayedAt" <= EXCLUDED."lastPlayedAt"
                   RETURNING id"#,
                user,
                media,
                ep,
                p.position,
                p.duration,
                p.completed,
                p.hidden,
                p.date
            )
            .fetch_optional(db)
            .await?
        }
    };
    Ok(row.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        "2030-01-01T00:00:00Z".parse().unwrap()
    }

    fn item(v: serde_json::Value) -> Item {
        Item::from_json(&v)
    }

    #[test]
    fn resume_beats_played_and_a_rewatch_is_not_completed() {
        let it =
            item(json!({"Id":"1","UserData":{"Played":true,"PlaybackPositionTicks":600_000_000}}));
        let p = plan(&it, true, now());
        assert!(!p.completed && !p.hidden);
        assert_eq!(p.position, 60.0);
        let p = plan(&it, false, now());
        assert!(p.completed && !p.hidden);
    }

    #[test]
    fn partial_progress_outside_resume_is_hidden() {
        let it =
            item(json!({"Id":"1","UserData":{"Played":false,"PlaybackPositionTicks":10_000_000}}));
        let p = plan(&it, false, now());
        assert!(p.hidden && !p.completed);
        assert!(!plan(&it, true, now()).hidden);
    }

    #[test]
    fn date_falls_back_through_the_chain() {
        let both = item(
            json!({"UserData":{"LastPlayedDate":"2020-01-02T03:04:05.0000000Z"},
            "DateCreated":"2019-01-01T00:00:00Z","PremiereDate":"2018-01-01T00:00:00Z"}),
        );
        assert_eq!(
            plan(&both, false, now()).date.to_rfc3339(),
            "2020-01-02T03:04:05+00:00"
        );
        let bad = item(
            json!({"UserData":{"LastPlayedDate":"nope"},"DateCreated":"2019-01-01T00:00:00Z"}),
        );
        assert_eq!(plan(&bad, false, now()).date.year_str(), "2019");
        let prem = item(json!({"PremiereDate":"2018-05-06"}));
        assert_eq!(plan(&prem, false, now()).date.year_str(), "2018");
        assert_eq!(plan(&item(json!({})), false, now()).date, now());
    }

    #[test]
    fn ticks_convert_and_duration_defaults_to_zero() {
        let it = item(json!({"RunTimeTicks": 36_005_000_000.0_f64}));
        let p = plan(&it, false, now());
        assert_eq!((p.duration, p.position), (3600.0, 0.0));
        assert_eq!(plan(&item(json!({})), false, now()).duration, 0.0);
    }

    #[test]
    fn tmdb_ids_are_integers_from_one() {
        assert_eq!(tmdb_of(Some(" 12 ")), Some(12));
        for bad in ["0", "-3", "12.5", "1e3", "0x1f", "", "abc"] {
            assert_eq!(tmdb_of(Some(bad)), None, "{bad}");
        }
        assert_eq!(tmdb_of(None), None);
    }

    trait YearStr {
        fn year_str(&self) -> String;
    }
    impl YearStr for DateTime<Utc> {
        fn year_str(&self) -> String {
            self.format("%Y").to_string()
        }
    }
}
