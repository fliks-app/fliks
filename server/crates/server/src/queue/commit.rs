//! Commit of a `staged` job (plan, "Commit (server)"): the output replaces the source under the locks,
//! journaled so a crash is finished by `recover`, then the database follows through the rescan path.
use super::{
    settings::{self, OriginalPolicy},
    swap::{self, Journal, Swapped},
    words,
};
use crate::{
    engine::SessionFilter,
    events::SseEvent,
    ingest::{
        busy, fsx,
        rescan::{self, Change, Stored},
    },
    state::AppState,
};
use fliks_engine_core::api::{JobPriority, MediaInfo};
use serde_json::{Value, json};
use sqlx::Row;
use std::{
    io,
    path::{Path, PathBuf},
};

/// A file held by a player is looked at again after this.
const BUSY_DELAY_S: f64 = 300.0;
/// The output may be this much shorter or longer than what the worker reported.
const DURATION_SLACK_S: f64 = 1.0;

/// A `staged` or `committing` job.
pub struct Job {
    pub id: i64,
    pub file_id: Option<i32>,
    pub in_path: Option<String>,
    pub in_size: Option<i64>,
    pub in_mtime: Option<i64>,
    pub in_dev: Option<i64>,
    pub in_ino: Option<i64>,
    pub staged: Option<String>,
    pub out_size: Option<i64>,
    pub result: Value,
    pub payload: Value,
}

impl Job {
    pub fn from_row(r: &sqlx::postgres::PgRow) -> Job {
        Job {
            id: r.get("id"),
            file_id: r.get("mediaFileId"),
            in_path: r.get("inPath"),
            in_size: r.get("inSize"),
            in_mtime: r.get("inMtimeMs"),
            in_dev: r.get("inDev"),
            in_ino: r.get("inIno"),
            staged: r.get("stagedPath"),
            out_size: r.get("outSize"),
            result: r.get::<Option<Value>, _>("result").unwrap_or(Value::Null),
            payload: r.get("payload"),
        }
    }

    pub fn journal(&self) -> Option<Journal> {
        serde_json::from_value(self.result.get("journal")?.clone()).ok()
    }
}

pub const COLS: &str = r#"id, "mediaFileId", "inPath", "inSize", "inMtimeMs", "inDev", "inIno",
    "stagedPath", "outSize", result, payload"#;

/// How an attempt ended.
#[derive(Debug, PartialEq, Eq)]
pub enum End {
    Done,
    /// Postponed, not a failure: a player, a locked file, an engine that is away.
    Busy(String),
    Skip(String),
    Fail(String),
    /// Left as it is: the journal is finished later by `recover`.
    Pending,
}

/// The file a job replaces, with the media and library it belongs to.
pub struct FileRow {
    pub media_id: i32,
    pub folder: String,
    pub rel: String,
    pub allow_rename: bool,
    pub info: Option<MediaInfo>,
    pub mtime_ms: Option<i64>,
}

