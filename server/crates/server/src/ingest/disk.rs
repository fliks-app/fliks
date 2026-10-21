//! Disk import routes (`ingest.md` rules 60-93): orphan scan, preview, relink and its batch.
use super::{
    MediaRow, fsx, is_video,
    library::{self, caller_nums, file_name},
    load_media, naming_formats,
    rescan::{ensure_season_and_episode, link_in_place, match_special},
    transfer::{Method, split_ext},
};
use crate::sync::MutexExt;
use crate::{
    events::{DomainEvent, Num, SseEvent, Subject as Subj, event::ImportSource},
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    importers::nfo,
    libraries::{accessible_library_ids, paths_visible},
    media::write::{self as mw, body::Body},
    state::AppState,
};
use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use fliks_domain::{
    acl::{Action, Subject},
    media::{
        bonus::{is_bonus_dir, is_sample_file},
        path::resolve,
    },
    naming::{
        self, MovieFolder, SeriesFolder, is_special_file, parse_episode_numbers,
        validate_folder_name,
    },
    nfo::NfoData,
    release::parsing::{quality::parse_release_quality, title::extract_media_title},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/imports/library/{libraryId}/orphans/scan", post(scan))
        .route("/api/imports/orphans/preview", post(preview))
        .route(
            "/api/imports/library/orphans/relink-batch",
            post(relink_batch),
        )
        .route("/api/imports/library/orphans/relink", post(relink))
}

struct Lib {
    id: i32,
    name: String,
    path: String,
    types: Vec<String>,
    provider: Option<String>,
    dq: Option<i32>,
    dl: Option<i32>,
}

/// `requirePathFor`: 404 unknown, 400 without a root path.
async fn require_path(st: &AppState, id: i32) -> Result<Lib, AppError> {
    let r = sqlx::query!(
        r#"SELECT id, name, path, "mediaTypes" AS types, "preferredProvider" AS provider,
                  "defaultQualityProfileId" AS dq, "defaultLanguageProfileId" AS dl FROM libraries WHERE id = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("Library #{id} not found")))?;
    let path = r.path.filter(|p| !p.is_empty()).ok_or_else(|| {
        AppError::bad_request(format!("Library #{id} has no root path configured"))
    })?;
    Ok(Lib {
        id: r.id,
        name: r.name,
        path,
        types: serde_json::from_value(r.types).unwrap_or_default(),
        provider: r.provider,
        dq: r.dq,
        dl: r.dl,
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    file_path: String,
    filename: String,
    size: u64,
    quality_name: &'static str,
    quality_id: u32,
    season_number: Option<i64>,
    episode_number: Option<i64>,
    episode_end: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Group {
    group_key: String,
    media_type: &'static str,
    folder_name: String,
    guess_title: String,
    guess_year: Option<i64>,
    nfo: Option<NfoData>,
    suggested_provider: String,
    files: Vec<FileEntry>,
}

/// Rule 62: depth 3, bonus folders below the scan root skipped, regular video files only.
fn collect(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 3 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    let mut subdirs = vec![];
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            if !(depth > 0 && is_bonus_dir(&name)) {
                subdirs.push(e.path());
            }
        } else if is_video(&name)
            && !is_sample_file(&name)
            && fs::metadata(e.path()).is_ok_and(|m| m.is_file())
        {
            out.push(e.path());
        }
    }
    for s in subdirs {
        collect(&s, depth + 1, out);
    }
}

fn progress(st: &AppState, key: &str, root: &str, current: usize, total: usize) {
    st.hub.emit(SseEvent::TaskProgress {
        command: "OrphanScan".into(),
        current: Num(current as f64),
        total: Num(total as f64),
        message: root.to_owned(),
        subject: None,
    });
    st.hub.activity().upsert_running(
        key,
        "OrphanScan",
        Some(subject_titled(root)),
        Some(Num(current as f64)),
        Some(Num(total as f64)),
        None,
    );
}

fn subject_titled(title: &str) -> Subj {
    Subj {
        title: title.to_owned(),
        media_id: None,
        media_type: None,
        season_number: None,
        episode_number: None,
        episode_title: None,
        episode_id: None,
    }
}

