//! Disk import routes (`ingest.md` rules 60-93): orphan scan, preview, relink and its batch.
use super::{
    MediaRow, books, fsx, is_video,
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
        kind::MediaKind,
        path::resolve,
    },
    metadata::limiter::Priority,
    naming::{
        self, MovieFolder, SeriesFolder, is_special_file, parse_episode_numbers,
        validate_folder_name, validate_folder_path,
    },
    nfo::NfoData,
    release::parsing::{
        quality::parse_release_quality,
        title::{ExtractedRelease, extract_media_title},
    },
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
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
    folders: Vec<crate::libraries::Folder>,
    types: Vec<MediaKind>,
    provider: Option<String>,
    dq: Option<i32>,
    dl: Option<i32>,
}

/// `requirePathFor`: 404 unknown, 400 without a root path.
async fn require_path(st: &AppState, id: i32) -> Result<Lib, AppError> {
    let r = sqlx::query!(
        r#"SELECT l.id, l.name, df.path AS "path?", l."mediaTypes" AS types,
                  l."preferredProvider" AS provider, l."defaultQualityProfileId" AS dq,
                  l."defaultLanguageProfileId" AS dl
           FROM libraries l LEFT JOIN library_default_folders df ON df."libraryId" = l.id WHERE l.id = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("Library #{id} not found")))?;
    let Some(path) = r.path.filter(|p| !p.is_empty()) else {
        return Err(AppError::bad_request(format!(
            "Library #{id} has no root path configured"
        )));
    };
    let folders = sqlx::query!(
        r#"SELECT id, path FROM library_folders WHERE "libraryId" = $1 ORDER BY position, id"#,
        id
    )
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .map(|f| crate::libraries::Folder {
        id: f.id,
        path: f.path,
    })
    .collect();
    Ok(Lib {
        id: r.id,
        name: r.name,
        path,
        folders,
        types: serde_json::from_value::<Vec<String>>(r.types)
            .unwrap_or_default()
            .iter()
            .filter_map(|t| MediaKind::parse(t))
            .collect(),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    folder_id: Option<i32>,
    group_key: String,
    media_type: MediaKind,
    folder_name: String,
    guess_title: String,
    guess_year: Option<i64>,
    nfo: Option<NfoData>,
    suggested_provider: String,
    files: Vec<FileEntry>,
}

/// Rule 62: depth 3, bonus folders below the scan root skipped, regular video files only. Book
/// files, when the library takes books, are read one level deeper and never through a link.
pub(crate) fn collect(dir: &Path, depth: usize, book: bool, out: &mut Vec<PathBuf>) {
    if depth > if book { BOOK_DEPTH } else { 3 } {
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
        let kind = e.file_type();
        if kind.as_ref().is_ok_and(|t| t.is_dir()) {
            if !(depth > 0 && is_bonus_dir(&name)) {
                subdirs.push(e.path());
            }
        } else if book && books::is_book_file(&name) {
            if kind.is_ok_and(|t| t.is_file()) {
                out.push(e.path());
            }
        } else if depth <= 3
            && is_video(&name)
            && !is_sample_file(&name)
            && fs::metadata(e.path()).is_ok_and(|m| m.is_file())
        {
            out.push(e.path());
        }
    }
    for s in subdirs {
        collect(&s, depth + 1, book, out);
    }
}

/// `Author/Series/Title/CD1/part`: the root, four folders, then the file.
const BOOK_DEPTH: usize = 4;

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

pub(crate) fn subject_titled(title: &str) -> Subj {
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

/// What one folder walk found.
struct Scanned {
    groups: Vec<Group>,
    scanned_files: usize,
    orphan_count: usize,
}

/// `scanOrphansUnder` (rules 62-66): reads only; `folder_id` tags the groups of a library folder.
async fn scan_under(
    st: &AppState,
    root: &str,
    folder_id: Option<i32>,
    types: &[MediaKind],
    provider: &str,
    linked: &HashMap<PathBuf, String>,
) -> Scanned {
    let key = format!("OrphanScan:{root}");
    let r = PathBuf::from(root);
    let book = types.contains(&MediaKind::Book);
    let all = tokio::task::spawn_blocking(move || {
        let mut out = vec![];
        collect(&r, 0, book, &mut out);
        out
    })
    .await
    .unwrap_or_default();
    let (book_files, video): (Vec<&PathBuf>, Vec<&PathBuf>) =
        all.iter().partition(|p| books::is_book_file(&file_name(p)));
    let unlinked: Vec<&PathBuf> = video
        .into_iter()
        .filter(|p| !linked.contains_key(*p))
        .collect();
    let total = unlinked.len() + 1;
    progress(st, &key, root, 0, total);
    let root_p = Path::new(root);
    let mut groups: Vec<Group> = vec![];
    let mut group_at: HashMap<String, usize> = HashMap::new();
    let mut orphan_count = 0;
    for (i, abs) in unlinked.iter().enumerate() {
        if (i + 1) % 25 == 0 {
            progress(st, &key, root, i + 1, total);
        }
        let name = file_name(abs);
        let abs_s = abs.to_string_lossy().into_owned();
        let nums = parse_episode_numbers(&name, Some(&abs_s));
        let series = nums.is_some() || is_special_file(&abs_s);
        let media_type = if series {
            MediaKind::Series
        } else {
            MediaKind::Movie
        };
        if !types.contains(&media_type) {
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
            size: tokio::fs::metadata(abs).await.map_or(0, |m| m.len()),
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
        match group_at.get(&key) {
            Some(&i) => groups[i].files.push(entry),
            None => {
                group_at.insert(key.clone(), groups.len());
                groups.push(Group {
                    folder_id,
                    group_key: key,
                    media_type,
                    folder_name: folder.clone(),
                    guess_title: folder,
                    guess_year: None,
                    nfo: None,
                    suggested_provider: provider.to_owned(),
                    files: vec![entry],
                });
            }
        }
    }
    for g in &mut groups {
        let sample = PathBuf::from(&g.files[0].file_path);
        g.nfo = nfo::for_video(&sample).await;
        let ex = guess_from_path(root_p, &sample);
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
    let works = book_groups(root_p, folder_id, provider, &book_files, linked).await;
    orphan_count += works.iter().map(|g| g.files.len()).sum::<usize>();
    groups.extend(works);
    progress(st, &key, root, total, total);
    st.hub.activity().remove(&key);
    Scanned {
        groups,
        scanned_files: all.len(),
        orphan_count,
    }
}

/// The file name's title, unless it has no year and a folder between it and `root` has one
/// (`00000.m2ts` in `Title (2024)/`, a disc's `BDMV/STREAM`).
fn guess_from_path(root: &Path, file: &Path) -> ExtractedRelease {
    let ex = extract_media_title(&file_name(file));
    if ex.year.is_some() {
        return ex;
    }
    file.ancestors()
        .skip(1)
        .take_while(|d| d.starts_with(root) && *d != root)
        .map(|d| extract_media_title(&file_name(d)))
        .find(|f| f.year.is_some())
        .unwrap_or(ex)
}

/// The works the book files make, one orphan group each for the works that have a file still
/// unlinked (`book-import.md` rules 1-2). `files` is every book file of the root, linked or not.
async fn book_groups(
    root: &Path,
    folder_id: Option<i32>,
    provider: &str,
    files: &[&PathBuf],
    linked: &HashMap<PathBuf, String>,
) -> Vec<Group> {
    let by_rel: HashMap<String, &PathBuf> = files
        .iter()
        .filter_map(|p| Some((fsx::rel_under(root, p)?, *p)))
        .collect();
    let rels: Vec<String> = by_rel.keys().cloned().collect();
    let mut out = vec![];
    for w in books::plan::plan(&rels, |r| linked.get(by_rel[r]).cloned()) {
        let mut entries = vec![];
        for rel in &w.files {
            let abs = by_rel[rel];
            entries.push(FileEntry {
                file_path: abs.to_string_lossy().into_owned(),
                filename: file_name(abs),
                size: tokio::fs::metadata(abs).await.map_or(0, |m| m.len()),
                quality_name: "",
                quality_id: 0,
                season_number: None,
                episode_number: None,
                episode_end: None,
            });
        }
        out.push(Group {
            folder_id,
            group_key: format!("book:{}", w.name_path),
            media_type: MediaKind::Book,
            folder_name: w.anchor.unwrap_or_default(),
            guess_title: w.title,
            guess_year: w.year.map(i64::from),
            nfo: None,
            suggested_provider: provider.to_owned(),
            files: entries,
        });
    }
    out
}

fn scanned_json(
    root: &str,
    folders: Option<&[crate::libraries::Folder]>,
    s: Vec<Scanned>,
) -> Value {
    let scanned_files: usize = s.iter().map(|f| f.scanned_files).sum();
    let orphan_count: usize = s.iter().map(|f| f.orphan_count).sum();
    let groups: Vec<Group> = s.into_iter().flat_map(|f| f.groups).collect();
    let mut v = json!({
        "libraryPath": root,
        "groups": groups,
        "scannedFiles": scanned_files,
        "orphanCount": orphan_count,
    });
    if let (Some(f), Some(o)) = (folders, v.as_object_mut()) {
        o.insert(
            "folders".into(),
            f.iter()
                .map(|f| json!({"id": f.id, "path": f.path}))
                .collect(),
        );
    }
    v
}

/// Every linked book or video file of the library, by absolute path, with its media's folder name.
pub(crate) async fn linked_owners(
    st: &AppState,
    library: i32,
) -> Result<HashMap<PathBuf, String>, sqlx::Error> {
    Ok(sqlx::query!(
        r#"SELECT mf."relativePath" AS rel, lf.path AS folder, COALESCE(m."folderName", '') AS "owner!"
           FROM media_files mf JOIN library_folders lf ON lf.id = mf."folderId"
           LEFT JOIN media m ON m.id = mf."mediaId" WHERE lf."libraryId" = $1"#,
        library
    )
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .map(|r| {
        (
            PathBuf::from(resolve(
                &fliks_domain::media::path::join(&r.folder, &r.rel.replace('\\', "/")),
                "/",
            )),
            r.owner,
        )
    })
    .collect())
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
    let linked = linked_owners(&st, id).await?;
    let mut scanned = vec![];
    for f in &lib.folders {
        scanned.push(
            scan_under(
                &st,
                &resolve(&f.path, "/"),
                Some(f.id),
                &lib.types,
                lib.provider.as_deref().unwrap_or("tmdb"),
                &linked,
            )
            .await,
        );
    }
    let mut v = scanned_json(&resolve(&lib.path, "/"), Some(&lib.folders), scanned);
    if !paths_visible(&a.perms)
        && let Some(o) = v.as_object_mut()
    {
        o.remove("libraryPath");
        o.remove("folders");
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
        Some(Some(t)) => t
            .iter()
            .map(|t| MediaKind::parse(t))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| {
                AppError::bad_request(vec![format!(
                    "each value in mediaTypes {}",
                    MediaKind::one_of_message()
                )])
            })?,
        _ => MediaKind::ALL.to_vec(),
    };
    let provider = b
        .str("preferredProvider")?
        .flatten()
        .unwrap_or_else(|| "tmdb".into());
    let clean = crate::libraries::sanitize_path(&path);
    if !Path::new(&clean).is_absolute() {
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
    let scanned = scan_under(&st, &root, None, &types, &provider, &HashMap::new()).await;
    Ok((
        StatusCode::CREATED,
        Json(scanned_json(&root, None, vec![scanned])),
    ))
}

#[utoipa::path(post, path = "/api/imports/library/orphans/relink", responses((status = 201)))]
pub async fn relink(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Create, Subject::Media)?;
    let mut d = parse_relink(v, "")?;
    d.priority = Priority::Interactive;
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

fn validated_folder(name: &str, media_type: MediaKind) -> Result<String, AppError> {
    if name.is_empty() {
        match media_type {
            MediaKind::Movie | MediaKind::Book => return Ok(String::new()),
            MediaKind::Series => {}
        }
    }
    match media_type {
        MediaKind::Book => validate_folder_path(name),
        _ => validate_folder_name(name),
    }
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
    relink_core(st, Some(a), a.user.id, d).await
}

/// One work of a bulk import: its files linked in place to an unmatched book (`book-import.md` rule 6).
pub(crate) struct BookWork {
    pub library_id: i32,
    pub folder_id: i32,
    /// The folder's path `files` were resolved against.
    pub folder_path: String,
    pub folder_name: String,
    pub title: String,
    pub year: Option<i32>,
    pub files: Vec<PathBuf>,
}

/// The message of the error a link raises when its folder moved after the caller read the path.
pub(crate) const FOLDER_MOVED: &str = "errors.folder_moved";

pub(crate) struct Linked {
    pub media_id: i32,
    pub linked: i64,
    pub errors: Vec<String>,
}

pub(crate) async fn link_book_work(
    st: &AppState,
    user: i32,
    w: BookWork,
) -> Result<Linked, AppError> {
    let d = RelinkDto {
        library_id: w.library_id,
        media_type: MediaKind::Book,
        external_id: None,
        provider: None,
        title: Some(w.title),
        year: w.year,
        quality_profile_id: None,
        language_profile_id: None,
        folder_name: w.folder_name,
        scan_root: None,
        reorganize: false,
        transfer: None,
        folder_id: Some(w.folder_id),
        folder_path: Some(w.folder_path),
        files: w
            .files
            .into_iter()
            .map(|p| RelinkFile {
                path: p.to_string_lossy().into_owned(),
                season: None,
                episode: None,
                end: None,
            })
            .collect(),
        priority: Priority::Background,
    };
    let r = relink_core(st, None, user, d).await?;
    Ok(Linked {
        media_id: r["mediaId"]
            .as_i64()
            .and_then(|m| i32::try_from(m).ok())
            .unwrap_or_default(),
        linked: r["linked"].as_i64().unwrap_or(0),
        errors: serde_json::from_value(r["errors"].clone()).unwrap_or_default(),
    })
}

/// `relink_orphans` after the library access check; `a` is only needed to import an identified title.
async fn relink_core(
    st: &AppState,
    a: Option<&Authed>,
    user: i32,
    d: RelinkDto,
) -> Result<Value, AppError> {
    let lib = require_path(st, d.library_id).await?;
    if let Some(f) = d.folder_id {
        crate::libraries::assert_folder_in_library(&st.db, lib.id, f).await?;
    }
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
        None => validated_folder(&d.folder_name, d.media_type)?,
        Some(_) => String::new(),
    };
    let (media, created, unmatched_key) = match &d.external_id {
        Some(_) => {
            let a = a.ok_or_else(|| AppError::bad_request("An identified title needs a caller"))?;
            let (m, c) = find_or_import(st, a, &d).await?;
            (m, c, None)
        }
        None => {
            let (m, c, k) = find_or_create_unmatched(st, &d, &lib, user).await?;
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
    use super::{guess_from_path, parse_relink};
    use std::path::Path;

    #[test]
    fn a_yearless_file_name_takes_the_title_of_its_folder() {
        let root = Path::new("/m/Movies");
        let g = |p: &str| {
            let e = guess_from_path(root, &root.join(p));
            (e.title, e.year)
        };
        let extra = ("A Little Something Extra".to_owned(), Some(2024));
        assert_eq!(g("A Little Something Extra (2024)/00000.m2ts"), extra);
        assert_eq!(
            g("A Little Something Extra (2024)/BDMV/STREAM/00000.m2ts"),
            extra
        );
        assert_eq!(
            g("Other (2001)/Avatar.2009.2160p.mkv"),
            ("Avatar".to_owned(), Some(2009))
        );
        assert_eq!(g("Avatar.mkv").1, None);
    }
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