pub async fn file_row(st: &AppState, id: i32) -> sqlx::Result<Option<FileRow>> {
    let r = sqlx::query(
        r#"SELECT f."mediaId", f."relativePath", f."streamInfo", f."mtimeMs", lf.path,
                  COALESCE(l."allowRename", false) AS rename
           FROM media_files f JOIN library_folders lf ON lf.id = f."folderId"
           LEFT JOIN media m ON m.id = f."mediaId" LEFT JOIN libraries l ON l.id = m."libraryId"
           WHERE f.id = $1"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await?;
    Ok(r.map(|r| FileRow {
        media_id: r.get("mediaId"),
        folder: r.get("path"),
        rel: r.get("relativePath"),
        allow_rename: r.get("rename"),
        info: r
            .get::<Option<Value>, _>("streamInfo")
            .and_then(|v| serde_json::from_value(v).ok()),
        mtime_ms: r.get("mtimeMs"),
    }))
}

/// Every `staged` job that is due, one at a time.
pub async fn run(st: &AppState) {
    loop {
        let row = sqlx::query(sqlx::AssertSqlSafe(format!(
            r#"SELECT {COLS} FROM jobs WHERE state = 'staged' AND "notBefore" <= now()
               ORDER BY id LIMIT 1"#
        )))
        .fetch_optional(&st.db)
        .await;
        let job = match row {
            Ok(Some(r)) => Job::from_row(&r),
            Ok(None) => return,
            Err(e) => return tracing::warn!("commit queue read failed: {e}"),
        };
        let end = commit(st, &job).await;
        settle(st, job.id, &end).await;
        if end == End::Pending {
            return;
        }
    }
}

pub async fn settle(st: &AppState, id: i64, end: &End) {
    let (state, class, msg) = match end {
        End::Done | End::Pending => return,
        End::Busy(m) => {
            let r = sqlx::query(
                r#"UPDATE jobs SET state = 'staged', "notBefore" = now() + make_interval(secs => $2),
                     "updatedAt" = now() WHERE id = $1 AND state IN ('staged', 'committing')"#,
            )
            .bind(id)
            .bind(BUSY_DELAY_S)
            .execute(&st.db)
            .await;
            tracing::info!(job = id, "commit postponed: {m}");
            if let Err(e) = r {
                tracing::warn!(job = id, "commit postponement not stored: {e}");
            }
            return;
        }
        End::Skip(m) => ("skipped", "stale", m),
        End::Fail(m) => ("failed", "verify", m),
    };
    let r = sqlx::query(
        r#"UPDATE jobs SET state = $2, error = $3, "finishedAt" = now(), "updatedAt" = now()
           WHERE id = $1 AND state IN ('staged', 'committing')"#,
    )
    .bind(id)
    .bind(state)
    .bind(json!({"class": class, "message": msg}))
    .execute(&st.db)
    .await;
    if let Err(e) = r {
        tracing::warn!(job = id, "commit end not stored: {e}");
    }
}

/// Whether someone is playing or downloading the file: an engine session, a recent `download`
/// resolve, or recent playback. An engine that cannot answer counts as busy.
pub async fn is_busy(st: &AppState, file_id: i32) -> bool {
    let filter = SessionFilter {
        owner_id: None,
        media_file_id: Some(file_id as u32),
    };
    match st.engine.list_sessions(&filter).await {
        Ok(s) if s.is_empty() => {}
        _ => return true,
    }
    st.queue.recent_download(file_id) || busy::listening(st, &[file_id]).await.unwrap_or(true)
}

/// Same streams and length as what the worker reported.
fn same_shape(a: &MediaInfo, b: &MediaInfo) -> bool {
    let near = match (a.duration_seconds, b.duration_seconds) {
        (Some(x), Some(y)) => (x - y).abs() <= DURATION_SLACK_S,
        _ => true,
    };
    near && (a.video.len(), a.audio.len(), a.subtitles.len())
        == (b.video.len(), b.audio.len(), b.subtitles.len())
}

/// Before any lock: the staged file is what the worker reported, probed by the local engine.
async fn prepare(st: &AppState, j: &Job, staged: &Path) -> Result<MediaInfo, End> {
    let meta = tokio::fs::metadata(staged)
        .await
        .map_err(|e| End::Fail(format!("the staged output is unreadable: {e}")))?;
    if Some(meta.len() as i64) != j.out_size {
        return Err(End::Fail(
            "the staged output is not the size reported".into(),
        ));
    }
    let reported: MediaInfo = serde_json::from_value(j.result.clone())
        .map_err(|_| End::Fail("the job holds no probe of its output".into()))?;
    let probed = st
        .engine
        .probe(&staged.to_string_lossy(), false, false, false)
        .await
        .map_err(|e| End::Busy(format!("engine probe: {e}")))?;
    match probed.info.filter(|_| probed.ok) {
        Some(i) if same_shape(&i, &reported) => Ok(i),
        Some(_) => Err(End::Fail(
            "the staged output differs from the worker's probe".into(),
        )),
        None => Err(End::Fail("the staged output does not probe".into())),
    }
}

/// The source is still what the job read (`stale` otherwise) and the staged file still has its size.
fn stat_checks(j: &Job, abs: &Path, staged: &Path) -> Result<(), String> {
    let (real, meta) = fsx::regular_source(abs).map_err(|e| format!("source: {e}"))?;
    let mtime = rescan::mtime_ms(&meta);
    let id = swap::ident(&real).map_err(|e| e.to_string())?;
    let same = j.in_path.as_deref() == Some(&real.to_string_lossy())
        && j.in_size == Some(meta.len() as i64)
        && j.in_mtime == mtime
        && (id.ino == 0 || (j.in_dev, j.in_ino) == (Some(id.dev as i64), Some(id.ino as i64)));
    if !same {
        return Err("the source changed during the job".into());
    }
    match swap::ident(staged) {
        Ok(s) if Some(s.size as i64) == j.out_size => Ok(()),
        _ => Err("the staged output changed".into()),
    }
}

/// The plan's container extension, for the renaming.
fn container_ext(j: &Job) -> &'static str {
    match j.payload.pointer("/plan/container").and_then(Value::as_str) {
        Some("mkv") => "mkv",
        Some("mp4") => "mp4",
        _ => "",
    }
}

