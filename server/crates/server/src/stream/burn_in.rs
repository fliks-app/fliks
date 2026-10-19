//! Subtitle burn-in resolution and the text renditions of the master (spec rules 42-45); the filter
//! strings come from `fliks_domain::burn_in`.
use super::file::ResolvedFile;
use crate::{engine::resolve::lexical_resolve, http::AppError, state::AppState};
use fliks_domain::burn_in::{
    BurnInInfo, BurnInType, EmbeddedSubtitle, ExternalSubtitle, RenditionKind, build_filter,
    is_image_based_codec, text_subtitle_renditions,
};
use fliks_engine_core::api::{BurnInKind, BurnInSpec, SubtitleTrack, SubtitleTrackKind};

/// What a request burns in; `stream_index` is the image track the engine overlays.
pub struct Resolved {
    pub spec: BurnInSpec,
    pub is_text: bool,
}

fn not_found(msg: &str) -> AppError {
    AppError::not_found(msg.to_owned())
}

/// `resolve` then `buildFilter`; the caller treats any error as "no burn-in".
pub async fn resolve(
    st: &AppState,
    subtitle_id: i32,
    file: &ResolvedFile,
) -> Result<Resolved, AppError> {
    let sub = sqlx::query!(
        r#"SELECT "mediaFileId" AS media_file_id, "filePath" AS file_path, "streamIndex" AS stream_index,
                  codec
           FROM subtitle_files WHERE id = $1"#,
        subtitle_id
    )
    .fetch_optional(&st.db)
    .await?
    .filter(|s| s.media_file_id == Some(file.id))
    .ok_or_else(|| AppError::not_found(format!("Subtitle #{subtitle_id} not found")))?;
    let image = is_image_based_codec(sub.codec.as_deref());
    let video_path = file.absolute.to_string_lossy().into_owned();
    let info = file.info.as_ref();
    let cue_offset = info.and_then(|i| {
        i.format_start_seconds
            .or_else(|| i.video.first().and_then(|v| v.start_time_seconds))
    });
    let kind = if image {
        BurnInType::Image
    } else {
        BurnInType::Text
    };
    let mut stream_index = None;
    let (subtitle_path, ordinal, cue) = if let Some(stored) =
        sub.file_path.as_deref().filter(|p| !p.is_empty())
    {
        let trimmed = stored.trim();
        let absolute = lexical_resolve(&file.root, trimmed);
        let missing = || not_found("Subtitle file not found on disk");
        if trimmed.is_empty() || !absolute.starts_with(&file.root) {
            return Err(missing());
        }
        let real = dunce::canonicalize(&absolute).map_err(|_| missing())?;
        (
            Some(real.to_string_lossy().into_owned()),
            None,
            Some(cue_offset.unwrap_or(0.0)),
        )
    } else if let Some(idx) = sub.stream_index {
        stream_index = u32::try_from(idx).ok();
        if image {
            (None, None, None)
        } else {
            let ordinal = info
                .and_then(|i| {
                    i.subtitles
                        .iter()
                        .position(|s| i64::from(s.stream_index) == i64::from(idx))
                })
                .ok_or_else(|| not_found("Embedded subtitle not found in the probed streams"))?;
            (None, Some(ordinal as u32), None)
        }
    } else {
        return Err(not_found("Subtitle has no file path or stream index"));
    };
    let domain = BurnInInfo {
        kind,
        video_path,
        subtitle_path,
        subtitle_ordinal: ordinal,
        cue_offset_seconds: cue,
    };
    let filter = build_filter(&domain);
    Ok(Resolved {
        is_text: filter.is_some(),
        spec: BurnInSpec {
            kind: if image {
                BurnInKind::Image
            } else {
                BurnInKind::Text
            },
            filter,
            stream_index,
        },
    })
}

/// Text tracks of the HLS master (rule 45): embedded streams then the renderable sidecars.
pub async fn renditions(st: &AppState, file: &ResolvedFile) -> Vec<SubtitleTrack> {
    let embedded: Vec<EmbeddedSubtitle> = file.info.as_ref().map_or_else(Vec::new, |i| {
        i.subtitles
            .iter()
            .map(|s| EmbeddedSubtitle {
                stream_index: i64::from(s.stream_index),
                language: Some(s.language.clone()),
                language_tag: Some(s.language_tag.clone()),
                title: s.title.clone(),
                is_image_based: Some(s.is_image_based),
                forced: Some(s.forced),
            })
            .collect()
    });
    let external = sqlx::query!(
        r#"SELECT id, "filePath" AS file_path, codec, language, forced
           FROM subtitle_files WHERE "mediaFileId" = $1 ORDER BY id ASC"#,
        file.id
    )
    .fetch_all(&st.db)
    .await
    .map_err(|e| tracing::warn!("renditions: external query failed for #{}: {e}", file.id))
    .map(|rows| {
        rows.into_iter()
            .map(|r| ExternalSubtitle {
                id: i64::from(r.id),
                relative_path: r.file_path,
                codec: r.codec,
                language: Some(r.language),
                forced: Some(r.forced),
            })
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();
    text_subtitle_renditions(&embedded, &external)
        .into_iter()
        .filter_map(|r| {
            Some(SubtitleTrack {
                kind: match r.kind {
                    RenditionKind::Embedded => SubtitleTrackKind::Embedded,
                    RenditionKind::External => SubtitleTrackKind::External,
                },
                key: u32::try_from(r.key).ok()?,
                language: Some(r.language),
                language_tag: r.language_tag.flatten(),
                name: r.name,
                forced: r.forced.unwrap_or(false),
            })
        })
        .collect()
}
