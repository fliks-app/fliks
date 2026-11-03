//! Optional merge of a multi-file audio version into one m4b (`book-ingest.md` rule 18).
use super::{Placed, group::work_dir, register};
use crate::{
    engine::EngineError,
    ingest::{
        fsx,
        post_import::file_path,
        probe,
        rescan::{PROBE_VERSION, mtime_ms},
    },
    state::AppState,
    sync::MutexExt,
};
use fliks_engine_core::{
    api::{
        BgJobState, JobKind, JobPriority, JobRequest, JobResult, MediaFamily, MediaInfo, MediaRef,
        MergeMeta, MergePart,
    },
    jobs::merge::{MAX_PARTS, validate},
};
use std::{
    path::{Path, PathBuf},
    time::SystemTime,
};

/// Free space kept after the merged file is written.
const MIN_FREE: i64 = 1 << 30;

/// One file of the media's audio edition, in listening order.
#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    pub id: i32,
    pub version: i32,
    pub folder_id: i32,
    pub rel: String,
    pub size: i64,
    pub mtime_ms: Option<i64>,
    pub quality: String,
    pub probe_version: Option<i32>,
    pub info: Option<MediaInfo>,
}

/// The version to merge: the first with several files, probed, in one folder and one work
/// directory, when the media has no m4b.
pub fn pick(rows: &[Part]) -> Option<Vec<Part>> {
    if rows.iter().any(|r| r.quality == "m4b") {
        return None;
    }
    let v = rows
        .iter()
        .map(|r| r.version)
        .find(|v| rows.iter().filter(|r| r.version == *v).count() > 1)?;
    let parts: Vec<Part> = rows.iter().filter(|r| r.version == v).cloned().collect();
    // What the engine would answer 400 to: too many parts, no duration, control characters.
    if parts.len() > MAX_PARTS {
        return None;
    }
    let dir = |p: &Part| work_dir(&p.rel.replace('\\', "/"));
    parts
        .iter()
        .all(|p| {
            p.folder_id == parts[0].folder_id
                && dir(p) == dir(&parts[0])
                && !p.rel.chars().any(char::is_control)
                && p.info
                    .as_ref()
                    .and_then(|i| i.duration_seconds)
                    .is_some_and(|d| d.is_finite() && d > 0.0)
                && p.probe_version == Some(PROBE_VERSION)
        })
        .then_some(parts)
}