/// Files that follow a renamed video: `<old stem>.<tail>` that is not a video or one of ours.
fn companions(source: &Path, target: &Path) -> Vec<(PathBuf, PathBuf)> {
    let (Some(dir), Some(old), Some(new)) = (
        source.parent(),
        source.file_stem().and_then(|s| s.to_str()),
        target.file_stem().and_then(|s| s.to_str()),
    ) else {
        return vec![];
    };
    let Ok(rd) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut out: Vec<_> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let tail = name.strip_prefix(&format!("{old}."))?;
            let skip = name.starts_with(".fliks-")
                || tail.ends_with("orig")
                || crate::ingest::is_video(&name)
                || !e.file_type().ok()?.is_file();
            (!skip).then(|| (e.path(), dir.join(format!("{new}.{tail}"))))
        })
        .collect();
    out.sort();
    out
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(f).await.ok()
}

fn transient(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy
    )
}

/// The whole commit of one `staged` job.
pub async fn commit(st: &AppState, j: &Job) -> End {
    let (Some(file_id), Some(staged)) = (j.file_id, j.staged.as_deref().map(PathBuf::from)) else {
        return End::Skip("the file or its output is gone".into());
    };
    let Ok(Some(f)) = file_row(st, file_id).await else {
        return End::Skip("the file is gone".into());
    };
    let Some(abs) = fsx::locate(&f.folder, &f.rel) else {
        return End::Skip("the file left its folder".into());
    };
    let Ok(root) = fsx::Root::open(&f.folder) else {
        return End::Busy("the library folder is not readable".into());
    };
    let settings = match settings::load(&st.db).await {
        Ok(s) => s,
        Err(e) => return End::Busy(format!("settings: {e}")),
    };
    let new_info = match prepare(st, j, &staged).await {
        Ok(i) => i,
        Err(e) => return e,
    };
    if is_busy(st, file_id).await {
        return End::Busy("the file is being played".into());
    }
    let _media = st.ingest.media.lock(f.media_id).await;
    let _moves = st.folder_moves.read().await;
    let (jc, a, s) = (clone_job(j), abs.clone(), staged.clone());
    match blocking(move || stat_checks(&jc, &a, &s)).await {
        Some(Ok(())) => {}
        Some(Err(m)) => return End::Skip(m),
        None => return End::Pending,
    }
    let Some(journal) = journal_for(
        j,
        &f,
        &root,
        &abs,
        &staged,
        &new_info,
        settings.optimize_original,
    )
    .await
    else {
        return End::Skip("the source changed during the job".into());
    };
    let wrote = sqlx::query(
        r#"UPDATE jobs SET state = 'committing', "updatedAt" = now(),
             result = COALESCE(result, '{}'::jsonb) || jsonb_build_object('journal', $2::jsonb)
           WHERE id = $1 AND state = 'staged'"#,
    )
    .bind(j.id)
    .bind(json!(journal))
    .execute(&st.db)
    .await;
    match wrote {
        Ok(r) if r.rows_affected() == 1 => {}
        Ok(_) => return End::Pending,
        Err(e) => return End::Busy(format!("journal: {e}")),
    }
    let jr = journal.clone();
    match blocking(move || swap::perform(&jr)).await {
        Some(Ok(Swapped::Done)) => {}
        Some(Ok(Swapped::Nothing)) => return End::Skip("the staged output vanished".into()),
        Some(Err(e)) if transient(&e) => return End::Busy(format!("the file is in use: {e}")),
        Some(Err(e)) => {
            tracing::error!(job = j.id, "swap failed, the journal stays: {e}");
            return End::Pending;
        }
        None => return End::Pending,
    }
    match complete(st, j.id, file_id, &journal, true).await {
        Ok(()) => End::Done,
        Err(e) => {
            tracing::error!(job = j.id, "database step failed, recovery retries: {e}");
            End::Pending
        }
    }
}

