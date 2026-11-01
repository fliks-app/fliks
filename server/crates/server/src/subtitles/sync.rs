//! The subtitle sync queue and its engine job (`subtitles.md` rules 45-49, `subtitle-files.md` rules 22-23).
use super::{
    events,
    files::{self, Dirs, FileRow, MediaCtx},
    model::{self, Row},
};
use crate::sync::MutexExt;
use crate::{
    events::{SseEvent, Subject},
    http::AppError,
    state::AppState,
};
use fliks_domain::js::now_ms;
use fliks_domain::srt::decode_text;
use fliks_engine_core::api::{
    JobKind, JobPriority, JobRequest, JobResult, MediaInfo, MediaRef, SubtitleFormat, SubtitleText,
    SyncReference,
};
use serde_json::{Value, json};
use std::sync::Mutex;

const MAX_CONCURRENT: usize = 2;
const KEEP: usize = 50;

#[derive(Debug, Clone, Default)]
pub struct Options {
    pub reference: Option<String>,
    pub max_offset_seconds: Option<f64>,
    pub no_fix_framerate: Option<bool>,
    pub golden_section_search: Option<bool>,
    pub automatic: bool,
}

#[derive(Clone)]
struct Item {
    subtitle_id: i32,
    status: &'static str,
    error: Option<String>,
    queued_at: i64,
    started_at: Option<i64>,
    completed_at: Option<i64>,
    subject: Subject,
    options: Options,
    job_id: Option<String>,
    cancelled: bool,
}

impl Item {
    fn json(&self) -> Value {
        let mut v = json!({
            "subtitleId": self.subtitle_id,
            "status": self.status,
            "queuedAt": self.queued_at,
            "subject": self.subject,
        });
        for (k, x) in [
            ("error", self.error.as_ref().map(|e| json!(e))),
            ("startedAt", self.started_at.map(|t| json!(t))),
            ("completedAt", self.completed_at.map(|t| json!(t))),
        ] {
            if let Some(x) = x {
                v[k] = x;
            }
        }
        v
    }
}

#[derive(Default)]
pub struct Queue(Mutex<(Vec<Item>, usize)>);

impl Queue {
    fn lock(&self) -> std::sync::MutexGuard<'_, (Vec<Item>, usize)> {
        self.0.lock_clean()
    }

    pub fn snapshot(&self) -> Vec<Value> {
        self.lock().0.iter().map(Item::json).collect()
    }

    /// Records the engine job of a running item; true when a cancel was already asked.
    fn attach(&self, id: i32, job_id: &str) -> bool {
        let mut q = self.lock();
        let Some(i) =
            q.0.iter_mut()
                .find(|i| i.subtitle_id == id && i.status == "running")
        else {
            return false;
        };
        i.job_id = Some(job_id.to_owned());
        i.cancelled
    }

    fn is_cancelled(&self, id: i32) -> bool {
        self.lock()
            .0
            .iter()
            .any(|i| i.subtitle_id == id && i.status == "running" && i.cancelled)
    }
}

/// Cancels a queued item (dropped) or a running one (its engine job is cancelled and its slot
/// settles without touching the subtitle); `locked` stays as `enqueue` left it, like a failure.
pub async fn cancel(st: &AppState, id: i32) {
    let (subject, job_id) = {
        let mut q = st.subtitles.sync.lock();
        let Some(pos) =
            q.0.iter()
                .position(|i| i.subtitle_id == id && matches!(i.status, "queued" | "running"))
        else {
            return;
        };
        if q.0[pos].status == "queued" {
            let item = q.0.remove(pos);
            st.hub.activity().remove(&activity_id(id));
            (item.subject, None)
        } else {
            // A running item settles through its `Slot`; one without a job yet is cancelled by `attach`.
            q.0[pos].cancelled = true;
            (q.0[pos].subject.clone(), q.0[pos].job_id.clone())
        }
    };
    if let Some(job) = job_id
        && let Err(e) = st.engine.cancel_job(&job).await
    {
        tracing::warn!("Cancelling the sync job of subtitle #{id} failed: {e}");
    }
    if let Some(media_id) = subject.media_id {
        events::emit(
            st,
            i32::try_from(media_id).unwrap_or_default(),
            SseEvent::SubtitleSyncCancelled {
                subtitle_id: id.into(),
                media_id: Some(media_id),
            },
        )
        .await;
    }
}

