//! Post-import queue and settle timer (`ingest.md` rules 34-37): in memory, lost on restart.
use super::fsx;
use crate::{
    events::{Num, SseEvent, Subject},
    state::AppState,
};
use fliks_engine_core::api::{JobPriority, MediaInfo};
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
        message: subject
            .as_ref()
            .map(|s| s.title.clone())
            .unwrap_or_default(),
        subject,
    });
}

impl Queue {
    fn lock(&self) -> std::sync::MutexGuard<'_, Q> {
        self.q.lock().expect("post-import queue")
    }

    pub fn enqueue(&self, st: &AppState, file_id: i32) {
        let (start, done, total) = {
            let mut q = self.lock();
            if !q.known.insert(file_id) {
                return;
            }
            q.tasks.push_back(file_id);
            q.total += 1;
            let start = !q.active;
            q.active = true;
            (start, q.done, q.total)
        };
        let act = st.hub.activity();
        act.upsert_pending(
            &format!("{KIND}:{file_id}"),
            KIND,
            None,
            Some(QUEUE_PARENT.into()),
        );
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
            let subject = enrich_subject(st, id).await;
            st.hub.activity().upsert_running(
                &key,
                KIND,
                subject.clone(),
                None,
                None,
                Some(QUEUE_PARENT.into()),
            );
            progress(st, done, total, subject);
            if let Err(e) = enrich(st, id).await {
                tracing::warn!("Post-import enrich of file #{id} failed: {e}");
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

async fn enrich_subject(st: &AppState, id: i32) -> Option<Subject> {
    let r = sqlx::query!(
        r#"SELECT m.id, m.title, m.type::text AS "media_type!" FROM media_files f JOIN media m ON m.id = f."mediaId"
           WHERE f.id = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await
    .ok()??;
    Some(Subject {
        title: r.title,
        media_id: Some(i64::from(r.id)),
        media_type: Some(r.media_type),
        season_number: None,
        episode_number: None,
        episode_title: None,
        episode_id: None,
    })
}

/// The absolute path of a file row, contained in its library root; `None` when it cannot be.
pub async fn file_path(
    st: &AppState,
    id: i32,
) -> Result<Option<(std::path::PathBuf, Option<MediaInfo>)>, sqlx::Error> {
    let Some(r) = sqlx::query!(
        r#"SELECT f."relativePath" AS rel, f."streamInfo" AS info, m."folderName" AS folder, l.path AS "lib?"
           FROM media_files f JOIN media m ON m.id = f."mediaId" LEFT JOIN libraries l ON l.id = m."libraryId"
           WHERE f.id = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await?
    else {
        return Ok(None);
    };
    let resolved = (|| {
        let root = fsx::Root::open(r.lib.as_deref()?).ok()?;
        let p = root
            .media_dir(r.folder.as_deref())
            .ok()?
            .join(fsx::safe_rel(&r.rel)?);
        root.contains(&p, false).then_some(p)
    })();
    let info = r.info.and_then(|v| serde_json::from_value(v).ok());
    Ok(resolved.map(|p| (p, info)))
}

/// `finalizeImportedFile` (rule 50): crop and the OpenSubtitles hash from one engine probe (C67).
async fn enrich(st: &AppState, id: i32) -> Result<(), String> {
    let Some((path, info)) = file_path(st, id).await.map_err(|e| e.to_string())? else {
        return Err("no contained path".into());
    };
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
        info.map(|i| serde_json::to_value(&i))
            .transpose()
            .map_err(|e| e.to_string())?,
        hash,
        size
    )
    .execute(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Per-media timers re-armed by each import of the media (rule 37).
#[derive(Default)]
pub struct Settle(Mutex<HashMap<i32, tokio::task::AbortHandle>>);

impl Settle {
    pub fn schedule(&self, st: &AppState, media_id: i32) {
        let st2 = st.clone();
        let h = tokio::spawn(async move {
            tokio::time::sleep(SETTLE).await;
            st2.ingest
                .settle
                .0
                .lock()
                .expect("settle")
                .remove(&media_id);
            settled(&st2, media_id).await;
        });
        if let Some(old) = self
            .0
            .lock()
            .expect("settle")
            .insert(media_id, h.abort_handle())
        {
            old.abort();
        }
    }
}

/// After a rescan that added nothing the sources are scanned right away.
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
    scan_sources(st, media_id).await;
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
    st.seams.markers.auto_detect_missing(media_id).await;
}
