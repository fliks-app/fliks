//! The `MediaCleanup` job (`cleanup.md` rules 15-24): flag, then act on what is due.
use super::{db, rules};
use crate::{
    ingest::load_media,
    media::write::delete_media_file,
    requests::services::{self, delete_media_folder},
    settings,
    state::AppState,
};
use serde_json::{Value, json};
use std::collections::HashMap;

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
    for (id, action) in &due {
        match act(st, *id, action).await {
            Ok(()) => done += 1,
            Err(e) => {
                failed += 1;
                tracing::warn!("MediaCleanup: media #{id} not cleaned: {e}");
            }
        }
    }
    tracing::info!(
        "MediaCleanup: {flagged} newly flagged, {done} cleaned, {failed} failed (cap {max})"
    );
    Ok(())
}

/// Syncs `cleanup_candidates` with the enabled rules; the lowest rule id wins a media. Returns the new flags.
pub async fn flag(st: &AppState) -> sqlx::Result<usize> {
    let mut claimed: HashMap<i32, (i32, Option<i32>)> = HashMap::new();
    for r in db::rules_enabled(&st.db).await? {
        for m in rules::matched(&st.db, &r.criteria.0, &r.action).await? {
            claimed.entry(m.id).or_insert((r.id, r.grace_days));
        }
    }
    let ids: Vec<i32> = claimed.keys().copied().collect();
    sqlx::query(r#"DELETE FROM cleanup_candidates WHERE "mediaId" <> ALL($1)"#)
        .bind(&ids)
        .execute(&st.db)
        .await?;
    let rule_ids: Vec<i32> = ids.iter().map(|m| claimed[m].0).collect();
    let graces: Vec<Option<i32>> = ids.iter().map(|m| claimed[m].1).collect();
    let fresh: Vec<(i32, String, Option<String>)> = sqlx::query_as(
        r#"WITH up AS (
             INSERT INTO cleanup_candidates ("mediaId", "ruleId", "deleteAt")
             SELECT t.m, t.r, now() + make_interval(days => t.g)
             FROM UNNEST($1::int[], $2::int[], $3::int[]) AS t(m, r, g)
             ON CONFLICT ("mediaId") DO UPDATE SET "ruleId" = EXCLUDED."ruleId",
               "deleteAt" = COALESCE(cleanup_candidates."deleteAt", EXCLUDED."deleteAt")
             RETURNING "mediaId", "deleteAt", (xmax = 0) AS inserted)
           SELECT up."mediaId", m.title, iso_ms(up."deleteAt") FROM up JOIN media m ON m.id = up."mediaId"
           WHERE up.inserted AND up."deleteAt" IS NOT NULL"#,
    )
    .bind(&ids)
    .bind(&rule_ids)
    .bind(&graces)
    .fetch_all(&st.db)
    .await?;
    for (id, title, delete_at) in &fresh {
        notify(
            st,
            "media.leaving_soon",
            json!({"title": title, "mediaId": id, "deleteAt": delete_at}),
        );
    }
    Ok(fresh.len())
}

/// Runs a rule action on one media, under its lock.
pub async fn act(st: &AppState, id: i32, action: &str) -> Result<(), String> {
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
        sqlx::query(r#"DELETE FROM cleanup_candidates WHERE "mediaId" = $1"#)
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