/// `buildMediaProgressSubject`.
pub fn progress_subject(media: &MediaCtx, ep: Option<(i32, i32, i32, Option<String>)>) -> Subject {
    let mut s = Subject {
        title: media.title.clone(),
        media_id: Some(media.id.into()),
        media_type: Some(media.kind),
        season_number: None,
        episode_number: None,
        episode_title: None,
        episode_id: None,
    };
    if let Some((id, season, number, title)) = ep {
        s.season_number = Some(season.into());
        s.episode_number = Some(number.into());
        s.episode_title = title;
        s.episode_id = Some(id.into());
    }
    s
}

/// The episode of a subtitle row: `(id, seasonNumber, episodeNumber, title)`.
pub async fn episode_of(st: &AppState, id: i32) -> Option<(i32, i32, i32, Option<String>)> {
    sqlx::query_as(
        r#"SELECT e.id, s."number", e."number", e.title FROM items e JOIN item_groups s ON s.id = e."groupId" WHERE e.id = $1"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await
    .ok()
    .flatten()
}

fn activity_id(id: i32) -> String {
    format!("SubtitleSync:{id}")
}

/// `enqueueSyncSubtitle`: locks the row, queues the item (or answers the live one) and starts the pump.
pub async fn enqueue(st: &AppState, id: i32, options: Options) -> Result<Value, AppError> {
    let row = model::by_id(&st.db, id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("SubtitleFile #{id} not found")))?;
    if row.is_embedded() {
        return Err(AppError::bad_request("Cannot sync an embedded subtitle"));
    }
    sqlx::query("UPDATE subtitle_files SET locked = true WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await?;
    let media = files::load_media(&st.db, row.media_id.unwrap_or(0)).await?;
    let ep = match row.episode_id {
        Some(e) => episode_of(st, e).await,
        None => None,
    };
    let subject = match &media {
        Some(m) => progress_subject(m, ep),
        None => Subject {
            title: String::new(),
            media_id: None,
            media_type: None,
            season_number: None,
            episode_number: None,
            episode_title: None,
            episode_id: None,
        },
    };
    let item = Item {
        subtitle_id: id,
        status: "queued",
        error: None,
        queued_at: now_ms(),
        started_at: None,
        completed_at: None,
        subject: subject.clone(),
        options,
        job_id: None,
        cancelled: false,
    };
    let out = item.json();
    {
        // The duplicate check and the push share one lock: two requests cannot both queue.
        let mut q = st.subtitles.sync.lock();
        if let Some(live) =
            q.0.iter()
                .find(|i| i.subtitle_id == id && matches!(i.status, "queued" | "running"))
        {
            return Ok(live.json());
        }
        q.0.push(item);
        while q.0.len() > KEEP && matches!(q.0[0].status, "completed" | "failed") {
            q.0.remove(0);
        }
    }
    st.hub
        .activity()
        .upsert_pending(&activity_id(id), "SubtitleSync", Some(subject), None);
    let started = pump(st);
    Ok(started
        .into_iter()
        .find(|(sid, _)| *sid == id)
        .map_or(out, |(_, v)| v))
}

/// Starts queued items while a slot is free; each item runs with its own options.
/// Returns each started item as it looked at the start (what an enqueue answers).
pub fn pump(st: &AppState) -> Vec<(i32, Value)> {
    let mut started = vec![];
    loop {
        let next = {
            let mut q = st.subtitles.sync.lock();
            if q.1 >= MAX_CONCURRENT {
                return started;
            }
            let Some(i) = q.0.iter().position(|i| i.status == "queued") else {
                return started;
            };
            q.1 += 1;
            q.0[i].status = "running";
            q.0[i].started_at = Some(now_ms());
            started.push((q.0[i].subtitle_id, q.0[i].json()));
            (
                q.0[i].subtitle_id,
                q.0[i].subject.clone(),
                q.0[i].options.clone(),
            )
        };
        let (id, subject, options) = next;
        st.hub.activity().upsert_running(
            &activity_id(id),
            "SubtitleSync",
            Some(subject),
            None,
            None,
            None,
        );
        let st = st.clone();
        tokio::spawn(async move {
            let mut slot = Slot {
                st: st.clone(),
                id,
                result: None,
            };
            let res = do_sync(&st, id, &options).await;
            if let Err(e) = &res {
                tracing::warn!("Sync failed for subtitle #{id}: {e}");
            }
            slot.result = Some(res);
        });
    }
}

/// A running slot: whatever way the task ends, a panic included, the item settles, the slot and the
/// activity row are freed and the queue moves on.
struct Slot {
    st: AppState,
    id: i32,
    result: Option<Result<(), String>>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        {
            let mut q = self.st.subtitles.sync.lock();
            let res = self
                .result
                .take()
                .unwrap_or_else(|| Err("Sync task panicked".into()));
            if let Some(item) =
                q.0.iter_mut()
                    .find(|i| i.subtitle_id == self.id && i.status == "running")
            {
                match res {
                    _ if item.cancelled => {}
                    Ok(()) => item.status = "completed",
                    Err(e) => {
                        item.status = "failed";
                        item.error = Some(e);
                    }
                }
                item.completed_at = Some(now_ms());
            }
            q.0.retain(|i| !(i.subtitle_id == self.id && i.cancelled));
            q.1 = q.1.saturating_sub(1);
        }
        self.st.hub.activity().remove(&activity_id(self.id));
        pump(&self.st);
    }
}

