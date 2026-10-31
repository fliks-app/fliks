//! Translating a subtitle (`translation.md` rules 42-47): the placeholder row, the gated run, the result.
use super::{
    events,
    files::{self, MediaCtx},
    model::{self, New, Row},
    service::{clean_options, flag_on},
    translation as engines, translation_providers as providers,
};
use crate::sync::MutexExt;
use crate::{events::SseEvent, http::AppError, state::AppState};
use fliks_domain::{
    language::normalize_language_code,
    srt::{Cue, decode_text, parse_srt, serialize_srt},
    subtitle_clean::clean_subtitle,
    subtitle_flags::IMAGE_BASED_CODECS,
    subtitle_path::sidecar_lang_suffix,
    translation::{Context, Request, TranslationError},
};
use fliks_engine_core::api::{
    JobKind, JobPriority, JobRequest, JobResult, MediaInfo, MediaRef, SrtSource,
};
use serde_json::Value;
use std::sync::Mutex;
use tokio::sync::Notify;

/// At most `subtitle_translation_max_concurrency` runs inside `translate`; the rest wait.
#[derive(Default)]
pub struct Gate {
    active: Mutex<usize>,
    freed: Notify,
}

/// A running slot of the gate, freed on drop.
pub struct Permit<'a>(&'a Gate);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut a = self.0.active.lock_clean();
        *a = a.saturating_sub(1);
        drop(a);
        self.0.freed.notify_one();
    }
}

impl Gate {
    async fn acquire(&self, limit: usize) -> Permit<'_> {
        loop {
            let waiting = self.freed.notified();
            tokio::pin!(waiting);
            // Registered before the check, so a release in between is not lost.
            waiting.as_mut().enable();
            {
                let mut a = self.active.lock_clean();
                if *a < limit {
                    *a += 1;
                    return Permit(self);
                }
            }
            waiting.await;
        }
    }
}

fn translation_error_message(e: &TranslationError) -> String {
    match e {
        TranslationError::RateLimit { scope, .. } if scope.as_str() == "daily" => {
            "errors.translation_rate_limited_daily".into()
        }
        TranslationError::RateLimit { .. } => "errors.translation_rate_limited".into(),
        TranslationError::TooLarge(_) => "errors.translation_too_large".into(),
        TranslationError::Other(m) => format!("Error: {m}").chars().take(2000).collect(),
    }
}

/// `translateSubtitle`: validations in the spec's order, then the placeholder and the detached run.
pub async fn start(
    st: &AppState,
    subtitle_id: i32,
    target_language: Option<&str>,
    provider_id: Option<i32>,
    remove_hi_tags: bool,
) -> Result<Value, AppError> {
    if !flag_on(st, "subtitle_translation_enabled").await? {
        return Err(AppError::bad_request("errors.translation_disabled"));
    }
    let provider = match provider_id {
        Some(id) => {
            let p = providers::find(st, id).await?;
            if !p.enabled {
                return Err(AppError::conflict("errors.translation_provider_disabled"));
            }
            p
        }
        None => providers::find_default(st)
            .await?
            .ok_or_else(|| AppError::bad_request("errors.no_translation_provider"))?,
    };
    engines::validate_config(&provider.engine, &provider.settings)?;
    let source = model::by_id(&st.db, subtitle_id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Subtitle #{subtitle_id} not found")))?;
    if source
        .codec
        .as_deref()
        .is_some_and(|c| IMAGE_BASED_CODECS.contains(&c))
    {
        return Err(AppError::bad_request("errors.subtitle_needs_ocr"));
    }
    if source.file_path.as_deref().is_none_or(str::is_empty) && source.stream_index.is_none() {
        return Err(AppError::bad_request("errors.subtitle_no_readable_text"));
    }
    let target = normalize_language_code(target_language);
    if target == "und" {
        return Err(AppError::bad_request("errors.target_language_required"));
    }
    if target == source.language {
        return Err(AppError::bad_request("errors.source_target_language_same"));
    }
    let remove_hi = remove_hi_tags || flag_on(st, "subtitle_remove_hi_tags").await?;
    let hi = source.hearing_impaired && !remove_hi;
    let key = format!(
        "{}:{}:{target}:{}:{hi}",
        source.media_file_id.unwrap_or(0),
        source.episode_id.map(|e| e.to_string()).unwrap_or_default(),
        source.forced
    );
    let Some(_starting) = st.subtitles.starting.claim(key) else {
        return Err(AppError::conflict("errors.already_running"));
    };
    let running: Option<i32> = sqlx::query_scalar(
        r#"SELECT id FROM subtitle_files WHERE "mediaFileId" IS NOT DISTINCT FROM $1 AND "episodeId" IS NOT DISTINCT FROM $2
           AND language = $3 AND forced = $4 AND "hearingImpaired" = $5 AND "providerType" = 'translated' AND status = 'processing' LIMIT 1"#,
    )
    .bind(source.media_file_id)
    .bind(source.episode_id)
    .bind(&target)
    .bind(source.forced)
    .bind(hi)
    .fetch_optional(&st.db)
    .await?;
    if running.is_some() {
        return Err(AppError::conflict("errors.already_running"));
    }
    let (Some(media_id), Some(file_id)) = (source.media_id, source.media_file_id) else {
        return Err(AppError::not_found(format!(
            "Subtitle #{subtitle_id} not found"
        )));
    };
    let model_name = engines::resolve_model(&provider.engine, &provider.settings);
    let new = New {
        media_id,
        media_file_id: file_id,
        episode_id: source.episode_id,
        language: target.clone(),
        forced: source.forced,
        hearing_impaired: hi,
        provider_type: "translated".into(),
        status: "processing".into(),
        codec: Some("subrip".into()),
        score: source.score,
        translation_provider_id: Some(provider.id),
        translation_provider_name: Some(provider.name.clone()),
        translation_engine: Some(provider.engine.clone()),
        translation_model: model_name,
        ..New::default()
    };
    let inserted = model::insert(&st.db, &new).await?;
    tracing::info!(
        "Translate start: sub #{subtitle_id} [{} -> {target}] via {} ({})",
        source.language,
        provider.name,
        provider.engine
    );
    let max = crate::settings::setting_value(&st.db, "subtitle_translation_max_concurrency")
        .await?
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n >= 1.0)
        .map_or(1, |n| n.floor() as usize);
    let (st2, id) = (st.clone(), inserted.id);
    let json = new.saved_json(&inserted);
    tokio::spawn(async move { run(&st2, id, &source, &target, &provider, max, remove_hi).await });
    Ok(json)
}

