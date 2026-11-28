//! Preparation of a track: `Separate`, `Align`, `Melody` (`docs/spec/karaoke.md` rules 13, 18, 19).
use super::{aligner, store};
use crate::sync::MutexExt;
use crate::{
    engine::EngineError, events::SseEvent, ingest::post_import::file_path, lyrics::store as lstore,
    state::AppState,
};
use fliks_domain::lyrics::{self as dl, Parsed, Sync, karaoke as kd};
use fliks_engine_core::api::{
    AlignLine, JobKind, JobPriority, JobRequest, JobResult, MediaInfo, MediaRef, MelodySpan,
    ModelInfo, ModelKind, ModelState, job_errors,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

/// A line found at this share of its words gives its start to the source row.
const SNAP_MATCHED: f64 = 0.8;
const MAX_MELODY_SPANS: usize = 100_000;

#[derive(Clone, Copy)]
pub struct Opts {
    pub align: bool,
    pub melody: bool,
    /// Redo done work (rule 13): `Align` reads the source again, `Melody` alone recomputes the pitch.
    pub force: bool,
}

/// A queued or running preparation; it leaves the map when it ends.
#[derive(Clone)]
pub struct RunState {
    pub state: &'static str,
    pub stage: Option<&'static str>,
    pub progress: Option<f64>,
    /// Who asked; `None` for the background pass and the party programme.
    pub user: Option<i32>,
    /// The users `karaoke.job_changed` goes to.
    pub viewers: Arc<[i32]>,
    /// Set by a `DELETE` of the track; every write of the run holds it, so none lands after.
    pub(crate) cancelled: Arc<tokio::sync::Mutex<bool>>,
    /// The engine job running now, which that `DELETE` cancels.
    pub(crate) job: Option<String>,
}

impl Opts {
    /// A forced `Melody` alone recomputes the pitch; beside `Align` it only follows a new row.
    fn repitch(self) -> bool {
        self.force && !self.align
    }
}

/// What a run learned that the background pass and the failure record act on.
#[derive(Default)]
pub struct Outcome {
    pub provider: Option<String>,
    pub lyrics_error: Option<Failure>,
    /// Share of the lyrics found in the vocals, when that was too low to save the alignment.
    pub rejected_match: Option<f64>,
    /// `Align` or `Melody` ran: the lyrics part of the record is replaced.
    pub lyrics_ran: bool,
    /// `(aligner, text)` of the lyrics the aligner rejected.
    pub rejected: Option<(String, String)>,
}

/// Why a step failed; `code` and its params are the wire form, the `Display` text is for logs.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum Failure {
    /// Percentages of the lyrics found in the vocals and the least that is kept.
    LyricsNotFoundInVocals {
        matched: u32,
        min: u32,
    },
    LyricsTooLong,
    NoWordTimed,
    /// The step's model is not installed.
    ModelMissing {
        message: String,
    },
    /// This engine cannot run the step (no ONNX runtime, no speech recogniser).
    Unsupported {
        message: String,
    },
    /// No engine runs, or it did not answer.
    EngineUnavailable {
        message: String,
    },
    Cancelled,
    /// Anything else (an unreadable file); `message` is the engine's or the server's text.
    Failed {
        message: String,
    },
}

impl Failure {
    fn low_match(matched: f64) -> Self {
        Self::LyricsNotFoundInVocals {
            matched: (matched * 100.0).round() as u32,
            min: (MIN_MATCHED * 100.0).round() as u32,
        }
    }

    /// A failure the same file would meet again: the background pass leaves the track alone.
    pub fn permanent(&self) -> bool {
        matches!(self, Self::Failed { .. })
    }

    /// The engine's typed `<code>: <text>` errors, else `Failed`.
    fn of_engine(message: String) -> Self {
        let code = message.split(':').next().unwrap_or_default();
        match code {
            job_errors::MODEL_MISSING => Self::ModelMissing { message },
            job_errors::UNSUPPORTED => Self::Unsupported { message },
            _ => Self::Failed { message },
        }
    }
}

impl From<EngineError> for Failure {
    fn from(e: EngineError) -> Self {
        match e {
            EngineError::Job { state, .. } if state == "cancelled" => Self::Cancelled,
            EngineError::Job { what, .. } => Self::of_engine(what),
            EngineError::Http {
                status, ref code, ..
            } if status < 500 => match code.as_deref() {
                Some(c @ (job_errors::MODEL_MISSING | job_errors::UNSUPPORTED)) => {
                    Self::of_engine(format!("{c}: {e}"))
                }
                _ => Self::Failed {
                    message: e.to_string(),
                },
            },
            e => Self::EngineUnavailable {
                message: e.to_string(),
            },
        }
    }
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::Failed { message }
    }
}

impl From<&str> for Failure {
    fn from(e: &str) -> Self {
        e.to_owned().into()
    }
}

