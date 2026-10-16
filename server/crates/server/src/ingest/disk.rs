//! Disk import routes (`ingest.md` rules 60-93): orphan scan, preview, relink and its batch.
use super::{
    MediaRow, fsx, is_video,
    library::{self, caller_nums, file_name},
    load_media, naming_formats,
    rescan::{ensure_season_and_episode, link_in_place, match_special},
    transfer::{Method, split_ext},
};
use crate::{
    events::{DomainEvent, Num, SseEvent, Subject as Subj, event::ImportSource},
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    libraries::{accessible_library_ids, paths_visible},
    media::write::{self as mw, body::Body},
    seams::Nfo,
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
    nfo: Option<Nfo>,
    suggested_provider: String,
    files: Vec<FileEntry>,
}

/// Rule 62: depth 3, bonus folders below the scan root skipped, regular video files only (C55).
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
        g.nfo = st.seams.nfo.for_video(&sample).await;
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
            .map(i64::from)
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

/// `POST /api/imports/library/:libraryId/orphans/scan` (rules 60, 70: ACL and F22 on the path).
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

pub struct RelinkFile {
    path: String,
    season: Option<i32>,
    episode: Option<i32>,
    end: Option<i32>,
}

pub struct RelinkDto {
    library_id: i32,
    media_type: String,
    external_id: Option<String>,
    provider: Option<String>,
    title: Option<String>,
    year: Option<i32>,
    quality_profile_id: Option<i32>,
    language_profile_id: Option<i32>,
    folder_name: String,
    scan_root: Option<String>,
    reorganize: bool,
    transfer: Option<Method>,
    files: Vec<RelinkFile>,
}

const RELINK_FIELDS: [&str; 13] = [
    "libraryId",
    "type",
    "externalId",
    "provider",
    "title",
    "year",
    "qualityProfileId",
    "languageProfileId",
    "folderName",
    "scanRoot",
    "reorganize",
    "transfer",
    "files",
];

/// `@Type(() => Number) @IsInt @Min(0)` on the file numbering.
fn non_negative(b: &Body, k: &str) -> Result<Option<i32>, AppError> {
    match b.0.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let n = match v {
                Value::String(s) => fliks_domain::media::query::js_number(s),
                v => v.as_f64(),
            };
            n.filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= f64::from(i32::MAX))
                .map(|n| Some(n as i32))
                .ok_or_else(|| {
                    AppError::bad_request(vec![format!("{}{k} must not be less than 0", b.1)])
                })
        }
    }
}

