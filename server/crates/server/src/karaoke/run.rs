//! Preparation of a track: `Separate`, `Align`, `Melody` (`docs/spec/karaoke.md` rules 13, 18, 19).
use super::store;
use crate::{
    events::SseEvent, ingest::post_import::file_path, lyrics::store as lstore, state::AppState,
};
use fliks_domain::lyrics::{self as dl, Parsed, Sync, karaoke as kd};
use fliks_engine_core::api::{
    AlignLine, JobKind, JobPriority, JobRequest, JobResult, MediaInfo, MediaRef, MelodySpan,
    ModelInfo, ModelKind, ModelState,
};
use std::{
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
}

#[derive(Clone)]
pub struct RunState {
    pub state: &'static str,
    pub stage: Option<&'static str>,
    pub progress: Option<f64>,
    pub error: Option<String>,
}

/// What a run learned that the background pass acts on.
#[derive(Default)]
pub struct Outcome {
    pub provider: Option<String>,
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

/// The installed model the engine takes for `kind` when a request names none.
pub fn installed_default(models: &[ModelInfo], kind: ModelKind) -> Option<&ModelInfo> {
    models
        .iter()
        .find(|m| m.kind == kind && m.default && m.state == ModelState::Installed)
}

fn set(st: &AppState, item: i32, s: Option<RunState>) {
    let mut runs = st.karaoke.runs.lock().unwrap_or_else(|e| e.into_inner());
    match &s {
        Some(s) => runs.insert(item, s.clone()),
        None => runs.remove(&item),
    };
    drop(runs);
    let (state, stage, progress) = match &s {
        Some(s) => (s.state.to_owned(), s.stage.map(str::to_owned), s.progress),
        None => ("ready".to_owned(), None, None),
    };
    st.hub.emit(SseEvent::KaraokeJobChanged {
        item_id: i64::from(item),
        state,
        stage,
        progress: progress.map(Into::into),
    });
}

fn stage(st: &AppState, item: i32, stage: &'static str) {
    set(
        st,
        item,
        Some(RunState {
            state: "running",
            stage: Some(stage),
            progress: Some(0.0),
            error: None,
        }),
    );
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
        set(
            &st,
            item,
            Some(RunState {
                state: "running",
                stage: Some(which),
                progress: Some(pct),
                error: None,
            }),
        );
    })
}