impl From<sqlx::Error> for Failure {
    fn from(e: sqlx::Error) -> Self {
        e.to_string().into()
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LyricsNotFoundInVocals { matched, .. } => {
                write!(f, "only {matched} % of the lyrics were found in the vocals")
            }
            Self::LyricsTooLong => f.write_str("the lyrics are too long to align"),
            Self::NoWordTimed => f.write_str("no lyrics word could be timed"),
            Self::Cancelled => f.write_str("cancelled"),
            Self::ModelMissing { message }
            | Self::Unsupported { message }
            | Self::EngineUnavailable { message }
            | Self::Failed { message } => f.write_str(message),
        }
    }
}

/// Most queued or running runs one caller holds (rule 13).
const MAX_RUNS_PER_USER: usize = 2;
/// Align results matching fewer lyric words than this are not saved (rule 18).
pub(super) const MIN_MATCHED: f64 = 0.17;

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    Busy,
    Full,
    Unavailable,
}

pub enum Start {
    Started(tokio::task::JoinHandle<Result<Outcome, Failure>>),
    /// Already running, or nothing left to run.
    Idle,
    Refused(Refusal),
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Admit {
    Join,
    Busy,
    Go,
}

pub(super) fn admit(runs: &HashMap<i32, RunState>, item: i32, user: Option<i32>) -> Admit {
    if runs.contains_key(&item) {
        return Admit::Join;
    }
    let held = runs
        .values()
        .filter(|r| user.is_some() && r.user == user)
        .count();
    if held >= MAX_RUNS_PER_USER {
        Admit::Busy
    } else {
        Admit::Go
    }
}

pub struct Track {
    pub file: i32,
    pub path: PathBuf,
    pub info: Option<MediaInfo>,
    pub duration_ms: Option<i32>,
}

/// The track's file ([`store::track_file`]) with its path, probe and duration.
pub async fn track(st: &AppState, item: i32) -> Result<Track, String> {
    let file = store::track_file(&st.db, item)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("the track has no file")?;
    let (path, info) = file_path(st, file)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("the file has no contained path")?;
    let stamped: Option<i32> =
        sqlx::query_scalar(r#"SELECT "durationMs" FROM track_details WHERE "itemId" = $1"#)
            .bind(item)
            .fetch_optional(&st.db)
            .await
            .map_err(|e| e.to_string())?
            .flatten();
    let duration_ms = stamped.or_else(|| {
        info.as_ref()
            .and_then(|i| i.duration_seconds)
            .map(|s| (s * 1000.0) as i32)
    });
    Ok(Track {
        file,
        path,
        info,
        duration_ms,
    })
}

/// The model a job of `kind` names (rule 2): the engine's default when installed, else the first installed one.
pub fn installed_model(models: &[ModelInfo], kind: ModelKind) -> Option<&ModelInfo> {
    let mut installed = models
        .iter()
        .filter(|m| m.kind == kind && m.state == ModelState::Installed);
    installed.clone().find(|m| m.default).or(installed.next())
}

fn event(item: i32, state: &str, stage: Option<&str>, progress: Option<f64>) -> SseEvent {
    SseEvent::KaraokeJobChanged {
        item_id: i64::from(item),
        state: state.to_owned(),
        stage: stage.map(str::to_owned),
        progress: progress.map(Into::into),
    }
}

/// Applies `f` to the run of `item` and tells its viewers; a no-op once the run is gone.
fn update(st: &AppState, item: i32, f: impl FnOnce(&mut RunState)) {
    let (ev, viewers) = {
        let mut runs = st.karaoke.runs.lock_clean();
        let Some(r) = runs.get_mut(&item) else { return };
        f(r);
        (event(item, r.state, r.stage, r.progress), r.viewers.clone())
    };
    st.hub.emit_to_users(&viewers, ev);
}

/// Tells the viewers of a track that its stems are done and nothing is left to run.
pub async fn announce_ready(st: &AppState, item: i32) {
    let ev = event(item, "ready", None, None);
    st.hub.emit_to_users(&viewers(st, item).await, ev);
}

/// A worker's progress on the track's `Separate`, 0 to 100.
pub async fn announce_worker(st: &AppState, item: i32, progress: f64) {
    let ev = event(item, "running", Some("separate"), Some(progress));
    st.hub.emit_to_users(&viewers(st, item).await, ev);
}

fn stage(st: &AppState, item: i32, stage: &'static str) {
    update(st, item, |r| {
        r.state = "running";
        r.stage = Some(stage);
        r.progress = None;
    });
}

/// The engine already sends a job's percent at most once a second.
fn progress(st: &AppState, item: i32, which: &'static str) -> crate::engine::Progress {
    let st = st.clone();
    Arc::new(move |pct| {
        update(&st, item, |r| {
            r.state = "running";
            r.stage = Some(which);
            r.progress = Some(pct);
        });
    })
}

/// Enabled readers of the track's library, plus the users who see every library.
async fn viewers(st: &AppState, item: i32) -> Arc<[i32]> {
    let ids = sqlx::query_scalar::<_, i32>(
        r#"SELECT u.id FROM users u LEFT JOIN roles r ON r.id = u."roleId"
           WHERE u.enabled AND (u."isAdmin" OR r.permissions ? 'manage:all'
             OR (r.permissions ? 'media.read' AND EXISTS (
               SELECT 1 FROM items i JOIN media m ON m.id = i."mediaId"
               JOIN editions e ON e.id = i."editionId"
               JOIN library_user_access a ON a."libraryId" = m."libraryId"
               WHERE i.id = $1 AND a."userId" = u.id)))
           ORDER BY u.id"#,
    )
    .bind(item)
    .fetch_all(&st.db)
    .await
    .unwrap_or_else(|e| {
        tracing::error!(error = %e, "karaoke event audience");
        vec![]
    });
    ids.into()
}

/// The track has every stem from an import or the installed separation model; false when unknown.
pub(super) async fn stems_valid(st: &AppState, item: i32) -> bool {
    let (Ok(Some(file)), Ok(models)) = (
        store::track_file(&st.db, item).await,
        super::engine_models(st).await,
    ) else {
        return false;
    };
    let sep = installed_model(&models.models, ModelKind::Separation)
        .map(|m| (m.id.as_str(), m.version.as_str()));
    store::missing(&st.db, file, sep)
        .await
        .is_ok_and(|m| m.is_empty())
}

/// What a run would do.
#[derive(Debug, PartialEq, Eq)]
enum Work {
    None,
    Stems,
    Lyrics,
}

/// `Separate` lacks a kind, or an asked step has work, its feature and model.
async fn pending(st: &AppState, item: i32, file: Option<i32>, opts: Opts) -> Work {
    let Some(file) = file else { return Work::Stems };
    let Ok(models) = super::engine_models(st).await else {
        return Work::Stems;
    };
    let sep = installed_model(&models.models, ModelKind::Separation)
        .map(|m| (m.id.as_str(), m.version.as_str()));
    match store::missing(&st.db, file, sep).await {
        Ok(m) if m.is_empty() => {}
        _ => return Work::Stems,
    }
    let caps = super::caps(st).await;
    let Ok(mut rows) = lstore::list(&st.db, item).await else {
        return Work::Stems;
    };
    lstore::sort(&mut rows);
    let rejected = store::failure(&st.db, item)
        .await
        .ok()
        .flatten()
        .and_then(|f| f.rejected());
    let align = opts.align
        && caps.align
        && align_plan(st, &models.models, &rows, opts.force)
            .await
            .is_some_and(|p| opts.force || rejected.as_ref() != Some(&p.key()));
    let melody = opts.melody
        && caps.melody
        && match melody_of(&rows).filter(|r| melody_spans(r, opts.repitch()).is_some()) {
            Some(r) => !opts.repitch() || !lstore::is_ultrastar(&st.db, r.id).await.unwrap_or(true),
            None => false,
        };
    if align || melody {
        Work::Lyrics
    } else {
        Work::None
    }
}

/// Registers the run and spawns it, unless it joins a running one, has nothing to do, or the caller is over a limit.
pub async fn start(
    st: &AppState,
    item: i32,
    opts: Opts,
    priority: JobPriority,
    user: Option<i32>,
) -> Start {
    if st.karaoke.runs.lock_clean().contains_key(&item) {
        return Start::Idle;
    }
    let file = match store::track_file(&st.db, item).await {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("karaoke of track #{item} not started: {e}");
            return Start::Refused(Refusal::Unavailable);
        }
    };
    // A leased worker job is separating the file; a queued one is the pass's, which a request takes over.
    if let Some(f) = file {
        let states: &[&str] = if user.is_some() {
            &["leased"]
        } else {
            &["queued", "leased"]
        };
        match store::worker_separating(&st.db, f, states).await {
            Ok(false) => {}
            Ok(true) => return Start::Idle,
            Err(e) => {
                tracing::warn!("karaoke of track #{item} not started: {e}");
                return Start::Refused(Refusal::Unavailable);
            }
        }
    }
    let work = pending(st, item, file, opts).await;
    if work == Work::None {
        return Start::Idle;
    }
    if work == Work::Stems && !super::caps(st).await.separate {
        return Start::Refused(Refusal::Unavailable);
    }
    if user.is_some() && work == Work::Stems {
        match store::total(&st.db).await {
            Ok(total) if total >= super::budget_bytes(st).await.saturating_mul(2) => {
                return Start::Refused(Refusal::Full);
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("karaoke of track #{item} not started: {e}");
                return Start::Refused(Refusal::Unavailable);
            }
        }
    }
    let viewers = viewers(st, item).await;
    {
        let mut runs = st.karaoke.runs.lock_clean();
        match admit(&runs, item, user) {
            Admit::Join => return Start::Idle,
            Admit::Busy => return Start::Refused(Refusal::Busy),
            Admit::Go => {}
        }
        runs.insert(
            item,
            RunState {
                state: "queued",
                stage: None,
                progress: None,
                user,
                viewers,
                cancelled: Arc::default(),
                job: None,
            },
        );
    }
    // After admission, so a refused request deletes nothing; a lease won meanwhile ends the run.
    if let (Some(f), Some(_)) = (file, user) {
        let _ = store::take_queued_separation(&st.db, f).await;
        if store::worker_separating(&st.db, f, &["leased"])
            .await
            .unwrap_or(false)
        {
            st.karaoke.runs.lock_clean().remove(&item);
            return Start::Idle;
        }
    }
    update(st, item, |_| {});
    let st = st.clone();
    Start::Started(tokio::spawn(async move {
        // Unattended runs share one slot, so a user's request always finds the other.
        let _lane = match user {
            None => Some(st.karaoke.unattended.acquire().await),
            Some(_) => None,
        };
        let _slot = st.karaoke.slots.acquire().await;
        let inner = st.clone();
        let done = tokio::spawn(async move { steps(&inner, item, opts, priority).await })
            .await
            .unwrap_or_else(|e| Err(format!("the run stopped: {e}").into()));
        finish(&st, item, &done).await;
        done
    }))
}

/// Records the outcome, ends the run and tells its viewers.
async fn finish(st: &AppState, item: i32, done: &Result<Outcome, Failure>) {
    if let Err(e) = done {
        tracing::warn!("karaoke of item #{item} failed: {e}");
    }
    if !matches!(done, Err(Failure::Cancelled))
        && let Err(e) = store::record(&st.db, item, done).await
    {
        tracing::warn!("karaoke failure of item #{item} not recorded: {e}");
    }
    let viewers = st
        .karaoke
        .runs
        .lock_clean()
        .remove(&item)
        .map(|r| r.viewers);
    let state = match done {
        Ok(_) => "ready",
        Err(Failure::Cancelled) => "none",
        Err(_) => "failed",
    };
    if let Some(v) = viewers {
        st.hub.emit_to_users(&v, event(item, state, None, None));
    }
}

/// The run's `DELETE` came: stop before the next step.
async fn check(st: &AppState, item: i32) -> Result<(), Failure> {
    let flag = st
        .karaoke
        .runs
        .lock_clean()
        .get(&item)
        .map(|r| r.cancelled.clone());
    match flag {
        Some(f) if *f.lock().await => Err(Failure::Cancelled),
        _ => Ok(()),
    }
}

/// Holds the run's cancel flag for a write; `Cancelled` once a `DELETE` set it.
async fn write_gate(
    st: &AppState,
    item: i32,
) -> Result<Option<tokio::sync::OwnedMutexGuard<bool>>, Failure> {
    let flag = st
        .karaoke
        .runs
        .lock_clean()
        .get(&item)
        .map(|r| r.cancelled.clone());
    let Some(flag) = flag else { return Ok(None) };
    let g = flag.lock_owned().await;
    if *g {
        return Err(Failure::Cancelled);
    }
    Ok(Some(g))
}

/// Submits `req`, keeping its id on the run for a `DELETE` to cancel.
async fn run_job(
    st: &AppState,
    item: i32,
    req: &JobRequest,
    which: &'static str,
) -> Result<JobResult, Failure> {
    let id = st.engine.submit_job(req).await?;
    if let Some(r) = st.karaoke.runs.lock_clean().get_mut(&item) {
        r.job = Some(id.clone());
    }
    if check(st, item).await.is_err() {
        let _ = st.engine.cancel_job(&id).await;
    }
    let done = st
        .engine
        .wait_job(id, req, Some(progress(st, item, which)))
        .await;
    if let Some(r) = st.karaoke.runs.lock_clean().get_mut(&item) {
        r.job = None;
    }
    Ok(done?)
}

/// Cancels the run of `item`, if any, and waits for a write in progress to end.
pub(crate) async fn cancel(st: &AppState, item: i32) {
    let flag = st
        .karaoke
        .runs
        .lock_clean()
        .get(&item)
        .map(|r| r.cancelled.clone());
    let Some(flag) = flag else { return };
    *flag.lock().await = true;
    let job = st
        .karaoke
        .runs
        .lock_clean()
        .get(&item)
        .and_then(|r| r.job.clone());
    if let Some(job) = job
        && let Err(e) = st.engine.cancel_job(&job).await
    {
        tracing::warn!("karaoke job {job} not cancelled: {e}");
    }
}

#[derive(Debug, Clone, Copy)]
enum Step {
    Align,
    Melody,
}

async fn steps(
    st: &AppState,
    item: i32,
    opts: Opts,
    priority: JobPriority,
) -> Result<Outcome, Failure> {
    check(st, item).await?;
    let t = track(st, item).await?;
    let models = super::engine_models(st).await?;
    let sep = installed_model(&models.models, ModelKind::Separation);
    let missing = store::missing(
        &st.db,
        t.file,
        sep.map(|m| (m.id.as_str(), m.version.as_str())),
    )
    .await?;
    let mut out = Outcome::default();
    if !missing.is_empty() {
        let sep = sep.ok_or_else(|| Failure::ModelMissing {
            message: "no separation model is installed".into(),
        })?;
        out.provider = Some(separate(st, item, &t, &sep.id, &missing, priority).await?);
        evict(st).await;
    }
    let vocals = store::rows(&st.db, t.file)
        .await?
        .into_iter()
        .find(|r| r.kind == "vocals")
        .map(|r| PathBuf::from(r.path))
        .ok_or("the vocals stem is missing")?;
    let caps = super::caps(st).await;
    let pick = |k| installed_model(&models.models, k).map(|m| m.id.as_str());
    for step in [Step::Align, Step::Melody] {
        let res = match step {
            Step::Align if opts.align && caps.align => {
                check(st, item).await?;
                align(
                    st,
                    item,
                    &t,
                    &vocals,
                    &models.models,
                    opts.force,
                    priority,
                    &mut out,
                )
                .await
            }
            Step::Melody if opts.melody && caps.melody => match pick(ModelKind::Melody) {
                Some(model) => {
                    check(st, item).await?;
                    melody(
                        st,
                        item,
                        &t,
                        &vocals,
                        model,
                        opts.repitch(),
                        priority,
                        &mut out,
                    )
                    .await
                }
                None => Ok(()),
            },
            _ => Ok(()),
        };
        match res {
            Ok(()) => {}
            Err(Failure::Cancelled) => return Err(Failure::Cancelled),
            Err(e) => {
                tracing::warn!("karaoke {step:?} of item #{item} failed: {e}");
                out.lyrics_ran = true;
                out.lyrics_error.get_or_insert(e);
            }
        }
    }
    Ok(out)
}

/// Rule 14, then the sweep of rule 15.
pub async fn evict(st: &AppState) {
    let budget = super::budget_bytes(st).await;
    if let Err(e) = store::evict(&st.db, budget).await {
        tracing::warn!("karaoke eviction failed: {e}");
    }
    if let Err(e) = store::sweep(st).await {
        tracing::warn!("karaoke sweep failed: {e}");
    }
}

/// Makes the `missing` stems; the provider that ran the network.
async fn separate(
    st: &AppState,
    item: i32,
    t: &Track,
    model: &str,
    missing: &[&'static str],
    priority: JobPriority,
) -> Result<String, Failure> {
    let info = t.info.clone().ok_or("the file was not probed")?;
    stage(st, item, "separate");
    let _separating = super::Separating::new(&st.karaoke, t.file);
    let dir = store::file_dir(t.file);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let tag = crate::config::random_hex(4);
    let at = |k: &str| {
        missing.contains(&k).then(|| {
            dir.join(format!("{k}-{tag}.opus"))
                .to_string_lossy()
                .into_owned()
        })
    };
    let providers = super::verified_providers(st).await;
    let req = JobRequest {
        kind: JobKind::Separate {
            info,
            model: Some(model.to_owned()),
            vocals: at("vocals"),
            instrumental: at("instrumental"),
            guide: None,
            guide_vocals_gain: None,
            bitrate_kbps: None,
            providers: Some(providers),
            model_version: None,
            input_token: None,
        },
        media: MediaRef {
            media_file_id: t.file as u32,
            path: t.path.to_string_lossy().into_owned(),
        },
        priority: Some(priority),
        force: false,
    };
    let JobResult::Separate { separate: s } = run_job(st, item, &req, "separate").await? else {
        return Err("the engine answered another result".into());
    };
    let duration_ms = (s.duration_seconds * 1000.0).round() as i32;
    let mut rows = vec![];
    for (kind, stem) in [("vocals", &s.vocals), ("instrumental", &s.instrumental)] {
        if !missing.contains(&kind) {
            continue;
        }
        let stem = stem.as_ref().ok_or("the engine wrote no stem")?;
        rows.push(store::New {
            file: t.file,
            kind,
            model: &s.model,
            model_version: &s.model_version,
            provider: &s.provider,
            path: &stem.path,
            size: stem.bytes as i64,
            duration_ms,
        });
    }
    let _gate = write_gate(st, item).await?;
    store::put_all(&st.db, &rows).await?;
    Ok(s.provider)
}

fn ms(v: i64) -> u32 {
    v.clamp(0, i64::from(u32::MAX)) as u32
}

/// The text `Align` times: the best main row of rule 66's order, unless a word-synced or reviewed one exists.
fn align_source(rows: &[lstore::Row], force: bool) -> Option<&lstore::Row> {
    let mains: Vec<_> = rows
        .iter()
        .filter(|r| r.kind == "main" && !(force && r.source == "generated" && !r.reviewed))
        .collect();
    let done = mains
        .iter()
        .any(|r| r.sync == "word" || (r.source == "generated" && r.reviewed));
    mains
        .first()
        .copied()
        .filter(|r| !done && !kd::align_request(&r.doc.0).is_empty())
}

/// `doc` on the audio's clock: the row's `offsetMs` (positive shows the text sooner) folded into its times.
fn on_audio(doc: &dl::Doc, offset_ms: i32) -> dl::Doc {
    match offset_ms {
        0 => doc.clone(),
        o => kd::retimed(doc, -f64::from(o), 1.0),
    }
}

/// A short digest of the lines `Align` times, kept with its result and its rejection.
fn text_digest(request: &[kd::Request]) -> String {
    let mut h = Sha256::new();
    for r in request {
        h.update(r.text.as_bytes());
        h.update(b"\n");
    }
    h.finalize()[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// What an `Align` of the track would send.
struct AlignPlan<'a> {
    src: &'a lstore::Row,
    /// The source on the audio's clock.
    doc: dl::Doc,
    request: Vec<kd::Request>,
    language: Option<String>,
    model: String,
    /// The quality model, which reads the source audio.
    quality: bool,
    text: String,
}

impl AlignPlan<'_> {
    fn key(&self) -> (String, String) {
        (self.model.clone(), self.text.clone())
    }
}

async fn align_plan<'a>(
    st: &AppState,
    models: &[ModelInfo],
    rows: &'a [lstore::Row],
    force: bool,
) -> Option<AlignPlan<'a>> {
    let src = align_source(rows, force)?;
    let doc = on_audio(&src.doc.0, src.offset_ms);
    let request = kd::align_request(&doc);
    let language = aligner::language_of(&src.lang, &src.doc.0);
    let m = aligner::aligner(
        models,
        language.as_deref(),
        &aligner::overrides(st).await,
        aligner::quality(st).await,
    )?;
    let (quality, model) = (m.id == aligner::QUALITY_MODEL, m.id.clone());
    Some(AlignPlan {
        src,
        text: text_digest(&request),
        doc,
        request,
        language,
        quality,
        model,
    })
}

