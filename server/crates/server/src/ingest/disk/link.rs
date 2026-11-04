//! Linking disk files to media: the orphan relink, the import confirm and the unmatched-media find or create.
use super::*;
use crate::ingest::books;
use fliks_domain::{
    external_id::Namespace,
    media::family::Family,
    naming::{BookNameTokens, apply_book_format},
};

/// Rules 82-87 under the media's lock.
pub(super) async fn link_files(
    st: &AppState,
    d: &RelinkDto,
    lib: &Lib,
    media: &MediaRow,
    folder: &str,
    created: bool,
    unmatched_key: Option<&str>,
) -> Result<(i64, i64, Vec<String>), AppError> {
    if let Some(l) = media.library_id
        && l != d.library_id
    {
        return Err(AppError::bad_request(
            "Media already belongs to another library",
        ));
    }
    let guard = st.ingest.media.lock(media.id).await;
    let (mut errors, mut slot) = (vec![], false);
    let (linked, present) =
        if d.reorganize || d.transfer.is_some() {
            relink_moved(st, &guard, d, lib, media, &mut errors, &mut slot).await?
        } else {
            let linked =
                match relink_in_place(st, &guard, d, lib, media, folder, &mut errors, &mut slot)
                    .await
                {
                    Ok(l) => l,
                    Err(e) => {
                        drop(guard);
                        if let Some(key) = unmatched_key.filter(|_| created) {
                            drop_unmatched_if_empty(st, media.id, key).await?;
                        }
                        return Err(e);
                    }
                };
            (linked, 0)
        };
    let identified = media.tmdb_id.is_some()
        || media.tvdb_id.is_some()
        || media.imdb_id.is_some()
        || crate::media::external_ids::has_plugin_id(&st.db, media.id).await?;
    if media.has_seasons()
        && slot
        && identified
        && let Err(e) = mw::refresh_series_episodes(st, media, d.priority).await
    {
        tracing::warn!("Orphan relink: refreshSeriesEpisodes failed — {}", e.text());
    }
    drop(guard);
    if let Some(key) = unmatched_key.filter(|_| created && linked == 0 && present == 0) {
        drop_unmatched_if_empty(st, media.id, key).await?;
    }
    Ok((linked, present, errors))
}

