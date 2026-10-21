//! `GET /api/media/:id/streams/:mediaFileId` (`media-query.md` rules 59-61).
use crate::{http::AppError, state::AppState};
use fliks_domain::media::path::{join, media_path, resolve};
use serde_json::{Value, json};

fn file_not_found(file: i32) -> AppError {
    AppError::not_found(format!("MediaFile #{file} not found"))
}

pub async fn streams(st: &AppState, media: i32, file: i32) -> Result<Vec<Value>, AppError> {
    let Some(row) = sqlx::query!(
        r#"SELECT f."relativePath" AS relative_path, l.path AS lib_path, m."folderName" AS folder_name
           FROM media m LEFT JOIN libraries l ON l.id = m."libraryId"
           JOIN media_files f ON f."mediaId" = m.id AND f.id = $2 WHERE m.id = $1"#,
        media,
        file
    )
    .fetch_optional(&st.db)
    .await?
    else {
        return Err(file_not_found(file));
    };
    // A library without path cannot place the file: 404.
    let Some(base) = media_path(row.lib_path.as_deref(), row.folder_name.as_deref()) else {
        return Err(file_not_found(file));
    };
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".into());
    let path = resolve(&join(&base, &row.relative_path), &cwd);
    let info = match st.engine.probe(&path, false, false, false).await {
        Ok(p) if p.ok => p.info,
        Ok(_) | Err(_) => None,
    };
    let Some(info) = info else { return Ok(vec![]) };
    let mut all: Vec<(u32, Value)> = vec![];
    for a in &info.audio {
        all.push((
            a.stream_index,
            stream(
                a.stream_index,
                "audio",
                &a.codec,
                &a.language,
                a.title.as_deref(),
            ),
        ));
    }
    for s in &info.subtitles {
        all.push((
            s.stream_index,
            stream(
                s.stream_index,
                "subtitle",
                &s.codec,
                &s.language,
                s.title.as_deref(),
            ),
        ));
    }
    all.sort_by_key(|(i, _)| *i);
    Ok(all.into_iter().map(|(_, v)| v).collect())
}

fn stream(index: u32, kind: &str, codec: &str, language: &str, title: Option<&str>) -> Value {
    let mut v = json!({"streamIndex": index, "type": kind, "codec": codec, "language": language});
    if let Some(t) = title {
        v["title"] = t.into();
    }
    v
}
