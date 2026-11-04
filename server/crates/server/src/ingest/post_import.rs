//! Post-import queue and settle timer (`ingest.md` rules 34-37): in memory, lost on restart.
use super::fsx;
use crate::sync::MutexExt;
use crate::{
    events::{Num, SseEvent, Subject},
    state::AppState,
};
use fliks_domain::media::kind::MediaKind;
use fliks_engine_core::api::{JobKind, JobPriority, JobRequest, MediaFamily, MediaInfo, MediaRef};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Mutex,
    time::Duration,
};
use tokio::sync::Notify;

const QUEUE_PARENT: &str = "PostImportEnrichQueue";
const KIND: &str = "PostImportEnrich";
pub const SETTLE: Duration = Duration::from_secs(60);
const IDLE_CEILING: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
struct Q {
    tasks: VecDeque<i32>,
    known: HashSet<i32>,
    active: bool,
    total: u64,
    done: u64,
}

/// FIFO, one task at a time, an id queued or running is not queued again.
#[derive(Default)]
pub struct Queue {
    q: Mutex<Q>,
    idle: Notify,
}

fn progress(st: &AppState, done: u64, total: u64, subject: Option<Subject>) {
    st.hub.emit(SseEvent::TaskProgress {
        command: KIND.into(),
        current: Num(done as f64),
        total: Num(total as f64),
        message: subject.as_ref().map(Subject::format).unwrap_or_default(),
        subject,
    });
}

impl Queue {
    fn lock(&self) -> std::sync::MutexGuard<'_, Q> {
        self.q.lock_clean()
    }

    pub async fn enqueue(&self, st: &AppState, file_id: i32) {
        if self.lock().known.contains(&file_id) {
            return;
        }
        let subject = file_subject(st, file_id).await;
        let act = st.hub.activity();
        let (start, done, total) = {
            let mut q = self.lock();
            if !q.known.insert(file_id) {
                return;
            }
            q.tasks.push_back(file_id);
            q.total += 1;
            let start = !q.active;
            q.active = true;
            // Under the queue lock: a drain that pops this file next must find the row already pending.
            act.upsert_pending(
                &format!("{KIND}:{file_id}"),
                KIND,
                subject,
                Some(QUEUE_PARENT.into()),
            );
            (start, q.done, q.total)
        };
        act.upsert_running(
            QUEUE_PARENT,
            KIND,
            None,
            Some(Num(done as f64)),
            Some(Num(total as f64)),
            None,
        );
        progress(st, done, total, None);
        if start {
            let st = st.clone();
            tokio::spawn(async move { st.ingest.queue.drain(&st).await });
        }
    }

    pub fn is_idle(&self) -> bool {
        let q = self.lock();
        !q.active && q.tasks.is_empty()
    }

    pub async fn when_idle(&self) {
        loop {
            let n = self.idle.notified();
            if self.is_idle() {
                return;
            }
            n.await;
        }
    }

    async fn drain(&self, st: &AppState) {
        loop {
            let next = {
                let mut q = self.lock();
                match q.tasks.pop_front() {
                    Some(id) => Some((id, q.done, q.total)),
                    None => {
                        st.hub.activity().remove(QUEUE_PARENT);
                        *q = Q::default();
                        None
                    }
                }
            };
            let Some((id, done, total)) = next else {
                self.idle.notify_waiters();
                return;
            };
            let key = format!("{KIND}:{id}");
            let subject = file_subject(st, id).await;
            st.hub.activity().upsert_running(
                &key,
                KIND,
                subject.clone(),
                None,
                None,
                Some(QUEUE_PARENT.into()),
            );
            let book = subject
                .as_ref()
                .is_some_and(|s| s.media_type.is_some_and(super::comics::registers));
            progress(st, done, total, subject);
            if let Err(e) = enrich(st, id).await {
                tracing::warn!("Post-import enrich of file #{id} failed: {e}");
            }
            // Whatever the probe returned: the embedded tracks and the search still run.
            if !book
                && let Ok(Some((Some(media), episode))) =
                    sqlx::query_as::<_, (Option<i32>, Option<i32>)>(
                        r#"SELECT f."mediaId", fi."episodeId" FROM media_files f
                       LEFT JOIN media_file_items fi ON fi."mediaFileId" = f.id WHERE f.id = $1"#,
                    )
                    .bind(id)
                    .fetch_optional(&st.db)
                    .await
            {
                crate::subtitles::scheduler::on_media_file_imported(st, media, id, episode).await;
            }
            st.hub.activity().remove(&key);
            let (done, total) = {
                let mut q = self.lock();
                q.known.remove(&id);
                q.done += 1;
                (q.done, q.total)
            };
            if done < total {
                st.hub.activity().upsert_running(
                    QUEUE_PARENT,
                    KIND,
                    None,
                    Some(Num(done as f64)),
                    Some(Num(total as f64)),
                    None,
                );
            }
            progress(st, done, total, None);
        }
    }
}

