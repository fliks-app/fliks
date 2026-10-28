//! Source scans, the scan backfill and the stale-probe rescan (spec rules 48-51).
use super::{BACKFILL_EVERY, file::resolve_file};
use crate::state::AppState;
use crate::sync::MutexExt;
use fliks_engine_core::api::{JobPriority, JobRequest, JobResult, MediaInfo, MediaRef, SourceScan};
use serde_json::Value;
use std::{
    collections::HashSet,
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicI32, Ordering},
    },
    time::{Duration, UNIX_EPOCH},
};

const BOOT_DELAY: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub struct Scans {
    scanning: Mutex<HashSet<i32>>,
    reprobing: Mutex<HashSet<i32>>,
    /// Files whose re-probe came back rejected or failed this run: no retry on every play.
    rejected: Mutex<HashSet<i32>>,
    running: AtomicBool,
    /// Highest id the backfill attempted: a scan that fails leaves no row and must not come back.
    cursor: AtomicI32,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock_clean()
}

/// What the stored scan is checked against: the bytes' size and mtime.
struct Stat {
    size: u64,
    mtime_ms: f64,
}

impl Stat {
    async fn of(path: &Path) -> std::io::Result<Self> {
        let m = tokio::fs::metadata(path).await?;
        let d = m.modified()?.duration_since(UNIX_EPOCH).unwrap_or_default();
        Ok(Self {
            size: m.len(),
            mtime_ms: d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6,
        })
    }

    /// `"<size>-<mtimeMs>"`: part of the engine's cache key.
    fn version(&self) -> String {
        format!(
            "{}-{}",
            self.size,
            fliks_engine_core::jsnum::js_string(self.mtime_ms)
        )
    }
}

/// The scan of the file as it is now and the version of its bytes.
pub struct Held {
    pub scan: Option<SourceScan>,
    pub version: Option<String>,
}

/// The stored scan; never scans. Puts back a clock break a re-probe dropped, in `info` and the row.
pub async fn lookup(st: &AppState, id: i32, path: &Path, info: Option<&mut MediaInfo>) -> Held {
    let stat = match Stat::of(path).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("Cannot stat {}: {e}", path.display());
            return Held {
                scan: None,
                version: None,
            };
        }
    };
    let version = Some(stat.version());
    let row = sqlx::query!(
        r#"SELECT size, "mtimeMs" AS mtime_ms, scan FROM media_file_scans WHERE "mediaFileId" = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await;
    let row = match row {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("Scan lookup failed for file #{id}: {e}");
            return Held {
                scan: None,
                version,
            };
        }
    };
    let scan = row
        .filter(|r| r.size as u64 == stat.size && r.mtime_ms == stat.mtime_ms)
        .and_then(|r| serde_json::from_value::<SourceScan>(r.scan).ok());
    if let (Some(info), Some(b)) = (info, scan.as_ref().and_then(|s| s.break_seconds))
        && info.timestamp_break_seconds != Some(Some(b))
    {
        info.timestamp_break_seconds = Some(Some(b));
        if let Err(e) = store_clock_break(st, id, &label(path), Some(b)).await {
            tracing::warn!("Clock break not restored: {e}");
        }
    }
    Held { scan, version }
}

fn label(path: &Path) -> String {
    path.file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
}

/// Sets that one key in place, so a re-probe written meanwhile is not overwritten.
async fn store_clock_break(
    st: &AppState,
    id: i32,
    label: &str,
    secs: Option<f64>,
) -> sqlx::Result<()> {
    let value = secs.map_or(Value::Null, |s| serde_json::json!(s));
    sqlx::query!(
        r#"UPDATE media_files SET "streamInfo" = jsonb_set("streamInfo", '{timestampBreakSeconds}', $2::jsonb)
           WHERE id = $1"#,
        id,
        value
    )
    .execute(&st.db)
    .await?;
    if let Some(s) = secs {
        tracing::warn!("\"{label}\": the timestamps break at {s}s; playback ends there");
    }
    Ok(())
}

