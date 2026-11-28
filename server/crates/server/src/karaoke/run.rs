//! Preparation of a track: `Separate`, `Align`, `Melody` (`docs/spec/karaoke.md` rules 13, 18, 19).
use super::stale::{Aligned, Pitched, Stages, Stamp, Wants};
use super::{aligner, store};
use crate::sync::MutexExt;
use crate::{
    engine::EngineError, events::SseEvent, ingest::post_import::file_path, lyrics::store as lstore,
    state::AppState,
};
use fliks_domain::lyrics::{self as dl, Parsed, Sync, karaoke as kd};
use fliks_engine_core::api::{
    AlignLine, JobKind, JobPriority, JobRequest, JobResult, MediaInfo, MediaRef, MelodySpan,
    ModelInfo, ModelKind, ModelState, ModelsResponse, job_errors,
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
    /// Separate again stems that are present but outdated (rule 12a); false runs the lyrics steps on them.
    pub separate: bool,
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
    /// What a request, the pass or a worker commit runs: every step that has work.
    pub const ALL: Self = Self {
        align: true,
        melody: true,
        force: false,
        separate: true,
    };

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
    /// The `Align` whose result was rejected.
    pub rejected: Option<Aligned>,
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

/// The track's file has a stem of every kind, current or not; false when unknown.
pub(super) async fn stems_present(st: &AppState, item: i32) -> bool {
    let Ok(Some(file)) = store::track_file(&st.db, item).await else {
        return false;
    };
    store::rows(&st.db, file).await.is_ok_and(|rows| {
        store::KINDS
            .iter()
            .all(|k| rows.iter().any(|r| r.kind == *k))
    })
}

/// What a run would do.
#[derive(Debug, PartialEq, Eq)]
enum Work {
    None,
    Stems,
    Lyrics,
}

/// The kinds `Separate` makes for `opts`: without `separate`, only the ones with no stem at all.
async fn to_separate(
    st: &AppState,
    file: i32,
    wants: &Wants,
    opts: Opts,
) -> sqlx::Result<Vec<&'static str>> {
    let missing = store::missing(&st.db, file, wants.separate.as_ref()).await?;
    if opts.separate || missing.is_empty() {
        return Ok(missing);
    }
    let held = store::rows(&st.db, file).await?;
    Ok(missing
        .into_iter()
        .filter(|k| !held.iter().any(|r| r.kind == *k))
        .collect())
}

/// `Separate` lacks a kind, or an asked step has work, its feature and model.
async fn pending(st: &AppState, item: i32, file: Option<i32>, opts: Opts) -> Work {
    let Some(file) = file else { return Work::Stems };
    let Ok(models) = super::engine_models(st).await else {
        return Work::Stems;
    };
    let wants = Wants::of(&models);
    match to_separate(st, file, &wants, opts).await {
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
        .and_then(|f| f.rejected.map(|r| r.0));
    let choice = aligner::choice(st).await;
    let align = opts.align
        && caps.align
        && align_plan(&models, &choice, &rows).is_some_and(|p| {
            p.due(&rows, opts.force) && (opts.force || !p.refused(rejected.as_ref()))
        });
    let melody = opts.melody
        && caps.melody
        && match melody_of(&rows) {
            Some(r) => {
                let redo = opts.repitch() || pitch_outdated(r, wants.melody.as_ref());
                melody_spans(r, redo).is_some()
                    && (!redo || !lstore::is_ultrastar(&st.db, r.id).await.unwrap_or(true))
            }
            None => false,
        };
    if align || melody {
        Work::Lyrics
    } else {
        Work::None
    }
}

/// The steps of `item` holding an outdated result (rule 12a), as the next run would see them.
pub async fn outdated(st: &AppState, item: i32, models: &ModelsResponse) -> sqlx::Result<Stages> {
    let wants = Wants::of(models);
    let separate = match (store::track_file(&st.db, item).await?, &wants.separate) {
        (Some(f), Some(w)) => store::rows(&st.db, f)
            .await?
            .iter()
            .any(|r| !r.current(Some(w))),
        _ => false,
    };
    let mut rows = lstore::list(&st.db, item).await?;
    lstore::sort(&mut rows);
    let choice = aligner::choice(st).await;
    let rejected = store::failure(&st.db, item)
        .await?
        .and_then(|f| f.rejected.map(|r| r.0));
    let (align, melody) = lyrics_outdated(&rows, models, &choice, &wants);
    Ok(Stages {
        separate,
        align: align.is_some_and(|p| !p.refused(rejected.as_ref())),
        melody,
    })
}

/// The plan of an outdated generated row, and whether the pitch is outdated, from rule 66's order.
pub(super) fn lyrics_outdated<'a>(
    rows: &'a [lstore::Row],
    models: &ModelsResponse,
    choice: &aligner::Choice,
    wants: &Wants,
) -> (Option<AlignPlan<'a>>, bool) {
    let align = align_plan(models, choice, rows).filter(|p| p.outdated(rows));
    let melody = melody_of(rows).is_some_and(|r| pitch_outdated(r, wants.melody.as_ref()));
    (align, melody)
}

