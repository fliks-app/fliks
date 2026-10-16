//! `GET /api/media/calendar` (`media-query.md` rules 47-51).
use super::params::Calendar;
use crate::http::AppError;
use chrono::{Datelike, Local, NaiveDate};
use serde_json::{Value, json};
use sqlx::PgPool;

/// Postgres rejected a date the DTO let through: 400 instead of Nest's 500 (C1).
fn date_error(e: sqlx::Error) -> AppError {
    match &e {
        sqlx::Error::Database(d) if d.code().is_some_and(|c| c.starts_with("22")) => {
            AppError::bad_request(vec![
                "start and end must be dates Postgres can read".to_owned(),
            ])
        }
        _ => e.into(),
    }
}

/// Both bounds sliced to 10 characters, else the current month in the server's local zone.
fn window(p: &Calendar) -> (String, String) {
    if let (Some(s), Some(e)) = (&p.start, &p.end) {
        let cut = |d: &str| d.chars().take(10).collect::<String>();
        return (cut(s), cut(e));
    }
    let now = Local::now().date_naive();
    let first = NaiveDate::from_ymd_opt(now.year(), now.month(), 1).expect("valid");
    let next = if now.month() == 12 {
        NaiveDate::from_ymd_opt(now.year() + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(now.year(), now.month() + 1, 1)
    }
    .expect("valid");
    (
        first.to_string(),
        (next - chrono::Duration::days(1)).to_string(),
    )
}

pub async fn calendar(
    db: &PgPool,
    p: &Calendar,
    ids: &[i32],
    uid: i32,
) -> Result<Vec<Value>, AppError> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let (start, end) = window(p);
    let added_by = p.requested_by_me.then_some(uid);
    let mut out: Vec<Value> = vec![];

    if p.media_type.as_deref().is_none_or(|t| t == "movie") {
        let rows = sqlx::query!(
            r#"SELECT m.id AS "id!", m.title AS "title!", m."posterUrl" AS poster_url, m."fanartUrl" AS fanart_url,
  m.status::text AS "status!", m.year,
  to_char(m."inCinemas", 'YYYY-MM-DD') AS in_cinemas, to_char(m."digitalRelease", 'YYYY-MM-DD') AS digital_release,
  to_char(m."physicalRelease", 'YYYY-MM-DD') AS physical_release, to_char(m."releaseDate", 'YYYY-MM-DD') AS release_date,
  EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id) AS "has_file!"
FROM media m
WHERE m.type = 'movie'
  AND (m."inCinemas" BETWEEN $1::text::date AND $2::text::date OR m."digitalRelease" BETWEEN $1::text::date AND $2::text::date
       OR m."physicalRelease" BETWEEN $1::text::date AND $2::text::date OR m."releaseDate" BETWEEN $1::text::date AND $2::text::date)
  AND ($3::bool IS NOT TRUE OR m.monitored = true) AND ($4::int IS NULL OR m."addedById" = $4)
  AND m."libraryId" = ANY($5)
ORDER BY m.id"#,
            start,
            end,
            p.monitored_only,
            added_by,
            ids
        )
        .fetch_all(db)
        .await
        .map_err(date_error)?;
        for m in rows {
            let entry = |event: &str, date: &str| {
                json!({"id": m.id, "mediaId": m.id, "title": m.title, "type": "movie", "event": event, "date": date,
                    "posterUrl": m.poster_url, "fanartUrl": m.fanart_url, "status": m.status, "year": m.year,
                    "hasFile": m.has_file})
            };
            // the window is compared as raw strings, so a compact `20260301` start selects the movie in SQL but emits nothing
            let inside = |d: &Option<String>| {
                d.clone()
                    .filter(|d| d.as_str() >= start.as_str() && d.as_str() <= end.as_str())
            };
            let mut specific = false;
            for (event, d) in [
                ("cinema", &m.in_cinemas),
                ("digital", &m.digital_release),
                ("physical", &m.physical_release),
            ] {
                if let Some(d) = inside(d) {
                    specific = true;
                    out.push(entry(event, &d));
                }
            }
            if let (false, Some(d)) = (specific, inside(&m.release_date)) {
                out.push(entry("release", &d));
            }
        }
    }

    if p.media_type.as_deref().is_none_or(|t| t == "series") {
        let rows = sqlx::query!(
            r#"SELECT ep.id AS "id!", ep."episodeNumber" AS "episode_number!", ep.title, to_char(ep."airDate", 'YYYY-MM-DD') AS "date!",
  season."seasonNumber" AS "season_number!", media.id AS "media_id!", media.title AS "media_title!",
  media."posterUrl" AS poster_url, media."fanartUrl" AS fanart_url, media.status::text AS "status!", media.year,
  (ep."hasFile" = true OR EXISTS (
    SELECT 1 FROM "episodes" cov
    WHERE cov."seasonId" = ep."seasonId" AND cov."hasFile" = true AND cov."endEpisodeNumber" IS NOT NULL
      AND ep."episodeNumber" > cov."episodeNumber" AND ep."episodeNumber" <= cov."endEpisodeNumber"
  )) AS "on_disk!"
FROM episodes ep
INNER JOIN seasons season ON season.id = ep."seasonId"
INNER JOIN media media ON media.id = season."mediaId"
WHERE ep."airDate" BETWEEN $1::text::date AND $2::text::date
  AND ($3::bool IS NOT TRUE OR (media.monitored = true AND ep.monitored = true))
  AND ($4::int IS NULL OR media."addedById" = $4)
  AND media."libraryId" = ANY($5)
ORDER BY ep."airDate" ASC, ep.id ASC"#,
            start,
            end,
            p.monitored_only,
            added_by,
            ids
        )
        .fetch_all(db)
        .await
        .map_err(date_error)?;
        out.extend(rows.into_iter().map(|e| {
            json!({"id": e.id, "mediaId": e.media_id, "title": e.media_title, "type": "series", "event": "airing",
                "date": e.date, "posterUrl": e.poster_url, "fanartUrl": e.fanart_url, "status": e.status,
                "year": e.year, "seasonNumber": e.season_number, "episodeNumber": e.episode_number,
                "episodeTitle": e.title, "hasFile": e.on_disk})
        }));
    }
    out.sort_by(|a, b| a["date"].as_str().cmp(&b["date"].as_str()));
    Ok(out)
}