async fn relink_moved(
    st: &AppState,
    guard: &tokio::sync::OwnedMutexGuard<()>,
    d: &RelinkDto,
    lib: &Lib,
    media: &MediaRow,
    errors: &mut Vec<String>,
    slot: &mut bool,
) -> Result<(i64, i64), AppError> {
    let (mut linked, mut present) = (0i64, 0i64);
    let mut entries = vec![];
    for f in &d.files {
        let name = file_name(Path::new(&f.path));
        // An in-place reorganize moves files that are already in this library, nothing else.
        if d.transfer.is_none()
            && !fsx::Root::open(&lib.path)
                .is_ok_and(|r| dunce::canonicalize(&f.path).is_ok_and(|p| r.contains(&p, false)))
        {
            errors.push(format!("{name}: file outside the library root"));
            continue;
        }
        let mut episode_id = None;
        if media.has_seasons() {
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
                    *slot |= c;
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
            guard,
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
    Ok((linked, present))
}

#[allow(clippy::too_many_arguments)]
async fn relink_in_place(
    st: &AppState,
    guard: &tokio::sync::OwnedMutexGuard<()>,
    d: &RelinkDto,
    lib: &Lib,
    media: &MediaRow,
    folder: &str,
    errors: &mut Vec<String>,
    slot: &mut bool,
) -> Result<i64, AppError> {
    let mut linked = 0i64;
    let _moves = st.folder_moves.read().await;
    if let (Some(id), Some(path)) = (d.folder_id, &d.folder_path) {
        let now: Option<String> =
            sqlx::query_scalar("SELECT path FROM library_folders WHERE id = $1")
                .bind(id)
                .fetch_optional(&st.db)
                .await?;
        if now.as_ref() != Some(path) {
            return Err(AppError::conflict(FOLDER_MOVED));
        }
    }
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
        sqlx::query!(
            r#"UPDATE media SET "libraryId" = $2, "folderName" = $3 WHERE id = $1"#,
            media.id,
            lib.id,
            folder
        )
        .execute(&st.db)
        .await?;
        if current.library_id.is_none() {
            crate::media::items::point_wants_at_default_folder(&st.db, media.id).await?;
        }
        current = load_media(&st.db, media.id).await?.unwrap_or(current);
    }
    if current.library_id.is_none() {
        sqlx::query!(
            r#"UPDATE media SET "libraryId" = $2 WHERE id = $1 AND "libraryId" IS NULL"#,
            media.id,
            lib.id
        )
        .execute(&st.db)
        .await?;
        crate::media::items::point_wants_at_default_folder(&st.db, media.id).await?;
        current = load_media(&st.db, media.id).await?.unwrap_or(current);
    }
    if current.media_type == MediaKind::Book {
        let mut placed = vec![];
        for f in &d.files {
            let abs = PathBuf::from(resolve(&f.path, "/"));
            match crate::ingest::rescan::locate_in_place(st, &current, &abs).await? {
                Err(e) => errors.push(format!("{}: {e}", file_name(&abs))),
                Ok(l) => placed.push(books::Placed {
                    folder_id: l.folder.id,
                    rel: l.rel,
                    abs: l.real,
                }),
            }
        }
        if !placed.is_empty() {
            match books::register(st, media.id, &placed).await {
                Ok(done) => {
                    linked += done.files.len() as i64;
                    errors.extend(done.conflicts);
                    if let Some(first) = done.files.first() {
                        st.hub.emit_domain(DomainEvent::MediaFilesImported {
                            media_id: i64::from(media.id),
                            family: first.family,
                            season_number: None,
                            episode_number: None,
                            source: ImportSource::Disk,
                        });
                    }
                }
                Err(e) => errors.push(e),
            }
        }
        return Ok(linked);
    }
    for f in &d.files {
        let abs = PathBuf::from(resolve(&f.path, "/"));
        let nums = caller_nums(f.season, f.episode, f.end);
        match link_in_place(st, guard, &current, &abs, nums).await? {
            Err(e) => errors.push(format!("{}: {e}", file_name(&abs))),
            Ok(l) => {
                linked += 1;
                *slot |= l.created;
                st.ingest.queue.enqueue(st, l.file_id).await;
            }
        }
    }
    if linked > 0 {
        st.hub.emit_domain(DomainEvent::MediaFilesImported {
            media_id: i64::from(media.id),
            family: Family::Video,
            season_number: None,
            episode_number: None,
            source: ImportSource::Disk,
        });
        st.ingest.settle.schedule(st, media.id);
    }

    Ok(linked)
}

/// An unmatched media nobody else holds and without a file is dropped again.
async fn drop_unmatched_if_empty(st: &AppState, media_id: i32, key: &str) -> Result<(), AppError> {
    let _k = st.ingest.unmatched.lock(key.to_owned()).await;
    let holders = st
        .ingest
        .unmatched_holders
        .lock_clean()
        .get(&media_id)
        .copied();
    let files = sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM media_files WHERE "mediaId" = $1"#,
        media_id
    )
    .fetch_one(&st.db)
    .await?;
    if holders == Some(1) && files == 0 {
        sqlx::query!("DELETE FROM media WHERE id = $1", media_id)
            .execute(&st.db)
            .await?;
    }

    Ok(())
}