/// What a recorded failure is tied to: the merged version's files as the database knows them.
pub fn fingerprint(parts: &[Part]) -> String {
    parts
        .iter()
        .map(|p| {
            format!(
                "{}:{}:{}:{:?}:{}",
                p.id, p.version, p.size, p.mtime_ms, p.rel
            )
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// Folder names that say a format, not a book.
const GENERIC: [&str; 9] = [
    "mp3",
    "m4a",
    "flac",
    "ogg",
    "opus",
    "aac",
    "audio",
    "audiobook",
    "parts",
];

fn file_stem(title: &str) -> Option<String> {
    let s: String = title
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let s = s.trim().trim_matches('.').to_owned();
    (!s.is_empty()).then_some(s)
}

/// `<work folder>/<name>.m4b` beside the parts, disc folders off; the name is the nearest folder
/// that is not a format name, else the title.
pub fn output_rel(first: &str, title: &str) -> Option<String> {
    let dir = work_dir(&first.replace('\\', "/"));
    if dir.is_empty() {
        return None;
    }
    let name = dir
        .rsplit('/')
        .find(|s| !GENERIC.contains(&s.to_lowercase().as_str()))
        .map(str::to_owned)
        .or_else(|| file_stem(title))?;
    Some(format!("{dir}/{name}.m4b"))
}

/// What a job result must match in the probe of the file before it is registered.
pub fn verify(meta: &MergeMeta, info: &MediaInfo, bytes: u64) -> Result<(), String> {
    if info.audio.is_empty() {
        return Err("the merged file has no audio".into());
    }
    if bytes == 0 || bytes as f64 != meta.bytes {
        return Err(format!("size {bytes} is not the {} reported", meta.bytes));
    }
    let want = meta.duration_seconds;
    let got = info.duration_seconds.unwrap_or(0.0);
    if (got - want).abs() > (want * 0.01).max(5.0) {
        return Err(format!("duration {got}s, expected {want}s"));
    }
    let chapters = info.chapters.as_ref().map_or(0, Vec::len);
    if chapters != meta.chapters.len() {
        return Err(format!(
            "{chapters} chapters, expected {}",
            meta.chapters.len()
        ));
    }
    Ok(())
}

pub async fn load(st: &AppState, media: i32) -> sqlx::Result<Vec<Part>> {
    let rows = sqlx::query!(
        r#"SELECT f.id, p.version, f."folderId" AS folder_id, f."relativePath" AS rel, f.size,
                  f."mtimeMs" AS mtime_ms, f.quality, f."probeVersion" AS probe_version,
                  f."streamInfo" AS info
           FROM item_parts p JOIN items i ON i.id = p."itemId"
             JOIN editions e ON e.id = i."editionId" JOIN media_files f ON f.id = p."mediaFileId"
           WHERE p."mediaId" = $1 AND e.family = 'audio' ORDER BY p.version, p.position"#,
        media
    )
    .fetch_all(&st.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Part {
            id: r.id,
            version: r.version,
            folder_id: r.folder_id,
            rel: r.rel,
            size: r.size,
            mtime_ms: r.mtime_ms,
            quality: r.quality,
            probe_version: r.probe_version,
            info: r.info.and_then(|v| serde_json::from_value(v).ok()),
        })
        .collect())
}

/// The option of the library of the media's first audio edition, else its own: the same choice
/// as `forget_failures` and the backfill.
async fn enabled(st: &AppState, media: i32) -> sqlx::Result<bool> {
    Ok(sqlx::query_scalar!(
        r#"SELECT l."mergeM4b" FROM media m JOIN libraries l ON l.id = COALESCE(
             (SELECT e."libraryId" FROM editions e
              WHERE e."mediaId" = m.id AND e.family = 'audio' ORDER BY e.id LIMIT 1), m."libraryId")
           WHERE m.id = $1"#,
        media
    )
    .fetch_optional(&st.db)
    .await?
    .unwrap_or(false))
}

/// Whether a file row holds this path: the output is then not ours to remove.
async fn registered(st: &AppState, folder: i32, rel: &str) -> bool {
    sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM media_files WHERE "folderId" = $1 AND "relativePath" = $2) AS "e!""#,
        folder,
        rel
    )
    .fetch_one(&st.db)
    .await
    .unwrap_or(true)
}

/// Removes `path` only when it is the file the engine reported for this run: unregistered, of
/// the reported size and written since the job was submitted.
async fn discard(
    st: &AppState,
    folder: i32,
    rel: &str,
    path: &Path,
    merge: &MergeMeta,
    since: SystemTime,
) {
    if registered(st, folder, rel).await {
        return;
    }
    let Ok(meta) = tokio::fs::metadata(path).await else {
        return;
    };
    if meta.len() as f64 == merge.bytes && meta.modified().is_ok_and(|t| t >= since) {
        let _ = tokio::fs::remove_file(path).await;
    } else {
        tracing::warn!(
            "m4b merge: {} is not the engine's output, left in place",
            path.display()
        );
    }
}

/// Whether every part is still the row, the place and the bytes the merge read.
async fn unchanged(st: &AppState, media: i32, parts: &[Part], abs: &[PathBuf]) -> bool {
    let Ok(now) = load(st, media).await else {
        return false;
    };
    for (p, path) in parts.iter().zip(abs) {
        let Ok(meta) = tokio::fs::metadata(path).await else {
            return false;
        };
        let on_disk =
            meta.len() as i64 == p.size && (p.mtime_ms.is_none() || mtime_ms(&meta) == p.mtime_ms);
        let same = |q: &Part| {
            (q.id, q.version, q.folder_id, &q.rel, q.size, q.mtime_ms)
                == (p.id, p.version, p.folder_id, &p.rel, p.size, p.mtime_ms)
        };
        if !on_disk || !now.iter().any(same) {
            return false;
        }
    }
    true
}

