//! The `MediaCleanup` job (`cleanup.md` rules 15-24): flag, then act on what is due.
use super::{
    db::{self, Scope},
    rules,
};
use crate::{
    ingest::load_media,
    media::write::delete_media_file,
    requests::services::{self, delete_media_folder},
    settings,
    state::AppState,
};
use serde_json::{Value, json};
use std::collections::HashMap;

type Key = (i32, Option<i32>, Option<i32>);

const MAX_PER_RUN_KEY: &str = "cleanup_max_per_run";
const DEFAULT_MAX_PER_RUN: i64 = 10;

fn notify(st: &AppState, event: &'static str, payload: Value) {
    if let Value::Object(p) = payload {
        services::notify(st, event, p);
    }
}

pub async fn run(st: &AppState) -> Result<(), String> {
    let flagged = flag(st).await.map_err(|e| e.to_string())?;
    let max = settings::setting_value(&st.db, MAX_PER_RUN_KEY)
        .await
        .map_err(|e| e.to_string())?
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|n| *n >= 0)
        .unwrap_or(DEFAULT_MAX_PER_RUN);
    let due = db::due(&st.db, max).await.map_err(|e| e.to_string())?;
    let (mut done, mut failed) = (0, 0);
    for d in &due {
        match act(
            st,
            d.media,
            d.scope(),
            &d.action,
            d.delete_series_when_empty,
        )
        .await
        {
            Ok(()) => done += 1,
            Err(e) => {
                failed += 1;
                tracing::warn!("MediaCleanup: media #{} not cleaned: {e}", d.media);
            }
        }
    }
    tracing::info!(
        "MediaCleanup: {flagged} newly flagged, {done} cleaned, {failed} failed (cap {max})"
    );
    Ok(())
}

/// Syncs `cleanup_candidates` with the enabled rules; the lowest rule id wins a scope. Returns the new flags.
pub async fn flag(st: &AppState) -> sqlx::Result<usize> {
    let mut claimed: HashMap<Key, (i32, Option<i32>)> = HashMap::new();
    for r in db::rules_enabled(&st.db).await? {
        for m in rules::matched(&st.db, &r.criteria.0, &r.level, &r.action).await? {
            claimed
                .entry((m.id, m.season_id, m.episode_id))
                .or_insert((r.id, r.grace_days));
        }
    }
    let keys: Vec<Key> = claimed.keys().copied().collect();
    let medias: Vec<i32> = keys.iter().map(|k| k.0).collect();
    let seasons: Vec<Option<i32>> = keys.iter().map(|k| k.1).collect();
    let episodes: Vec<Option<i32>> = keys.iter().map(|k| k.2).collect();
    sqlx::query(
        r#"DELETE FROM cleanup_candidates c WHERE NOT EXISTS (
             SELECT 1 FROM UNNEST($1::int[], $2::int[], $3::int[]) AS t(m, s, e)
             WHERE t.m = c."mediaId" AND t.s IS NOT DISTINCT FROM c."seasonId"
               AND t.e IS NOT DISTINCT FROM c."episodeId")"#,
    )
    .bind(&medias)
    .bind(&seasons)
    .bind(&episodes)
    .execute(&st.db)
    .await?;
    let rule_ids: Vec<i32> = keys.iter().map(|k| claimed[k].0).collect();
    let graces: Vec<Option<i32>> = keys.iter().map(|k| claimed[k].1).collect();
    let fresh: Vec<i32> = sqlx::query_scalar(
        r#"WITH up AS (
             INSERT INTO cleanup_candidates ("mediaId", "seasonId", "episodeId", "ruleId", "deleteAt")
             SELECT t.m, t.s, t.e, t.r, now() + make_interval(days => t.g)
             FROM UNNEST($1::int[], $2::int[], $3::int[], $4::int[], $5::int[]) AS t(m, s, e, r, g)
             ON CONFLICT ("mediaId", "seasonId", "episodeId") DO UPDATE SET "ruleId" = EXCLUDED."ruleId",
               "deleteAt" = COALESCE(cleanup_candidates."deleteAt", EXCLUDED."deleteAt")
             RETURNING id, "deleteAt", (xmax = 0) AS inserted)
           SELECT id FROM up WHERE inserted AND "deleteAt" IS NOT NULL"#,
    )
    .bind(&medias)
    .bind(&seasons)
    .bind(&episodes)
    .bind(&rule_ids)
    .bind(&graces)
    .fetch_all(&st.db)
    .await?;
    remind(st, &fresh).await?;
    Ok(fresh.len())
}