/// `RelinkOrphansDto` (rule 72); `prefix` names a batch item.
fn parse_relink(v: Value, prefix: &str) -> Result<RelinkDto, AppError> {
    let b = Body::nested(v, &RELINK_FIELDS, prefix)?;
    let library_id = b.required(b.id("libraryId")?, "libraryId", "must be an integer number")?;
    let media_type = b.required(
        b.one_of("type", &["movie", "series"])?,
        "type",
        "must be one of the following values: movie, series",
    )?;
    let title = b.str("title")?.flatten();
    if title.as_ref().is_some_and(|t| t.chars().count() > 255) {
        return Err(AppError::bad_request(vec![format!(
            "{prefix}title must be shorter than or equal to 255 characters"
        )]));
    }
    let year = match b.0.get("year") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let n = match v {
                Value::String(s) => fliks_domain::media::query::js_number(s),
                v => v.as_f64(),
            };
            Some(
                n.filter(|n| n.fract() == 0.0 && (1888.0..=2100.0).contains(n))
                    .map(|n| n as i32)
                    .ok_or_else(|| {
                        AppError::bad_request(vec![format!(
                            "{prefix}year must not be less than 1888"
                        )])
                    })?,
            )
        }
    };
    let transfer = b.one_of("transfer", &["copy", "move"])?.flatten().map(|t| {
        if t == "copy" {
            Method::Copy
        } else {
            Method::Move
        }
    });
    let files = match b.0.get("files") {
        Some(Value::Array(a)) if !a.is_empty() => a
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let fb = Body::nested(
                    f.clone(),
                    &["filePath", "seasonNumber", "episodeNumber", "episodeEnd"],
                    &format!("{prefix}files.{i}."),
                )?;
                let path = crate::libraries::sanitize_path(&fb.required(
                    fb.str("filePath")?,
                    "filePath",
                    "must be a string",
                )?);
                if !path.starts_with('/') {
                    return Err(AppError::bad_request(vec![format!(
                        "{prefix}files.{i}.filePath must be an absolute path"
                    )]));
                }
                Ok(RelinkFile {
                    path,
                    season: non_negative(&fb, "seasonNumber")?,
                    episode: non_negative(&fb, "episodeNumber")?,
                    end: non_negative(&fb, "episodeEnd")?,
                })
            })
            .collect::<Result<Vec<_>, AppError>>()?,
        Some(Value::Array(_)) => {
            return Err(AppError::bad_request(vec![format!(
                "{prefix}files should not be empty"
            )]));
        }
        _ => {
            return Err(AppError::bad_request(vec![format!(
                "{prefix}files must be an array"
            )]));
        }
    };
    Ok(RelinkDto {
        library_id,
        media_type,
        external_id: b.str("externalId")?.flatten(),
        provider: b.str("provider")?.flatten(),
        title,
        year,
        quality_profile_id: b.id("qualityProfileId")?.flatten(),
        language_profile_id: b.id("languageProfileId")?.flatten(),
        folder_name: b.required(b.str("folderName")?, "folderName", "must be a string")?,
        scan_root: b.str("scanRoot")?.flatten(),
        reorganize: b.bool("reorganize")?.flatten().unwrap_or(false),
        transfer,
        files,
    })
}

