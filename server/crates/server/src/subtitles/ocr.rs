//! OCR of an embedded image track through the engine (`subtitle-files.md` rules 24, 26-27).
use super::{
    events,
    files::{self, FileRow, MediaCtx},
    model::{self, New, Row},
    service::clean_options,
};
use crate::{events::SseEvent, http::AppError, state::AppState};
use fliks_domain::{
    language::normalize_language_code,
    subtitle_clean::clean_subtitle,
    subtitle_flags::{IMAGE_BASED_CODECS, is_ocr_supported_codec},
    subtitle_path::sidecar_lang_suffix,
};
use fliks_engine_core::api::{JobKind, JobPriority, JobRequest, JobResult, MediaInfo, MediaRef};

/// Starts an OCR run: the PROCESSING placeholder is returned (and listed), the run goes on detached.
pub async fn start(
    st: &AppState,
    subtitle_id: i32,
    language: Option<&str>,
    automatic: bool,
) -> Result<serde_json::Value, AppError> {
    let source = model::by_id(&st.db, subtitle_id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Subtitle #{subtitle_id} not found")))?;
    let codec = source.codec.as_deref();
    if !codec.is_some_and(|c| IMAGE_BASED_CODECS.contains(&c)) {
        return Err(AppError::bad_request("Subtitle is not image-based"));
    }
    if !is_ocr_supported_codec(codec) {
        return Err(AppError::bad_request(format!(
            "OCR is not available for \"{}\" subtitles",
            codec.unwrap_or_default()
        )));
    }
    let Some(stream) = source.stream_index else {
        return Err(AppError::bad_request(
            "OCR is only supported for embedded image subtitles",
        ));
    };
    let (Some(media_id), Some(file_id)) = (source.media_id, source.media_file_id) else {
        return Err(AppError::not_found(format!(
            "Subtitle #{subtitle_id} not found"
        )));
    };
    let language = match language.filter(|l| !l.trim().is_empty()) {
        Some(l) => normalize_language_code(Some(l)),
        None => source.language.clone(),
    };
    let new = New {
        media_id,
        media_file_id: file_id,
        episode_id: source.episode_id,
        language: language.clone(),
        forced: source.forced,
        hearing_impaired: source.hearing_impaired,
        provider_type: "ocr".into(),
        status: "processing".into(),
        codec: Some("subrip".into()),
        score: 100,
        source_stream_index: Some(stream),
        ..New::default()
    };
    // One run per source track, decided under an advisory lock so two requests cannot both pass.
    let mut tx = st.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("ocr:{file_id}:{stream}"))
        .execute(&mut *tx)
        .await?;
    let busy: Option<i32> = sqlx::query_scalar(
        r#"SELECT id FROM subtitle_files WHERE "mediaFileId" = $1 AND "providerType" = 'ocr'
           AND status = 'processing' AND "sourceStreamIndex" = $2 LIMIT 1"#,
    )
    .bind(file_id)
    .bind(stream)
    .fetch_optional(&mut *tx)
    .await?;
    if busy.is_some() {
        return Err(AppError::conflict("errors.already_running"));
    }
    let inserted = model::insert(&mut *tx, &new).await?;
    tx.commit().await?;
    events::list_changed(st, media_id).await;
    let (st2, placeholder) = (st.clone(), inserted.id);
    let mut src = source;
    src.language = language;
    tokio::spawn(async move { run(&st2, placeholder, &src, automatic).await });
    Ok(new.saved_json(&inserted))
}

async fn run(st: &AppState, placeholder: i32, source: &Row, automatic: bool) {
    let media = files::load_media_of(&st.db, source.media_id.unwrap_or(0), source.media_file_id)
        .await
        .ok()
        .flatten();
    let media_id = source.media_id.unwrap_or(0);
    let auto = automatic.then_some(true);
    match try_run(st, placeholder, source, media.as_ref(), automatic).await {
        Ok(title) => {
            events::emit(
                st,
                media_id,
                SseEvent::SubtitleDownloaded {
                    media_id: media_id.into(),
                    title,
                    language: source.language.clone(),
                    provider: "ocr".into(),
                    subtitle_id: None,
                    reason: None,
                    automatic: auto,
                },
            )
            .await;
        }
        Err(err) => {
            tracing::warn!("OCR end (failed) - sub #{placeholder}: {err}");
            // `String(err)` carries the `Error: ` prefix.
            let text = format!("Error: {err}");
            events::emit(
                st,
                media_id,
                SseEvent::SubtitleFailed {
                    media_id: media_id.into(),
                    title: media.map(|m| m.title).unwrap_or_default(),
                    language: source.language.clone(),
                    error: text.clone(),
                    reason: None,
                    scope: None,
                    automatic: auto,
                },
            )
            .await;
            let msg: String = text.chars().take(2000).collect();
            if let Err(e) = sqlx::query(
                r#"UPDATE subtitle_files SET status = 'failed', "errorMessage" = $2 WHERE id = $1"#,
            )
            .bind(placeholder)
            .bind(msg)
            .execute(&st.db)
            .await
            {
                tracing::warn!("OCR failure of subtitle #{placeholder} not stored: {e}");
            }
        }
    }
}