async fn record(st: &AppState, media: i32, fp: &str, folder: i32, out: &str) -> sqlx::Result<()> {
    sqlx::query!(
        r#"INSERT INTO book_merges ("mediaId", fingerprint, state, "folderId", output)
           VALUES ($1, $2, 'running', $3, $4)
           ON CONFLICT ("mediaId") DO UPDATE SET state = 'running', "folderId" = EXCLUDED."folderId",
             output = EXCLUDED.output, error = NULL, "nextAttemptAt" = NULL, "jobId" = NULL,
             attempts = CASE WHEN book_merges.fingerprint = EXCLUDED.fingerprint
                             THEN book_merges.attempts ELSE 0 END,
             "jobFailures" = CASE WHEN book_merges.fingerprint = EXCLUDED.fingerprint
                                  THEN book_merges."jobFailures" ELSE 0 END,
             fingerprint = EXCLUDED.fingerprint"#,
        media,
        fp,
        folder,
        out
    )
    .execute(&st.db)
    .await
    .map(drop)
}

/// A failure the parts explain: no retry until they change.
async fn failed(st: &AppState, media: i32, why: &str) {
    let _ = sqlx::query!(
        r#"UPDATE book_merges SET state = 'failed', error = $2 WHERE "mediaId" = $1"#,
        media,
        why
    )
    .execute(&st.db)
    .await;
}

/// Failed attempts after which only the next settle or backfill tries again.
const AUTO_RETRIES: i32 = 5;

/// Seconds before attempt `n + 1`: a minute doubling, capped at an hour.
fn backoff(n: i32) -> i64 {
    (60_i64 << (n - 1).clamp(0, 6)).min(3600)
}

/// A failure the parts do not explain (disk, engine, timeout): retried after a growing delay. A
/// job that failed in ffmpeg twice on the same parts is the parts' fault: it turns sticky.
async fn retry(st: &AppState, media: i32, why: &str, job_failed: bool) {
    let row = sqlx::query!(
        r#"UPDATE book_merges SET state = 'retry', error = $2, attempts = attempts + 1,
             "jobFailures" = "jobFailures" + $3::int
           WHERE "mediaId" = $1 RETURNING attempts, "jobFailures" AS job_failures"#,
        media,
        why,
        i32::from(job_failed)
    )
    .fetch_optional(&st.db)
    .await
    .ok()
    .flatten();
    let Some(row) = row else { return };
    if row.job_failures >= 2 {
        return failed(st, media, why).await;
    }
    let n = row.attempts;
    let secs = backoff(n);
    let _ = sqlx::query!(
        r#"UPDATE book_merges SET "nextAttemptAt" = now() + make_interval(secs => $2::float8)
           WHERE "mediaId" = $1"#,
        media,
        secs as f64
    )
    .execute(&st.db)
    .await;
    if n <= AUTO_RETRIES {
        later(st, media, secs as u64 + 1);
    }
}

/// Runs the merge of `media` again after `secs`.
fn later(st: &AppState, media: i32, secs: u64) {
    let st = st.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
        if let Err(e) = run(&st, media).await {
            tracing::warn!("m4b merge of book #{media}: {e}");
        }
    });
}

/// The row of a media's last merge attempt.
struct Row {
    fingerprint: String,
    state: String,
    folder_id: i32,
    output: String,
    job_id: Option<String>,
    waiting: bool,
}