/// `confirmImport` (rule 92); the caller holds the media's lock.
pub(super) async fn confirm_import(
    st: &AppState,
    guard: &tokio::sync::OwnedMutexGuard<()>,
    media_id: i32,
    lib: &Lib,
    entries: Vec<(String, Option<i32>, &'static str)>,
    method: Method,
    uniquify: bool,
) -> Result<(i64, i64, Vec<String>), AppError> {
    let (mut imported, mut present, mut errors) = (0i64, 0i64, vec![]);
    let mut book_files: Vec<library::File> = vec![];
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
            Ok(m) if !m.is_file() || !books::owns(media.media_type, &name) => {
                errors.push(format!(
                    "{name}: not a {} file",
                    if media.media_type == MediaKind::Book {
                        "book"
                    } else {
                        "video"
                    }
                ));
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
                if folder_error(media.media_type, &folder) {
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
                crate::media::items::point_wants_at_default_folder(&st.db, media.id).await?;
            }
        }
        let file = library::File {
            path: PathBuf::from(&path),
            episode_id,
        };
        // A book's files are ingested together: the parts of one audiobook are one version.
        if media.media_type == MediaKind::Book {
            book_files.push(file);
            continue;
        }
        let r = ingest_files(st, guard, media_id, vec![file], method, quality, uniquify).await;
        tally(st, &name, r, &mut imported, &mut present, &mut errors);
    }
    if !book_files.is_empty() {
        let r = ingest_files(st, guard, media_id, book_files, method, "", uniquify).await;
        tally(st, "books", r, &mut imported, &mut present, &mut errors);
    }
    Ok((imported, present, errors))
}

async fn ingest_files(
    st: &AppState,
    guard: &tokio::sync::OwnedMutexGuard<()>,
    media_id: i32,
    files: Vec<library::File>,
    method: Method,
    quality: &str,
    uniquify: bool,
) -> Result<library::Outcome, String> {
    library::ingest(
        st,
        guard,
        library::Request {
            media_id,
            files,
            transfer: method,
            fallback_quality: Some(quality.to_owned()),
            release_name: None,
            force: false,
            uniquify_on_collision: uniquify,
            replace_existing: false,
            language: None,
        },
    )
    .await
}

fn tally(
    st: &AppState,
    name: &str,
    r: Result<library::Outcome, String>,
    imported: &mut i64,
    present: &mut i64,
    errors: &mut Vec<String>,
) {
    match r {
        Ok(o) => {
            *imported += o.imported.len() as i64;
            *present += o.already_present.len() as i64;
            errors.extend(o.errors);
            if !o.imported.is_empty() {
                crate::media_servers::dispatch_detached(st, "library.rescan");
            }
        }
        Err(e) => errors.push(format!("{name}: {e}")),
    }
}

pub(super) fn pin_folder(f: &naming::NamingFormats, m: &MediaRow) -> String {
    let (year, tmdb_id) = (m.year.map(i64::from), m.tmdb_id.map(i64::from));
    match m.media_type {
        MediaKind::Series => naming::apply_series_folder_format(
            &f.series_folder,
            &SeriesFolder {
                series_title: m.title.clone(),
                original_title: m.original_title.clone(),
                year,
                tmdb_id,
            },
        ),
        MediaKind::Book | MediaKind::Comic => book_folder(f, &m.title, year),
        MediaKind::Movie => naming::apply_movie_folder_format(
            &f.movie_folder,
            &MovieFolder {
                title: m.title.clone(),
                original_title: m.original_title.clone(),
                year,
                tmdb_id,
            },
        ),
    }
}

/// Whether `name` is no valid `folderName` for a media of `kind` (a book's may hold several components).
fn folder_error(kind: MediaKind, name: &str) -> bool {
    match kind {
        MediaKind::Book => naming::validate_folder_path(name).is_err(),
        _ => validate_folder_name(name).is_err(),
    }
}

fn book_folder(f: &naming::NamingFormats, title: &str, year: Option<i64>) -> String {
    apply_book_format(
        &f.book_folder,
        &BookNameTokens {
            title: title.to_owned(),
            year,
            ..Default::default()
        },
    )
}