async fn try_run(
    st: &AppState,
    placeholder: i32,
    source: &Row,
    media: Option<&MediaCtx>,
    automatic: bool,
) -> Result<String, String> {
    let sql = |e: sqlx::Error| e.to_string();
    let media = media.ok_or("media root folder not set")?;
    let dirs = media
        .dirs("no root")
        .map_err(|_| "media root folder not set".to_owned())?;
    let file: FileRow = files::file_by_id(&st.db, source.media_file_id.unwrap_or(0))
        .await
        .map_err(sql)?
        .ok_or("media file is gone")?;
    let video = dirs.l.join(
        crate::ingest::fsx::safe_rel(&file.relative_path).ok_or("media file path is invalid")?,
    );
    let info: MediaInfo = file
        .stream_info
        .clone()
        .and_then(|v| serde_json::from_value(v).ok())
        .ok_or("No probe data for this file; rescan the media first")?;
    if !st
        .engine
        .engine_features()
        .iter()
        .any(|f| f == "subtitle-ocr")
    {
        return Err("The engine has no subtitle-ocr feature".into());
    }
    let lang = (source.language.len() == 2
        && source.language.bytes().all(|b| b.is_ascii_alphabetic()))
    .then(|| source.language.to_lowercase());
    let req = JobRequest {
        kind: JobKind::SubtitleOcr {
            info,
            stream_index: u32::try_from(source.stream_index.unwrap_or(0)).unwrap_or(0),
            language: lang,
        },
        media: MediaRef {
            media_file_id: u32::try_from(file.id).unwrap_or(0),
            path: video.to_string_lossy().into_owned(),
        },
        priority: Some(if automatic {
            JobPriority::Low
        } else {
            JobPriority::High
        }),
        force: false,
    };
    let srt = match st
        .engine
        .run_job(&req, None)
        .await
        .map_err(|e| e.to_string())?
    {
        JobResult::SubtitleOcr { srt } => srt,
        _ => return Err("engine job answered another kind".into()),
    };
    let opts = clean_options(st, true).await.map_err(|e| e.text())?;
    let cleaned = clean_subtitle(&srt, &opts);
    let hi = source.hearing_impaired && !opts.remove_hi_tags;
    let suffix = sidecar_lang_suffix(&source.language, source.forced, hi);
    let rel = dirs
        .write_sidecar_ocr(&file.relative_path, &suffix, cleaned.as_bytes())
        .map_err(|e| e.text())?;
    // One statement; no row back means the placeholder was deleted, so the file goes too.
    let attached: Option<i32> = sqlx::query_scalar(
        r#"UPDATE subtitle_files SET "filePath" = $2, "hearingImpaired" = $3, status = 'downloaded' WHERE id = $1 RETURNING id"#,
    )
    .bind(placeholder)
    .bind(&rel)
    .bind(hi)
    .fetch_optional(&st.db)
    .await
    .map_err(sql)?;
    if attached.is_none() {
        let _ = dirs.unlink(&rel);
        return Err("the subtitle was removed during the run".into());
    }
    tracing::info!("OCR end (ok) - sub #{placeholder} -> {rel}");
    if super::service::flag_on(st, "subtitle_ocr_delete_source")
        .await
        .map_err(|e| e.text())?
    {
        if let Err(e) = sqlx::query("DELETE FROM subtitle_files WHERE id = $1")
            .bind(source.id)
            .execute(&st.db)
            .await
        {
            tracing::warn!("OCR source subtitle #{} not removed: {e}", source.id);
        }
        tracing::info!(
            "OCR: removed source image subtitle #{} after extraction",
            source.id
        );
    }
    Ok(media.title.clone())
}