async fn row(st: &AppState, media: i32) -> sqlx::Result<Option<Row>> {
    Ok(sqlx::query!(
        r#"SELECT fingerprint, state, "folderId" AS folder_id, output, "jobId" AS job_id,
                  COALESCE("nextAttemptAt" > now(), false) AS "waiting!"
           FROM book_merges WHERE "mediaId" = $1"#,
        media
    )
    .fetch_optional(&st.db)
    .await?
    .map(|r| Row {
        fingerprint: r.fingerprint,
        state: r.state,
        folder_id: r.folder_id,
        output: r.output,
        job_id: r.job_id,
        waiting: r.waiting,
    }))
}

/// What the engine says about the job a cut run submitted.
enum Resume {
    /// Nothing of that run to keep: submit again (a file left in place makes the engine refuse,
    /// which is retried, never deleted).
    Submit,
    /// The job is open for these parts: wait on it at its stored output.
    Wait,
    /// The job's output was verified and registered.
    Registered,
}

fn stale(why: String) -> Result<Resume, String> {
    tracing::warn!("m4b merge: {why}");
    Ok(Resume::Submit)
}

/// A row with a job id belongs to a run that did not see its end. The engine is asked for the
/// job: an open one is waited for, a done one is registered when its path and bytes match the
/// file, a failed or cancelled one left nothing. A job that vouches for nothing is dropped and
/// the run goes on as a fresh one. Nothing is deleted.
async fn recover(
    st: &AppState,
    media: i32,
    parts: &[Part],
    fp: &str,
    r: &Row,
    job: &str,
) -> Result<Resume, String> {
    let snap = st.engine.get_job(job).await.map_err(|e| e.to_string())?;
    let same = r.fingerprint == fp && r.folder_id == parts[0].folder_id;
    let Some(snap) = snap else {
        let (out, _root) = output_path(st, r.folder_id, &r.output).await?;
        let taken = tokio::fs::symlink_metadata(&out).await.is_ok()
            && !registered(st, r.folder_id, &r.output).await;
        return if taken {
            stale(format!(
                "{} left in place: the engine lost its job",
                r.output
            ))
        } else {
            Ok(Resume::Submit)
        };
    };
    if !snap.state.ended() {
        return if same {
            Ok(Resume::Wait)
        } else {
            Err(format!("job {job} still runs for other parts"))
        };
    }
    let Some(JobResult::Merge { merge }) = snap.result.filter(|_| snap.state == BgJobState::Done)
    else {
        return Ok(Resume::Submit);
    };
    let _media = st.ingest.media.lock(media).await;
    let _moves = st.folder_moves.read().await;
    let (out, _root) = output_path(st, r.folder_id, &r.output).await?;
    let Ok(meta) = tokio::fs::metadata(&out).await else {
        return Ok(Resume::Submit);
    };
    if registered(st, r.folder_id, &r.output).await {
        return Ok(Resume::Submit);
    }
    if merge.path != out.to_string_lossy() || meta.len() as f64 != merge.bytes {
        return stale(format!(
            "{} is not the output of job {job}, left in place",
            r.output
        ));
    }
    if !same {
        return stale(format!(
            "{} is the output of job {job} for other parts, left in place",
            r.output
        ));
    }
    let (abs, _) = part_paths(st, parts).await.map_err(|(e, _)| e)?;
    match publish(st, media, parts, &abs, &merge, &r.output, &out).await {
        Ok(()) => Ok(Resume::Registered),
        Err((e, Fail::Parts)) => stale(format!("{}: {e}", r.output)),
        Err((e, _)) => Err(format!("{}: {e}", r.output)),
    }
}

