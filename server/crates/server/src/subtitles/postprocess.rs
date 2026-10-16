//! `POST .../post-process` (`subtitle-files.md` rules 15-17, 21, 34-35).
use super::{files, model};
use crate::{http::AppError, state::AppState};
use fliks_domain::{
    srt::decode_text, subtitle_name::strip_hi_from_filename, subtitle_post as post,
};
use serde_json::Value;

const ACTIONS: [&str; 10] = [
    "removeHiTags",
    "removeStyleTags",
    "removeEmoji",
    "ocrFixes",
    "commonFixes",
    "fixUppercase",
    "reverseRtl",
    "adjustTimes",
    "changeFrameRate",
    "convertToSrt",
];

/// `Number(params?.x ?? default)`, finite or 400 (C62).
fn number(params: &Value, key: &str, default: f64) -> Result<f64, AppError> {
    let bad = || AppError::bad_request(format!("{key} must be a finite number"));
    match params.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()).ok_or_else(bad),
        Some(Value::String(s)) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite())
            .ok_or_else(bad),
        _ => Err(bad()),
    }
}

pub async fn apply(
    st: &AppState,
    id: i32,
    action: &str,
    params: &Value,
) -> Result<Value, AppError> {
    let mut row = model::by_id(&st.db, id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("SubtitleFile #{id} not found")))?;
    let stored = row
        .file_path
        .clone()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| AppError::bad_request("Subtitle has no file path"))?;
    let media = files::load_media(&st.db, row.media_id.unwrap_or(0)).await?;
    let dirs = media
        .and_then(|m| m.dirs("no root").ok())
        .ok_or_else(|| AppError::not_found("Subtitle file path could not be resolved"))?;
    let abs = dirs.resolve_file(&stored)?;
    if !ACTIONS.contains(&action) {
        return Err(AppError::bad_request(format!(
            "Unknown post-processing action: {action}"
        )));
    }
    let offset = if action == "adjustTimes" {
        number(params, "offsetMs", 0.0)?
    } else {
        0.0
    };
    let (from, to) = if action == "changeFrameRate" {
        let (f, t) = (
            number(params, "fromFps", 23.976)?,
            number(params, "toFps", 25.0)?,
        );
        if f <= 0.0 || t <= 0.0 {
            return Err(AppError::bad_request(
                "fromFps and toFps must be greater than 0",
            ));
        }
        (f, t)
    } else {
        (0.0, 0.0)
    };
    let ext = fliks_domain::subtitle_name::ext(&stored);
    if ext == ".sup" || ext == ".sub" {
        return Err(AppError::bad_request(format!(
            "Cannot post-process a {ext} subtitle"
        )));
    }
    let raw = std::fs::read(&abs).map_err(|e| {
        tracing::error!(error = %e, "post-process read");
        AppError::plain(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        )
    })?;
    let content = decode_text(&raw);
    let (out, converted) = match action {
        "removeHiTags" => (post::remove_hi_tags(&content), false),
        "removeStyleTags" => (post::remove_style_tags(&content), false),
        "removeEmoji" => (post::remove_emoji(&content), false),
        "ocrFixes" => (post::fix_ocr(&content), false),
        "commonFixes" => (post::common_fixes(&content, Some(&row.language)), false),
        "fixUppercase" => (post::fix_uppercase(&content), false),
        "reverseRtl" => (post::reverse_rtl(&content), false),
        "adjustTimes" => (post::adjust_times(&content, offset), false),
        "changeFrameRate" => (post::change_frame_rate(&content, from, to), false),
        _ => {
            let c = post::ass_to_srt(&content);
            let changed = c != content;
            (c, changed)
        }
    };
    let name = abs
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_owned();
    let stem = name
        .rfind('.')
        .filter(|i| *i > 0)
        .map_or(name.as_str(), |i| &name[..i])
        .to_owned();
    if converted
        && name != format!("{stem}.srt")
        && stem_target_exists(&abs, &format!("{stem}.srt"))
    {
        return Err(AppError::conflict("Target subtitle already exists"));
    }
    dirs.rewrite(&stored, out.as_bytes())?;
    if action == "removeHiTags" && row.hearing_impaired {
        match strip_hi_from_filename(&name) {
            None => row.hearing_impaired = false,
            Some(n) => {
                if let Some(rel) = dirs.rename(&stored, &n) {
                    row.file_path = Some(rel);
                    row.hearing_impaired = false;
                }
            }
        }
    }
    if converted
        && let Some(rel) = dirs.rename(
            row.file_path.as_deref().unwrap_or(&stored),
            &format!("{stem}.srt"),
        )
    {
        row.file_path = Some(rel);
        row.codec = Some("subrip".into());
    }
    sqlx::query(r#"UPDATE subtitle_files SET "filePath" = $2, "hearingImpaired" = $3, codec = $4, locked = true WHERE id = $1"#)
        .bind(id)
        .bind(&row.file_path)
        .bind(row.hearing_impaired)
        .bind(&row.codec)
        .execute(&st.db)
        .await?;
    Ok(model::by_id(&st.db, id)
        .await?
        .map_or(Value::Null, |r| r.json()))
}

fn stem_target_exists(abs: &std::path::Path, name: &str) -> bool {
    abs.parent()
        .is_some_and(|d| std::fs::symlink_metadata(d.join(name)).is_ok())
}