/// `schedule_if_needed` at `normal` priority, detached: new bytes (an import, a changed file).
pub fn spawn_scan(st: &AppState, id: i32, path: std::path::PathBuf, info: Option<MediaInfo>) {
    let st = st.clone();
    tokio::spawn(async move {
        schedule_if_needed(&st, id, &path, info, JobPriority::Normal).await;
    });
}

/// Scans the file unless its current version was; never fails. A scan already running for the file
/// is not waited for (ponytail: callers only need it started).
pub async fn schedule_if_needed(
    st: &AppState,
    id: i32,
    path: &Path,
    info: Option<MediaInfo>,
    priority: JobPriority,
) {
    let Some(info) = info.filter(|i| !i.video.is_empty()) else {
        return;
    };
    if !lock(&st.stream.scans.scanning).insert(id) {
        return;
    }
    scan(st, id, path, info, priority).await;
    lock(&st.stream.scans.scanning).remove(&id);
}

async fn scan(st: &AppState, id: i32, path: &Path, info: MediaInfo, priority: JobPriority) {
    let label = label(path);
    let run = async {
        if lookup(st, id, path, None).await.scan.is_some() {
            return Ok(());
        }
        let before = Stat::of(path).await.map_err(|e| e.to_string())?;
        let t0 = std::time::Instant::now();
        let prior = info.timestamp_break_seconds.flatten();
        let req = JobRequest {
            kind: fliks_engine_core::api::JobKind::Scan { info },
            media: MediaRef {
                media_file_id: id as u32,
                path: path.to_string_lossy().into_owned(),
            },
            priority: Some(priority),
            force: false,
        };
        let JobResult::Scan { scan } = st
            .engine
            .run_job(&req, None)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Err("engine answered another job kind".to_owned());
        };
        let after = Stat::of(path).await.map_err(|e| e.to_string())?;
        if after.version() != before.version() {
            tracing::warn!("\"{label}\" changed while it was scanned; scan dropped");
            return Ok(());
        }
        let json = serde_json::to_value(&scan).map_err(|e| e.to_string())?;
        sqlx::query!(
            r#"INSERT INTO media_file_scans ("mediaFileId", size, "mtimeMs", scan) VALUES ($1, $2, $3, $4)
               ON CONFLICT ("mediaFileId") DO UPDATE SET size = EXCLUDED.size,
                 "mtimeMs" = EXCLUDED."mtimeMs", scan = EXCLUDED.scan, "updatedAt" = now()"#,
            id,
            after.size as i64,
            after.mtime_ms,
            json
        )
        .execute(&st.db)
        .await
        .map_err(|e| e.to_string())?;
        tracing::info!(
            "\"{label}\" scanned in {} ms: {} keyframes",
            t0.elapsed().as_millis(),
            scan.keyframes.len()
        );
        if scan.break_seconds != prior {
            store_clock_break(st, id, &label, scan.break_seconds)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    };
    if let Err(e) = run.await {
        tracing::warn!("Source scan failed for \"{label}\": {e}");
    }
}

/// One file per minute past the cursor, only while nobody watches and the process is past its boot probes.
pub(super) fn spawn_backfill(st: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(BACKFILL_EVERY);
        tick.tick().await;
        loop {
            tick.tick().await;
            backfill_tick(&st).await;
        }
    });
}

pub(super) async fn backfill_tick(st: &AppState) {
    let s = &st.stream;
    if s.booted.elapsed() < BOOT_DELAY || st.presence.size() > 0 {
        return;
    }
    if s.scans.running.swap(true, Ordering::AcqRel) {
        return;
    }
    backfill_one(st).await;
    s.scans.running.store(false, Ordering::Release);
}

async fn backfill_one(st: &AppState) {
    let cursor = &st.stream.scans.cursor;
    let next = sqlx::query_scalar!(
        r#"SELECT mf.id AS "id!" FROM media_files mf
           LEFT JOIN media_file_scans mfs ON mfs."mediaFileId" = mf.id
           WHERE mfs.id IS NULL AND mf.id > $1 AND mf."streamInfo" -> 'video' -> 0 IS NOT NULL
           ORDER BY mf.id ASC LIMIT 1"#,
        cursor.load(Ordering::Acquire)
    )
    .fetch_optional(&st.db)
    .await;
    let id = match next {
        Ok(Some(id)) => id,
        Ok(None) => return,
        Err(e) => return tracing::warn!("Scan backfill: {e}"),
    };
    cursor.store(id, Ordering::Release);
    match resolve_file(st, None, i64::from(id)).await {
        Ok(f) => schedule_if_needed(st, id, &f.absolute, f.info, JobPriority::Low).await,
        Err(e) => tracing::warn!("Scan backfill: file #{id} unresolvable, skipping: {e:?}"),
    }
}