/// The absolute output path inside its library folder.
async fn output_path(
    st: &AppState,
    folder: i32,
    rel: &str,
) -> Result<(PathBuf, fsx::Root), String> {
    let path = sqlx::query_scalar!(r#"SELECT path FROM library_folders WHERE id = $1"#, folder)
        .fetch_optional(&st.db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("the library folder is gone")?;
    let root = fsx::Root::open(&path).map_err(|e| e.to_string())?;
    let out = root
        .path()
        .join(fsx::safe_rel(rel).ok_or("unsafe output path")?);
    if !out.parent().is_some_and(|d| root.contains(d, false)) {
        return Err("output outside the library folder".into());
    }
    Ok((out, root))
}

/// Merges the media's multi-file audio version into a new m4b version when its library asks for
/// it. The parts stay and the server deletes only an output the engine reported for this run:
/// the file is registered once verified. A failure the parts explain is not retried until they
/// change; any other is retried with a growing delay.
pub async fn run(st: &AppState, media: i32) -> Result<(), String> {
    if !enabled(st, media).await.map_err(|e| e.to_string())?
        || !st.engine.job_applies("Merge", MediaFamily::Audio).await
    {
        return Ok(());
    }
    // A second run waits, then finds the m4b or the failure record and stops.
    let _one = st.ingest.merging.lock(media).await;
    let _slot = st.ingest.merge_slot.lock().await;
    let rows = load(st, media).await.map_err(|e| e.to_string())?;
    let Some(parts) = pick(&rows) else {
        return Ok(());
    };
    let fp = fingerprint(&parts);
    let prior = row(st, media).await.map_err(|e| e.to_string())?;
    if prior.as_ref().is_some_and(|p| {
        p.fingerprint == fp && (p.state == "failed" || (p.state == "retry" && p.waiting))
    }) {
        return Ok(());
    }
    let title = sqlx::query_scalar!(r#"SELECT title FROM media WHERE id = $1"#, media)
        .fetch_one(&st.db)
        .await
        .map_err(|e| e.to_string())?;
    let mut out_rel = output_rel(&parts[0].rel, &title).ok_or("no folder to write the m4b in")?;
    if let Some((p, job)) = prior
        .as_ref()
        .and_then(|p| p.job_id.as_deref().map(|j| (p, j)))
        .filter(|(p, _)| p.state != "failed")
    {
        match recover(st, media, &parts, &fp, p, job).await {
            Ok(Resume::Registered) => {
                let _ = sqlx::query!(r#"DELETE FROM book_merges WHERE "mediaId" = $1"#, media)
                    .execute(&st.db)
                    .await;
                return Ok(());
            }
            // The open job writes to the stored output, whatever the title says now.
            Ok(Resume::Wait) => out_rel = p.output.clone(),
            Ok(Resume::Submit) => {}
            Err(e) => {
                tracing::warn!("m4b merge of book #{media}: {e}");
                retry(st, media, &e, false).await;
                return Err(e);
            }
        }
    }
    let (out, _root) = output_path(st, parts[0].folder_id, &out_rel).await?;
    record(st, media, &fp, parts[0].folder_id, &out_rel)
        .await
        .map_err(|e| e.to_string())?;
    match execute(st, media, &parts, &out_rel, &out).await {
        Ok(()) => {
            let _ = sqlx::query!(r#"DELETE FROM book_merges WHERE "mediaId" = $1"#, media)
                .execute(&st.db)
                .await;
            Ok(())
        }
        Err((e, Fail::Parts)) => {
            failed(st, media, &e).await;
            Err(e)
        }
        Err((e, fail)) => {
            retry(st, media, &e, fail == Fail::Job).await;
            Err(e)
        }
    }
}

/// Merges `media` one after the other in the background; a failure is logged.
pub fn spawn(st: &AppState, media: Vec<i32>) {
    let st = st.clone();
    tokio::spawn(async move {
        for m in media {
            if let Err(e) = run(&st, m).await {
                tracing::warn!("m4b merge of book #{m}: {e}");
            }
        }
    });
}

/// Turning the option on again forgets the library's failed and waiting merges.
pub async fn forget_failures(st: &AppState, library: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"DELETE FROM book_merges b USING media m
           WHERE b."mediaId" = m.id AND b.state <> 'running' AND COALESCE(
             (SELECT e."libraryId" FROM editions e
              WHERE e."mediaId" = m.id AND e.family = 'audio' ORDER BY e.id LIMIT 1), m."libraryId") = $1"#,
        library
    )
    .execute(&st.db)
    .await
    .map(drop)
}

/// Held while a library's backfill runs, so a repeated toggle starts none more; its drop is for
/// a panic, the normal end removes the entry under the lock that decides there is no new round.
struct Backfill(AppState, i32);

impl Drop for Backfill {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.0.ingest.backfills.lock_clean().remove(&self.1);
        }
    }
}

/// Queues the merge of every book of a library whose option was just turned on, one backfill
/// per library at a time. A call during a backfill makes it go round again once it ends, so the
/// failures it forgets are retried. A restart drops what is left: the next settle resumes it.
pub fn spawn_library(st: &AppState, library: i32) {
    {
        let mut running = st.ingest.backfills.lock_clean();
        if let Some(again) = running.get_mut(&library) {
            *again = true;
            return;
        }
        running.insert(library, false);
    }
    let guard = Backfill(st.clone(), library);
    let st = st.clone();
    tokio::spawn(async move {
        let _guard = guard;
        loop {
            let _ = forget_failures(&st, library).await;
            let ids = sqlx::query_scalar!(
                r#"SELECT m.id FROM media m WHERE m.type = 'book' AND COALESCE(
                     (SELECT e."libraryId" FROM editions e
                      WHERE e."mediaId" = m.id AND e.family = 'audio' ORDER BY e.id LIMIT 1),
                     m."libraryId") = $1 ORDER BY m.id"#,
                library
            )
            .fetch_all(&st.db)
            .await
            .unwrap_or_default();
            for m in ids {
                if let Err(e) = run(&st, m).await {
                    tracing::warn!("m4b merge of book #{m}: {e}");
                }
            }
            let mut running = st.ingest.backfills.lock_clean();
            match running.get_mut(&library) {
                Some(again) if *again => *again = false,
                _ => {
                    running.remove(&library);
                    break;
                }
            }
        }
    });
}

/// What went wrong, as far as a retry is concerned.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Fail {
    /// The parts explain it: a retry would fail the same way.
    Parts,
    /// The engine's job failed in ffmpeg: the parts' fault when it happens twice.
    Job,
    /// Disk, engine, timeout, a part touched meanwhile.
    Transient,
}