/// F48: moving files from outside the library is a library manager's action.
fn check_transfer(a: &Authed, d: &RelinkDto) -> Result<(), AppError> {
    if d.transfer.is_some() {
        a.require(Action::Manage, Subject::Settings)?;
    }
    Ok(())
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
    act.upsert_running(
        &batch,
        "OrphanImport",
        None,
        Some(Num(0.0)),
        Some(Num(total as f64)),
        None,
    );
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
    if d.transfer.is_none() {
        validated_folder(&d.folder_name, &d.media_type)?;
    }
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
    let r = link_files(st, &d, &lib, &media, created, unmatched_key.as_deref()).await;
    if unmatched_key.is_some() {
        let mut h = st.ingest.unmatched_holders.lock().expect("holders");
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

/// Rules 82-87 under the media's lock (C54).
async fn link_files(
    st: &AppState,
    d: &RelinkDto,
    lib: &Lib,
    media: &MediaRow,
    created: bool,
    unmatched_key: Option<&str>,
) -> Result<(i64, i64, Vec<String>), AppError> {
    if let Some(l) = media.library_id
        && l != d.library_id
    {
        return Err(AppError::bad_request(format!(
            "Media already belongs to another library (\"{}\")",
            media.library_name.clone().unwrap_or_default()
        )));
    }
    let guard = st.ingest.media.lock(media.id).await;
    let (mut linked, mut present, mut errors, mut slot) = (0i64, 0i64, vec![], false);
    if d.reorganize || d.transfer.is_some() {
        let mut entries = vec![];
        for f in &d.files {
            let name = file_name(Path::new(&f.path));
            // F47: an in-place reorganize moves files that are already in this library, nothing else.
            if d.transfer.is_none()
                && !fsx::Root::open(&lib.path)
                    .is_ok_and(|r| fs::canonicalize(&f.path).is_ok_and(|p| r.contains(&p, false)))
            {
                errors.push(format!("{name}: file outside the library root"));
                continue;
            }
            let mut episode_id = None;
            if media.is_series() {
                match caller_nums(f.season, f.episode, f.end)
                    .or_else(|| parse_episode_numbers(&name, Some(&f.path)))
                {
                    None => match match_special(&st.db, media.id, &name).await? {
                        Some(ep) => episode_id = Some(ep.id),
                        None => {
                            errors.push(format!("{name}: no SxxEyy pattern found"));
                            continue;
                        }
                    },
                    Some(n) => {
                        let (ep, c) = ensure_season_and_episode(&st.db, media.id, n).await?;
                        episode_id = Some(ep);
                        slot |= c;
                    }
                }
            }
            entries.push((
                f.path.clone(),
                episode_id,
                parse_release_quality(&name).quality.name,
            ));
        }
        if !entries.is_empty() {
            let r = confirm_import(
                st,
                &guard,
                media.id,
                lib,
                entries,
                d.transfer.unwrap_or(Method::Move),
                d.transfer.is_none(),
            )
            .await?;
            linked = r.0;
            present = r.1;
            errors.extend(r.2);
        }
    } else {
        let mut current = load_media(&st.db, media.id)
            .await?
            .unwrap_or_else(|| media.clone());
        let has_files = sqlx::query_scalar!(
            r#"SELECT count(*) AS "n!" FROM media_files WHERE "mediaId" = $1"#,
            media.id
        )
        .fetch_one(&st.db)
        .await?
            > 0;
        if !has_files && current.folder_name.as_deref().unwrap_or("") != d.folder_name {
            let folder = validated_folder(&d.folder_name, &d.media_type)?;
            sqlx::query!(
                r#"UPDATE media SET "libraryId" = $2, "folderName" = $3 WHERE id = $1"#,
                media.id,
                lib.id,
                folder
            )
            .execute(&st.db)
            .await?;
            current = load_media(&st.db, media.id).await?.unwrap_or(current);
        }
        if current.library_id.is_none() {
            current.library_id = Some(lib.id);
            current.library_path = Some(lib.path.clone());
            current.library_name = Some(lib.name.clone());
        }
        for f in &d.files {
            let abs = PathBuf::from(resolve(&f.path, "/"));
            let nums = caller_nums(f.season, f.episode, f.end);
            match link_in_place(st, &guard, &current, &abs, nums).await? {
                Err(e) => errors.push(format!("{}: {e}", file_name(&abs))),
                Ok(l) => {
                    linked += 1;
                    slot |= l.created;
                    st.ingest.queue.enqueue(st, l.file_id);
                }
            }
        }
        if linked > 0 {
            st.hub.emit_domain(DomainEvent::MediaFilesImported {
                media_id: i64::from(media.id),
                season_number: None,
                episode_number: None,
                source: ImportSource::Disk,
            });
            st.ingest.settle.schedule(st, media.id);
        }
    }
    let identified = media.tmdb_id.is_some() || media.tvdb_id.is_some() || media.imdb_id.is_some();
    if media.is_series()
        && slot
        && identified
        && let Err(e) = mw::refresh_series_episodes(st, media).await
    {
        tracing::warn!("Orphan relink: refreshSeriesEpisodes failed — {}", e.text());
    }
    drop(guard);
    if let Some(key) = unmatched_key
        && created
        && linked == 0
        && present == 0
    {
        let _k = st.ingest.unmatched.lock(key.to_owned()).await;
        let holders = st
            .ingest
            .unmatched_holders
            .lock()
            .expect("holders")
            .get(&media.id)
            .copied();
        let files = sqlx::query_scalar!(
            r#"SELECT count(*) AS "n!" FROM media_files WHERE "mediaId" = $1"#,
            media.id
        )
        .fetch_one(&st.db)
        .await?;
        if holders == Some(1) && files == 0 {
            sqlx::query!("DELETE FROM media WHERE id = $1", media.id)
                .execute(&st.db)
                .await?;
        }
    }
    Ok((linked, present, errors))
}

/// `confirmImport` (rule 92, C53); the caller holds the media's lock.
async fn confirm_import(
    st: &AppState,
    guard: &tokio::sync::OwnedMutexGuard<()>,
    media_id: i32,
    lib: &Lib,
    entries: Vec<(String, Option<i32>, &'static str)>,
    method: Method,
    uniquify: bool,
) -> Result<(i64, i64, Vec<String>), AppError> {
    let (mut imported, mut present, mut errors) = (0i64, 0i64, vec![]);
    let formats = naming_formats(&st.db).await?;
    for (path, episode_id, quality) in entries {
        let name = file_name(Path::new(&path));
        let Some(media) = load_media(&st.db, media_id).await? else {
            errors.push(format!("Media #{media_id} not found"));
            continue;
        };
        match fs::metadata(&path) {
            Err(_) => {
                errors.push(format!("{name}: source file not found"));
                continue;
            }
            Ok(m) if !m.is_file() || !is_video(&name) => {
                errors.push(format!("{name}: not a video file"));
                continue;
            }
            Ok(_) => {}
        }
        if !lib.types.contains(&media.media_type) {
            errors.push(format!(
                "{name}: library \"{}\" does not accept {}",
                lib.name, media.media_type
            ));
            continue;
        }
        match media.library_id {
            Some(l) if l != lib.id => {
                errors.push(format!("{name}: media already belongs to another library"));
                continue;
            }
            Some(_) => {}
            None => {
                let folder = pin_folder(&formats, &media);
                if validate_folder_name(&folder).is_err() {
                    errors.push(format!("{name}: invalid folder name \"{folder}\""));
                    continue;
                }
                sqlx::query!(
                    r#"UPDATE media SET "libraryId" = $2, "folderName" = $3 WHERE id = $1"#,
                    media.id,
                    lib.id,
                    folder
                )
                .execute(&st.db)
                .await?;
            }
        }
        let r = library::ingest(
            st,
            guard,
            library::Request {
                media_id,
                files: vec![library::File {
                    path: PathBuf::from(&path),
                    episode_id,
                }],
                transfer: method,
                fallback_quality: Some(quality.to_owned()),
                release_name: None,
                force: false,
                uniquify_on_collision: uniquify,
                replace_existing: false,
            },
        )
        .await;
        match r {
            Ok(o) => {
                imported += o.imported.len() as i64;
                present += o.already_present.len() as i64;
                errors.extend(o.errors);
                if !o.imported.is_empty() {
                    st.seams.media_servers.dispatch(
                        "library.rescan",
                        media.title.clone(),
                        media.path(),
                    );
                }
            }
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }
    Ok((imported, present, errors))
}

fn pin_folder(f: &naming::NamingFormats, m: &MediaRow) -> String {
    let (year, tmdb_id) = (m.year.map(i64::from), m.tmdb_id.map(i64::from));
    if m.is_series() {
        naming::apply_series_folder_format(
            &f.series_folder,
            &SeriesFolder {
                series_title: m.title.clone(),
                original_title: m.original_title.clone(),
                year,
                tmdb_id,
            },
        )
    } else {
        naming::apply_movie_folder_format(
            &f.movie_folder,
            &MovieFolder {
                title: m.title.clone(),
                original_title: m.original_title.clone(),
                year,
                tmdb_id,
            },
        )
    }
}

/// `findOrImportIdentified` (rule 78, C1: a numeric id).
async fn find_or_import(
    st: &AppState,
    a: &Authed,
    d: &RelinkDto,
) -> Result<(MediaRow, bool), AppError> {
    let ext = d.external_id.clone().unwrap_or_default();
    let n: i32 = ext.trim().parse().ok().filter(|n| *n > 0).ok_or_else(|| {
        AppError::bad_request(vec!["externalId must be a number string".to_owned()])
    })?;
    let tvdb = d.provider.as_deref() == Some("tvdb");
    let lookup = async || -> Result<Option<MediaRow>, AppError> {
        let id = if tvdb {
            sqlx::query_scalar!(
                r#"SELECT id FROM media WHERE "tvdbId" = $1 AND type::text = $2 LIMIT 1"#,
                n,
                d.media_type
            )
            .fetch_optional(&st.db)
            .await?
        } else {
            sqlx::query_scalar!(
                r#"SELECT id FROM media WHERE "tmdbId" = $1 AND type::text = $2 LIMIT 1"#,
                n,
                d.media_type
            )
            .fetch_optional(&st.db)
            .await?
        };
        Ok(match id {
            Some(id) => load_media(&st.db, id).await?,
            None => None,
        })
    };
    if let Some(m) = lookup().await? {
        return Ok((m, false));
    }
    let provider = d.provider.clone().filter(|p| p == "tmdb" || p == "tvdb");
    let imported = async {
        let target = mw::resolve_target(st, a, &d.media_type, Some(d.library_id)).await?;
        let imp = mw::Import {
            media_type: d.media_type.clone(),
            library_id: target.id,
            quality_profile_id: mw::resolve_profile(
                &st.db,
                false,
                d.quality_profile_id,
                target.default_quality,
            )
            .await?,
            language_profile_id: mw::resolve_profile(
                &st.db,
                true,
                d.language_profile_id,
                target.default_language,
            )
            .await?,
            added_by: Some(a.user.id),
            monitored_seasons: None,
        };
        mw::import_title(st, provider, ext.clone(), imp).await
    }
    .await;
    match imported {
        Ok(id) => Ok((
            load_media(&st.db, id)
                .await?
                .ok_or_else(|| AppError::bad_request("Media not found after import"))?,
            true,
        )),
        Err(e) => match lookup().await? {
            Some(m) => Ok((m, false)),
            None => Err(e),
        },
    }
}

/// `seriesFolderOf` (rule 69): the outermost ancestor named `folder`, capped at `scan_root`.
fn series_folder_of(file: &Path, folder: &str, scan_root: Option<&str>) -> PathBuf {
    let start = file.parent().unwrap_or(file).to_path_buf();
    let cap = scan_root.map(|r| PathBuf::from(resolve(&crate::libraries::sanitize_path(r), "/")));
    let mut best = None;
    let mut cur = Some(start.as_path());
    while let Some(c) = cur {
        if c.file_name().is_some_and(|n| n == folder) {
            best = Some(c.to_path_buf());
        }
        if cap.as_deref() == Some(c) {
            break;
        }
        cur = c.parent();
    }
    best.unwrap_or(start)
}

/// `findLocalArtwork` (rule 68): one `readdir`, case-insensitive, read only.
fn local_artwork(dir: &Path, base: Option<&str>, base_only: bool) -> mw::Artwork {
    let names: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    let pick = |cands: Vec<String>| {
        cands.iter().find_map(|c| {
            ["jpg", "jpeg", "png", "webp"].iter().find_map(|e| {
                let want = format!("{c}.{e}").to_lowercase();
                names
                    .iter()
                    .find(|n| n.to_lowercase() == want)
                    .map(|n| dir.join(n))
            })
        })
    };
    let with = |suffix: &str, generic: &[&str]| -> Vec<String> {
        let mut v: Vec<String> = base.map(|b| format!("{b}-{suffix}")).into_iter().collect();
        if !base_only {
            v.extend(generic.iter().map(|s| s.to_string()));
        }
        v
    };
    mw::Artwork {
        poster: pick(with("poster", &["poster", "folder", "cover", "movie"])),
        fanart: pick(with("fanart", &["fanart", "backdrop"])),
        logo: if base_only {
            None
        } else {
            pick(vec!["clearlogo".into(), "logo".into()])
        },
    }
}

/// `findOrCreateUnmatched` (rules 79-81) under the `(library, type, folder)` lock.
async fn find_or_create_unmatched(
    st: &AppState,
    d: &RelinkDto,
    lib: &Lib,
    user: i32,
) -> Result<(MediaRow, bool, String), AppError> {
    let sample = PathBuf::from(resolve(&d.files[0].path, "/"));
    let series = d.media_type == "series";
    let art_dir = if !series {
        sample.parent().unwrap_or(&sample).to_path_buf()
    } else if d.transfer.is_some() {
        series_folder_of(&sample, &d.folder_name, d.scan_root.as_deref())
    } else {
        PathBuf::from(&lib.path).join(&d.folder_name)
    };
    let root_movie = d.folder_name.is_empty();
    let art_base = (!series).then(|| split_ext(&file_name(&sample)).0.to_owned());
    let read_nfo = async || -> Option<Nfo> {
        let nfo = &st.seams.nfo;
        if series {
            match nfo.file(&art_dir.join("tvshow.nfo")).await {
                Some(n) => Some(n),
                None => nfo.for_video(&sample).await,
            }
        } else if root_movie {
            nfo.file(&art_dir.join(format!("{}.nfo", art_base.clone().unwrap_or_default())))
                .await
        } else {
            nfo.for_video(&sample).await
        }
    };
    let guessed = d
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .or_else(|| Some(extract_media_title(&file_name(&sample)).title).filter(|t| !t.is_empty()))
        .unwrap_or_else(|| d.folder_name.clone());
    let transfer_nfo = if d.transfer.is_some() {
        read_nfo().await
    } else {
        None
    };
    let title = match transfer_nfo.as_ref().and_then(|n| n.title.clone()) {
        Some(t) if !t.is_empty() && guessed == d.folder_name => t,
        _ => guessed,
    };
    let year = d.year.or(transfer_nfo.as_ref().and_then(|n| n.year));
    let folder = if d.transfer.is_some() {
        let f = naming_formats(&st.db).await?;
        let named = if series {
            naming::apply_series_folder_format(
                &f.series_folder,
                &SeriesFolder {
                    series_title: title.clone(),
                    original_title: None,
                    year: year.map(i64::from),
                    tmdb_id: None,
                },
            )
        } else {
            naming::apply_movie_folder_format(
                &f.movie_folder,
                &MovieFolder {
                    title: title.clone(),
                    original_title: None,
                    year: year.map(i64::from),
                    tmdb_id: None,
                },
            )
        };
        validate_folder_name(&named)
            .map_err(|_| AppError::bad_request(format!("Invalid folder name for \"{title}\"")))?
            .to_owned()
    } else {
        d.folder_name.clone()
    };
    let key = format!("{}:{}:{folder}", lib.id, d.media_type);
    let _lock = st.ingest.unmatched.lock(key.clone()).await;
    let existing = if folder.is_empty() {
        let wanted: Vec<String> = d
            .files
            .iter()
            .map(|f| file_name(Path::new(&f.path)))
            .collect();
        sqlx::query_scalar!(
            r#"SELECT m.id FROM media m WHERE m."libraryId" = $1 AND m.type::text = $2 AND m."folderName" = ''
               AND EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id AND f."relativePath" = ANY($3))
               ORDER BY m.id LIMIT 1"#,
            lib.id,
            d.media_type,
            &wanted
        )
        .fetch_optional(&st.db)
        .await?
    } else {
        sqlx::query_scalar!(
            r#"SELECT id FROM media WHERE "libraryId" = $1 AND type::text = $2 AND "folderName" = $3 ORDER BY id LIMIT 1"#,
            lib.id,
            d.media_type,
            folder
        )
        .fetch_optional(&st.db)
        .await?
    };
    let (id, created) = match existing {
        Some(id) => (id, false),
        None => {
            if d.transfer.is_none() {
                let outside = || AppError::bad_request("File outside the library root");
                let root = fsx::Root::open(&lib.path).map_err(|_| outside())?;
                let real = fs::canonicalize(&sample).map_err(|_| outside())?;
                if !root.contains(&real, false) || !root.contains(&art_dir, true) {
                    return Err(outside());
                }
            }
            let nfo = match transfer_nfo {
                Some(mut n) => {
                    n.title = None;
                    Some(n)
                }
                None if d.transfer.is_some() => None,
                None => read_nfo().await,
            };
            let artwork = local_artwork(&art_dir, art_base.as_deref(), root_movie);
            let id = mw::create_unmatched(
                st,
                mw::Unmatched {
                    title,
                    year,
                    media_type: d.media_type.clone(),
                    library_id: d.library_id,
                    folder_name: folder,
                    quality_profile_id: d.quality_profile_id,
                    language_profile_id: d.language_profile_id,
                    library_default_quality: lib.dq,
                    library_default_language: lib.dl,
                    nfo,
                    artwork,
                },
                user,
            )
            .await?;
            (id, true)
        }
    };
    *st.ingest
        .unmatched_holders
        .lock()
        .expect("holders")
        .entry(id)
        .or_default() += 1;
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| AppError::bad_request("Media not found after import"))?;
    Ok((media, created, key))
}

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