/// `scanOrphansUnder` (rules 62-66): reads only.
async fn scan_under(
    st: &AppState,
    root: &str,
    types: &[String],
    provider: &str,
    linked: &HashSet<PathBuf>,
) -> Value {
    let key = format!("OrphanScan:{root}");
    let r = PathBuf::from(root);
    let all = tokio::task::spawn_blocking(move || {
        let mut out = vec![];
        collect(&r, 0, &mut out);
        out
    })
    .await
    .unwrap_or_default();
    let unlinked: Vec<&PathBuf> = all.iter().filter(|p| !linked.contains(*p)).collect();
    let total = unlinked.len() + 1;
    progress(st, &key, root, 0, total);
    let root_p = Path::new(root);
    let mut groups: Vec<Group> = vec![];
    let mut orphan_count = 0;
    for (i, abs) in unlinked.iter().enumerate() {
        if (i + 1) % 25 == 0 {
            progress(st, &key, root, i + 1, total);
        }
        let name = file_name(abs);
        let abs_s = abs.to_string_lossy().into_owned();
        let nums = parse_episode_numbers(&name, Some(&abs_s));
        let series = nums.is_some() || is_special_file(&abs_s);
        let media_type = if series { "series" } else { "movie" };
        if !types.iter().any(|t| t == media_type) {
            continue;
        }
        let q = parse_release_quality(&name).quality;
        let rel = fsx::rel_under(root_p, abs).unwrap_or_default();
        let segs: Vec<&str> = rel.split('/').collect();
        let folder = if segs.len() > 1 {
            segs[0].to_owned()
        } else {
            String::new()
        };
        if series && folder.is_empty() {
            continue;
        }
        orphan_count += 1;
        let entry = FileEntry {
            file_path: abs_s.clone(),
            filename: name,
            size: fs::metadata(abs).map_or(0, |m| m.len()),
            quality_name: q.name,
            quality_id: q.id,
            season_number: nums.map(|n| n.season),
            episode_number: nums.map(|n| n.episode),
            episode_end: nums.and_then(|n| n.episode_end),
        };
        let key = if series {
            format!("series:{folder}")
        } else {
            format!("movie:{abs_s}")
        };
        match groups.iter_mut().find(|g| g.group_key == key) {
            Some(g) => g.files.push(entry),
            None => groups.push(Group {
                group_key: key,
                media_type,
                folder_name: folder.clone(),
                guess_title: folder,
                guess_year: None,
                nfo: None,
                suggested_provider: provider.to_owned(),
                files: vec![entry],
            }),
        }
    }
    for g in &mut groups {
        let sample = PathBuf::from(&g.files[0].file_path);
        g.nfo = nfo::for_video(&sample).await;
        let ex = extract_media_title(&file_name(&sample));
        g.guess_title = g
            .nfo
            .as_ref()
            .and_then(|n| n.title.clone())
            .unwrap_or(ex.title);
        g.guess_year = g
            .nfo
            .as_ref()
            .and_then(|n| n.year)
            .or(ex.year.map(i64::from));
    }
    progress(st, &key, root, total, total);
    st.hub.activity().remove(&key);
    json!({
        "libraryPath": root,
        "groups": groups,
        "scannedFiles": all.len(),
        "orphanCount": orphan_count,
    })
}

/// `POST /api/imports/library/:libraryId/orphans/scan` (rules 60, 70: ACL on the path).
#[utoipa::path(post, path = "/api/imports/library/{libraryId}/orphans/scan", responses((status = 201)))]
pub async fn scan(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Create, Subject::Media)?;
    let PathParams(id) = id?;
    if !accessible_library_ids(&st.db, &a).await?.contains(&id) {
        return Err(AppError::not_found(format!("Library #{id} not found")));
    }
    let lib = require_path(&st, id).await?;
    let linked: HashSet<PathBuf> = sqlx::query!(
        r#"SELECT mf."relativePath" AS rel, m."folderName" AS folder FROM media_files mf
           JOIN media m ON m.id = mf."mediaId" WHERE m."libraryId" = $1"#,
        id
    )
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .map(|r| {
        let base = fliks_domain::media::path::media_path(Some(&lib.path), r.folder.as_deref())
            .unwrap_or_default();
        PathBuf::from(resolve(
            &fliks_domain::media::path::join(&base, &r.rel.replace('\\', "/")),
            "/",
        ))
    })
    .collect();
    let root = resolve(&lib.path, "/");
    let mut v = scan_under(
        &st,
        &root,
        &lib.types,
        lib.provider.as_deref().unwrap_or("tmdb"),
        &linked,
    )
    .await;
    if !paths_visible(&a.perms)
        && let Some(o) = v.as_object_mut()
    {
        o.remove("libraryPath");
    }
    Ok((StatusCode::CREATED, Json(v)))
}