#[derive(sqlx::FromRow)]
struct Due {
    id: i32,
    media: i32,
    title: String,
    delete_at: String,
    days_left: i32,
    thresholds: Vec<i32>,
    last: Option<i32>,
    season: Option<i32>,
    episode: Option<i32>,
}

/// Sends `media.leaving_soon` for the newly flagged candidates and each threshold newly crossed (rules 27-28).
async fn remind(st: &AppState, fresh: &[i32]) -> sqlx::Result<()> {
    let rows: Vec<Due> = sqlx::query_as(
        r#"SELECT c.id, c."mediaId" AS media, m.title, iso_ms(c."deleteAt") AS delete_at,
             CEIL(EXTRACT(EPOCH FROM (c."deleteAt" - now())) / 86400)::int AS days_left,
             r."reminderDays" AS thresholds, c."lastReminderDays" AS last,
             s."seasonNumber" AS season, e."episodeNumber" AS episode
           FROM cleanup_candidates c JOIN media m ON m.id = c."mediaId"
           JOIN cleanup_rules r ON r.id = c."ruleId"
           LEFT JOIN seasons s ON s.id = c."seasonId" LEFT JOIN episodes e ON e.id = c."episodeId"
           WHERE c."deleteAt" > now()"#,
    )
    .fetch_all(&st.db)
    .await?;
    for d in rows {
        let crossed = d
            .thresholds
            .iter()
            .copied()
            .filter(|t| *t >= d.days_left)
            .min();
        let new = crossed.is_some_and(|t| d.last.is_none_or(|l| t < l));
        if !new && !fresh.contains(&d.id) {
            continue;
        }
        if let Some(t) = crossed.filter(|_| new) {
            sqlx::query(r#"UPDATE cleanup_candidates SET "lastReminderDays" = $2 WHERE id = $1"#)
                .bind(d.id)
                .bind(t)
                .execute(&st.db)
                .await?;
        }
        let mut p = json!({"title": d.title, "mediaId": d.media, "deleteAt": d.delete_at, "daysLeft": d.days_left});
        scope_numbers(&mut p, d.season, d.episode);
        notify(st, "media.leaving_soon", p);
    }
    Ok(())
}

/// Adds `seasonNumber` / `episodeNumber` to a notification payload when scoped.
fn scope_numbers(payload: &mut Value, season: Option<i32>, episode: Option<i32>) {
    if let Some(s) = season {
        payload["seasonNumber"] = json!(s);
    }
    if let Some(e) = episode {
        payload["episodeNumber"] = json!(e);
    }
}

/// Runs a rule action on one scope, under the media lock.
pub async fn act(
    st: &AppState,
    id: i32,
    scope: Scope,
    action: &str,
    delete_series_when_empty: bool,
) -> Result<(), String> {
    if scope.season.is_some() {
        return act_scope(st, id, scope, action, delete_series_when_empty).await;
    }
    if action == "delete_files_unmonitor" {
        let lock = st.ingest.media.lock(id).await;
        let media = load_media(&st.db, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("media not found")?;
        let files: Vec<i32> =
            sqlx::query_scalar(r#"SELECT id FROM media_files WHERE "mediaId" = $1 ORDER BY id"#)
                .bind(id)
                .fetch_all(&st.db)
                .await
                .map_err(|e| e.to_string())?;
        for f in files {
            delete_media_file(st, &media, f, true)
                .await
                .map_err(|e| e.text())?;
        }
        sqlx::query("UPDATE media SET monitored = false WHERE id = $1")
            .bind(id)
            .execute(&st.db)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query(
            r#"DELETE FROM cleanup_candidates WHERE "mediaId" = $1 AND "seasonId" IS NULL"#,
        )
        .bind(id)
        .execute(&st.db)
        .await
        .map_err(|e| e.to_string())?;
        drop(lock);
        notify(
            st,
            "media.cleaned_up",
            json!({"title": media.title, "mediaId": id, "action": action}),
        );
        return Ok(());
    }
    remove_whole(st, id, action).await
}

async fn remove_whole(st: &AppState, id: i32, action: &str) -> Result<(), String> {
    let removed = services::remove_media(st, id)
        .await
        .map_err(|e| e.message)?;
    if let Some(path) = &removed.disk_path {
        delete_media_folder(path).await?;
    }
    notify(
        st,
        "media.cleaned_up",
        json!({"title": removed.title, "mediaId": id, "action": action}),
    );
    Ok(())
}

/// Season or episode scope (`cleanup.md` rule 16b): delete its files, unmonitor it, then the series if empty.
async fn act_scope(
    st: &AppState,
    id: i32,
    scope: Scope,
    action: &str,
    delete_series_when_empty: bool,
) -> Result<(), String> {
    let err = |e: sqlx::Error| e.to_string();
    let lock = st.ingest.media.lock(id).await;
    let media = load_media(&st.db, id)
        .await
        .map_err(err)?
        .ok_or("media not found")?;
    let files: Vec<i32> = sqlx::query_scalar(
        r#"SELECT f.id FROM media_files f WHERE f."mediaId" = $1
        AND ($2::int IS NULL OR f."episodeId" = $2)
        AND ($3::int IS NULL OR f."episodeId" IN (SELECT id FROM episodes WHERE "seasonId" = $3))
        ORDER BY f.id"#,
    )
    .bind(id)
    .bind(scope.episode)
    .bind(scope.season)
    .fetch_all(&st.db)
    .await
    .map_err(err)?;
    for f in files {
        delete_media_file(st, &media, f, true)
            .await
            .map_err(|e| e.text())?;
    }
    sqlx::query(
        r#"UPDATE episodes SET monitored = false WHERE ($1::int IS NULL OR id = $1)
        AND ($1::int IS NOT NULL OR "seasonId" = $2)"#,
    )
    .bind(scope.episode)
    .bind(scope.season)
    .execute(&st.db)
    .await
    .map_err(err)?;
    if scope.episode.is_none() {
        sqlx::query("UPDATE seasons SET monitored = false WHERE id = $1")
            .bind(scope.season)
            .execute(&st.db)
            .await
            .map_err(err)?;
    }
    sqlx::query(
        r#"DELETE FROM cleanup_candidates WHERE "mediaId" = $1 AND "seasonId" = $2
        AND ($3::int IS NULL OR "episodeId" = $3)"#,
    )
    .bind(id)
    .bind(scope.season)
    .bind(scope.episode)
    .execute(&st.db)
    .await
    .map_err(err)?;
    let empty = !sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS (SELECT 1 FROM media_files WHERE "mediaId" = $1)"#,
    )
    .bind(id)
    .fetch_one(&st.db)
    .await
    .map_err(err)?;
    let (season, episode): (Option<i32>, Option<i32>) = sqlx::query_as(
        r#"SELECT (SELECT "seasonNumber" FROM seasons WHERE id = $1),
                  (SELECT "episodeNumber" FROM episodes WHERE id = $2)"#,
    )
    .bind(scope.season)
    .bind(scope.episode)
    .fetch_one(&st.db)
    .await
    .map_err(err)?;
    drop(lock);
    let mut p = json!({"title": media.title, "mediaId": id, "action": action});
    scope_numbers(&mut p, season, episode);
    notify(st, "media.cleaned_up", p);
    if delete_series_when_empty && empty {
        remove_whole(st, id, "delete").await?;
    }
    Ok(())
}
