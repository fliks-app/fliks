//! Detection orchestration and the intro / outro passes (`docs/spec/markers.md` rules 7-22, 24).
use super::db::{self, CommandRow, EpisodeFile, ScanSeason, SeasonInfo};
use crate::{
    busy::Claim,
    events::{Num, SseEvent, Subject},
    http::AppError,
    state::AppState,
};
use fliks_domain::media::path::{join, resolve};
use fliks_engine_core::api::{
    Chapter, Fingerprint, FingerprintWindow, IntroDetectKind, IntroDetectRequest, IntroEpisode,
    JobKind, JobPriority, JobRequest, JobResult, MediaRef,
};
use futures_util::future::join_all;
use std::{
    collections::HashSet,
    sync::atomic::{AtomicUsize, Ordering},
};

const FINGERPRINT_CONCURRENCY: usize = 4;
const COMMAND: &str = "IntroDetection";

/// `(current, total, message)`.
type Progress<'a> = Option<&'a (dyn Fn(i64, i64, &str) + Send + Sync)>;

/// C40: a positive finite number, else the default.
pub fn positive_or(value: Option<&str>, default: f64) -> f64 {
    value
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(default)
}

async fn setting(st: &AppState, key: &str) -> Result<Option<String>, String> {
    crate::settings::setting_value(&st.db, key)
        .await
        .map_err(|e| e.to_string())
}

fn duration(info: Option<&serde_json::Value>) -> f64 {
    info.and_then(|i| i["durationSeconds"].as_f64())
        .unwrap_or(0.0)
}

struct Fingerprinted<'a> {
    episode: &'a EpisodeFile,
    file_id: i32,
    fingerprint: Fingerprint,
}