/// The row's pitch came from a `Melody` that `want` would not make today.
fn pitch_outdated(r: &lstore::Row, want: Option<&Stamp>) -> bool {
    r.pitched_by
        .as_ref()
        .zip(want)
        .is_some_and(|(p, w)| p.by.stale(w))
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
    let wants = Wants::of(&models);
    let missing = to_separate(st, t.file, &wants, opts).await?;
    let mut out = Outcome::default();
    if !missing.is_empty() {
        let sep = wants
            .separate
            .as_ref()
            .ok_or_else(|| Failure::ModelMissing {
                message: "no separation model is installed".into(),
            })?;
        out.provider = Some(separate(st, item, &t, &sep.model, &missing, priority).await?);
        evict(st).await;
    }
    let vocals = store::rows(&st.db, t.file)
        .await?
        .into_iter()
        .find(|r| r.kind == "vocals")
        .map(|r| PathBuf::from(r.path))
        .ok_or("the vocals stem is missing")?;
    let caps = super::caps(st).await;
    for step in [Step::Align, Step::Melody] {
        let res = match step {
            Step::Align if opts.align && caps.align => {
                check(st, item).await?;
                align(
                    st, item, &t, &vocals, &models, opts.force, priority, &mut out,
                )
                .await
            }
            Step::Melody if opts.melody && caps.melody => match &wants.melody {
                Some(want) => {
                    check(st, item).await?;
                    melody(
                        st,
                        item,
                        &t,
                        &vocals,
                        want,
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
            revision: s.revision,
        });
    }
    let _gate = write_gate(st, item).await?;
    store::put_all(&st.db, &rows).await?;
    Ok(s.provider)
}

fn ms(v: i64) -> u32 {
    v.clamp(0, i64::from(u32::MAX)) as u32
}

/// The text `Align` times: the best main row of rule 66's order but the unreviewed generated one,
/// unless a word-synced or reviewed one exists.
fn align_source(rows: &[lstore::Row]) -> Option<&lstore::Row> {
    let mains: Vec<_> = rows
        .iter()
        .filter(|r| r.kind == "main" && !replaceable(r))
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

/// An unreviewed generated row, which a new `Align` replaces.
fn replaceable(r: &lstore::Row) -> bool {
    r.kind == "main" && r.source == "generated" && !r.reviewed
}

/// What an `Align` of the track would send.
pub(super) struct AlignPlan<'a> {
    src: &'a lstore::Row,
    /// The source on the audio's clock.
    doc: dl::Doc,
    request: Vec<kd::Request>,
    pub(super) language: Option<String>,
    /// The aligner as it would stamp its result.
    pub(super) want: Stamp,
    /// The quality model, which reads the source audio.
    quality: bool,
    text: String,
}

impl AlignPlan<'_> {
    /// The generated row exists and another aligner, version, revision or text made it.
    pub(super) fn outdated(&self, rows: &[lstore::Row]) -> bool {
        rows.iter().find(|r| replaceable(r)).is_some_and(|g| {
            g.aligned_by
                .as_ref()
                .is_none_or(|a| a.stale(&self.want, &self.text))
        })
    }

    fn due(&self, rows: &[lstore::Row], force: bool) -> bool {
        force || !rows.iter().any(replaceable) || self.outdated(rows)
    }

    /// The same aligner already rejected the same text (rule 18).
    pub(super) fn refused(&self, rejected: Option<&Aligned>) -> bool {
        rejected.is_some_and(|r| !r.stale(&self.want, &self.text))
    }

    /// The stamp of this plan's result.
    pub(super) fn stamp(&self, matched: f64, fallback: Option<String>) -> Aligned {
        Aligned {
            by: self.want.clone(),
            text: self.text.clone(),
            matched,
            fallback,
        }
    }
}

pub(super) fn align_plan<'a>(
    models: &ModelsResponse,
    choice: &aligner::Choice,
    rows: &'a [lstore::Row],
) -> Option<AlignPlan<'a>> {
    let src = align_source(rows)?;
    let doc = on_audio(&src.doc.0, src.offset_ms);
    let request = kd::align_request(&doc);
    let language = aligner::language_of(&src.lang, &src.doc.0);
    let m = aligner::aligner(
        &models.models,
        language.as_deref(),
        &choice.overrides,
        choice.quality,
    )?;
    let (quality, want) = (
        m.id == aligner::QUALITY_MODEL,
        Stamp::current(m, models.revisions.align),
    );
    Some(AlignPlan {
        src,
        text: text_digest(&request),
        doc,
        request,
        language,
        quality,
        want,
    })
}