/// `POST /api/imports/orphans/preview` (rules 61, 71: `settings.access`, absolute paths only).
#[utoipa::path(post, path = "/api/imports/orphans/preview", responses((status = 201)))]
pub async fn preview(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Create, Subject::Media)?;
    a.require(Action::Manage, Subject::Settings)?;
    let b = Body::new(v, &["path", "mediaTypes", "preferredProvider"])?;
    let path = b.required(b.str("path")?, "path", "must be a string")?;
    let types = match b.strings("mediaTypes")? {
        Some(Some(t)) => {
            if t.iter().any(|t| t != "movie" && t != "series") {
                return Err(AppError::bad_request(vec![
                    "each value in mediaTypes must be one of the following values: movie, series"
                        .to_owned(),
                ]));
            }
            t
        }
        _ => vec!["movie".into(), "series".into()],
    };
    let provider = b
        .str("preferredProvider")?
        .flatten()
        .unwrap_or_else(|| "tmdb".into());
    let clean = crate::libraries::sanitize_path(&path);
    if !clean.starts_with('/') {
        return Err(AppError::bad_request("Path must be absolute"));
    }
    let root = resolve(&clean, "/");
    match fs::metadata(&root) {
        Err(_) => return Err(AppError::bad_request(format!("Path not found: {root}"))),
        Ok(m) if !m.is_dir() => {
            return Err(AppError::bad_request(format!("Not a directory: {root}")));
        }
        Ok(_) => {}
    }
    Ok((
        StatusCode::CREATED,
        Json(scan_under(&st, &root, &types, &provider, &HashSet::new()).await),
    ))
}

#[utoipa::path(post, path = "/api/imports/library/orphans/relink", responses((status = 201)))]
pub async fn relink(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Create, Subject::Media)?;
    let d = parse_relink(v, "")?;
    check_transfer(&a, &d)?;
    Ok((StatusCode::CREATED, Json(relink_orphans(&st, &a, d).await?)))
}

#[utoipa::path(post, path = "/api/imports/library/orphans/relink-batch", responses((status = 201)))]
pub async fn relink_batch(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Create, Subject::Media)?;
    let b = Body::new(v, &["items"])?;
    let items = match b.0.get("items") {
        Some(Value::Array(a)) => a.clone(),
        _ => {
            return Err(AppError::bad_request(vec![
                "items must be an array".to_owned(),
            ]));
        }
    };
    let items = items
        .into_iter()
        .enumerate()
        .map(|(i, v)| parse_relink(v, &format!("items.{i}.")))
        .collect::<Result<Vec<_>, _>>()?;
    for d in &items {
        check_transfer(&a, d)?;
    }
    let n = items.len();
    tokio::spawn(run_batch(st, a, items));
    Ok((StatusCode::CREATED, Json(json!({ "queued": n }))))
}

/// Rule 73: sequential, failures logged, every activity row removed at the end.
async fn run_batch(st: AppState, a: Authed, items: Vec<RelinkDto>) {
    let batch = format!("OrphanImport:{}", &fsx::tmp_name()[".fliks-tmp-".len()..]);
    let total = items.len();
    let act = st.hub.activity();
    let keys: Vec<String> = items
        .iter()
        .map(|d| format!("{batch}:{}:{}", d.media_type, d.folder_name))
        .collect();
    for (k, d) in keys.iter().zip(&items) {
        act.upsert_pending(
            k,
            "OrphanImport",
            Some(subject_titled(&d.folder_name)),
            Some(batch.clone()),
        );
    }
    let (mut created, mut linked, mut failed) = (0, 0, 0);
    for (i, (k, d)) in keys.iter().zip(items).enumerate() {
        st.hub.emit(SseEvent::TaskProgress {
            command: "OrphanImport".into(),
            current: Num(i as f64),
            total: Num(total as f64),
            message: d.folder_name.clone(),
            subject: None,
        });
        act.upsert_running(
            &batch,
            "OrphanImport",
            Some(subject_titled(&d.folder_name)),
            Some(Num((i + 1) as f64)),
            Some(Num(total as f64)),
            None,
        );
        act.upsert_running(
            k,
            "OrphanImport",
            Some(subject_titled(&d.folder_name)),
            None,
            None,
            Some(batch.clone()),
        );
        let folder = d.folder_name.clone();
        match relink_orphans(&st, &a, d).await {
            Ok(r) => {
                created += usize::from(r["created"] == true);
                let l = r["linked"].as_i64().unwrap_or(0);
                linked += l;
                if l == 0 && r["alreadyPresent"].as_i64().unwrap_or(0) == 0 {
                    failed += 1;
                }
            }
            Err(e) => {
                failed += 1;
                tracing::warn!("Orphan batch item \"{folder}\" failed: {}", e.text());
            }
        }
        act.remove(k);
    }
    act.remove(&batch);
    st.hub.emit(SseEvent::TaskProgress {
        command: "OrphanImport".into(),
        current: Num(total as f64),
        total: Num(total as f64),
        message: String::new(),
        subject: None,
    });
    tracing::info!(
        "Orphan batch import done: {total} item(s), {created} created, {linked} linked, {failed} failed"
    );
}

