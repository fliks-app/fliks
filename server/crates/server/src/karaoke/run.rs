//! Preparation of a track: `Separate`, `Align`, `Melody` (`docs/spec/karaoke.md` rules 13, 18, 19).
use super::{aligner, store};
use crate::{
    events::SseEvent, ingest::post_import::file_path, lyrics::store as lstore, state::AppState,
};
use fliks_domain::lyrics::{self as dl, Parsed, Sync, karaoke as kd};
use fliks_engine_core::api::{
    AlignLine, JobKind, JobPriority, JobRequest, JobResult, MediaInfo, MediaRef, MelodySpan,
    ModelInfo, ModelKind, ModelState,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

/// The engine's own limits for an `Align` request (`docs/spec/karaoke.md` section 4).
const MAX_ALIGN_LINES: usize = 3000;
const MAX_ALIGN_WORDS: usize = 6000;
const MAX_MELODY_SPANS: usize = 100_000;

#[derive(Clone, Copy)]
pub struct Opts {
    pub align: bool,
    pub melody: bool,
    /// Align again from the source lyrics: the generated row stays until a new one replaces it.
    pub realign: bool,
}

#[derive(Clone)]
pub struct RunState {
    pub state: &'static str,
    pub stage: Option<&'static str>,
    pub progress: Option<f64>,
    pub error: Option<Failure>,
    pub lyrics_error: Option<Failure>,
    /// Who asked; `None` for the background pass.
    pub user: Option<i32>,
    /// The users `karaoke.job_changed` goes to.
    pub viewers: Arc<[i32]>,
}

impl RunState {
    pub(crate) fn active(&self) -> bool {
        self.state == "queued" || self.state == "running"
    }
}

/// What a run learned that the background pass acts on.
#[derive(Default)]
pub struct Outcome {
    pub provider: Option<String>,
    pub lyrics_error: Option<Failure>,
    /// Share of the lyrics found in the vocals, when that was too low to save the alignment.
    pub rejected_match: Option<f64>,
}

/// Why a step failed; `code` and its params are the wire form, the `Display` text is for logs.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum Failure {
    /// Percentages of the lyrics found in the vocals and the least that is kept.
    LyricsNotFoundInVocals {
        matched: u32,
        min: u32,
    },
    LyricsTooLong,
    NoWordTimed,
    /// Anything else; `message` is the engine's or the server's text, for settings managers only.
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

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LyricsNotFoundInVocals { matched, .. } => {
                write!(f, "only {matched} % of the lyrics were found in the vocals")
            }
            Self::LyricsTooLong => f.write_str("the lyrics are too long to align"),
            Self::NoWordTimed => f.write_str("no lyrics word could be timed"),
            Self::Failed { message } => f.write_str(message),
        }
    }
}

/// Most queued or running runs one caller holds (rule 13).
const MAX_RUNS_PER_USER: usize = 2;
/// Align results matching fewer lyric words than this are not saved (rule 18).
pub(super) const MIN_MATCHED: f64 = 0.3;

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    Busy,
    Full,
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
    if runs.get(&item).is_some_and(RunState::active) {
        return Admit::Join;
    }
    let held = runs
        .values()
        .filter(|r| r.active() && user.is_some() && r.user == user)
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