/// The quality model times the full mix; the others the vocals stem.
fn align_media<'a>(quality: bool, source: &'a Path, vocals: &'a Path) -> &'a Path {
    if quality { source } else { vocals }
}

#[allow(clippy::too_many_arguments)]
async fn align(
    st: &AppState,
    item: i32,
    t: &Track,
    vocals: &Path,
    models: &[ModelInfo],
    force: bool,
    priority: JobPriority,
    out: &mut Outcome,
) -> Result<(), Failure> {
    let mut rows = lstore::list(&st.db, item).await?;
    lstore::sort(&mut rows);
    let Some(plan) = align_plan(st, models, &rows, force).await else {
        return Ok(());
    };
    let rejected = store::failure(&st.db, item)
        .await?
        .and_then(|f| f.rejected());
    if !force && rejected == Some(plan.key()) {
        return Ok(());
    }
    let kind = JobKind::Align {
        lines: plan
            .request
            .iter()
            .map(|r| AlignLine {
                text: r.text.clone(),
                start_ms: r.start.map(ms),
                end_ms: r
                    .end
                    .zip(r.start)
                    .filter(|(e, s)| e >= s)
                    .map(|(e, _)| ms(e)),
            })
            .collect(),
        language: plan.language.clone(),
        model: Some(plan.model.clone()),
        providers: Some(super::verified_providers(st).await),
    };
    if let Err(e) = fliks_engine_core::jobs::align::validate(&kind) {
        return Err(if e.contains("at most") {
            Failure::LyricsTooLong
        } else {
            e.into()
        });
    }
    stage(st, item, "align");
    out.lyrics_ran = true;
    let req = JobRequest {
        kind,
        media: MediaRef {
            media_file_id: t.file as u32,
            path: align_media(plan.quality, &t.path, vocals)
                .to_string_lossy()
                .into_owned(),
        },
        priority: Some(priority),
        force: false,
    };
    let JobResult::Align { align: a } = run_job(st, item, &req, "align").await? else {
        return Err("the engine answered another result".into());
    };
    let placed: Vec<kd::Placed> = a
        .lines
        .iter()
        .map(|l| kd::Placed {
            line: l.line as usize,
            start: i64::from(l.start_ms),
            end: i64::from(l.end_ms),
            words: l
                .words
                .iter()
                .map(|w| kd::Word {
                    byte_start: w.byte_start as usize,
                    byte_end: w.byte_end as usize,
                    start: i64::from(w.start_ms),
                    end: i64::from(w.end_ms),
                    guessed: w.guessed,
                })
                .collect(),
        })
        .collect();
    let doc = kd::from_alignment(&plan.doc, &plan.request, &placed);
    if doc.lines.is_empty() {
        return Err(Failure::NoWordTimed);
    }
    if a.matched < MIN_MATCHED {
        out.rejected_match = Some(a.matched);
        out.rejected = Some(plan.key());
        return Err(Failure::low_match(a.matched));
    }
    let src = plan.src;
    let _gate = write_gate(st, item).await?;
    // A line-synced source follows the audio: lines the engine found take its time, the others the fit.
    if src.sync == "line" && !src.reviewed {
        let fitted = match a.lrc_fit {
            Some(f) => kd::retimed(&plan.doc, f.offset_ms, f.scale),
            None => plan.doc.clone(),
        };
        let found: Vec<_> = a
            .lines
            .iter()
            .filter(|l| l.repeat == 0 && l.matched >= SNAP_MATCHED)
            .map(|l| (l.line as usize, i64::from(l.start_ms)))
            .collect();
        let snapped = kd::snapped(&fitted, &plan.request, &found);
        if snapped != src.doc.0 {
            lstore::retime(&st.db, src.id, &src.doc.0, &snapped).await?;
        }
    }
    let mut source_ref = format!(
        "{}#matched={:.2}#version={}#text={}",
        a.model, a.matched, a.model_version, plan.text
    );
    if let Some(why) = &a.fallback {
        source_ref.push_str(&format!("#fallback={why}"));
    }
    lstore::upsert(
        &st.db,
        &lstore::New {
            item,
            file: Some(t.file),
            kind: "main",
            lang: &src.lang,
            source: "generated",
            source_ref: Some(&source_ref),
            parsed: &Parsed {
                sync: Sync::Word,
                doc,
                ..Parsed::default()
            },
            raw: None,
            duration_ms: t.duration_ms,
            reviewed: false,
        },
    )
    .await?;
    Ok(())
}

