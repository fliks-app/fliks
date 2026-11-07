//! Finishing the commits a crash, a restart or a backup restore left `committing`, and restoring originals.
use super::{
    commit::{self, COLS, End, Job},
    swap::{self, Restore, Swapped},
};
use crate::{ingest::fsx, state::AppState};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// Jobs left `committing` at least `min_age_s` ago: roll the swap forward, or cancel it when nothing moved.
/// Boot and a backup restore pass 0, the periodic sweep leaves a commit that is running alone.
pub async fn recover(st: &AppState, min_age_s: f64) {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        r#"SELECT {COLS} FROM jobs WHERE state = 'committing'
           AND "updatedAt" < now() - make_interval(secs => $1) ORDER BY id"#
    )))
    .bind(min_age_s)
    .fetch_all(&st.db)
    .await;
    let rows = match rows {
        Ok(r) => r,
        Err(e) => return tracing::warn!("commit recovery read failed: {e}"),
    };
    for r in rows {
        let job = Job::from_row(&r);
        let end = recover_one(st, &job).await;
        commit::settle(st, job.id, &end).await;
    }
    let restores = sqlx::query(sqlx::AssertSqlSafe(format!(
        r#"SELECT {COLS} FROM jobs WHERE state = 'done' AND result ? 'restore'
           AND NOT (result ? 'restoredAt') AND "updatedAt" < now() - make_interval(secs => $1)"#
    )))
    .bind(min_age_s)
    .fetch_all(&st.db)
    .await
    .unwrap_or_default();
    for r in restores {
        let job = Job::from_row(&r);
        if let Err(e) = finish_restore(st, &job).await {
            tracing::warn!(job = job.id, "restore not finished, tried again later: {e}");
        }
    }
}

async fn recover_one(st: &AppState, job: &Job) -> End {
    let Some(journal) = job.journal() else {
        return End::Fail("a committing job without a journal".into());
    };
    let file = match job.file_id {
        Some(id) => commit::file_row(st, id)
            .await
            .ok()
            .flatten()
            .map(|f| (id, f)),
        None => None,
    };
    let _media = match &file {
        Some((_, f)) => Some(st.ingest.media.lock(f.media_id).await),
        None => None,
    };
    let _moves = st.folder_moves.read().await;
    let jr = journal.clone();
    let swapped = tokio::task::spawn_blocking(move || swap::perform(&jr)).await;
    match swapped {
        Ok(Ok(Swapped::Done)) => {}
        Ok(Ok(Swapped::Nothing)) => {
            let jr = journal.clone();
            let _ = tokio::task::spawn_blocking(move || swap::abort(&jr)).await;
            return if swap::is(&journal.source, &journal.source_id) {
                End::Skip("the commit never reached the disk".into())
            } else {
                End::Fail("neither the output nor the original is where the journal says".into())
            };
        }
        Ok(Err(e)) if fsx::busy(&e) => {
            tracing::warn!(job = job.id, "recovery swap busy, tried again later: {e}");
            return End::Pending;
        }
        Ok(Err(e)) if swap::is(&journal.target, &journal.staged_id) => {
            return End::Fail(format!(
                "the output is placed but the swap cannot finish: {e}"
            ));
        }
        Ok(Err(e)) => {
            let jr = journal.clone();
            let _ = tokio::task::spawn_blocking(move || swap::abort(&jr)).await;
            return End::Skip(format!("the swap cannot be done: {e}"));
        }
        Err(_) => return End::Pending,
    }
    let Some((file_id, _)) = file else {
        return match commit::mark_done(st, job.id, &journal).await {
            Ok(()) => End::Done,
            Err(_) => End::Pending,
        };
    };
    match commit::complete(st, job.id, file_id, &journal, true).await {
        Ok(()) => End::Done,
        Err(e) => {
            tracing::warn!(
                job = job.id,
                "recovery database step failed, tried again later: {e}"
            );
            End::Pending
        }
    }
}

/// "Restore": the original comes back, the optimized file goes to the trash (never to `.orig`, which only
/// ever holds the real original). Only while the file is still the one the job produced.
pub async fn restore(st: &AppState, id: i64) -> Result<(), String> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        r#"SELECT {COLS} FROM jobs WHERE id = $1 AND state = 'done'"#
    )))
    .bind(id)
    .fetch_optional(&st.db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or("no such finished job")?;
    let job = Job::from_row(&row);
    let journal = job.journal().ok_or("the job has no journal")?;
    let (Some(file_id), Some(back)) = (job.file_id, journal.backup.clone()) else {
        return Err("the original was not kept".into());
    };
    if ["trashPurgedAt", "restoredAt", "restore"]
        .iter()
        .any(|k| job.result.get(k).is_some())
    {
        return Err("the original is gone or already restored".into());
    }
    let f = commit::file_row(st, file_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("the file is gone")?;
    if commit::is_busy(st, file_id).await {
        return Err("the file is being played".into());
    }
    let _media = st.ingest.media.lock(f.media_id).await;
    let _moves = st.folder_moves.read().await;
    let slot = swap::optimized_slot(Path::new(&f.folder), id);
    let ocr: Vec<(PathBuf, PathBuf)> = job
        .result
        .get("ocrTrash")
        .and_then(|v| serde_json::from_value::<Vec<(PathBuf, PathBuf)>>(v.clone()).ok())
        .unwrap_or_default();
    let r = Restore {
        target: journal.target.clone(),
        source: journal.source.clone(),
        back,
        slot,
        optimized: journal.staged_id.clone(),
        original: journal.source_id.clone(),
        companions: journal
            .companions
            .iter()
            .map(|(from, to)| (to.clone(), from.clone()))
            .chain(ocr.into_iter().map(|(from, trashed)| {
                // Trashed under its post-rename name; it returns under the old one.
                let old = journal.companions.iter().find(|(_, to)| *to == from);
                (trashed, old.map_or(from, |(f, _)| f.clone()))
            }))
            .collect(),
    };
    let rc = r.clone();
    if !tokio::task::spawn_blocking(move || rc.startable())
        .await
        .map_err(|e| e.to_string())?
    {
        return Err("the file is not the one the job produced".into());
    }
    sqlx::query(
        r#"UPDATE jobs SET result = result || jsonb_build_object('restore', $2::jsonb, 'trashPath', $3::text),
             "updatedAt" = now() WHERE id = $1 AND state = 'done'"#,
    )
    .bind(id)
    .bind(json!(r))
    .bind(r.slot.to_string_lossy())
    .execute(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    let mut job = job;
    job.result["restore"] = json!(r);
    finish_restore(st, &job).await
}

/// The disk and database halves of a journaled restore, safe to run again.
async fn finish_restore(st: &AppState, job: &Job) -> Result<(), String> {
    let r: Restore =
        serde_json::from_value(job.result.get("restore").cloned().unwrap_or(Value::Null))
            .map_err(|e| e.to_string())?;
    let file_id = job.file_id.ok_or("the file is gone")?;
    let rc = r.clone();
    tokio::task::spawn_blocking(move || swap::perform_restore(&rc))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    commit::sync_rows(st, file_id, &r.source, &r.companions, None).await?;
    sqlx::query(
        r#"UPDATE jobs SET result = result || jsonb_build_object('restoredAt', now()), "updatedAt" = now()
           WHERE id = $1"#,
    )
    .bind(job.id)
    .execute(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