fn validated_folder(name: &str, media_type: &str) -> Result<String, AppError> {
    if name.is_empty() && media_type == "movie" {
        return Ok(String::new());
    }
    validate_folder_name(name)
        .map(str::to_owned)
        .map_err(|_| AppError::bad_request(format!("Invalid folder name \"{name}\"")))
}

/// `relinkOrphans` (rules 76-92).
async fn relink_orphans(st: &AppState, a: &Authed, d: RelinkDto) -> Result<Value, AppError> {
    if !accessible_library_ids(&st.db, a)
        .await?
        .contains(&d.library_id)
    {
        return Err(AppError::not_found(format!(
            "Library #{} not found",
            d.library_id
        )));
    }
    let lib = require_path(st, d.library_id).await?;
    if !lib.types.contains(&d.media_type) {
        return Err(AppError::bad_request(format!(
            "Library \"{}\" does not accept {}",
            lib.name, d.media_type
        )));
    }
    let in_place_reorganize = d.reorganize && d.transfer.is_none();
    if d.external_id.is_none() && in_place_reorganize {
        return Err(AppError::bad_request(
            "Reorganize needs an identified title",
        ));
    }
    if d.folder_name.is_empty() && in_place_reorganize {
        return Err(AppError::bad_request(
            "Reorganize needs a title with its own folder",
        ));
    }
    let folder = match d.transfer {
        None => validated_folder(&d.folder_name, &d.media_type)?,
        Some(_) => String::new(),
    };
    let (media, created, unmatched_key) = match &d.external_id {
        Some(_) => {
            let (m, c) = find_or_import(st, a, &d).await?;
            (m, c, None)
        }
        None => {
            let (m, c, k) = find_or_create_unmatched(st, &d, &lib, a.user.id).await?;
            (m, c, Some(k))
        }
    };
    let r = link_files(
        st,
        &d,
        &lib,
        &media,
        &folder,
        created,
        unmatched_key.as_deref(),
    )
    .await;
    if unmatched_key.is_some() {
        let mut h = st.ingest.unmatched_holders.lock_clean();
        match h.get(&media.id).copied().unwrap_or(1) {
            n if n > 1 => {
                h.insert(media.id, n - 1);
            }
            _ => {
                h.remove(&media.id);
            }
        }
    }
    let (linked, present, errors) = r?;
    tracing::info!(
        "Orphan relink — media #{} created={created} linked={linked} alreadyPresent={present} errors={}",
        media.id,
        errors.len()
    );
    Ok(json!({
        "mediaId": media.id,
        "created": created,
        "linked": linked,
        "alreadyPresent": present,
        "errors": errors,
    }))
}

mod link;
mod relink_dto;
use link::*;
use relink_dto::*;

#[cfg(test)]
mod tests {
    use super::parse_relink;
    use serde_json::json;

    fn body(path: &str) -> serde_json::Value {
        json!({"libraryId": 1, "type": "movie", "folderName": "A", "files": [{"filePath": path}]})
    }

    #[test]
    fn relink_file_path_is_sanitized_and_absolute() {
        assert!(parse_relink(body("rel/a.mkv"), "").is_err());
        let d = parse_relink(body(" \u{200B}/m/a.mkv "), "").unwrap();
        assert_eq!(d.files[0].path, "/m/a.mkv");
    }
}