/// Registers the run and spawns it; `None` when the track is already queued or running.
pub fn start(
    st: &AppState,
    item: i32,
    opts: Opts,
    priority: JobPriority,
) -> Option<tokio::task::JoinHandle<Result<Outcome, String>>> {
    {
        let mut runs = st.karaoke.runs.lock().unwrap_or_else(|e| e.into_inner());
        if runs
            .get(&item)
            .is_some_and(|r| r.state == "queued" || r.state == "running")
        {
            return None;
        }
        runs.insert(
            item,
            RunState {
                state: "queued",
                stage: None,
                progress: None,
                error: None,
            },
        );
    }
    set(
        st,
        item,
        Some(RunState {
            state: "queued",
            stage: None,
            progress: None,
            error: None,
        }),
    );
    let st = st.clone();
    Some(tokio::spawn(async move {
        let _slot = st.karaoke.slots.acquire().await;
        stage(&st, item, "separate");
        let done = steps(&st, item, opts, priority).await;
        match &done {
            Ok(_) => set(&st, item, None),
            Err(e) => {
                tracing::warn!("karaoke of item #{item} failed: {e}");
                set(
                    &st,
                    item,
                    Some(RunState {
                        state: "failed",
                        stage: None,
                        progress: None,
                        error: Some(e.clone()),
                    }),
                );
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
) -> Result<Outcome, String> {
    let t = track(st, item).await?;
    let models = st.engine.models().await.map_err(|e| e.to_string())?;
    let sep = installed_default(&models.models, ModelKind::Separation)
        .ok_or("model_missing: no separation model is installed")?;
    store::invalidate_stale_models(&st.db, &sep.id, &sep.version)
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Outcome::default();
    if !store::valid(&st.db, t.file, &sep.id, &sep.version)
        .await
        .map_err(|e| e.to_string())?
    {
        out.provider = Some(separate(st, item, &t, priority).await?);
        evict(st).await;
    }
    let vocals = store::rows(&st.db, t.file)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|r| r.kind == "vocals")
        .map(|r| PathBuf::from(r.path))
        .ok_or("the vocals stem is missing")?;
    if opts.align && installed_default(&models.models, ModelKind::Alignment).is_some() {
        stage(st, item, "align");
        align(st, item, &t, &vocals, priority).await?;
    }
    if opts.melody && installed_default(&models.models, ModelKind::Melody).is_some() {
        stage(st, item, "melody");
        melody(st, item, &t, &vocals, priority).await?;
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
    priority: JobPriority,
) -> Result<String, String> {
    let info = t.info.clone().ok_or("the file was not probed")?;
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
    let req = JobRequest {
        kind: JobKind::Separate {
            info,
            model: None,
            vocals: Some(at("vocals")),
            instrumental: Some(at("instrumental")),
            guide: Some(at("guide")),
            guide_vocals_gain: None,
            bitrate_kbps: None,
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

async fn align(
    st: &AppState,
    item: i32,
    t: &Track,
    vocals: &std::path::Path,
    priority: JobPriority,
) -> Result<(), String> {
    let mut rows = lstore::list(&st.db, item)
        .await
        .map_err(|e| e.to_string())?;
    lstore::sort(&mut rows);
    let mains: Vec<_> = rows.iter().filter(|r| r.kind == "main").collect();
    let done = mains
        .iter()
        .any(|r| r.sync == "word" || (r.source == "generated" && r.reviewed));
    let Some(src) = mains.first().filter(|_| !done) else {
        return Ok(());
    };
    let request = kd::align_request(&src.doc.0);
    let words: usize = request
        .iter()
        .map(|r| r.text.split_whitespace().count())
        .sum();
    if request.is_empty() {
        return Ok(());
    }
    if request.len() > MAX_ALIGN_LINES || words > MAX_ALIGN_WORDS {
        return Err("the lyrics are too long to align".into());
    }
    let language = Some(src.lang.clone()).filter(|l| (2..=3).contains(&l.len()) && l != "und");
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
            model: None,
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
        return Err("no lyrics word could be timed".into());
    }
    lstore::upsert(
        &st.db,
        &lstore::New {
            item,
            file: Some(t.file),
            kind: "main",
            lang: &src.lang,
            source: "generated",
            source_ref: Some(&a.model),
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
    Ok(rows
        .into_iter()
        .find(|r| r.kind == "main" && r.sync == "word"))
}

pub fn has_pitch(d: &dl::Doc) -> bool {
    d.lines
        .iter()
        .flat_map(|l| &l.cues)
        .any(|c| c.pitch.is_some())
}

async fn melody(
    st: &AppState,
    item: i32,
    t: &Track,
    vocals: &std::path::Path,
    priority: JobPriority,
) -> Result<(), String> {
    let Some(target) = melody_target(st, item).await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let spans = kd::cue_spans(&target.doc.0);
    if spans.is_empty() || has_pitch(&target.doc.0) {
        return Ok(());
    }
    if spans.len() > MAX_MELODY_SPANS {
        return Err("the lyrics have too many words for the melody".into());
    }
    let req = JobRequest {
        kind: JobKind::Melody {
            spans: spans
                .iter()
                .map(|(s, e)| MelodySpan {
                    start_ms: ms(*s),
                    end_ms: ms((*e).max(*s + 1)),
                })
                .collect(),
            model: None,
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
    let mut doc = target.doc.0.clone();
    kd::apply_pitch(&mut doc, &notes);
    sqlx::query("UPDATE lyrics SET doc = $2 WHERE id = $1")
        .bind(target.id)
        .bind(sqlx::types::Json(&doc))
        .execute(&st.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
