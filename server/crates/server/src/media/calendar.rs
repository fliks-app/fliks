//! `GET /api/media/calendar` (`media-query.md` rules 47-51).
use super::params::Calendar;
use crate::http::AppError;
use chrono::{Datelike, Local, NaiveDate};
use fliks_domain::media::{kind::MediaKind, release::ReleaseKind};
use serde_json::{Value, json};
use sqlx::PgPool;

/// Postgres rejected a date the DTO let through: 400, never a database 500.
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

    if p.media_type.is_none_or(|t| !t.has_seasons()) {
        let kinds: Vec<&str> = MediaKind::ALL
            .into_iter()
            .filter(|k| !k.has_seasons())
            .map(MediaKind::as_str)
            .collect();
        let rows = sqlx::query!(
            r#"SELECT m.id AS "id!", m.title AS "title!", m.type AS "kind!", m."posterUrl" AS poster_url,
  m."fanartUrl" AS fanart_url, m.status::text AS "status!", m.year,
  dates.by_kind AS "dates!: Value",
  EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id) AS "has_file!"
FROM media m
LEFT JOIN LATERAL (SELECT jsonb_object_agg(kind, to_char(date, 'YYYY-MM-DD')) AS by_kind
                   FROM media_release_dates WHERE "mediaId" = m.id) dates ON true
WHERE m.type = ANY($6)
  AND EXISTS (SELECT 1 FROM media_release_dates w WHERE w."mediaId" = m.id
              AND w.date BETWEEN $1::text::date AND $2::text::date)
  AND ($3::bool IS NOT TRUE OR m.monitored = true) AND ($4::int IS NULL OR m."addedById" = $4)
  AND m."libraryId" = ANY($5)
ORDER BY m.id"#,
            start,
            end,
            p.monitored_only,
            added_by,
            ids,
            &kinds as &[&str]
        )
        .fetch_all(db)
        .await
        .map_err(date_error)?;
        for m in rows {
            let kind = crate::db::kind(&m.kind)?;
            let entry = |event: &str, date: &str| {
                json!({"id": m.id, "mediaId": m.id, "title": m.title, "type": kind, "event": event, "date": date,
                    "posterUrl": m.poster_url, "fanartUrl": m.fanart_url, "status": m.status, "year": m.year,
                    "hasFile": m.has_file})
            };
            // the window is compared as raw strings, so a compact `20260301` start selects the media in SQL but emits nothing
            let inside = |k: ReleaseKind| {
                m.dates[k.as_str()]
                    .as_str()
                    .filter(|d| *d >= start.as_str() && *d <= end.as_str())
            };
            let mut specific = false;
            for k in ReleaseKind::ALL.into_iter().filter(|k| !k.is_fallback()) {
                if let Some(d) = inside(k) {
                    specific = true;
                    out.push(entry(k.event(), d));
                }
            }
            for k in ReleaseKind::ALL.into_iter().filter(|k| k.is_fallback()) {
                if let (false, Some(d)) = (specific, inside(k)) {
                    out.push(entry(k.event(), d));
                }
            }
        }
    }

    if p.media_type.is_none_or(MediaKind::has_seasons) {
        let rows = sqlx::query!(
            r#"SELECT ep.id AS "id!", ep."number" AS "episode_number!", ep.title, to_char(ep."airDate", 'YYYY-MM-DD') AS "date!",
  season."number" AS "season_number!", media.id AS "media_id!", media.title AS "media_title!",
  media."posterUrl" AS poster_url, media."fanartUrl" AS fanart_url, media.status::text AS "status!", media.year,
  EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = ep.id) AS "on_disk!"
FROM items ep
INNER JOIN item_groups season ON season.id = ep."groupId"
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
            json!({"id": e.id, "mediaId": e.media_id, "title": e.media_title, "type": MediaKind::Series, "event": "airing",
                "date": e.date, "posterUrl": e.poster_url, "fanartUrl": e.fanart_url, "status": e.status,
                "year": e.year, "seasonNumber": e.season_number, "episodeNumber": e.episode_number,
                "episodeTitle": e.title, "hasFile": e.on_disk})
        }));
    }
    out.sort_by(|a, b| a["date"].as_str().cmp(&b["date"].as_str()));
    Ok(out)
}