fn format_of(stored: &str) -> Result<SubtitleFormat, String> {
    let ext = stored
        .rfind('.')
        .map_or(String::new(), |i| stored[i + 1..].to_lowercase());
    Ok(match ext.as_str() {
        "srt" => SubtitleFormat::Srt,
        "sub" => SubtitleFormat::Sub,
        "ass" => SubtitleFormat::Ass,
        "ssa" => SubtitleFormat::Ssa,
        "vtt" => SubtitleFormat::Vtt,
        _ => {
            return Err(format!(
                "Cannot sync a .{} subtitle",
                if ext.is_empty() { "unknown" } else { &ext }
            ));
        }
    })
}

/// `syncReference`, with the reference confined to the media directory.
fn reference(raw: Option<&str>, dirs: &Dirs) -> Result<SyncReference, String> {
    let Some(raw) = raw.filter(|r| !r.is_empty() && *r != "auto") else {
        return Ok(SyncReference::Auto);
    };
    if let Some((kind, n)) = raw.split_once(':').filter(|(k, n)| {
        matches!(*k, "audio" | "subtitle") && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())
    }) {
        let index: u32 = n
            .parse()
            .map_err(|_| format!("Invalid reference subtitle path: {raw}"))?;
        if index > 999 {
            return Err(format!("Invalid reference subtitle path: {raw}"));
        }
        return Ok(if kind == "audio" {
            SyncReference::AudioStream { index }
        } else {
            SyncReference::SubtitleStream { index }
        });
    }
    let bad = || format!("Invalid reference subtitle path: {raw}");
    let path = raw
        .strip_prefix("file:")
        .filter(|p| !p.is_empty())
        .unwrap_or(raw);
    let abs = if path.starts_with('/') {
        std::path::PathBuf::from(path)
    } else {
        std::path::PathBuf::from(
            fliks_domain::subtitle_path::resolve_subtitle_absolute_path(
                &dirs.m.to_string_lossy(),
                path,
            )
            .ok_or_else(bad)?,
        )
    };
    let real = dunce::canonicalize(&abs).map_err(|_| bad())?;
    let ext = real
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    let ok = real.starts_with(dirs.mc.path())
        && real.is_file()
        && ["srt", "sub", "ass", "ssa", "vtt", "idx"].contains(&ext.as_str());
    if !ok {
        return Err(bad());
    }
    Ok(SyncReference::File {
        path: real.to_string_lossy().into_owned(),
    })
}

async fn load(st: &AppState, id: i32) -> Result<(Row, FileRow, MediaCtx), String> {
    let sql = |e: sqlx::Error| e.to_string();
    let row = model::by_id(&st.db, id)
        .await
        .map_err(sql)?
        .ok_or(format!("SubtitleFile #{id} not found"))?;
    if row.is_embedded() {
        return Err("Cannot sync an embedded subtitle".into());
    }
    let fid = row.media_file_id.unwrap_or(0);
    let file = files::file_by_id(&st.db, fid)
        .await
        .map_err(sql)?
        .ok_or(format!("MediaFile #{fid} not found"))?;
    let mid = row.media_id.unwrap_or(0);
    let media = files::load_media(&st.db, mid)
        .await
        .map_err(sql)?
        .ok_or(format!("Media #{mid} not found or has no root path"))?;
    Ok((row, file, media))
}