/// The quality model times the full mix, reading word ends from the vocals; the others the vocals.
fn align_media<'a>(
    quality: bool,
    source: &'a Path,
    vocals: &'a Path,
) -> (&'a Path, Option<&'a Path>) {
    if quality {
        (source, Some(vocals))
    } else {
        (vocals, None)
    }
}

#[allow(clippy::too_many_arguments)]
async fn align(
    st: &AppState,
    item: i32,
    t: &Track,
    vocals: &Path,
    models: &ModelsResponse,
    force: bool,
    priority: JobPriority,
    out: &mut Outcome,
) -> Result<(), Failure> {
    let mut rows = lstore::list(&st.db, item).await?;
    lstore::sort(&mut rows);
    let choice = aligner::choice(st).await;
    let Some(plan) = align_plan(models, &choice, &rows).filter(|p| p.due(&rows, force)) else {
        return Ok(());
    };
    let rejected = store::failure(&st.db, item)
        .await?
        .and_then(|f| f.rejected.map(|r| r.0));
    if !force && plan.refused(rejected.as_ref()) {
        return Ok(());
    }
    let (media, voicing) = align_media(plan.quality, &t.path, vocals);
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
        model: Some(plan.want.model.clone()),
        providers: Some(super::verified_providers(st).await),
        voicing: voicing.map(|v| v.to_string_lossy().into_owned()),
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
            path: media.to_string_lossy().into_owned(),
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
        out.rejected = Some(plan.stamp(a.matched, a.fallback.clone()));
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
    let stamp = plan.stamp(a.matched, a.fallback.clone());
    let id = lstore::upsert(
        &st.db,
        &lstore::New {
            item,
            file: Some(t.file),
            kind: "main",
            lang: &src.lang,
            source: "generated",
            source_ref: None,
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
    lstore::stamp_alignment(&st.db, id, &stamp).await?;
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

/// Writes the pitch of `notes` and its stamp into row `id` only if its `doc` is still `snapshot`; false when it moved.
pub async fn write_pitch(
    db: &sqlx::PgPool,
    id: i32,
    snapshot: &dl::Doc,
    notes: &[Vec<kd::Note>],
    by: &Pitched,
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
    sqlx::query(r#"UPDATE lyrics SET doc = $2, "pitchedBy" = $3 WHERE id = $1"#)
        .bind(id)
        .bind(sqlx::types::Json(&doc))
        .bind(sqlx::types::Json(by))
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
    want: &Stamp,
    repitch: bool,
    priority: JobPriority,
    out: &mut Outcome,
) -> Result<(), Failure> {
    let Some(target) = melody_target(st, item).await? else {
        return Ok(());
    };
    let redo = repitch || pitch_outdated(&target, Some(want));
    let Some(spans) = melody_spans(&target, redo) else {
        return Ok(());
    };
    // An UltraStar row's notes are authored: a forced run would replace them for good.
    if redo && lstore::is_ultrastar(&st.db, target.id).await? {
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
            model: Some(want.model.clone()),
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
    let by = Pitched {
        by: Stamp {
            model: m.model.clone(),
            version: m.model_version.clone(),
            revision: m.revision,
        },
        analysis: m.analysis,
    };
    let _gate = write_gate(st, item).await?;
    if !write_pitch(&st.db, target.id, &target.doc.0, &notes, &by).await? {
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
        let start = start(&st, 1, Opts::ALL, JobPriority::Normal, Some(1)).await;
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
            aligned_by: None,
            pitched_by: None,
        }
    }

    fn models() -> ModelsResponse {
        let model = |id: &str, kind: &str| {
            serde_json::json!({
                "id": id, "kind": kind, "name": id, "version": "1", "default": true,
                "state": "installed", "languages": ["fr"], "files": [], "downloadedBytes": 0,
                "homepage": "", "sizeBytes": 0, "diskBytes": 0, "outdated": false, "verifying": false,
                "licence": {"name": "l", "text": "t", "clear": true}
            })
        };
        serde_json::from_value(serde_json::json!({
            "runtime": {"onnx": true, "providers": [], "whisper": false, "rubberband": false},
            "modelsDir": "/m", "usedBytes": 0, "orphans": [],
            "models": [model("fr", "alignment"), model("pitch", "melody")],
            "revisions": {"separate": 2, "align": 2, "melody": 2}
        }))
        .unwrap()
    }

    fn choice() -> aligner::Choice {
        aligner::Choice {
            overrides: HashMap::new(),
            quality: false,
        }
    }

    #[test]
    fn the_quality_aligner_reads_the_source_audio_and_the_others_the_vocals() {
        let (src, vocals) = (Path::new("/m/a.flac"), Path::new("/s/vocals.wav"));
        assert_eq!(align_media(true, src, vocals), (src, Some(vocals)));
        assert_eq!(align_media(false, src, vocals), (vocals, None));
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
            separate: true,
        }
    }

    #[test]
    fn a_prepared_track_has_no_work_until_it_is_forced_or_outdated() {
        let (models, choice) = (models(), choice());
        let mut done = [
            with_pitch(row(1, "generated", "word", false)),
            row(2, "lrclib", "line", false),
        ];
        let plan = align_plan(&models, &choice, &done).unwrap();
        let stamp = plan.stamp(0.9, None);
        done[0].aligned_by = Some(sqlx::types::Json(stamp.clone()));
        let plan = align_plan(&models, &choice, &done).unwrap();
        assert_eq!(
            plan.src.id, 2,
            "the source is read, never the generated row"
        );
        assert!(!plan.due(&done, false));
        assert!(plan.due(&done, true));
        assert!(melody_spans(&done[0], false).is_none());
        assert!(melody_spans(&done[0], opts(false, true, true).repitch()).is_some());
        let mut older = done.clone();
        older[0].aligned_by.as_mut().unwrap().by.revision = 1;
        assert!(plan.due(&older, false), "an older revision is outdated");
        let mut changed = done.clone();
        changed[1].doc.0.lines[0].text = "a c".into();
        let edited = align_plan(&models, &choice, &changed).unwrap();
        assert!(edited.outdated(&changed), "the source text changed");
        assert!(edited.refused(Some(&edited.stamp(0.1, None))));
        assert!(!edited.refused(Some(&stamp)), "a rejection of another text");
    }

    #[test]
    fn the_pitch_is_outdated_only_when_a_melody_made_it() {
        let want = Wants::of(&models()).melody.unwrap();
        let mut r = with_pitch(row(1, "generated", "word", false));
        assert!(!pitch_outdated(&r, Some(&want)), "authored pitch");
        let mut by = Pitched {
            by: want.clone(),
            analysis: None,
        };
        r.pitched_by = Some(sqlx::types::Json(by.clone()));
        assert!(!pitch_outdated(&r, Some(&want)));
        by.by.version = "0".into();
        r.pitched_by = Some(sqlx::types::Json(by));
        assert!(pitch_outdated(&r, Some(&want)));
        assert!(!pitch_outdated(&r, None), "nothing can redo it");
    }

    #[test]
    fn a_forced_sync_leaves_a_reviewed_row_and_a_forced_melody_needs_a_synced_row() {
        let reviewed = [
            with_pitch(row(1, "generated", "word", true)),
            row(2, "lrclib", "line", false),
        ];
        assert!(align_source(&reviewed).is_none());
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
        assert_eq!(align_source(&rows).map(|r| r.id), Some(2));
        let reviewed = [
            row(1, "generated", "word", true),
            row(2, "lrclib", "line", false),
        ];
        assert!(align_source(&reviewed).is_none());
    }
}
