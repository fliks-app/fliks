//! Post-import queue and settle timer (`ingest.md` rules 34-37): accelerators over the durable markers
//! `media_files.enrichedAt` and `media.settledAt`, which `recover` replays.
use super::fsx;
use crate::sync::MutexExt;
use crate::{
    events::{Num, SseEvent, Subject},
    state::AppState,
};
use fliks_domain::media::kind::MediaKind;
use fliks_engine_core::api::{JobPriority, MediaInfo, VideoStreamInfo};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Mutex,
    time::Duration,
};
use tokio::sync::Notify;

const QUEUE_PARENT: &str = "PostImportEnrichQueue";
const KIND: &str = "PostImportEnrich";
pub const SETTLE: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Q {
    tasks: VecDeque<i32>,
    /// Rescan and recovery backlog: runs only while `tasks` is empty.
    bulk: VecDeque<i32>,
    known: HashSet<i32>,
    active: bool,
    running: Option<i32>,
    total: u64,
    done: u64,
}

impl Q {
    /// The next file and whether it comes from the bulk lane.
    fn pop(&mut self) -> Option<(i32, bool)> {
        match self.tasks.pop_front() {
            Some(id) => Some((id, false)),
            None => self.bulk.pop_front().map(|id| (id, true)),
        }
    }
}

