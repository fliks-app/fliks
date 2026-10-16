//! Seek-bar sprite jobs (spec rule 52): the engine's `Sprite` job tracked as activity.
use crate::{
    events::{Num, Subject},
    state::AppState,
};
use fliks_engine_core::api::{
    JobKind, JobPriority, JobRequest, JobResult, MediaInfo, MediaRef, SpriteMeta,
};
use std::{path::Path, sync::Arc};

/// What a sprite is made from: the file row and the media root its path hangs under.
pub struct SpriteJob<'a> {
    pub file_id: i32,
    pub relative_path: &'a str,
    pub info: Option<&'a MediaInfo>,
    pub media_path: Option<&'a str>,
    pub title: &'a str,
    pub subject: Subject,
    pub force: bool,
    pub priority: JobPriority,
}

/// `None` when the file has no probed duration or no path yet, or when the job fails.
pub async fn generate(st: &AppState, job: SpriteJob<'_>) -> Option<SpriteMeta> {
    let info = job
        .info
        .filter(|i| i.duration_seconds.is_some_and(|d| d != 0.0))?;
    let abs = Path::new(job.media_path.filter(|p| !p.is_empty())?).join(job.relative_path);
    let key = format!("GenerateSprite:{}", job.file_id);
    let activity = st.hub.activity();
    activity.upsert_pending(&key, "GenerateSprite", Some(job.subject.clone()), None);
    let progress = {
        let (hub, key, subject) = (st.hub.clone(), key.clone(), job.subject.clone());
        Arc::new(move |pct: f64| {
            hub.activity().upsert_running(
                &key,
                "GenerateSprite",
                Some(subject.clone()),
                Some(Num(pct.round())),
                Some(Num(100.0)),
                None,
            );
        })
    };
    let req = JobRequest {
        kind: JobKind::Sprite { info: info.clone() },
        media: MediaRef {
            media_file_id: job.file_id as u32,
            path: abs.to_string_lossy().into_owned(),
        },
        priority: Some(job.priority),
        force: job.force,
    };
    let done = st.engine.run_job(&req, Some(progress)).await;
    activity.remove(&key);
    match done {
        Ok(JobResult::Sprite { sprite }) => Some(sprite),
        Ok(_) => None,
        Err(e) => {
            tracing::warn!(
                "Sprite failed for file #{} \"{}\": {e}",
                job.file_id,
                job.title
            );
            None
        }
    }
}

/// The engine's sprites and any the host made before the engine took over.
pub async fn delete_for_file(st: &AppState, file_id: i32) {
    st.engine.invalidate(file_id as u32).await;
    let dir = crate::paths::cache_dir()
        .join("thumbnails")
        .join(file_id.to_string());
    if let Err(e) = tokio::fs::remove_dir_all(&dir).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("Sprite cleanup failed for file #{file_id}: {e}");
    }
}

/// Sprites used to sit directly in the data dir, next to the avatars.
pub(super) fn spawn_legacy_cleanup() {
    if crate::paths::cache_dir() == crate::paths::data_dir() {
        return;
    }
    tokio::spawn(async {
        for name in ["thumbnails", "thumbnails-tmp"] {
            let dir = crate::paths::data_dir().join(name);
            if let Err(e) = tokio::fs::remove_dir_all(&dir).await
                && e.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!("Failed to remove legacy dir \"{}\": {e}", dir.display());
            }
        }
    });
}
