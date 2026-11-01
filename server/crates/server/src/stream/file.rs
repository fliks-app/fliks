//! `StreamingService.resolveFile` (spec rules 38-39): a media file row, the library ACL and the path rules.
use crate::{
    engine::resolve::{lexical_resolve, media_root},
    http::{AppError, auth::Authed},
    state::AppState,
};
use fliks_domain::{
    acl::{Action, Subject},
    media::kind::MediaKind,
};
use fliks_engine_core::api::MediaInfo;
use std::path::PathBuf;

pub struct ResolvedFile {
    pub id: i32,
    pub absolute: PathBuf,
    pub size: u64,
    /// Lower-cased with the dot (`.mkv`).
    pub ext: String,
    pub content_type: &'static str,
    pub info: Option<MediaInfo>,
    pub media_id: Option<i32>,
    pub episode_id: Option<i32>,
    /// The first item the file plays; `None` for a file no item plays.
    pub item_id: Option<i32>,
    pub media_title: Option<String>,
    pub media_type: Option<MediaKind>,
    pub poster_url: Option<String>,
    pub fanart_url: Option<String>,
    /// The media's root folder, the base of its sidecars.
    pub root: PathBuf,
}

/// `path.extname`, lower-cased: from the last dot of the basename, none for a leading dot.
pub fn extname(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    match base.rfind('.') {
        Some(i) if i > 0 && base != ".." => base[i..].to_lowercase(),
        _ => String::new(),
    }
}

fn content_type(ext: &str) -> &'static str {
    match ext {
        ".mp4" | ".m4v" => "video/mp4",
        ".webm" => "video/webm",
        ".mkv" => "video/x-matroska",
        ".avi" => "video/x-msvideo",
        ".mov" => "video/quicktime",
        ".ts" | ".m2ts" | ".mts" => "video/mp2t",
        ".mpg" | ".mpeg" => "video/mpeg",
        ".ogm" => "video/ogg",
        _ => "application/octet-stream",
    }
}

/// The ACL is skipped for internal callers (`user` absent); a denial reads like a missing file.
pub async fn resolve_file(
    st: &AppState,
    user: Option<&Authed>,
    id: i64,
) -> Result<ResolvedFile, AppError> {
    let missing = || AppError::not_found(format!("MediaFile #{id} not found"));
    let row = match i32::try_from(id) {
        Ok(id) => sqlx::query!(
            r#"SELECT mf."relativePath" AS "relative_path!", mf."streamInfo" AS stream_info,
                      mf."mediaId" AS media_id,
                      (SELECT fi."episodeId" FROM media_file_items fi WHERE fi."mediaFileId" = mf.id) AS episode_id,
                      (SELECT fi."itemId" FROM media_file_items fi WHERE fi."mediaFileId" = mf.id) AS item_id,
                      m.title AS "title?", m."type" AS media_type,
                      m."posterUrl" AS poster_url, m."fanartUrl" AS fanart_url,
                      m."libraryId" AS library_id, m."folderName" AS folder, l."path" AS library_path
               FROM media_files mf
               LEFT JOIN media m ON m.id = mf."mediaId"
               LEFT JOIN libraries l ON l.id = m."libraryId"
               WHERE mf.id = $1"#,
            id
        )
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(missing)?,
        Err(_) => return Err(missing()),
    };
    if let Some(a) = user {
        let allowed = match row.library_id {
            None => false,
            Some(_) if a.perms.can(Action::Manage, &Subject::All) => true,
            Some(lib) => {
                sqlx::query_scalar!(
                    r#"SELECT EXISTS (SELECT 1 FROM library_user_access WHERE "userId" = $1 AND "libraryId" = $2) AS "ok!""#,
                    a.user.id,
                    lib
                )
                .fetch_one(&st.db)
                .await?
            }
        };
        if !allowed {
            return Err(missing());
        }
    }
    let root = media_root(row.library_path, row.folder).ok_or_else(|| {
        let title = row.title.clone().unwrap_or_else(|| {
            row.media_id.map_or_else(String::new, |m| m.to_string())
        });
        AppError::not_found(format!(
            "Media \"{title}\" has no root folder assigned. Go to the media detail page and set a root folder."
        ))
    })?;
    let absolute = lexical_resolve(&root, &row.relative_path);
    let invalid = || AppError::not_found("Invalid file path");
    if !absolute.starts_with(&root) {
        return Err(invalid());
    }
    let meta = tokio::fs::metadata(&absolute).await.map_err(|_| {
        AppError::not_found(format!("File not found on disk: {}", absolute.display()))
    })?;
    let real = dunce::canonicalize(&absolute).map_err(|_| invalid())?;
    if !real.starts_with(&root) {
        return Err(invalid());
    }
    let ext = extname(&row.relative_path);
    let info = row.stream_info.and_then(|v| {
        serde_json::from_value::<MediaInfo>(v)
            .map_err(|e| tracing::warn!("file #{id}: stream info unreadable: {e}"))
            .ok()
    });
    Ok(ResolvedFile {
        id: id as i32,
        absolute,
        size: meta.len(),
        content_type: content_type(&ext),
        ext,
        info,
        media_id: row.media_id,
        episode_id: row.episode_id,
        item_id: row.item_id,
        media_title: row.title,
        media_type: row.media_type.as_deref().map(crate::db::kind).transpose()?,
        poster_url: row.poster_url,
        fanart_url: row.fanart_url,
        root,
    })
}