/// FIFO, one task at a time, an id queued or running is not queued again.
#[derive(Default)]
pub struct Queue {
    q: Mutex<Q>,
    /// Pinged at each task end.
    ended: Notify,
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
        self.push(st, file_id, false).await;
    }

    pub async fn enqueue_bulk(&self, st: &AppState, ids: &[i32]) {
        for &id in ids {
            self.push(st, id, true).await;
        }
    }

    async fn push(&self, st: &AppState, file_id: i32, bulk: bool) {
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
            if bulk {
                q.bulk.push_back(file_id);
            } else {
                q.tasks.push_back(file_id);
            }
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
        !q.active && q.tasks.is_empty() && q.bulk.is_empty()
    }

    /// Returns once none of `ids` is queued or running.
    async fn wait_for(&self, ids: &[i32]) {
        loop {
            let n = self.ended.notified();
            if !ids.iter().any(|id| self.lock().known.contains(id)) {
                return;
            }
            n.await;
        }
    }

    async fn drain(&self, st: &AppState) {
        let _unwind = ResetOnPanic { queue: self, st };
        loop {
            let next = {
                let mut q = self.lock();
                match q.pop() {
                    Some((id, bulk)) => {
                        q.running = Some(id);
                        Some((id, bulk, q.done, q.total))
                    }
                    None => {
                        st.hub.activity().remove(QUEUE_PARENT);
                        *q = Q::default();
                        None
                    }
                }
            };
            let Some((id, bulk, done, total)) = next else {
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
                .is_some_and(|s| s.media_type.is_some_and(super::registers));
            progress(st, done, total, subject);
            match enrich(st, id, bulk).await {
                Ok(()) => mark_enriched(st, id).await,
                Err(e) => tracing::warn!("Post-import enrich of file #{id} failed: {e}"),
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
                q.running = None;
                q.done += 1;
                (q.done, q.total)
            };
            self.ended.notify_waiters();
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

/// A panic in the drain drops only the file it was running; the rest of the queue gets a new drain.
struct ResetOnPanic<'a> {
    queue: &'a Queue,
    st: &'a AppState,
}

impl Queue {
    fn recover(&self, st: &AppState) {
        let (failed, more) = {
            let mut q = self.lock();
            let failed = q.running.take();
            if let Some(id) = failed {
                q.known.remove(&id);
                q.done += 1;
            }
            let more = !q.tasks.is_empty() || !q.bulk.is_empty();
            if !more {
                *q = Q::default();
            }
            (failed, more)
        };
        if let Some(id) = failed {
            tracing::error!("Post-import enrich of file #{id} panicked");
            st.hub.activity().remove(&format!("{KIND}:{id}"));
        }
        self.ended.notify_waiters();
        if more {
            let st = st.clone();
            tokio::spawn(async move { st.ingest.queue.drain(&st).await });
        } else {
            st.hub.activity().remove(QUEUE_PARENT);
        }
    }
}

impl Drop for ResetOnPanic<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.queue.recover(self.st);
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
/// the source scan while the new bytes are still in the page cache (not for the bulk backlog).
async fn enrich(st: &AppState, id: i32, bulk: bool) -> Result<(), String> {
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
    // An audio file's cover is stored by the settle of its media.
    let name = super::library::file_name(&path);
    if super::books::classify(&name).is_some() || super::music::is_music_file(&name) {
        return Ok(());
    }
    let video = info.as_ref().is_some_and(|i| !i.video.is_empty());
    let probed = super::probe_hashed(st, &path, video).await?;
    let (hash, size) = probed.moviehash.unzip();
    sqlx::query!(
        r#"UPDATE media_files SET "osdbHash" = $2, "osdbBytesize" = $3 WHERE id = $1"#,
        id,
        hash,
        size
    )
    .execute(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    let Some(mut info) = info.filter(|_| video) else {
        return Ok(());
    };
    let p = probed.info.video.first();
    store_crop(&st.db, id, p).await.map_err(|e| e.to_string())?;
    info.video[0].crop = p.and_then(|v| v.crop.clone());
    info.video[0].crop_stable = p.and_then(|v| v.crop_stable);
    if !bulk {
        crate::stream::spawn_scan(st, id, path, Some(info));
    }
    Ok(())
}

/// Writes only `video[0].crop` and `cropStable` (absent when unknown, as serialised): the rest may have moved.
pub(super) async fn store_crop(
    db: &sqlx::PgPool,
    id: i32,
    probed: Option<&VideoStreamInfo>,
) -> sqlx::Result<()> {
    let crop = serde_json::json!(probed.and_then(|v| v.crop.as_ref()));
    let stable = serde_json::json!(probed.and_then(|v| v.crop_stable));
    sqlx::query!(
        r#"UPDATE media_files SET "streamInfo" = jsonb_set("streamInfo", '{video,0}',
             ("streamInfo"->'video'->0) - 'crop' - 'cropStable'
               || jsonb_strip_nulls(jsonb_build_object('crop', $2::jsonb, 'cropStable', $3::jsonb)))
           WHERE id = $1 AND jsonb_array_length("streamInfo"->'video') > 0"#,
        id,
        crop,
        stable
    )
    .execute(db)
    .await?;
    Ok(())
}

async fn mark_enriched(st: &AppState, id: i32) {
    if let Err(e) = sqlx::query!(
        r#"UPDATE media_files SET "enrichedAt" = now() WHERE id = $1"#,
        id
    )
    .execute(&st.db)
    .await
    {
        tracing::warn!("Post-import: file #{id} not marked enriched: {e}");
    }
}

/// Files imported within the last `RECOVER_DAYS` days past the sweep's reach are left alone.
const RECOVER_DAYS: i32 = 7;

/// The files to enrich and the media to settle again, oldest first.
async fn pending(db: &sqlx::PgPool) -> Result<(Vec<i32>, Vec<i32>), sqlx::Error> {
    let files = sqlx::query_scalar!(
        r#"SELECT id FROM media_files
           WHERE "enrichedAt" IS NULL AND "createdAt" > now() - make_interval(days => $1)
           ORDER BY id"#,
        RECOVER_DAYS
    )
    .fetch_all(db)
    .await?;
    let media = sqlx::query_scalar!(
        r#"SELECT m.id FROM media m WHERE EXISTS (
             SELECT 1 FROM media_files f WHERE f."mediaId" = m.id
               AND f."createdAt" > now() - make_interval(days => $1)
               AND f."createdAt" > COALESCE(m."settledAt", '-infinity'))
           ORDER BY m.id"#,
        RECOVER_DAYS
    )
    .fetch_all(db)
    .await?;
    Ok((files, media))
}

/// `recover` once the engine is adopted: a probe before that fails `NotRunning` and leaves the file unmarked.
pub async fn recover_when_engine_ready(st: &AppState) {
    let mut adopted = st.engine.adoptions();
    if !st.engine.enabled() && adopted.changed().await.is_err() {
        return;
    }
    recover(st).await;
}

/// Replays the work a restart lost: the files without `enrichedAt` and the media with a file newer
/// than their `settledAt`, bounded by age. Runs at boot and on the daily prune tick.
pub async fn recover(st: &AppState) {
    let (files, media) = match pending(&st.db).await {
        Ok(p) => p,
        Err(e) => return tracing::warn!("Post-import recovery not read: {e}"),
    };
    if !files.is_empty() || !media.is_empty() {
        tracing::info!(
            "Post-import recovery: {} file(s) to enrich, {} media to settle",
            files.len(),
            media.len()
        );
    }
    st.ingest.queue.enqueue_bulk(st, &files).await;
    for id in media {
        st.ingest.settle.schedule(st, id);
    }
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

/// Whether the file's queued job may start at once (its profile has no minimum age).
pub(crate) async fn starts_now(st: &AppState, file_id: i32) -> bool {
    sqlx::query_scalar::<_, bool>(
        r#"SELECT "notBefore" <= now() FROM jobs WHERE "mediaFileId" = $1 AND state = 'queued' AND kind = 'optimize'"#,
    )
    .bind(file_id)
    .fetch_optional(&st.db)
    .await
    .ok()
    .flatten()
    .unwrap_or(false)
}

async fn settled(st: &AppState, media_id: i32) {
    // Optimize plans freeze the crop: wait for this media's own enrich, however long the backlog.
    let files = sqlx::query_scalar!(
        r#"SELECT id FROM media_files WHERE "mediaId" = $1"#,
        media_id
    )
    .fetch_all(&st.db)
    .await
    .unwrap_or_default();
    st.ingest.queue.wait_for(&files).await;
    let began = sqlx::query_scalar!(r#"SELECT now() AS "now!""#)
        .fetch_one(&st.db)
        .await;
    if settle(st, media_id).await
        && let Ok(began) = began
        && let Err(e) = sqlx::query!(
            r#"UPDATE media SET "settledAt" = $2 WHERE id = $1"#,
            media_id,
            began
        )
        .execute(&st.db)
        .await
    {
        tracing::warn!("Post-import[media #{media_id}]: settle not recorded: {e}");
    }
}

/// False when the settle asked to run again (a transient identification failure).
async fn settle(st: &AppState, media_id: i32) -> bool {
    let book = sqlx::query_scalar!(r#"SELECT type FROM media WHERE id = $1"#, media_id)
        .fetch_optional(&st.db)
        .await
        .ok()
        .flatten()
        .and_then(|t| MediaKind::parse(&t));
    match book {
        Some(MediaKind::Book) => return super::books::settled(st, media_id).await,
        Some(MediaKind::Album) => {
            super::music::settled(st, media_id).await;
            return true;
        }
        Some(MediaKind::Comic) => {
            if let Err(e) = crate::media::service::fields::merge_unmatched(st, media_id).await {
                tracing::warn!("Post-import[comic #{media_id}]: file merge failed: {e}");
            }
            return true;
        }
        _ => {
            if let Err(e) = crate::media::service::fields::merge_unmatched(st, media_id).await {
                tracing::warn!("Post-import[media #{media_id}]: file merge failed: {e}");
            }
        }
    }
    // One batch at a time, so a season pack does not queue every media's jobs at once.
    let _turn = st.ingest.settle.turn.lock().await;
    let ids = sqlx::query_scalar!(
        r#"SELECT id FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
        media_id
    )
    .fetch_all(&st.db)
    .await
    .unwrap_or_default();
    // A job that starts now rewrites the file and the commit requeues its sprites.
    let mut immediate = HashSet::new();
    for &id in &ids {
        match crate::queue::queue_new(st, id).await {
            Ok(q) if q.outcome == crate::queue::Outcome::Queued && starts_now(st, id).await => {
                immediate.insert(id);
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(
                "Post-import[media #{media_id}]: optimize queueing of file #{id} failed: {e}"
            ),
        }
    }
    for id in ids {
        if !immediate.contains(&id) {
            sprite_if_missing(st, id).await;
        }
    }
    if let Err(e) = crate::markers::auto_detect_missing(st, media_id).await {
        tracing::warn!("Post-import[media #{media_id}]: marker detection failed: {e}");
    }
    true
}

/// Asks the engine for the seek sprites of a file (it answers a cached sheet at once), when the import setting asks for them.
pub(crate) async fn sprite_if_missing(st: &AppState, id: i32) {
    if !super::setting_on(&st.db, "sprites_auto_generate_on_import")
        .await
        .unwrap_or(true)
    {
        return;
    }
    if let Err(e) = crate::stream::sprite_file(st, id, false, JobPriority::Low, None).await {
        tracing::warn!("sprite of file #{id} failed: {e:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[sqlx::test(migrations = false)]
    async fn recovery_finds_the_recent_files_and_media_a_restart_left_unfinished(db: sqlx::PgPool) {
        crate::db::migrate(&db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO libraries (id, name) VALUES (1, 'L');
               INSERT INTO library_folders (id, "libraryId", path) VALUES (1, 1, '/m');
               INSERT INTO media (id, title, type, "libraryId", "folderName", "settledAt")
                 VALUES (1, 'A', 'movie', 1, 'a', now()), (2, 'B', 'movie', 1, 'b', NULL),
                        (3, 'C', 'movie', 1, 'c', NULL);
               INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "createdAt", "enrichedAt") VALUES
                 (1, 1, 1, 'a.mkv', 1, 'x', now() - interval '1 hour', now()),
                 (2, 2, 1, 'b.mkv', 1, 'x', now() - interval '1 hour', NULL),
                 (3, 3, 1, 'c.mkv', 1, 'x', now() - interval '30 days', NULL)"#,
        )
        .execute(&db)
        .await
        .unwrap();
        assert_eq!(pending(&db).await.unwrap(), (vec![2], vec![2]));
    }

    #[sqlx::test(migrations = false)]
    async fn boot_recovery_waits_for_the_engine(pool: sqlx::PgPool) {
        crate::db::migrate(&pool).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO libraries (id, name) VALUES (1, 'L');
               INSERT INTO library_folders (id, "libraryId", path) VALUES (1, 1, '/m');
               INSERT INTO media (id, title, type, "libraryId", "folderName", "settledAt")
                 VALUES (1, 'A', 'movie', 1, 'a', NULL);
               INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "createdAt", "enrichedAt")
                 VALUES (1, 1, 1, 'a.mkv', 1, 'x', now() - interval '1 hour', now())"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let st = crate::metadata::books::tests::state(&pool, vec![]);
        let task = tokio::spawn({
            let st = st.clone();
            async move { recover_when_engine_ready(&st).await }
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            st.ingest.settle.timers.lock_clean().is_empty(),
            "no engine yet"
        );
        task.abort();
    }

    #[sqlx::test(migrations = false)]
    async fn a_panic_drops_only_the_running_file_and_keeps_the_queue(pool: sqlx::PgPool) {
        let st = crate::metadata::books::tests::state(&pool, vec![]);
        {
            let mut q = st.ingest.queue.lock();
            q.known.extend([1, 2]);
            q.tasks.push_back(2);
            q.running = Some(1);
            q.active = true;
            q.total = 2;
        }
        st.ingest.queue.recover(&st);
        let q = st.ingest.queue.lock();
        assert_eq!(q.tasks, [2]);
        assert_eq!(q.known, HashSet::from([2]));
        assert_eq!((q.running, q.active, q.done), (None, true, 1));
    }

    #[test]
    fn an_import_overtakes_the_bulk_backlog() {
        let mut q = Q::default();
        q.bulk.extend([1, 2]);
        q.tasks.push_back(3);
        assert_eq!(q.pop(), Some((3, false)));
        assert_eq!(q.pop(), Some((1, true)));
    }

    #[tokio::test]
    async fn a_wait_ends_when_its_files_leave_the_queue() {
        let queue = std::sync::Arc::new(Queue::default());
        queue.lock().known.extend([1, 2]);
        let w = tokio::spawn({
            let queue = queue.clone();
            async move { queue.wait_for(&[2, 9]).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        queue.lock().known.remove(&1);
        queue.ended.notify_waiters();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!w.is_finished(), "file 2 is still queued");
        queue.lock().known.remove(&2);
        queue.ended.notify_waiters();
        tokio::time::timeout(Duration::from_secs(1), w)
            .await
            .unwrap()
            .unwrap();
    }

    #[sqlx::test(migrations = false)]
    async fn a_panic_on_the_last_file_leaves_an_idle_queue(pool: sqlx::PgPool) {
        let st = crate::metadata::books::tests::state(&pool, vec![]);
        {
            let mut q = st.ingest.queue.lock();
            q.known.insert(1);
            q.running = Some(1);
            q.active = true;
        }
        st.ingest.queue.recover(&st);
        assert!(st.ingest.queue.is_idle());
    }
}