/// The file a track's stems derive from: its first version.
pub async fn track(st: &AppState, item: i32) -> Result<Track, String> {
    let file: Option<i32> = sqlx::query_scalar(
        r#"SELECT ip."mediaFileId" FROM item_parts ip WHERE ip."itemId" = $1 ORDER BY ip.version LIMIT 1"#,
    )
    .bind(item)
    .fetch_optional(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    let file = file.ok_or("the track has no file")?;
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

/// Applies `f` to the run of `item` and tells its viewers; a no-op once the run is gone.
fn update(st: &AppState, item: i32, f: impl FnOnce(&mut RunState)) {
    let (ev, viewers) = {
        let mut runs = st.karaoke.runs.lock().unwrap_or_else(|e| e.into_inner());
        let Some(r) = runs.get_mut(&item) else { return };
        f(r);
        let ev = SseEvent::KaraokeJobChanged {
            item_id: i64::from(item),
            state: r.state.to_owned(),
            stage: r.stage.map(str::to_owned),
            progress: r.progress.map(Into::into),
        };
        (ev, r.viewers.clone())
    };
    st.hub.emit_to_users(&viewers, ev);
}

fn stage(st: &AppState, item: i32, stage: &'static str) {
    update(st, item, |r| {
        r.state = "running";
        r.stage = Some(stage);
        r.progress = Some(0.0);
    });
}

/// A callback that reports a running job's percent at most once a second.
fn progress(st: &AppState, item: i32, which: &'static str) -> crate::engine::Progress {
    let (st, last) = (st.clone(), std::sync::Mutex::new(Instant::now()));
    Arc::new(move |pct| {
        let mut at = last.lock().unwrap_or_else(|e| e.into_inner());
        if at.elapsed() < Duration::from_secs(1) {
            return;
        }
        *at = Instant::now();
        drop(at);
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
           WHERE u.enabled AND (u."isAdmin" OR r.permissions LIKE '%"manage:all"%'
             OR (r.permissions LIKE '%"media.read"%' AND EXISTS (
               SELECT 1 FROM items i JOIN media m ON m.id = i."mediaId"
               JOIN editions e ON e.id = i."editionId"
               JOIN library_user_access a ON a."libraryId" = COALESCE(e."libraryId", m."libraryId")
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

/// What a run still has to do: `Separate` is not valid, or an asked step has work and its feature.
async fn pending(st: &AppState, item: i32, opts: Opts) -> bool {
    let Ok(t) = track(st, item).await else {
        return true;
    };
    let Ok(models) = st.engine.models().await else {
        return true;
    };
    let Some(sep) = installed_model(&models.models, ModelKind::Separation) else {
        return true;
    };
    if !store::valid(&st.db, t.file, &sep.id, &sep.version)
        .await
        .unwrap_or(false)
    {
        return true;
    }
    let caps = super::caps(st).await;
    let Ok(mut rows) = lstore::list(&st.db, item).await else {
        return true;
    };
    lstore::sort(&mut rows);
    (opts.align && caps.align && align_source(&rows, opts.realign).is_some())
        || (opts.melody
            && caps.melody
            && melody_of(&rows).is_some_and(|r| melody_spans(r).is_some()))
}

/// Registers the run and spawns it, unless it joins a running one, has nothing to do, or the caller is over a limit.
pub async fn start(
    st: &AppState,
    item: i32,
    opts: Opts,
    priority: JobPriority,
    user: Option<i32>,
) -> Start {
    if st
        .karaoke
        .runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&item)
        .is_some_and(RunState::active)
    {
        return Start::Idle;
    }
    if user.is_some()
        && store::total(&st.db).await.unwrap_or(0) >= super::budget_bytes(st).await * 2
    {
        return Start::Refused(Refusal::Full);
    }
    if !pending(st, item, opts).await {
        return Start::Idle;
    }
    let viewers = viewers(st, item).await;
    {
        let mut runs = st.karaoke.runs.lock().unwrap_or_else(|e| e.into_inner());
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
                error: None,
                lyrics_error: None,
                user,
                viewers,
            },
        );
    }
    update(st, item, |_| {});
    let st = st.clone();
    Start::Started(tokio::spawn(async move {
        let _slot = st.karaoke.slots.acquire().await;
        let done = steps(&st, item, opts, priority).await;
        match &done {
            Ok(out) => {
                update(&st, item, |r| {
                    r.state = "ready";
                    r.stage = None;
                    r.progress = None;
                    r.lyrics_error.clone_from(&out.lyrics_error);
                });
                if out.lyrics_error.is_none() {
                    st.karaoke
                        .runs
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&item);
                }
            }
            Err(e) => {
                tracing::warn!("karaoke of item #{item} failed: {e}");
                update(&st, item, |r| {
                    r.state = "failed";
                    r.stage = None;
                    r.progress = None;
                    r.error = Some(e.clone());
                });
            }
        }
        done
    }))
}

async fn steps(
    st: &AppState,
    item: i32,
    opts: Opts,
    priority: JobPriority,
) -> Result<Outcome, Failure> {
    let t = track(st, item).await?;
    let models = st.engine.models().await.map_err(|e| e.to_string())?;
    let sep = installed_model(&models.models, ModelKind::Separation)
        .ok_or("model_missing: no separation model is installed")?;
    store::invalidate_stale_models(&st.db, &sep.id, &sep.version)
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Outcome::default();
    if !store::valid(&st.db, t.file, &sep.id, &sep.version)
        .await
        .map_err(|e| e.to_string())?
    {
        out.provider = Some(separate(st, item, &t, &sep.id, priority).await?);
        evict(st).await;
    }
    let vocals = store::rows(&st.db, t.file)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|r| r.kind == "vocals")
        .map(|r| PathBuf::from(r.path))
        .ok_or("the vocals stem is missing")?;
    let caps = super::caps(st).await;
    let pick = |k| installed_model(&models.models, k).map(|m| m.id.as_str());
    if opts.align
        && caps.align
        && let Err(e) = align(
            st,
            item,
            &t,
            &vocals,
            &models.models,
            opts.realign,
            priority,
        )
        .await
    {
        tracing::warn!("karaoke align of item #{item} failed: {e}");
        if let Failure::LyricsNotFoundInVocals { matched, .. } = &e {
            out.rejected_match = Some(f64::from(*matched) / 100.0);
        }
        out.lyrics_error = Some(e);
    }
    if opts.melody
        && caps.melody
        && let Some(model) = pick(ModelKind::Melody)
        && let Err(e) = melody(st, item, &t, &vocals, model, priority).await
    {
        tracing::warn!("karaoke melody of item #{item} failed: {e}");
        out.lyrics_error.get_or_insert(e);
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

/// The provider that ran the network.
async fn separate(
    st: &AppState,
    item: i32,
    t: &Track,
    model: &str,
    priority: JobPriority,
) -> Result<String, String> {
    let info = t.info.clone().ok_or("the file was not probed")?;
    stage(st, item, "separate");
    let dir = store::file_dir(t.file);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let tag = crate::config::random_hex(4);
    let at = |k: &str| {
        dir.join(format!("{k}-{tag}.opus"))
            .to_string_lossy()
            .into_owned()
    };
    let providers = super::verified_providers(st).await;
    let req = JobRequest {
        kind: JobKind::Separate {
            info,
            model: Some(model.to_owned()),
            vocals: Some(at("vocals")),
            instrumental: Some(at("instrumental")),
            guide: Some(at("guide")),
            guide_vocals_gain: None,
            bitrate_kbps: None,
            providers: Some(providers),
        },
        media: MediaRef {
            media_file_id: t.file as u32,
            path: t.path.to_string_lossy().into_owned(),
        },
        priority: Some(priority),
        force: false,
    };
    let result = st
        .engine
        .run_job(&req, Some(progress(st, item, "separate")))
        .await
        .map_err(|e| e.to_string())?;
    let JobResult::Separate { separate: s } = result else {
        return Err("the engine answered another result".into());
    };
    let duration_ms = (s.duration_seconds * 1000.0).round() as i32;
    for (kind, stem) in [
        ("vocals", &s.vocals),
        ("instrumental", &s.instrumental),
        ("guide", &s.guide),
    ] {
        let stem = stem.as_ref().ok_or("the engine wrote no stem")?;
        store::put(
            &st.db,
            &store::New {
                file: t.file,
                kind,
                model: &s.model,
                model_version: &s.model_version,
                provider: &s.provider,
                path: &stem.path,
                size: stem.bytes as i64,
                duration_ms,
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(s.provider)
}

fn ms(v: i64) -> u32 {
    v.clamp(0, i64::from(u32::MAX)) as u32
}

/// The text `Align` times: the best main row of rule 66's order, unless a word-synced or reviewed one exists.
fn align_source(rows: &[lstore::Row], realign: bool) -> Option<&lstore::Row> {
    let mains: Vec<_> = rows
        .iter()
        .filter(|r| r.kind == "main" && !(realign && r.source == "generated" && !r.reviewed))
        .collect();
    let done = mains
        .iter()
        .any(|r| r.sync == "word" || (r.source == "generated" && r.reviewed));
    mains
        .first()
        .copied()
        .filter(|r| !done && !kd::align_request(&r.doc.0).is_empty())
}

async fn align(
    st: &AppState,
    item: i32,
    t: &Track,
    vocals: &std::path::Path,
    models: &[ModelInfo],
    realign: bool,
    priority: JobPriority,
) -> Result<(), Failure> {
    let mut rows = lstore::list(&st.db, item)
        .await
        .map_err(|e| e.to_string())?;
    lstore::sort(&mut rows);
    let Some(src) = align_source(&rows, realign) else {
        return Ok(());
    };
    let request = kd::align_request(&src.doc.0);
    let words: usize = request
        .iter()
        .map(|r| r.text.split_whitespace().count())
        .sum();
    if request.len() > MAX_ALIGN_LINES || words > MAX_ALIGN_WORDS {
        return Err(Failure::LyricsTooLong);
    }
    let language = aligner::language_of(&src.lang, &src.doc.0);
    let model = aligner::aligner(models, language.as_deref(), &aligner::overrides(st).await)
        .ok_or("model_missing: no alignment model is installed")?
        .id
        .clone();
    stage(st, item, "align");
    let req = JobRequest {
        kind: JobKind::Align {
            lines: request
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
            language,
            model: Some(model),
            providers: Some(super::verified_providers(st).await),
        },
        media: MediaRef {
            media_file_id: t.file as u32,
            path: vocals.to_string_lossy().into_owned(),
        },
        priority: Some(priority),
        force: false,
    };
    let result = st
        .engine
        .run_job(&req, Some(progress(st, item, "align")))
        .await
        .map_err(|e| e.to_string())?;
    let JobResult::Align { align: a } = result else {
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
                })
                .collect(),
        })
        .collect();
    let doc = kd::from_alignment(&src.doc.0, &request, &placed);
    if doc.lines.is_empty() {
        return Err(Failure::NoWordTimed);
    }
    if a.matched < MIN_MATCHED {
        return Err(Failure::low_match(a.matched));
    }
    let mut source_ref = format!("{}#matched={:.2}", a.model, a.matched);
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
    .await
    .map_err(|e| e.to_string())?;
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

/// The spans a `Melody` would look at: the row has cues and no pitch yet.
fn melody_spans(r: &lstore::Row) -> Option<Vec<(i64, i64)>> {
    let spans = kd::line_spans(&r.doc.0);
    (!spans.is_empty() && !has_pitch(&r.doc.0)).then_some(spans)
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

async fn melody(
    st: &AppState,
    item: i32,
    t: &Track,
    vocals: &std::path::Path,
    model: &str,
    priority: JobPriority,
) -> Result<(), Failure> {
    let Some(target) = melody_target(st, item).await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let Some(spans) = melody_spans(&target) else {
        return Ok(());
    };
    if spans.len() > MAX_MELODY_SPANS {
        return Err(Failure::LyricsTooLong);
    }
    stage(st, item, "melody");
    let req = JobRequest {
        kind: JobKind::Melody {
            spans: spans
                .iter()
                .map(|(s, e)| MelodySpan {
                    start_ms: ms(*s),
                    end_ms: ms((*e).max(*s + 1)),
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
    let result = st
        .engine
        .run_job(&req, Some(progress(st, item, "melody")))
        .await
        .map_err(|e| e.to_string())?;
    let JobResult::Melody { melody: m } = result else {
        return Err("the engine answered another result".into());
    };
    let notes: Vec<Vec<kd::Note>> = m
        .spans
        .iter()
        .map(|s| {
            s.iter()
                .map(|n| (i64::from(n.start_ms), i64::from(n.end_ms), n.midi))
                .collect()
        })
        .collect();
    if !write_pitch(&st.db, target.id, &target.doc.0, &notes)
        .await
        .map_err(|e| e.to_string())?
    {
        tracing::info!("karaoke melody of item #{item} dropped: the lyrics changed meanwhile");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