type Failure = (String, Fail);

/// The absolute path and the engine's view of each part.
async fn part_paths(
    st: &AppState,
    parts: &[Part],
) -> Result<(Vec<PathBuf>, Vec<MergePart>), Failure> {
    let sticky = |e: String| (e, Fail::Parts);
    let (mut abs, mut merge_parts) = (vec![], vec![]);
    for p in parts {
        let (path, _) = file_path(st, p.id)
            .await
            .map_err(|e| (e.to_string(), Fail::Transient))?
            .ok_or_else(|| sticky(format!("part #{} has no contained path", p.id)))?;
        merge_parts.push(MergePart {
            path: path.to_string_lossy().into_owned(),
            info: p
                .info
                .clone()
                .ok_or_else(|| sticky(format!("part #{} was not probed", p.id)))?,
        });
        abs.push(path);
    }
    Ok((abs, merge_parts))
}

async fn execute(
    st: &AppState,
    media: i32,
    parts: &[Part],
    out_rel: &str,
    out: &Path,
) -> Result<(), Failure> {
    let sticky = |e: String| (e, Fail::Parts);
    let (abs, merge_parts) = part_paths(st, parts).await?;
    validate(&merge_parts, &out.to_string_lossy()).map_err(sticky)?;
    let need = parts.iter().map(|p| p.size).sum::<i64>() + MIN_FREE;
    let dir = out
        .parent()
        .map_or_else(String::new, |d| d.to_string_lossy().into_owned());
    let disk = crate::libraries::disk(&dir).await;
    if !disk.accessible || disk.free_space < need {
        return Err((
            format!("not enough free space for the m4b ({need} bytes needed)"),
            Fail::Transient,
        ));
    }
    let req = JobRequest {
        kind: JobKind::Merge {
            parts: merge_parts,
            output: out.to_string_lossy().into_owned(),
            tags: None,
        },
        media: MediaRef {
            media_file_id: parts[0].id as u32,
            path: abs[0].to_string_lossy().into_owned(),
        },
        priority: Some(JobPriority::Low),
        force: false,
    };
    let since = SystemTime::now();
    let engine = |e: EngineError| {
        let fail = match &e {
            EngineError::Http { status: 400, .. } => Fail::Parts,
            EngineError::Job { state, what }
                if state == "failed"
                    && what.contains("ffmpeg exited")
                    && !what.contains("exited with None") =>
            {
                Fail::Job
            }
            _ => Fail::Transient,
        };
        (e.to_string(), fail)
    };
    // The engine answers an identical open job with its id; the id is kept for a run a restart cuts.
    let job = st.engine.submit_job(&req).await.map_err(engine)?;
    let _ = sqlx::query!(
        r#"UPDATE book_merges SET "jobId" = $2 WHERE "mediaId" = $1"#,
        media,
        job
    )
    .execute(&st.db)
    .await;
    let result = st.engine.wait_job(job, &req, None).await.map_err(engine)?;
    let JobResult::Merge { merge } = result else {
        return Err(sticky("engine answered another result".into()));
    };
    // Ingests and rescans of the media wait while the output is checked and registered.
    let _media = st.ingest.media.lock(media).await;
    let _moves = st.folder_moves.read().await;
    let outcome = publish(st, media, parts, &abs, &merge, out_rel, out).await;
    if outcome.is_err() {
        discard(st, parts[0].folder_id, out_rel, out, &merge, since).await;
    }
    outcome
}