async fn run(
    st: &AppState,
    placeholder: i32,
    source: &Row,
    target: &str,
    provider: &providers::Row,
    max: usize,
    remove_hi: bool,
) {
    let media_id = source.media_id.unwrap_or(0);
    let media = files::load_media(&st.db, media_id).await.ok().flatten();
    let outcome = try_run(
        st,
        placeholder,
        source,
        target,
        provider,
        max,
        media.as_ref(),
        remove_hi,
    )
    .await;
    st.subtitles.set_translation_progress(placeholder, None);
    match outcome {
        Ok(title) => {
            events::emit(
                st,
                media_id,
                SseEvent::SubtitleDownloaded {
                    media_id: media_id.into(),
                    title,
                    language: target.to_owned(),
                    provider: provider.name.clone(),
                    subtitle_id: Some(placeholder.into()),
                    reason: Some("translation".into()),
                    automatic: None,
                },
            )
            .await;
        }
        Err(e) => {
            tracing::warn!("Translate end (failed) - sub #{placeholder} [{target}]: {e}");
            let (reason, scope) = match &e {
                TranslationError::RateLimit { scope, .. } => {
                    ("rate_limit", Some(scope.as_str().to_owned()))
                }
                _ => ("translation", None),
            };
            events::emit(
                st,
                media_id,
                SseEvent::SubtitleFailed {
                    media_id: media_id.into(),
                    title: media.map(|m| m.title).unwrap_or_default(),
                    language: target.to_owned(),
                    error: format!("Error: {e}"),
                    reason: Some(reason.into()),
                    scope,
                    automatic: None,
                },
            )
            .await;
            if let Err(e) = sqlx::query(
                r#"UPDATE subtitle_files SET status = 'failed', "errorMessage" = $2 WHERE id = $1"#,
            )
            .bind(placeholder)
            .bind(translation_error_message(&e))
            .execute(&st.db)
            .await
            {
                tracing::warn!("translation failure of subtitle #{placeholder} not stored: {e}");
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn try_run(
    st: &AppState,
    placeholder: i32,
    source: &Row,
    target: &str,
    provider: &providers::Row,
    max: usize,
    media: Option<&MediaCtx>,
    remove_hi: bool,
) -> Result<String, TranslationError> {
    let other = |e: &dyn std::fmt::Display| TranslationError::Other(e.to_string());
    let media = media.ok_or_else(|| other(&"media root folder not set"))?;
    let dirs = media
        .dirs("no root")
        .map_err(|_| other(&"media root folder not set"))?;
    let file = files::file_by_id(&st.db, source.media_file_id.unwrap_or(0))
        .await
        .map_err(|e| other(&e))?
        .ok_or_else(|| other(&"media file is gone"))?;
    let video = dirs.m.join(
        crate::ingest::fsx::safe_rel(&file.relative_path)
            .ok_or_else(|| other(&"media file path is invalid"))?,
    );
    let srt_in = load_source_srt(st, &dirs, source, &file, &video).await?;
    let cues = parse_srt(&srt_in);
    if cues.is_empty() {
        return Err(other(&"source subtitle has no text"));
    }
    let req = Request {
        source_language: source.language.clone(),
        target_language: target.to_owned(),
        register: None,
        context: Context {
            title: Some(media.title.clone()),
            year: media.year.map(i64::from),
            media_type: Some(media.kind),
            genres: media
                .genres
                .as_ref()
                .and_then(|g| g.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            overview: media.overview.clone(),
        },
    };
    // The viewers of the media only, resolved once; events go out in order.
    let viewers = events::viewers_for_media(st, source.media_id.unwrap_or(0)).await;
    let on = |done: usize, total: usize| {
        let pct = if total > 0 {
            (done as f64 / total as f64 * 100.0).round() as i32
        } else {
            0
        };
        st.subtitles
            .set_translation_progress(placeholder, Some(pct));
        st.hub.emit_to_users(
            &viewers,
            SseEvent::SubtitleTranslationProgress {
                subtitle_id: placeholder.into(),
                media_id: source.media_id.unwrap_or(0).into(),
                progress: i64::from(pct).into(),
            },
        );
    };
    let texts: Vec<String> = cues.iter().map(|c| c.text.clone()).collect();
    on(0, texts.len());
    let permit = st.subtitles.gate.acquire(max).await;
    let mut progress = |d, t| on(d, t);
    let translated = engines::translate(
        &st.subtitles,
        &provider.engine,
        &texts,
        req,
        &provider.settings,
        &mut progress,
    )
    .await;
    drop(permit);
    let translated = translated?;
    let out: Vec<Cue> = cues
        .iter()
        .enumerate()
        .map(|(i, c)| Cue {
            timing: c.timing.clone(),
            text: translated
                .get(i)
                .filter(|t| !t.is_empty())
                .cloned()
                .unwrap_or_else(|| c.text.clone()),
        })
        .collect();
    let mut opts = clean_options(st, true)
        .await
        .map_err(|e| other(&e.text()))?;
    opts.remove_hi_tags |= remove_hi;
    let cleaned = clean_subtitle(&serialize_srt(&out), &opts);
    let hi = source.hearing_impaired && !opts.remove_hi_tags;
    let suffix = sidecar_lang_suffix(target, source.forced, hi);
    let rel = dirs
        .write_sidecar(&file.relative_path, &suffix, ".srt", cleaned.as_bytes())
        .map_err(|e| other(&e.text()))?;
    // One statement; no row back means the placeholder was deleted, so the file goes too.
    let attached: Option<i32> = sqlx::query_scalar(
        r#"UPDATE subtitle_files SET "filePath" = $2, "hearingImpaired" = $3, status = 'downloaded' WHERE id = $1 RETURNING id"#,
    )
    .bind(placeholder)
    .bind(&rel)
    .bind(hi)
    .fetch_optional(&st.db)
    .await
    .map_err(|e| other(&e))?;
    if attached.is_none() {
        let _ = dirs.unlink(&rel);
        return Err(other(&"the subtitle was removed during the run"));
    }
    tracing::info!("Translate end (ok) - sub #{placeholder} [{target}] -> {rel}");
    Ok(media.title.clone())
}

async fn load_source_srt(
    st: &AppState,
    dirs: &files::Dirs,
    source: &Row,
    file: &files::FileRow,
    video: &std::path::Path,
) -> Result<String, TranslationError> {
    let other = |m: String| TranslationError::Other(m);
    let info: Option<MediaInfo> = file
        .stream_info
        .clone()
        .and_then(|v| serde_json::from_value(v).ok());
    let media = MediaRef {
        media_file_id: u32::try_from(file.id).unwrap_or(0),
        path: video.to_string_lossy().into_owned(),
    };
    let job = |kind: JobKind| JobRequest {
        kind,
        media: media.clone(),
        priority: Some(JobPriority::High),
        force: false,
    };
    let srt_of = |r: JobResult| match r {
        JobResult::SubtitleToSrt { srt } => Ok(srt),
        _ => Err(other("engine job answered another kind".into())),
    };
    if let Some(stored) = source.file_path.as_deref().filter(|p| !p.is_empty()) {
        let abs = dirs
            .resolve_file(stored)
            .map_err(|_| other("source subtitle path is invalid".into()))?;
        if source.codec.as_deref() == Some("subrip") || stored.to_lowercase().ends_with(".srt") {
            let bytes = tokio::fs::read(&abs)
                .await
                .map_err(|e| other(e.to_string()))?;
            return Ok(decode_text(&bytes));
        }
        let info = info.unwrap_or_else(empty_info);
        let r = st
            .engine
            .run_job(
                &job(JobKind::SubtitleToSrt {
                    info,
                    source: SrtSource::File {
                        path: abs.to_string_lossy().into_owned(),
                    },
                }),
                None,
            )
            .await
            .map_err(|e| other(e.to_string()))?;
        return srt_of(r);
    }
    let info =
        info.ok_or_else(|| other("No probe data for this file; rescan the media first".into()))?;
    let index = source
        .stream_index
        .ok_or_else(|| other("embedded subtitle has no stream index".into()))?;
    let r = st
        .engine
        .run_job(
            &job(JobKind::SubtitleToSrt {
                info,
                source: SrtSource::Stream {
                    index: u32::try_from(index).unwrap_or(0),
                },
            }),
            None,
        )
        .await
        .map_err(|e| other(e.to_string()))?;
    srt_of(r)
}

fn empty_info() -> MediaInfo {
    serde_json::from_value(serde_json::json!({"video": [], "audio": [], "subtitles": []}))
        .expect("empty probe info")
}
