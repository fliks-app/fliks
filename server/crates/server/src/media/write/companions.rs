//! Companion files of a media file (rules 81-95): the listing is the only authority for what a
//! client may download or delete.
use super::gate;
use crate::{
    http::{AppError, auth::Authed, validate::PathParams},
    ingest::{fsx, is_video, load_media, transfer::split_ext},
    state::AppState,
};
use axum::{
    Json,
    extract::{
        Multipart, Query, State,
        multipart::{MultipartError, MultipartRejection},
    },
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use fliks_domain::{
    acl::{Action, Subject},
    edl::{MAX_EDL_BYTES, parse_edl},
    media::path::normalize,
    subtitle_name::{match_subtitle_video, parse_subtitle_filename},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
};

const IMAGE_EXTS: [&str; 4] = [".jpg", ".jpeg", ".png", ".webp"];
const FOLDER_ART: [&str; 8] = [
    "poster",
    "folder",
    "cover",
    "movie",
    "fanart",
    "backdrop",
    "clearlogo",
    "logo",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleInfo {
    id: Option<i32>,
    language: String,
    forced: bool,
    hearing_impaired: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shared {
    file_id: i32,
    name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Companion {
    name: String,
    relative_path: String,
    size: u64,
    mtime: String,
    kind: &'static str,
    scope: &'static str,
    subtitle: Option<SubtitleInfo>,
    shared_with: Vec<Shared>,
    has_pair: bool,
}

struct FileRow {
    id: i32,
    rel: String,
    info: Option<Value>,
}

struct SubRow {
    id: i32,
    file_id: Option<i32>,
    rel: String,
    language: String,
    forced: bool,
    hi: bool,
}

struct Listing {
    root: Option<(fsx::Root, PathBuf)>,
    file: FileRow,
    rows: Vec<SubRow>,
    entries: Vec<Companion>,
}

fn norm(p: &str) -> String {
    normalize(&p.replace('\\', "/"))
}

fn regular_files(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect()
}

fn stem_l(rel: &str) -> String {
    let b = rel.rsplit('/').next().unwrap_or(rel);
    split_ext(b).0.to_lowercase()
}

fn base_name(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_owned()
}

/// `load` + `collect` (rule 82).
async fn collect(st: &AppState, media_id: i32, file_id: i32) -> Result<Listing, AppError> {
    let media = load_media(&st.db, media_id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(media_id))?;
    let mut files = sqlx::query_as!(
        FileRow,
        r#"SELECT id, "relativePath" AS rel, "streamInfo" AS info FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
        media_id
    )
    .fetch_all(&st.db)
    .await?;
    let pos = files
        .iter()
        .position(|f| f.id == file_id)
        .ok_or_else(|| AppError::not_found(format!("File #{file_id} not found")))?;
    let rows = sqlx::query_as!(
        SubRow,
        r#"SELECT id, "mediaFileId" AS file_id, "filePath" AS "rel!", language, forced, "hearingImpaired" AS hi
           FROM subtitle_files WHERE "mediaId" = $1 AND "filePath" IS NOT NULL AND "filePath" <> ''
             AND "providerType"::text <> 'embedded' ORDER BY id"#,
        media_id
    )
    .fetch_all(&st.db)
    .await?;
    let root = media.library_path.as_deref().and_then(|l| {
        let r = fsx::Root::open(l).ok()?;
        let m = r.media_dir(media.folder_name.as_deref()).ok()?;
        Some((r, m))
    });
    let entries = match &root {
        Some((r, m)) => scan(
            r,
            m,
            media.has_seasons(),
            media.folder_name.as_deref().is_some_and(|f| !f.is_empty()),
            &files,
            pos,
            &rows,
        ),
        None => vec![],
    };
    let file = files.swap_remove(pos);
    Ok(Listing {
        root,
        file,
        rows,
        entries,
    })
}

mod scan;
use scan::scan;

type Ids = Result<PathParams<(i32, i32)>, AppError>;

async fn ids_gate(
    st: &AppState,
    a: &Authed,
    action: Action,
    ids: Ids,
    path: Option<&Option<String>>,
) -> Result<(i32, i32), AppError> {
    a.require(action, Subject::Media)?;
    let PathParams((id, file)) = ids?;
    if let Some(p) = path
        && p.as_deref().is_none_or(str::is_empty)
    {
        return Err(AppError::bad_request("path is required"));
    }
    gate(st, a, action, Ok(PathParams(id))).await?;
    Ok((id, file))
}

#[utoipa::path(get, path = "/api/media/{id}/files/{fileId}/companions", responses((status = 200)))]
pub async fn companions_list(
    State(st): State<AppState>,
    a: Authed,
    ids: Ids,
) -> Result<Json<Vec<Companion>>, AppError> {
    let (id, file) = ids_gate(&st, &a, Action::Read, ids, None).await?;
    Ok(Json(collect(&st, id, file).await?.entries))
}

fn not_listed() -> AppError {
    AppError::not_found("Companion file not found")
}

/// `findListed` (rule 86): an exact `relativePath` of this listing, never a path component.
async fn find_listed(
    st: &AppState,
    id: i32,
    file: i32,
    rel: &str,
) -> Result<(Listing, Companion, PathBuf), AppError> {
    let l = collect(st, id, file).await?;
    let hit = l
        .entries
        .iter()
        .find(|c| c.relative_path == rel)
        .cloned()
        .ok_or_else(not_listed)?;
    let (root, mdir) = l.root.as_ref().ok_or_else(not_listed)?;
    let abs = mdir.join(fsx::safe_rel(&hit.relative_path).ok_or_else(not_listed)?);
    if !root.contains(abs.parent().unwrap_or(mdir), true) {
        return Err(not_listed());
    }
    Ok((l, hit, abs))
}

fn mime(name: &str) -> &'static str {
    match split_ext(name).1.to_lowercase().as_str() {
        ".srt" => "application/x-subrip",
        ".vtt" => "text/vtt; charset=utf-8",
        ".ass" | ".ssa" => "text/x-ssa; charset=utf-8",
        ".nfo" => "text/x-nfo; charset=utf-8",
        ".txt" => "text/plain; charset=utf-8",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".png" => "image/png",
        ".webp" => "image/webp",
        ".sub" => "text/vnd.dvb.subtitle; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// `Content-Disposition: attachment` as `res.attachment(name)` words it.
fn disposition(name: &str) -> String {
    let plain = name.chars().all(|c| c.is_ascii() && !c.is_ascii_control());
    let quoted = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    if plain {
        return format!("attachment; filename=\"{}\"", quoted(name));
    }
    let fallback: String = name
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_ascii_control() {
                c
            } else {
                '?'
            }
        })
        .collect();
    let enc =
        percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC).to_string();
    format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{enc}",
        quoted(&fallback)
    )
}

#[utoipa::path(get, path = "/api/media/{id}/files/{fileId}/companions/download", responses((status = 200)))]
pub async fn companions_download(
    State(st): State<AppState>,
    a: Authed,
    ids: Ids,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, AppError> {
    let path = q.get("path").cloned();
    let (id, file) = ids_gate(&st, &a, Action::Read, ids, Some(&path)).await?;
    let (_, hit, abs) = find_listed(&st, id, file, path.as_deref().unwrap_or_default()).await?;
    let bytes = tokio::task::spawn_blocking(move || {
        let mut o = fs::OpenOptions::new();
        o.read(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::custom_flags(&mut o, libc::O_NOFOLLOW);
        let mut f = o.open(&abs)?;
        if !f.metadata()?.is_file() {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        let mut b = vec![];
        std::io::Read::read_to_end(&mut f, &mut b)?;
        Ok::<_, std::io::Error>(b)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
    .map_err(|_| not_listed())?;
    let mut r = bytes.into_response();
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(mime(&hit.name)),
    );
    if let Ok(v) = HeaderValue::from_str(&disposition(&hit.name)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    Ok(r)
}

/// Rules 93-95: a tracked subtitle goes through the subtitle delete, anything else is a contained unlink.
#[utoipa::path(delete, path = "/api/media/{id}/files/{fileId}/companions", responses((status = 200)))]
pub async fn companions_delete(
    State(st): State<AppState>,
    a: Authed,
    ids: Ids,
    Query(q): Query<HashMap<String, String>>,
) -> Result<StatusCode, AppError> {
    let path = q.get("path").cloned();
    let (id, file) = ids_gate(&st, &a, Action::Delete, ids, Some(&path)).await?;
    let (l, hit, _) = find_listed(&st, id, file, path.as_deref().unwrap_or_default()).await?;
    let pair_base = |p: &str| {
        let p = p.to_lowercase();
        p.strip_suffix(".idx")
            .or_else(|| p.strip_suffix(".sub"))
            .map(str::to_owned)
            .unwrap_or(p)
    };
    let targets: Vec<&Companion> = if hit.has_pair {
        l.entries
            .iter()
            .filter(|c| c.has_pair && pair_base(&c.relative_path) == pair_base(&hit.relative_path))
            .collect()
    } else {
        vec![&hit]
    };
    let (root, mdir) = l.root.as_ref().ok_or_else(not_listed)?;
    for t in &targets {
        let tracked: Vec<i32> = l
            .rows
            .iter()
            .filter(|r| norm(&r.rel) == t.relative_path)
            .map(|r| r.id)
            .collect();
        if !tracked.is_empty() {
            for id in tracked {
                crate::subtitles::sidecars::delete_subtitle(&st, id).await?;
            }
            continue;
        }
        let abs = mdir.join(fsx::safe_rel(&t.relative_path).ok_or_else(not_listed)?);
        match fsx::unlink_contained(root, &abs) {
            Ok(fsx::Unlinked::Removed) => {}
            Ok(fsx::Unlinked::Missing) => return Err(not_listed()),
            Err(e) => {
                tracing::error!("companion unlink {}: {e}", abs.display());
                return Err(not_listed());
            }
        }
    }
    tracing::info!(
        "User {} deleted companion file \"{}\" (media #{id}, file #{file}, {})",
        a.user.id,
        hit.relative_path,
        hit.kind
    );
    Ok(StatusCode::OK)
}

fn bad(m: &str) -> AppError {
    AppError::bad_request(m)
}

fn edl_exists() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({"code": "EDL_EXISTS", "message": "file_info.import_edl_exists"})),
    )
        .into_response()
}

fn too_large() -> AppError {
    AppError::payload_too_large("file_info.import_err_too_large")
}

/// Only a size error is 413 (multer `LIMIT_FILE_SIZE`); a malformed body is 400.
fn multipart_error(e: MultipartError) -> AppError {
    if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
        too_large()
    } else {
        bad(&format!("Multipart: {}", e.body_text()))
    }
}

/// `POST .../companions/edl` (rules 89-92): the uploaded bytes, written atomically beside the video.
#[utoipa::path(post, path = "/api/media/{id}/files/{fileId}/companions/edl", responses((status = 201)))]
pub async fn companions_edl(
    State(st): State<AppState>,
    a: Authed,
    ids: Ids,
    Query(q): Query<HashMap<String, String>>,
    multipart: Result<Multipart, MultipartRejection>,
) -> Result<Response, AppError> {
    a.require(Action::Update, Subject::Media)?;
    let PathParams((id, file_id)) = ids?;
    let mut bytes: Option<Vec<u8>> = None;
    if let Ok(mut m) = multipart {
        while let Some(mut field) = m.next_field().await.map_err(multipart_error)? {
            let is_file = field.name() == Some("file") && field.file_name().is_some();
            let mut b = vec![];
            while let Some(c) = field.chunk().await.map_err(multipart_error)? {
                b.extend_from_slice(&c);
                if b.len() as u64 > MAX_EDL_BYTES {
                    return Err(too_large());
                }
            }
            if is_file && bytes.is_none() {
                bytes = Some(b);
            }
        }
    }
    gate(&st, &a, Action::Update, Ok(PathParams(id))).await?;
    let bytes = bytes.ok_or_else(|| bad("No file uploaded"))?;
    if bytes.contains(&0) {
        return Err(bad("file_info.import_err_binary"));
    }
    let text =
        String::from_utf8(bytes.clone()).map_err(|_| bad("file_info.import_err_encoding"))?;
    let l = collect(&st, id, file_id).await?;
    let (root, mdir) = l
        .root
        .as_ref()
        .ok_or_else(|| bad("file_info.import_err_no_folder"))?;
    let rel = fsx::safe_rel(&l.file.rel).ok_or_else(|| bad("Invalid file path"))?;
    let video = mdir.join(rel);
    let dir = video.parent().unwrap_or(mdir).to_path_buf();
    if !root.contains(&dir, true) {
        return Err(bad("Invalid file path"));
    }
    let fps = l
        .file
        .info
        .as_ref()
        .and_then(|i| i["video"][0]["frameRate"].as_str())
        .and_then(crate::presence::parse_source_fps);
    let parsed = parse_edl(&text, fps);
    if parsed.ranges.is_empty() {
        return Err(bad("file_info.import_err_no_ranges"));
    }
    let replace = q.get("replace").is_some_and(|v| v == "true");
    let found = PathBuf::from(crate::stream::edl_sidecar(&video.to_string_lossy()).await);
    let existing = fs::symlink_metadata(&found).is_ok().then_some(found);
    if existing.is_some() && !replace {
        return Ok(edl_exists());
    }
    let stem = split_ext(&crate::ingest::library::file_name(&video))
        .0
        .to_owned();
    let target = existing
        .clone()
        .unwrap_or_else(|| dir.join(format!("{stem}.edl")));
    let claimed_here = existing.is_none();
    if claimed_here {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(edl_exists()),
            Err(e) => return Err(AppError::internal(e.to_string())),
        }
    }
    let (t, b) = (target.clone(), bytes);
    let written = tokio::task::spawn_blocking(move || fsx::write_atomic(&t, &b))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?;
    if let Err(e) = written {
        if claimed_here {
            let _ = fs::remove_file(&target);
        }
        return Err(AppError::internal(e.to_string()));
    }
    tracing::info!(
        "User {} imported EDL \"{}\" (media #{id}, file #{file_id}, {} range(s))",
        a.user.id,
        target.display(),
        parsed.ranges.len()
    );
    let rejected: Vec<Value> = parsed
        .rejected
        .iter()
        .map(|r| json!({"line": r.line, "reason": r.reason}))
        .collect();
    Ok((
        StatusCode::CREATED,
        Json(json!({"ranges": parsed.ranges.len(), "rejected": rejected})),
    )
        .into_response())
}
