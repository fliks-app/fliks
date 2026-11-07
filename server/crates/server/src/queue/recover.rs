//! Finishing the commits a crash, a restart or a backup restore left `committing`, and restoring originals.
use super::{
    commit::{self, COLS, End, Job},
    swap::{self, Swapped},
};
use crate::{ingest::fsx, state::AppState};

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
        Ok(Ok(Swapped::Nothing)) if swap::is(&journal.source, &journal.source_id) => {
            return End::Skip("the commit never reached the disk".into());
        }
        Ok(Ok(Swapped::Nothing)) => {
            return End::Fail(
                "neither the output nor the original is where the journal says".into(),
            );
        }
        Ok(Err(e)) => {
            tracing::warn!(job = job.id, "recovery swap failed, tried again later: {e}");
            return End::Pending;
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

/// "Restore": the original comes back, the optimized file takes its slot in the trash or `.orig`. Only while
/// the file is still the one the job produced.
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
    if job.result.get("trashPurgedAt").is_some() || job.result.get("restoredAt").is_some() {
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
    let (jr, b) = (journal.clone(), back.clone());
    tokio::task::spawn_blocking(move || swap::restore(&jr, &b))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    sqlx::query(
        r#"UPDATE jobs SET result = result || jsonb_build_object('restoredAt', now()), "updatedAt" = now()
           WHERE id = $1"#,
    )
    .bind(id)
    .execute(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    commit::sync_rows(st, file_id, &journal.source, &[], None).await?;
    let _ = fsx::Root::open(&f.folder);
    Ok(())
}