/// The first word-synced main row of rule 66's order.
pub async fn melody_target(st: &AppState, item: i32) -> sqlx::Result<Option<lstore::Row>> {
    let mut rows = lstore::list(&st.db, item).await?;
    lstore::sort(&mut rows);
    Ok(melody_of(&rows).cloned())
}

fn melody_of(rows: &[lstore::Row]) -> Option<&lstore::Row> {
    rows.iter().find(|r| r.kind == "main" && r.sync == "word")
}

/// The spans a `Melody` would look at: the row has cues and, unless `repitch`, no pitch yet.
fn melody_spans(r: &lstore::Row, repitch: bool) -> Option<Vec<(i64, i64)>> {
    let spans = kd::line_spans(&r.doc.0);
    (!spans.is_empty() && (repitch || !has_pitch(&r.doc.0))).then_some(spans)
}

pub fn has_pitch(d: &dl::Doc) -> bool {
    d.lines
        .iter()
        .flat_map(|l| &l.cues)
        .any(|c| c.pitch.is_some())
}

/// Writes the pitch of `notes` into row `id` only if its `doc` is still `snapshot`; false when it moved.
pub async fn write_pitch(
    db: &sqlx::PgPool,
    id: i32,
    snapshot: &dl::Doc,
    notes: &[Vec<kd::Note>],
) -> sqlx::Result<bool> {
    let mut tx = db.begin().await?;
    let current: Option<sqlx::types::Json<dl::Doc>> =
        sqlx::query_scalar("SELECT doc FROM lyrics WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(mut doc) = current.map(|d| d.0).filter(|d| d == snapshot) else {
        return Ok(false);
    };
    kd::apply_pitch(&mut doc, notes);
    sqlx::query("UPDATE lyrics SET doc = $2 WHERE id = $1")
        .bind(id)
        .bind(sqlx::types::Json(&doc))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
async fn melody(
    st: &AppState,
    item: i32,
    t: &Track,
    vocals: &Path,
    model: &str,
    repitch: bool,
    priority: JobPriority,
    out: &mut Outcome,
) -> Result<(), Failure> {
    let Some(target) = melody_target(st, item).await? else {
        return Ok(());
    };
    let Some(spans) = melody_spans(&target, repitch) else {
        return Ok(());
    };
    // An UltraStar row's notes are authored: a forced run would replace them for good.
    if repitch && lstore::is_ultrastar(&st.db, target.id).await? {
        return Ok(());
    }
    if spans.len() > MAX_MELODY_SPANS {
        return Err(Failure::LyricsTooLong);
    }
    stage(st, item, "melody");
    out.lyrics_ran = true;
    let offset = i64::from(target.offset_ms);
    let req = JobRequest {
        kind: JobKind::Melody {
            spans: spans
                .iter()
                .map(|(s, e)| MelodySpan {
                    start_ms: ms(*s - offset),
                    end_ms: ms((*e).max(*s + 1) - offset),
                })
                .collect(),
            model: Some(model.to_owned()),
        },
        media: MediaRef {
            media_file_id: t.file as u32,
            path: vocals.to_string_lossy().into_owned(),
        },
        priority: Some(priority),
        force: false,
    };
    let JobResult::Melody { melody: m } = run_job(st, item, &req, "melody").await? else {
        return Err("the engine answered another result".into());
    };
    let notes: Vec<Vec<kd::Note>> = m
        .spans
        .iter()
        .map(|s| {
            s.iter()
                .map(|n| {
                    let at = |v: u32| i64::from(v) + offset;
                    (at(n.start_ms), at(n.end_ms), n.midi)
                })
                .collect()
        })
        .collect();
    let _gate = write_gate(st, item).await?;
    if !write_pitch(&st.db, target.id, &target.doc.0, &notes).await? {
        tracing::info!("karaoke melody of item #{item} dropped: the lyrics changed meanwhile");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_database_error_during_admission_is_a_refusal_not_idle() {
        let pool = sqlx::PgPool::connect_lazy("postgres://unused@localhost/unused").unwrap();
        pool.close().await;
        let st = AppState::new(
            pool,
            crate::config::Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        );
        let opts = Opts {
            align: true,
            melody: true,
            force: false,
        };
        let start = start(&st, 1, opts, JobPriority::Normal, Some(1)).await;
        assert!(matches!(start, Start::Refused(Refusal::Unavailable)));
    }

    fn row(id: i32, source: &str, sync: &str, reviewed: bool) -> lstore::Row {
        lstore::Row {
            id,
            item_id: 1,
            kind: "main".into(),
            lang: "fr".into(),
            sync: sync.into(),
            source: source.into(),
            source_ref: None,
            offset_ms: 0,
            doc: sqlx::types::Json(
                serde_json::from_value(
                    serde_json::json!({"agents": [], "lines": [{"text": "a b"}]}),
                )
                .unwrap(),
            ),
            reviewed,
            preferred: false,
        }
    }

    #[test]
    fn the_quality_aligner_reads_the_source_audio_and_the_others_the_vocals() {
        let (src, vocals) = (Path::new("/m/a.flac"), Path::new("/s/vocals.wav"));
        assert_eq!(align_media(true, src, vocals), src);
        assert_eq!(align_media(false, src, vocals), vocals);
    }

    fn with_pitch(mut r: lstore::Row) -> lstore::Row {
        r.doc = sqlx::types::Json(
            serde_json::from_value(serde_json::json!({"agents": [], "lines": [
                {"text": "a", "start": 0, "end": 900,
                 "cues": [{"start": 0, "end": 900, "byteStart": 0, "byteEnd": 1, "pitch": 60.0}]}]}))
            .unwrap(),
        );
        r
    }

    fn opts(align: bool, melody: bool, force: bool) -> Opts {
        Opts {
            align,
            melody,
            force,
        }
    }

    #[test]
    fn a_prepared_track_has_no_work_until_it_is_forced() {
        let done = [
            with_pitch(row(1, "generated", "word", false)),
            row(2, "lrclib", "line", false),
        ];
        assert!(align_source(&done, false).is_none());
        assert!(melody_spans(&done[0], false).is_none());
        assert_eq!(align_source(&done, true).map(|r| r.id), Some(2));
        assert!(melody_spans(&done[0], opts(false, true, true).repitch()).is_some());
    }

    #[test]
    fn a_forced_sync_leaves_a_reviewed_row_and_a_forced_melody_needs_a_synced_row() {
        let reviewed = [
            with_pitch(row(1, "generated", "word", true)),
            row(2, "lrclib", "line", false),
        ];
        assert!(align_source(&reviewed, true).is_none());
        assert!(melody_of(&[row(2, "lrclib", "line", false)]).is_none());
    }

    #[test]
    fn the_row_offset_is_folded_into_the_times_the_engine_reads() {
        let doc: dl::Doc = serde_json::from_value(serde_json::json!({"agents": [], "lines": [
            {"text": "a", "start": 1000, "end": 2000}, {"text": "b", "start": 300}]}))
        .unwrap();
        // Shown 500 ms sooner: each line is sung 500 ms before its written time.
        let shown_sooner = on_audio(&doc, 500);
        let starts: Vec<_> = shown_sooner.lines.iter().map(|l| l.start).collect();
        assert_eq!(starts, [Some(500), Some(0)]);
        assert_eq!(shown_sooner.lines[0].end, Some(1500));
        assert_eq!(on_audio(&doc, -500).lines[1].start, Some(800));
        assert_eq!(on_audio(&doc, 0), doc);
    }

    #[test]
    fn engine_errors_map_to_codes_a_client_can_name() {
        let job = |state: &str, what: &str| {
            Failure::from(EngineError::Job {
                state: state.into(),
                what: what.into(),
            })
        };
        assert!(matches!(
            job("failed", "model_missing: no such model"),
            Failure::ModelMissing { .. }
        ));
        assert!(matches!(
            job("failed", "unsupported: no ONNX runtime"),
            Failure::Unsupported { .. }
        ));
        assert_eq!(job("cancelled", "x"), Failure::Cancelled);
        assert!(matches!(job("failed", "bad audio"), Failure::Failed { .. }));
        assert!(matches!(
            Failure::from(EngineError::NotRunning),
            Failure::EngineUnavailable { .. }
        ));
        assert!(job("failed", "bad audio").permanent());
        assert!(!Failure::from(EngineError::NotRunning).permanent());
        let wire = serde_json::to_value(job("failed", "model_missing: m")).unwrap();
        assert_eq!(wire["code"], "model_missing");
    }

    #[test]
    fn a_forced_melody_beside_a_sync_only_follows_the_new_row() {
        let o = opts(true, true, true);
        assert!(!o.repitch());
        assert!(opts(false, true, true).repitch());
        assert!(!opts(false, true, false).repitch());
        let sung = with_pitch(row(1, "generated", "word", false));
        assert!(melody_spans(&sung, false).is_none());
        assert!(melody_spans(&sung, true).is_some());
    }

    #[test]
    fn a_realign_reads_the_source_lyrics_and_keeps_the_generated_row() {
        let rows = [
            row(1, "generated", "word", false),
            row(2, "lrclib", "line", false),
        ];
        assert!(align_source(&rows, false).is_none());
        assert_eq!(align_source(&rows, true).map(|r| r.id), Some(2));
        let reviewed = [
            row(1, "generated", "word", true),
            row(2, "lrclib", "line", false),
        ];
        assert!(align_source(&reviewed, true).is_none());
    }
}