fn clone_job(j: &Job) -> Job {
    Job {
        result: Value::Null,
        payload: Value::Null,
        id: j.id,
        file_id: j.file_id,
        in_path: j.in_path.clone(),
        in_size: j.in_size,
        in_mtime: j.in_mtime,
        in_dev: j.in_dev,
        in_ino: j.in_ino,
        staged: j.staged.clone(),
        out_size: j.out_size,
    }
}

async fn journal_for(
    j: &Job,
    f: &FileRow,
    root: &fsx::Root,
    abs: &Path,
    staged: &Path,
    new: &MediaInfo,
    policy: OriginalPolicy,
) -> Option<Journal> {
    let (root_p, source, staged, id) = (
        root.path().to_owned(),
        abs.to_owned(),
        staged.to_owned(),
        j.id,
    );
    let (allow, ext, new) = (f.allow_rename, container_ext(j), new.clone());
    blocking(move || {
        let (real, _) = fsx::regular_source(&source).ok()?;
        let target = allow
            .then(|| {
                let name = real.file_name()?.to_str()?;
                Some(real.with_file_name(words::renamed(name, &new, ext)?))
            })
            .flatten()
            .filter(|t| !t.exists())
            .unwrap_or_else(|| real.clone());
        Some(Journal {
            source_id: swap::ident(&real).ok()?,
            staged_id: swap::ident(&staged).ok()?,
            backup: swap::backup_path(policy, &root_p, &real, id),
            old: swap::old_path(&real, id),
            companions: if target == real {
                vec![]
            } else {
                companions(&real, &target)
            },
            target,
            source: real,
            staged,
            policy,
        })
    })
    .await
    .flatten()
}

/// After the swap, from a commit or a recovery: the rows follow the new bytes, then the job is `done`.
pub async fn complete(
    st: &AppState,
    id: i64,
    file_id: i32,
    j: &Journal,
    optimized: bool,
) -> Result<(), String> {
    sync_rows(
        st,
        file_id,
        &j.target,
        &j.companions,
        optimized.then_some(id),
    )
    .await?;
    mark_done(st, id, j).await.map_err(|e| e.to_string())
}

/// `done`, with the trash slot of the original for the purge.
pub async fn mark_done(st: &AppState, id: i64, j: &Journal) -> sqlx::Result<()> {
    let mut extra = json!({"committedAt": chrono::Utc::now().to_rfc3339()});
    if let (OriginalPolicy::Trash, Some(b)) = (j.policy, &j.backup) {
        extra["trashPath"] = json!(b);
    }
    sqlx::query(
        r#"UPDATE jobs SET state = 'done', "stagedPath" = NULL, error = NULL, "finishedAt" = now(),
             "updatedAt" = now(), result = COALESCE(result, '{}'::jsonb) || $2 WHERE id = $1"#,
    )
    .bind(id)
    .bind(extra)
    .execute(&st.db)
    .await
    .map(drop)
}