/// `doSync`: one engine job over the sidecar's text, written back in place on success.
pub async fn do_sync(st: &AppState, id: i32, o: &Options) -> Result<(), String> {
    let (row, file, media) = load(st, id).await?;
    let info: MediaInfo = file
        .stream_info
        .clone()
        .and_then(|v| serde_json::from_value(v).ok())
        .ok_or("No probe data for this file; rescan the media first")?;
    let dirs = media
        .dirs("no root")
        .map_err(|_| format!("Media #{} not found or has no root path", media.id))?;
    let stored = row.file_path.clone().unwrap_or_default();
    let abs = dirs.resolve_file(&stored).map_err(
        |_| "Subtitle has no resolvable file path (check media root folder and relative path)",
    )?;
    let format = format_of(&stored)?;
    let text = decode_text(&tokio::fs::read(&abs).await.map_err(|e| e.to_string())?);
    let reference = reference(o.reference.as_deref(), &dirs)?;
    let video = dirs.m.join(
        crate::ingest::fsx::safe_rel(&file.relative_path).ok_or("MediaFile path is invalid")?,
    );
    let req = JobRequest {
        kind: JobKind::SubtitleSync {
            info,
            subtitle: SubtitleText { format, text },
            reference,
            max_offset_seconds: o.max_offset_seconds,
            no_fix_framerate: o.no_fix_framerate,
            gss: o.golden_section_search,
        },
        media: MediaRef {
            media_file_id: u32::try_from(file.id).unwrap_or(0),
            path: video.to_string_lossy().into_owned(),
        },
        priority: Some(if o.automatic {
            JobPriority::Low
        } else {
            JobPriority::High
        }),
        force: false,
    };
    let job_id = st
        .engine
        .submit_job(&req)
        .await
        .map_err(|e| e.to_string())?;
    if st.subtitles.sync.attach(id, &job_id) {
        let _ = st.engine.cancel_job(&job_id).await;
    }
    let job = st.engine.wait_job(job_id, &req, None).await;
    if st.subtitles.sync.is_cancelled(id) {
        return Err("Sync cancelled".into());
    }
    let outcome = match job {
        Ok(JobResult::SubtitleSync { subtitle }) => dirs
            .rewrite(&stored, subtitle.text.as_bytes())
            .map_err(|e| e.text()),
        Ok(_) => Err("engine job answered another kind".to_owned()),
        Err(e) => Err(e.to_string()),
    };
    if let Err(detail) = outcome {
        tracing::error!("Subtitle sync failed for #{id}: {detail}");
        let msg: String = detail.chars().take(2000).collect();
        if let Err(e) = sqlx::query(
            r#"UPDATE subtitle_files SET "syncFailed" = true, "errorMessage" = $2 WHERE id = $1"#,
        )
        .bind(id)
        .bind(msg)
        .execute(&st.db)
        .await
        {
            tracing::warn!("sync failure of subtitle #{id} not stored: {e}");
        }
        events::emit(
            st,
            media.id,
            SseEvent::SubtitleSyncFailed {
                subtitle_id: id.into(),
                error: detail.chars().take(2000).collect(),
                media_id: Some(media.id.into()),
            },
        )
        .await;
        return Err(format!("Sync failed: {detail}"));
    }
    sqlx::query(r#"UPDATE subtitle_files SET synced = true, status = 'synced', "syncFailed" = false, "errorMessage" = NULL WHERE id = $1"#)
        .bind(id)
        .execute(&st.db)
        .await
        .map_err(|e| e.to_string())?;
    events::notify(
        st,
        "subtitle.synced",
        json!({"language": row.language, "subtitleId": id}),
    )
    .await;
    events::emit(
        st,
        media.id,
        SseEvent::SubtitleSynced {
            subtitle_id: id.into(),
            language: row.language.clone(),
            media_id: Some(media.id.into()),
            automatic: o.automatic.then_some(true),
        },
    )
    .await;
    crate::media_servers::dispatch_detached(st, "subtitle.synced");
    Ok(())
}