async fn file_subject(st: &AppState, id: i32) -> Option<Subject> {
    crate::events::subject::for_file(&st.db, id)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("Post-import subject of file #{id} failed: {e}");
            None
        })
}

/// The absolute path of a file row, contained in its library root; `None` when it cannot be.
pub async fn file_path(
    st: &AppState,
    id: i32,
) -> Result<Option<(std::path::PathBuf, Option<MediaInfo>)>, sqlx::Error> {
    let Some(r) = sqlx::query!(
        r#"SELECT f."relativePath" AS rel, f."streamInfo" AS info, lf.path AS folder
           FROM media_files f JOIN library_folders lf ON lf.id = f."folderId"
           WHERE f.id = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await?
    else {
        return Ok(None);
    };
    let resolved = (|| {
        let root = fsx::Root::open(&r.folder).ok()?;
        let p = root.path().join(fsx::safe_rel(&r.rel)?);
        root.contains(&p, false).then_some(p)
    })();
    let info = r.info.and_then(|v| serde_json::from_value(v).ok());
    Ok(resolved.map(|p| (p, info)))
}

/// `finalizeImportedFile` (rule 50): crop and the OpenSubtitles hash from one engine probe, then
/// the source scan while the new bytes are still in the page cache.
async fn enrich(st: &AppState, id: i32) -> Result<(), String> {
    let Some((path, info)) = file_path(st, id).await.map_err(|e| e.to_string())? else {
        return Err("no contained path".into());
    };
    // An `image` file has no video or audio job.
    let comic = sqlx::query_scalar!(
        r#"SELECT m.type = 'comic' AS "comic!" FROM media_files f JOIN media m ON m.id = f."mediaId" WHERE f.id = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await
    .map_err(|e| e.to_string())?
    .unwrap_or(false);
    if comic {
        return Ok(());
    }
    if let Some((family, _)) = super::books::classify(&super::library::file_name(&path)) {
        return enrich_book(st, id, &path, family, info).await;
    }
    let probed = super::probe(
        st,
        &path,
        info.as_ref().is_some_and(|i| !i.video.is_empty()),
    )
    .await?;
    let info = info.map(|mut i| {
        if let (Some(v), Some(p)) = (i.video.first_mut(), probed.info.video.first()) {
            v.crop = p.crop.clone();
        }
        i
    });
    let (hash, size) = probed.moviehash.unzip();
    sqlx::query!(
        r#"UPDATE media_files SET "streamInfo" = COALESCE($2, "streamInfo"), "osdbHash" = $3, "osdbBytesize" = $4 WHERE id = $1"#,
        id,
        info.as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|e| e.to_string())?,
        hash,
        size
    )
    .execute(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    crate::stream::spawn_scan(st, id, path, info);
    Ok(())
}

/// A book file keeps the tags and cover its probe stored (`book-ingest.md` rules 14-15): only the
/// `Cover` job runs, and only where the engine says it applies to the family.
async fn enrich_book(
    st: &AppState,
    id: i32,
    path: &std::path::Path,
    family: fliks_domain::media::family::Family,
    info: Option<MediaInfo>,
) -> Result<(), String> {
    let Some(info) = info.filter(|i| i.cover.is_some()) else {
        return Ok(());
    };
    let engine_family = match family {
        fliks_domain::media::family::Family::Audio => MediaFamily::Audio,
        _ => return Ok(()),
    };
    if !st.engine.job_applies("Cover", engine_family).await {
        return Ok(());
    }
    let req = JobRequest {
        kind: JobKind::Cover { info },
        media: MediaRef {
            media_file_id: id as u32,
            path: path.to_string_lossy().into_owned(),
        },
        priority: Some(JobPriority::Low),
        force: false,
    };
    st.engine
        .run_job(&req, None)
        .await
        .map_err(|e| e.to_string())?;
    let media = sqlx::query_scalar!(r#"SELECT "mediaId" FROM media_files WHERE id = $1"#, id)
        .fetch_optional(&st.db)
        .await
        .map_err(|e| e.to_string())?
        .flatten();
    if let (Some(media), Some(bytes)) =
        (media, st.engine.cover(id).await.map_err(|e| e.to_string())?)
    {
        super::books::store_cover(st, media, &bytes).await;
    }
    Ok(())
}

/// Per-media timers re-armed by each import of the media (rule 37).
#[derive(Default)]
pub struct Settle {
    timers: Mutex<HashMap<i32, tokio::task::AbortHandle>>,
    /// One settle runs at a time across all media.
    turn: tokio::sync::Mutex<()>,
}

impl Settle {
    pub fn schedule(&self, st: &AppState, media_id: i32) {
        let st2 = st.clone();
        let h = tokio::spawn(async move {
            tokio::time::sleep(SETTLE).await;
            st2.ingest.settle.timers.lock_clean().remove(&media_id);
            settled(&st2, media_id).await;
        });
        if let Some(old) = self.timers.lock_clean().insert(media_id, h.abort_handle()) {
            old.abort();
        }
    }

    /// Drops the pending settle of a media whose caller settles it itself.
    pub fn cancel(&self, media_id: i32) {
        if let Some(t) = self.timers.lock_clean().remove(&media_id) {
            t.abort();
        }
    }
}

/// Every file of the media without a scan of its current bytes gets one (a manual rescan).
pub async fn scan_sources(st: &AppState, media_id: i32) {
    let ids = sqlx::query_scalar!(
        r#"SELECT id FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
        media_id
    )
    .fetch_all(&st.db)
    .await
    .unwrap_or_default();
    for id in ids {
        if let Err(e) = crate::stream::scan_file(st, id, JobPriority::Low).await {
            tracing::warn!("Source scan failed for file #{id}: {e:?}");
        }
    }
}

async fn settled(st: &AppState, media_id: i32) {
    let _ = tokio::time::timeout(IDLE_CEILING, st.ingest.queue.when_idle()).await;
    let book = sqlx::query_scalar!(r#"SELECT type FROM media WHERE id = $1"#, media_id)
        .fetch_optional(&st.db)
        .await
        .ok()
        .flatten()
        .and_then(|t| MediaKind::parse(&t));
    match book {
        Some(MediaKind::Book) => {
            super::books::settled(st, media_id).await;
            return;
        }
        Some(MediaKind::Comic) => return,
        _ => {}
    }
    // One batch at a time, so a season pack does not queue every media's jobs at once.
    let _turn = st.ingest.settle.turn.lock().await;
    if super::setting_on(&st.db, "sprites_auto_generate_on_import")
        .await
        .unwrap_or(true)
    {
        let ids = sqlx::query_scalar!(
            r#"SELECT id FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
            media_id
        )
        .fetch_all(&st.db)
        .await
        .unwrap_or_default();
        let thumbs = crate::paths::cache_dir().join("thumbnails");
        for id in ids {
            if thumbs.join(id.to_string()).join("sprite.json").exists() {
                continue;
            }
            if let Err(e) = crate::stream::sprite_file(st, id, false, JobPriority::Low).await {
                tracing::warn!(
                    "Post-import[media #{media_id}]: sprite of file #{id} failed: {e:?}"
                );
            }
        }
    }
    if let Err(e) = crate::markers::auto_detect_missing(st, media_id).await {
        tracing::warn!("Post-import[media #{media_id}]: marker detection failed: {e}");
    }
}