/// The database half, idempotent: path, forced rescan path, subtitle rows, event, revoke, sprites.
/// `ocr_job` is the optimize job whose OCR'd SRTs now live inside the file.
pub async fn sync_rows(
    st: &AppState,
    file_id: i32,
    now_at: &Path,
    moved: &[(PathBuf, PathBuf)],
    ocr_job: Option<i64>,
) -> Result<(), String> {
    let sql = |e: sqlx::Error| e.to_string();
    let f = file_row(st, file_id)
        .await
        .map_err(sql)?
        .ok_or("the file row is gone")?;
    let root = fsx::Root::open(&f.folder).map_err(|e| e.to_string())?;
    let rel = fsx::rel_under(root.path(), now_at).ok_or("the file left its folder")?;
    if rel != f.rel {
        sqlx::query(r#"UPDATE media_files SET "relativePath" = $2 WHERE id = $1"#)
            .bind(file_id)
            .bind(&rel)
            .execute(&st.db)
            .await
            .map_err(sql)?;
        for (from, to) in moved {
            let (Some(a), Some(b)) = (
                fsx::rel_under(root.path(), from),
                fsx::rel_under(root.path(), to),
            ) else {
                continue;
            };
            // `hashMatched` stays: the timeline and the original hash are unchanged.
            sqlx::query(
                r#"UPDATE subtitle_files SET "filePath" = $3 WHERE "mediaFileId" = $1 AND "filePath" = $2"#,
            )
            .bind(file_id)
            .bind(a)
            .bind(b)
            .execute(&st.db)
            .await
            .map_err(sql)?;
        }
    }
    let meta = tokio::fs::metadata(now_at)
        .await
        .map_err(|e| e.to_string())?;
    let name = now_at
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_owned();
    rescan::refresh_content(
        st,
        now_at,
        &name,
        Stored {
            file_id,
            info: f.info.clone(),
            mtime_ms: f.mtime_ms,
        },
        Change {
            content_changed: true,
            timeline_preserved: true,
        },
        meta.len() as i64,
        rescan::mtime_ms(&meta),
    )
    .await?;
    subtitle_rows(st, file_id, &f, &root, ocr_job).await?;
    let episode: Option<i32> = sqlx::query_scalar(
        r#"SELECT "episodeId" FROM media_file_items WHERE "mediaFileId" = $1 LIMIT 1"#,
    )
    .bind(file_id)
    .fetch_optional(&st.db)
    .await
    .map_err(sql)?
    .flatten();
    crate::subtitles::embedded::detect_and_store(st, f.media_id, file_id, episode).await;
    crate::subtitles::events::emit(
        st,
        f.media_id,
        SseEvent::MediaFileChanged {
            media_id: f.media_id.into(),
            media_file_id: file_id.into(),
        },
    )
    .await;
    st.engine.revoke_files(&[file_id]).await;
    let st2 = st.clone();
    tokio::spawn(async move {
        let _ = crate::stream::sprite_file(&st2, file_id, true, JobPriority::Low, None).await;
    });
    Ok(())
}

/// OCR rows lose the track they came from when it is gone; after an `ocr_then_drop` job their SRT and
/// row go too, the text now living in the file.
async fn subtitle_rows(
    st: &AppState,
    file_id: i32,
    f: &FileRow,
    root: &fsx::Root,
    ocr_job: Option<i64>,
) -> Result<(), String> {
    let sql = |e: sqlx::Error| e.to_string();
    let info: Option<MediaInfo> = sqlx::query_scalar::<_, Option<Value>>(
        r#"SELECT "streamInfo" FROM media_files WHERE id = $1"#,
    )
    .bind(file_id)
    .fetch_one(&st.db)
    .await
    .map_err(sql)?
    .and_then(|v| serde_json::from_value(v).ok());
    let images: Vec<i32> = info
        .iter()
        .flat_map(|i| i.subtitles.iter())
        .filter(|s| s.is_image_based)
        .map(|s| s.stream_index as i32)
        .collect();
    sqlx::query(
        r#"UPDATE subtitle_files SET "sourceStreamIndex" = NULL
           WHERE "mediaFileId" = $1 AND "providerType" = 'ocr' AND "sourceStreamIndex" IS NOT NULL
             AND NOT ("sourceStreamIndex" = ANY($2))"#,
    )
    .bind(file_id)
    .bind(&images)
    .execute(&st.db)
    .await
    .map_err(sql)?;
    let Some(job) = ocr_job else { return Ok(()) };
    let wanted = extra_paths(st, job).await;
    let rows = sqlx::query(
        r#"SELECT id, "filePath" FROM subtitle_files
           WHERE "mediaFileId" = $1 AND "providerType" = 'ocr' AND "filePath" IS NOT NULL"#,
    )
    .bind(file_id)
    .fetch_all(&st.db)
    .await
    .map_err(sql)?;
    for r in rows {
        let (sid, path): (i32, String) = (r.get("id"), r.get("filePath"));
        let Some(abs) = fsx::locate(&f.folder, &path) else {
            continue;
        };
        if !wanted.iter().any(|w| Path::new(w) == abs) {
            continue;
        }
        sqlx::query("DELETE FROM subtitle_files WHERE id = $1")
            .bind(sid)
            .execute(&st.db)
            .await
            .map_err(sql)?;
        if let Err(e) = fsx::unlink_contained(root, &abs) {
            tracing::warn!(job, "OCR subtitle {} kept on disk: {e}", abs.display());
        }
    }
    Ok(())
}

/// Paths of the SRTs the plan added as extra inputs.
async fn extra_paths(st: &AppState, job: i64) -> Vec<String> {
    let v: Option<Value> = sqlx::query_scalar("SELECT payload FROM jobs WHERE id = $1")
        .bind(job)
        .fetch_optional(&st.db)
        .await
        .ok()
        .flatten();
    v.and_then(|v| v.pointer("/plan/extraSubtitles").cloned())
        .and_then(|v| serde_json::from_value::<Vec<Value>>(v).ok())
        .into_iter()
        .flatten()
        .filter_map(|e| e.get("path")?.as_str().map(str::to_owned))
        .collect()
}