/// Re-probes a row the engine reports stale, in the background; never blocks the caller.
pub fn spawn_stale_reprobe(st: AppState, id: i32, path: std::path::PathBuf) {
    if lock(&st.stream.scans.rejected).contains(&id) || !lock(&st.stream.scans.reprobing).insert(id)
    {
        return;
    }
    tokio::spawn(async move {
        reprobe(&st, id, &path).await;
        lock(&st.stream.scans.reprobing).remove(&id);
    });
}

async fn stored_info(st: &AppState, id: i32) -> sqlx::Result<Option<MediaInfo>> {
    let row = sqlx::query_scalar!(r#"SELECT "streamInfo" FROM media_files WHERE id = $1"#, id)
        .fetch_optional(&st.db)
        .await?;
    Ok(row.flatten().and_then(|v| serde_json::from_value(v).ok()))
}

async fn reprobe(st: &AppState, id: i32, path: &Path) {
    let run = async {
        let before = Stat::of(path).await.map_err(|e| e.to_string())?;
        let probed = st
            .engine
            .probe(&path.to_string_lossy(), false, false, false)
            .await;
        let fresh = match probed {
            Ok(p) if p.ok => p.info.ok_or("probe answered without info")?,
            Ok(p) => return Err(p.error.unwrap_or_else(|| "probe failed".into())),
            Err(e) => return Err(e.to_string()),
        };
        let after = Stat::of(path).await.map_err(|e| e.to_string())?;
        if before.version() != after.version() {
            tracing::warn!(
                "\"{}\" changed during re-probe; result dropped",
                path.display()
            );
            return Ok(());
        }
        let Some(stored) = stored_info(st, id).await.map_err(|e| e.to_string())? else {
            return Ok(());
        };
        let broken = fresh.error.is_some()
            || fresh.format_name.as_deref().is_none_or(str::is_empty)
            || (!stored.video.is_empty() && fresh.video.is_empty());
        if broken {
            tracing::warn!(
                "Re-probe of \"{}\" (file #{id}) looks broken: {}; keeping the stored streamInfo",
                path.display(),
                fresh.error.as_deref().unwrap_or("no video stream detected")
            );
            lock(&st.stream.scans.rejected).insert(id);
            schedule_if_needed(st, id, path, Some(stored), JobPriority::Low).await;
            return Ok(());
        }
        let mut fresh = fresh;
        if let (Some(crop), Some(v)) = (
            stored.video.first().and_then(|v| v.crop.clone()),
            fresh.video.first_mut(),
        ) {
            v.crop = Some(crop);
        }
        if let Some(Some(b)) = stored.timestamp_break_seconds {
            fresh.timestamp_break_seconds = Some(Some(b));
        }
        let json = serde_json::to_value(&fresh).map_err(|e| e.to_string())?;
        sqlx::query!(
            r#"UPDATE media_files SET "streamInfo" = $2 WHERE id = $1"#,
            id,
            json
        )
        .execute(&st.db)
        .await
        .map_err(|e| e.to_string())?;
        tracing::info!(
            "Re-probed stale streamInfo for file #{id} \"{}\"",
            path.display()
        );
        schedule_if_needed(st, id, path, Some(fresh), JobPriority::Low).await;
        Ok::<(), String>(())
    };
    if let Err(e) = run.await {
        tracing::warn!("Background re-probe failed for file #{id}: {e}");
        lock(&st.stream.scans.rejected).insert(id);
        if let Ok(Some(stored)) = stored_info(st, id).await {
            schedule_if_needed(st, id, path, Some(stored), JobPriority::Low).await;
        }
    }
}