/// `findOrImportIdentified` (rule 78: a numeric id).
pub(super) async fn find_or_import(
    st: &AppState,
    a: &Authed,
    d: &RelinkDto,
) -> Result<(MediaRow, bool), AppError> {
    let raw = d.external_id.clone().unwrap_or_default();
    let ns = match d.provider.as_deref() {
        None | Some("tmdb") => Namespace::TMDB,
        Some(p) => Namespace::parse(p)
            .filter(|n| match n.core() {
                Some(_) => *n == Namespace::TVDB,
                None => st
                    .metadata
                    .get(*n)
                    .is_some_and(|m| m.supports(d.media_type)),
            })
            .ok_or_else(|| AppError::bad_request(format!("Unknown provider: {p}")))?,
    };
    let ext = match ns.core() {
        Some(_) => raw
            .trim()
            .parse::<i32>()
            .ok()
            .filter(|n| *n > 0)
            .map(|n| n.to_string()),
        None => ns.normalize(raw.trim()),
    }
    .ok_or_else(|| {
        AppError::bad_request(vec!["externalId is not an id of the provider".to_owned()])
    })?;
    let lookup = async || -> Result<Option<MediaRow>, AppError> {
        let id = if ns.is_unique() {
            crate::media::external_ids::find(&st.db, d.media_type, ns, &ext).await?
        } else {
            crate::media::external_ids::find_in_library(
                &st.db,
                d.media_type,
                ns,
                &ext,
                d.library_id,
            )
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
    let provider = Some(ns.as_str().to_owned());
    let imported = async {
        let target =
            mw::resolve_target(st, a, d.media_type, Some(d.library_id), d.folder_id).await?;
        let imp = mw::Import {
            media_type: d.media_type,
            library_id: target.id,
            folder_id: target.folder_id,
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
            links: vec![],
        };
        mw::import_title(st, provider, ext.clone(), imp, d.priority).await
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
pub(super) fn series_folder_of(file: &Path, folder: &str, scan_root: Option<&str>) -> PathBuf {
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
pub(super) fn local_artwork(dir: &Path, base: Option<&str>, base_only: bool) -> mw::Artwork {
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

/// The folder the media lives in: named from the formats on a transfer, else the one the caller gave.
async fn target_folder(
    st: &AppState,
    d: &RelinkDto,
    title: &str,
    year: Option<i32>,
) -> Result<String, AppError> {
    Ok(if d.transfer.is_some() {
        let f = naming_formats(&st.db).await?;
        let named = match d.media_type {
            MediaKind::Series => naming::apply_series_folder_format(
                &f.series_folder,
                &SeriesFolder {
                    series_title: title.to_owned(),
                    original_title: None,
                    year: year.map(i64::from),
                    tmdb_id: None,
                },
            ),
            MediaKind::Book | MediaKind::Comic => book_folder(&f, title, year.map(i64::from)),
            MediaKind::Movie => naming::apply_movie_folder_format(
                &f.movie_folder,
                &MovieFolder {
                    title: title.to_owned(),
                    original_title: None,
                    year: year.map(i64::from),
                    tmdb_id: None,
                },
            ),
        };
        if folder_error(d.media_type, &named) {
            return Err(AppError::bad_request(format!(
                "Invalid folder name for \"{title}\""
            )));
        }
        named
    } else {
        d.folder_name.clone()
    })
}

async fn existing_unmatched(
    st: &AppState,
    d: &RelinkDto,
    lib: &Lib,
    folder: &str,
) -> Result<Option<i32>, AppError> {
    Ok(if folder.is_empty() {
        // A loose media is found by the paths its files hold under the library folder.
        let roots: Vec<&crate::libraries::Folder> = lib
            .folders
            .iter()
            .filter(|f| d.folder_id.is_none_or(|id| id == f.id))
            .collect();
        let wanted: Vec<String> = d
            .files
            .iter()
            .flat_map(|f| {
                let abs = PathBuf::from(resolve(&f.path, "/"));
                roots
                    .iter()
                    .filter_map(move |r| fsx::rel_under(Path::new(&resolve(&r.path, "/")), &abs))
            })
            .collect();
        let folders: Vec<i32> = roots.iter().map(|f| f.id).collect();
        sqlx::query_scalar!(
            r#"SELECT m.id FROM media m WHERE m."libraryId" = $1 AND m.type = $2 AND m."folderName" = ''
               AND EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id
                           AND f."folderId" = ANY($4) AND f."relativePath" = ANY($3))
               ORDER BY m.id LIMIT 1"#,
            lib.id,
            d.media_type.as_str(),
            &wanted,
            &folders
        )
        .fetch_optional(&st.db)
        .await?
    } else {
        sqlx::query_scalar!(
            r#"SELECT id FROM media WHERE "libraryId" = $1 AND type = $2 AND "folderName" = $3 ORDER BY id LIMIT 1"#,
            lib.id,
            d.media_type.as_str(),
            folder
        )
        .fetch_optional(&st.db)
        .await?
    })
}

/// `findOrCreateUnmatched` (rules 79-81) under the `(library, type, folder)` lock.
pub(super) async fn find_or_create_unmatched(
    st: &AppState,
    d: &RelinkDto,
    lib: &Lib,
    user: i32,
) -> Result<(MediaRow, bool, String), AppError> {
    let sample = PathBuf::from(resolve(&d.files[0].path, "/"));
    let art_dir = match d.media_type {
        MediaKind::Movie | MediaKind::Book | MediaKind::Comic => {
            sample.parent().unwrap_or(&sample).to_path_buf()
        }
        MediaKind::Series if d.transfer.is_some() => {
            series_folder_of(&sample, &d.folder_name, d.scan_root.as_deref())
        }
        MediaKind::Series => PathBuf::from(&lib.path).join(&d.folder_name),
    };
    let root_movie = d.folder_name.is_empty();
    let art_base = match d.media_type {
        MediaKind::Movie | MediaKind::Book | MediaKind::Comic => {
            Some(split_ext(&file_name(&sample)).0.to_owned())
        }
        MediaKind::Series => None,
    };
    let nfo = group_nfo(d.media_type, &art_dir, &sample, root_movie).await;
    let root = d.scan_root.as_deref().map_or_else(
        || PathBuf::from(&lib.path),
        |r| PathBuf::from(resolve(&crate::libraries::sanitize_path(r), "/")),
    );
    let (guessed_title, guessed_year) = guess(d.media_type, &root, &sample, nfo.as_ref());
    let title = d
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .or(guessed_title)
        .unwrap_or_else(|| d.folder_name.clone());
    let year = d.year.or(guessed_year.and_then(|y| i32::try_from(y).ok()));
    let folder = target_folder(st, d, &title, year).await?;
    let key = format!("{}:{}:{folder}", lib.id, d.media_type);
    let _lock = st.ingest.unmatched.lock(key.clone()).await;
    let existing = existing_unmatched(st, d, lib, &folder).await?;
    let (id, created) = match existing {
        Some(id) => (id, false),
        None => {
            if d.transfer.is_none() {
                let outside = || AppError::bad_request("File outside the library root");
                let root = fsx::Root::open(&lib.path).map_err(|_| outside())?;
                let real = dunce::canonicalize(&sample).map_err(|_| outside())?;
                if !root.contains(&real, false) || !root.contains(&art_dir, true) {
                    return Err(outside());
                }
            }
            let artwork = local_artwork(&art_dir, art_base.as_deref(), root_movie);
            let id = mw::create_unmatched(
                st,
                mw::Unmatched {
                    title,
                    year,
                    media_type: d.media_type,
                    library_id: d.library_id,
                    folder_id: d.folder_id,
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
        .lock_clean()
        .entry(id)
        .or_default() += 1;
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| AppError::bad_request("Media not found after import"))?;
    Ok((media, created, key))
}