async fn fingerprint(
    st: &AppState,
    file_id: i32,
    path: String,
    lookup_sec: f64,
    outro_of: Option<f64>,
    priority: JobPriority,
) -> Result<Fingerprint, String> {
    let req = JobRequest {
        kind: JobKind::Fingerprint {
            window: match outro_of {
                None => FingerprintWindow::Head,
                Some(duration_seconds) => FingerprintWindow::Outro { duration_seconds },
            },
            max_lookup_minutes: Some(lookup_sec / 60.0),
        },
        media: MediaRef {
            media_file_id: file_id as u32,
            path,
        },
        priority: Some(priority),
        force: false,
    };
    match st.engine.run_job(&req, None).await {
        Ok(JobResult::Fingerprint { fingerprint }) => Ok(fingerprint),
        Ok(_) => Err("unexpected job result".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// One pass over a season: returns the number of segments the engine resolved.
async fn pass(
    st: &AppState,
    season: i32,
    kind: IntroDetectKind,
    progress: Progress<'_>,
    priority: JobPriority,
) -> Result<i64, String> {
    let outro = kind == IntroDetectKind::Outro;
    let (name, label) = if outro {
        ("outro", "Outro fingerprinting")
    } else {
        ("intro", "Fingerprinting")
    };
    if !st
        .engine
        .engine_features()
        .iter()
        .any(|f| f == "intro-detect")
    {
        return Err("The engine has no intro-detect feature".into());
    }
    let info = db::season_info(&st.db, season)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Season #{season} not found"))?;
    let Some(media_path) = info.media_path else {
        tracing::warn!("Skip season #{season}: parent media has no path");
        return Ok(0);
    };
    let episodes = db::episodes_with_files(&st.db, season)
        .await
        .map_err(|e| e.to_string())?;
    if episodes.is_empty() || (!outro && episodes.len() < 2) {
        return Ok(0);
    }
    let lookup_sec =
        positive_or(setting(st, "introMaxLookupMinutes").await?.as_deref(), 10.0) * 60.0;
    let min_segment = positive_or(
        setting(st, "introMinSegmentSeconds").await?.as_deref(),
        15.0,
    );
    let ids: Vec<i32> = episodes.iter().map(|e| e.episode_id).collect();
    let manual: HashSet<i32> = db::manual_episodes(&st.db, &ids, name)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    let eligible = |e: &&EpisodeFile| {
        !manual.contains(&e.episode_id)
            && e.file_id.is_some()
            && (!outro || duration(e.info.as_ref()) > 0.0)
    };
    let targets: Vec<&EpisodeFile> = episodes.iter().filter(eligible).collect();
    let total = targets.len() as i64;
    if let Some(p) = progress {
        p(0, total, &format!("{label} 0/{total}"));
    }
    let done = AtomicUsize::new(0);
    let mut prints: Vec<Fingerprinted> = vec![];
    for slice in targets.chunks(FINGERPRINT_CONCURRENCY) {
        let runs = slice.iter().map(|ep| async {
            let file_id = ep.file_id.expect("eligible");
            let abs = resolve(
                &join(&media_path, ep.relative_path.as_deref().unwrap_or_default()),
                &std::env::current_dir()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| "/".into()),
            );
            let dur = duration(ep.info.as_ref());
            let r = fingerprint(
                st,
                file_id,
                abs.clone(),
                lookup_sec,
                outro.then_some(dur),
                priority,
            )
            .await;
            let n = done.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some(p) = progress {
                p(n as i64, total, &format!("{label} {n}/{total}"));
            }
            match r {
                Ok(fingerprint) => Some(Fingerprinted {
                    episode: ep,
                    file_id,
                    fingerprint,
                }),
                Err(e) => {
                    tracing::warn!("E{} fingerprint failed ({abs}): {e}", ep.episode_number);
                    None
                }
            }
        });
        prints.extend(join_all(runs).await.into_iter().flatten());
    }
    prints.sort_by_key(|p| p.episode.episode_number);

    let mut result_files = HashSet::new();
    let mut detected = 0;
    if !prints.is_empty() {
        let body = IntroDetectRequest {
            kind,
            lookup_seconds: lookup_sec,
            min_segment_seconds: Some(min_segment),
            episodes: prints
                .iter()
                .map(|p| IntroEpisode {
                    media_file_id: p.file_id as u32,
                    duration_seconds: duration(p.episode.info.as_ref()),
                    chapters: p.episode.info.as_ref().and_then(|i| {
                        serde_json::from_value::<Vec<Chapter>>(i["chapters"].clone()).ok()
                    }),
                    intro_fingerprint: (!outro).then(|| p.fingerprint.clone()),
                    outro_fingerprint: outro.then(|| p.fingerprint.clone()),
                })
                .collect(),
        };
        let res = st
            .engine
            .intro_detect(&body)
            .await
            .map_err(|e| e.to_string())?;
        for seg in &res.results {
            result_files.insert(seg.media_file_id as i32);
            let Some(p) = prints
                .iter()
                .find(|p| p.file_id as u32 == seg.media_file_id)
            else {
                continue;
            };
            db::upsert_detected(
                &st.db,
                p.episode.episode_id,
                name,
                seg.start_seconds,
                seg.end_seconds,
                seg.confidence,
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        detected = res.results.len() as i64;
    }
    let skipped = episodes
        .iter()
        .filter(eligible)
        .filter(|e| e.file_id.is_some_and(|f| !result_files.contains(&f)))
        .count();
    tracing::info!("{name} detection of season #{season}: {detected} saved, {skipped} skipped");
    if !outro && let Some(p) = progress {
        let n = episodes.len() as i64;
        p(n, n, &format!("Detection complete: {detected} intro(s)"));
    }
    Ok(detected)
}

/// Rule 16: intros (a failure aborts), outros (a failure is logged), then the scanned stamp.
async fn detect_all(
    st: &AppState,
    season: i32,
    progress: Progress<'_>,
    priority: JobPriority,
) -> Result<(i64, i64), String> {
    let intros = pass(st, season, IntroDetectKind::Intro, progress, priority).await?;
    let outros = pass(st, season, IntroDetectKind::Outro, progress, priority)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("Outro detection failed for season #{season}: {e}");
            0
        });
    db::stamp_scanned(&st.db, season)
        .await
        .map_err(|e| e.to_string())?;
    Ok((intros, outros))
}

fn subject(info: &SeasonInfo) -> Subject {
    Subject {
        title: info.media_title.clone(),
        media_id: Some(i64::from(info.media_id)),
        media_type: Some("series".into()),
        season_number: Some(i64::from(info.season_number)),
        episode_number: None,
        episode_title: None,
        episode_id: None,
    }
}

fn activity_id(season: i32) -> String {
    format!("{COMMAND}:{season}")
}

/// Rule 9: the queued `commands` row; the run itself continues in the background.
pub async fn detect_season(
    st: &AppState,
    season: i32,
    trigger: &'static str,
) -> Result<CommandRow, AppError> {
    let claim = st.busy.marker_seasons.claim(season).ok_or_else(|| {
        AppError::bad_request(format!("Detection already running for season #{season}"))
    })?;
    let info = db::season_info(&st.db, season)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Season #{season} not found")))?;
    let cmd = db::insert_command(&st.db, trigger, season, &info).await?;
    let priority = if trigger == "manual" {
        JobPriority::High
    } else {
        JobPriority::Low
    };
    tokio::spawn(run_detection(
        st.clone(),
        cmd.id,
        season,
        info,
        priority,
        claim,
    ));
    Ok(cmd)
}

async fn run_detection(
    st: AppState,
    cmd: i32,
    season: i32,
    info: SeasonInfo,
    priority: JobPriority,
    _claim: Claim<i32>,
) {
    let id = activity_id(season);
    let run = async {
        db::command_running(&st.db, cmd)
            .await
            .map_err(|e| e.to_string())?;
        st.hub.emit(SseEvent::CommandStarted {
            name: COMMAND.into(),
        });
        let subject = subject(&info);
        let activity = st.hub.activity();
        activity.upsert_running(&id, COMMAND, Some(subject.clone()), None, None, None);
        let progress = |current: i64, total: i64, message: &str| {
            st.hub.emit(SseEvent::TaskProgress {
                command: COMMAND.into(),
                current: Num(current as f64),
                total: Num(total as f64),
                message: message.into(),
                subject: Some(subject.clone()),
            });
            activity.upsert_running(
                &id,
                COMMAND,
                Some(subject.clone()),
                Some(Num(current as f64)),
                Some(Num(total as f64)),
                None,
            );
        };
        let (intros, outros) = detect_all(&st, season, Some(&progress), priority).await?;
        db::command_end(&st.db, cmd, "completed")
            .await
            .map_err(|e| e.to_string())?;
        st.hub.emit(SseEvent::CommandCompleted {
            name: COMMAND.into(),
            status: "completed".into(),
        });
        st.hub.emit(SseEvent::MarkersSeasonCompleted {
            media_id: i64::from(info.media_id),
            season_id: i64::from(season),
            season_number: i64::from(info.season_number),
            intros_detected: intros + outros,
        });
        Ok::<(), String>(())
    }
    .await;
    if let Err(e) = run {
        tracing::error!("IntroDetection failed for season #{season}: {e}");
        match db::command_end(&st.db, cmd, "failed").await {
            Ok(()) => st.hub.emit(SseEvent::CommandCompleted {
                name: COMMAND.into(),
                status: "failed".into(),
            }),
            Err(e) => tracing::error!("IntroDetection #{cmd} crashed: {e}"),
        }
    }
    st.hub.activity().remove(&id);
}

/// Rule 13: bulk jobs; `subject` is the one the caller pre-registered the pending activity row under.
pub async fn run_detection_inline(
    st: &AppState,
    season: i32,
    subject: Option<Subject>,
) -> Result<(i64, i64), String> {
    let id = activity_id(season);
    let activity = st.hub.activity();
    let Some(_claim) = st.busy.marker_seasons.claim(season) else {
        if subject.is_some() {
            activity.remove(&id);
        }
        return Ok((0, 0));
    };
    if let Some(s) = &subject {
        activity.upsert_running(
            &id,
            COMMAND,
            Some(s.clone()),
            Some(Num(0.0)),
            Some(Num(1.0)),
            None,
        );
    }
    let progress = |current: i64, total: i64, _: &str| {
        if let Some(s) = &subject {
            activity.upsert_running(
                &id,
                COMMAND,
                Some(s.clone()),
                Some(Num(current as f64)),
                Some(Num(total as f64)),
                None,
            );
        }
    };
    let out = detect_all(st, season, Some(&progress), JobPriority::Normal).await;
    if subject.is_some() {
        activity.remove(&id);
    }
    out
}

/// Rule 11: one command per season with `seasonNumber > 0`; a refused season is skipped.
pub async fn detect_series(
    st: &AppState,
    media: i32,
    trigger: &'static str,
) -> Result<Vec<CommandRow>, AppError> {
    let mut out = vec![];
    for (id, number) in db::season_numbers(&st.db, media).await? {
        if number <= 0 {
            continue;
        }
        match detect_season(st, id, trigger).await {
            Ok(cmd) => out.push(cmd),
            Err(e) => tracing::warn!("enqueue intro detection skipped for season #{id}: {e:?}"),
        }
    }
    Ok(out)
}

/// Rule 14.
pub async fn list_seasons_for_scan(
    st: &AppState,
    only_missing: bool,
    media_id: Option<i32>,
) -> sqlx::Result<Vec<ScanSeason>> {
    db::seasons_for_scan(&st.db, only_missing, media_id).await
}

/// Rules 7 and 15 (post-import): only the string `true` enables it, absent is on.
pub async fn auto_detect_missing(st: &AppState, media_id: i32) -> sqlx::Result<()> {
    let on = crate::settings::setting_value(&st.db, "markers_auto_detect_on_import")
        .await?
        .is_none_or(|v| v == "true");
    if !on {
        return Ok(());
    }
    for s in list_seasons_for_scan(st, true, Some(media_id)).await? {
        if let Err(e) = detect_season(st, s.id, "auto").await {
            tracing::debug!("auto detect skipped season #{}: {e:?}", s.id);
        }
    }
    Ok(())
}