/// Under the media and `folder_moves` locks: the option, the parts and the probe of the output
/// are checked, then it is registered. Removes nothing.
async fn publish(
    st: &AppState,
    media: i32,
    parts: &[Part],
    abs: &[PathBuf],
    merge: &MergeMeta,
    out_rel: &str,
    out: &Path,
) -> Result<(), Failure> {
    let sticky = |e: String| (e, Fail::Parts);
    if !enabled(st, media)
        .await
        .map_err(|e| (e.to_string(), Fail::Transient))?
    {
        return Err(("the library option was turned off".into(), Fail::Transient));
    }
    check(st, media, parts, abs, merge, out).await?;
    let placed = Placed {
        folder_id: parts[0].folder_id,
        rel: out_rel.to_owned(),
        abs: out.to_owned(),
    };
    let done = register(st, media, &[placed]).await.map_err(sticky)?;
    if done.files.len() != 1 {
        return Err(sticky(done.conflicts.join("; ")));
    }
    Ok(())
}

async fn check(
    st: &AppState,
    media: i32,
    parts: &[Part],
    abs: &[PathBuf],
    merge: &MergeMeta,
    out: &Path,
) -> Result<(), Failure> {
    if !unchanged(st, media, parts, abs).await {
        return Err(("a part changed during the merge".into(), Fail::Transient));
    }
    let bytes = tokio::fs::metadata(out)
        .await
        .map_err(|e| (e.to_string(), Fail::Transient))?
        .len();
    let info = probe(st, out, false)
        .await
        .map_err(|e| (e, Fail::Transient))?
        .info;
    verify(merge, &info, bytes).map_err(|e| (e, Fail::Parts))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(id: i32, version: i32, rel: &str, quality: &str) -> Part {
        Part {
            id,
            version,
            folder_id: 1,
            rel: rel.into(),
            size: 1,
            mtime_ms: None,
            quality: quality.into(),
            probe_version: Some(PROBE_VERSION),
            info: Some(
                serde_json::from_value(
                    serde_json::json!({"video": [], "audio": [], "subtitles": [], "durationSeconds": 1.0}),
                )
                .unwrap(),
            ),
        }
    }

    #[test]
    fn the_first_multi_file_version_is_picked_unless_an_m4b_exists() {
        let mp3 = [
            part(1, 0, "T/a.mp3", "mp3"),
            part(2, 0, "T/b.mp3", "mp3"),
            part(3, 1, "T/c.flac", "flac"),
        ];
        assert_eq!(pick(&mp3).unwrap().len(), 2);
        assert!(pick(&mp3[..1]).is_none());
        let both = [&mp3[..2], &[part(9, 1, "T/T.m4b", "m4b")]].concat();
        assert!(pick(&both).is_none());
    }

    #[test]
    fn what_the_engine_would_refuse_is_not_picked() {
        let rows = |n: usize| -> Vec<Part> {
            (0..n)
                .map(|i| part(i as i32, 0, &format!("T/{i}.mp3"), "mp3"))
                .collect()
        };
        assert!(pick(&rows(MAX_PARTS)).is_some());
        assert!(pick(&rows(MAX_PARTS + 1)).is_none());
        let mut r = rows(2);
        r[1].rel = "T/b\u{7}.mp3".into();
        assert!(pick(&r).is_none());
        let mut r = rows(2);
        r[1].info.as_mut().unwrap().duration_seconds = Some(0.0);
        assert!(pick(&r).is_none());
    }

    #[test]
    fn the_retry_delay_doubles_to_an_hour() {
        assert_eq!([1, 2, 3].map(backoff), [60, 120, 240]);
        assert_eq!(backoff(40), 3600);
    }

    #[test]
    fn parts_must_share_a_directory_and_be_probed_and_the_fingerprint_follows_them() {
        let mut rows = vec![part(1, 0, "T/a.mp3", "mp3"), part(2, 0, "T/b.mp3", "mp3")];
        assert!(pick(&rows).is_some());
        let before = fingerprint(&rows);
        rows[1].size = 2;
        assert_ne!(fingerprint(&rows), before);
        rows[1].rel = "T/Sub/b.mp3".into();
        assert!(pick(&rows).is_none());
        rows[1].rel = "T/b.mp3".into();
        rows[1].probe_version = Some(0);
        assert!(pick(&rows).is_none());
    }

    #[test]
    fn the_output_sits_in_the_work_folder_named_after_it() {
        let rel = |p: &str| output_rel(p, "A/Title");
        assert_eq!(rel("A/T/CD1/01.mp3").as_deref(), Some("A/T/T.m4b"));
        assert_eq!(rel("T/01.mp3").as_deref(), Some("T/T.m4b"));
        assert_eq!(rel("Book/MP3/01.mp3").as_deref(), Some("Book/MP3/Book.m4b"));
        assert_eq!(rel("MP3/01.mp3").as_deref(), Some("MP3/A_Title.m4b"));
        assert_eq!(rel("01.mp3"), None);
    }

    #[test]
    fn a_result_the_probe_does_not_confirm_is_refused() {
        let meta: MergeMeta = serde_json::from_value(serde_json::json!({
            "path": "/x.m4b", "bytes": 10.0, "durationSeconds": 100.0,
            "chapters": [{"startSeconds": 0.0, "endSeconds": 100.0, "title": "One"}],
            "reencoded": false
        }))
        .unwrap();
        let info = |d: f64, chapters: usize| -> MediaInfo {
            serde_json::from_value(serde_json::json!({
                "video": [], "audio": [{"streamIndex": 0, "codec": "aac", "language": "und"}], "subtitles": [],
                "durationSeconds": d,
                "chapters": vec![serde_json::json!({"startSeconds": 0.0, "endSeconds": 1.0}); chapters],
            }))
            .unwrap()
        };
        assert!(verify(&meta, &info(101.0, 1), 10).is_ok());
        assert!(verify(&meta, &info(60.0, 1), 10).is_err());
        assert!(verify(&meta, &info(100.0, 2), 10).is_err());
        assert!(verify(&meta, &info(100.0, 1), 9).is_err());
    }
}
