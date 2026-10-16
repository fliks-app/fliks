//! Radarr and Sonarr: connection test, root folder preview and the media import (`importers.md` A-C).
use super::{db, dto, fetch, subtitles};
use crate::{
    http::{AppError, auth::Authed},
    outbound::{ITEM_TIMEOUT, LIST_TIMEOUT, TEST_TIMEOUT, base_url, error_text},
    state::AppState,
};
use axum::{Json, http::StatusCode};
use fliks_domain::{
    acl::{Action, Subject},
    arr_import::{
        Mapped, PathMapping, RemoteItem, apply_path_mapping, extname, language_from_name,
        map_remote_items, parse_language_from_path, resolve_cutoff, suggest_local_library_id,
    },
    media::path::{join, media_path, normalize},
    naming::validate_folder_name,
};
use serde_json::{Value, json};
use std::collections::HashMap;

type Res<T> = Result<T, AppError>;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Arr {
    Radarr,
    Sonarr,
}

impl Arr {
    fn name(self) -> &'static str {
        match self {
            Self::Radarr => "Radarr",
            Self::Sonarr => "Sonarr",
        }
    }
    fn key_setting(self) -> &'static str {
        match self {
            Self::Radarr => "radarr_api_key",
            Self::Sonarr => "sonarr_api_key",
        }
    }
    pub(super) fn url_setting(self) -> &'static str {
        match self {
            Self::Radarr => "radarr_url",
            Self::Sonarr => "sonarr_url",
        }
    }
    fn media_type(self) -> &'static str {
        match self {
            Self::Radarr => "movie",
            Self::Sonarr => "series",
        }
    }
    fn list_path(self) -> &'static str {
        self.media_type()
    }
    fn status(self) -> &'static str {
        match self {
            Self::Radarr => "released",
            Self::Sonarr => "continuing",
        }
    }
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// A non-empty string member (`x || fallback`).
fn truthy<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    str_of(v, k).filter(|s| !s.is_empty())
}

fn int_of(v: &Value, k: &str) -> Option<i32> {
    v.get(k)
        .and_then(Value::as_i64)
        .and_then(|n| i32::try_from(n).ok())
}

/// A TMDB id taken from a JSON number or numeric string; anything below 1 is not an id (C33).
fn tmdb_id(v: &Value) -> Option<i32> {
    let n = match v.get("tmdbId")? {
        Value::Number(n) => n.as_f64().filter(|f| f.fract() == 0.0)? as i64,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            t.parse().ok()?
        }
        _ => return None,
    };
    i32::try_from(n).ok().filter(|n| *n >= 1)
}

/// A truthy JS member: not null, `false`, `0` or `''`.
fn has(v: &Value, k: &str) -> bool {
    match v.get(k) {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn label(title: &str) -> &str {
    if title.is_empty() {
        "(no title)"
    } else {
        title
    }
}

fn unreachable_arr(arr: Arr, e: reqwest::Error) -> AppError {
    AppError::bad_request(format!(
        "Cannot connect to {}: {}",
        arr.name(),
        error_text(e)
    ))
}

/// A list call: 400 on a non-2xx (`<Arr> API returned <status>: <reason>`), a transport or decode failure.
async fn fetch_json(arr: Arr, url: String, key: &str, timeout: std::time::Duration) -> Res<Value> {
    let res = fetch(url, key, timeout)
        .await
        .map_err(|e| unreachable_arr(arr, e))?;
    let status = res.status();
    if !status.is_success() {
        return Err(AppError::bad_request(format!(
            "{} API returned {}: {}",
            arr.name(),
            status.as_u16(),
            status.canonical_reason().unwrap_or_default()
        )));
    }
    res.json().await.map_err(|e| unreachable_arr(arr, e))
}

pub(super) async fn test(st: &AppState, arr: Arr, a: Authed, body: Value) -> Res<Json<Value>> {
    a.require(Action::Manage, Subject::Settings)?;
    let c = dto::connection(body, true)?;
    let key =
        super::resolve_key(st, c.api_key, &c.url, arr.key_setting(), arr.url_setting()).await?;
    let url = format!("{}/api/v3/system/status", base_url(&c.url, true));
    let name = arr.name();
    let out = match fetch(url, &key, TEST_TIMEOUT).await {
        Err(e) => json!({"ok": false, "message": error_text(e)}),
        Ok(res) if !res.status().is_success() => {
            let s = res.status();
            json!({"ok": false, "message": format!("{name} returned {} {}", s.as_u16(), s.canonical_reason().unwrap_or_default())})
        }
        Ok(res) => match res.json::<Value>().await {
            Ok(v) => {
                let n = str_of(&v, "instanceName").unwrap_or(name);
                json!({"ok": true, "message": format!("Connecté à {n}")})
            }
            Err(e) => json!({"ok": false, "message": error_text(e)}),
        },
    };
    Ok(Json(out))
}

pub(super) async fn preview(st: &AppState, arr: Arr, a: Authed, body: Value) -> Res<Json<Value>> {
    a.require(Action::Manage, Subject::Settings)?;
    let c = dto::connection(body, false)?;
    let key =
        super::resolve_key(st, c.api_key, &c.url, arr.key_setting(), arr.url_setting()).await?;
    let url = format!("{}/api/v3/rootfolder", base_url(&c.url, true));
    let body = fetch_json(arr, url, &key, LIST_TIMEOUT).await?;
    let decode =
        |what: &str| AppError::bad_request(format!("Cannot connect to {}: {what}", arr.name()));
    let Value::Array(entries) = body else {
        return Err(decode("rootfolder response is not an array"));
    };
    let mut paths = vec![];
    for e in &entries {
        match e {
            Value::Object(o) => match o.get("path") {
                None | Some(Value::Null) => {}
                Some(Value::String(s)) => paths.push(s.as_str()),
                Some(_) => return Err(decode("rootfolder path is not a string")),
            },
            Value::Null => return Err(decode("rootfolder entry is null")),
            _ => {}
        }
    }
    let libraries = db::libraries(&st.db).await?;
    let suggest: Vec<(i32, Option<String>)> =
        libraries.iter().map(|l| (l.id, l.path.clone())).collect();
    let remote: Vec<Value> = paths
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| json!({"remotePath": p, "suggestedLocalLibraryId": suggest_local_library_id(p, &suggest)}))
        .collect();
    let local: Vec<Value> = libraries
        .iter()
        .map(|l| json!({"id": l.id, "name": l.name, "path": l.path}))
        .collect();
    Ok(Json(
        json!({"remoteRootFolders": remote, "localLibraries": local}),
    ))
}

struct Request<'a> {
    base: String,
    key: String,
    update: bool,
    mappings: &'a [PathMapping],
}

pub(super) async fn import(
    st: &AppState,
    arr: Arr,
    a: Authed,
    body: Value,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Create, Subject::Settings)?;
    let b = dto::import_body(body)?;
    let key = super::resolve_key(
        st,
        b.api_key.clone(),
        &b.url,
        arr.key_setting(),
        arr.url_setting(),
    )
    .await?;
    let library = db::libraries(&st.db)
        .await?
        .into_iter()
        .find(|l| l.id == b.target_library_id)
        .ok_or_else(|| {
            AppError::bad_request(format!("Library #{} not found", b.target_library_id))
        })?;
    if !library.media_types.iter().any(|t| t == arr.media_type()) {
        return Err(AppError::bad_request(format!(
            "Library \"{}\" does not accept {}",
            library.name,
            arr.media_type()
        )));
    }
    let mut stray: Vec<i32> = vec![];
    for id in b
        .mappings
        .iter()
        .filter(|m| !m.ignore)
        .filter_map(|m| m.local_library_id)
        .filter(|id| *id != library.id)
    {
        if !stray.contains(&id) {
            stray.push(id);
        }
    }
    if !stray.is_empty() {
        let ids: Vec<String> = stray.iter().map(i32::to_string).collect();
        return Err(AppError::bad_request(format!(
            "Path mappings target a different library than the import (target #{}, mappings: {})",
            library.id,
            ids.join(", ")
        )));
    }
    let req = Request {
        base: base_url(&b.url, true),
        key,
        update: b.update,
        mappings: &b.mappings,
    };
    let list = fetch_json(
        arr,
        format!("{}/api/v3/{}", req.base, arr.list_path()),
        &req.key,
        LIST_TIMEOUT,
    )
    .await?;
    let items = match list {
        Value::Array(a) if !a.is_empty() => a,
        _ => {
            let what = if arr == Arr::Radarr {
                "movies"
            } else {
                "series"
            };
            return Ok((
                StatusCode::CREATED,
                Json(json!({
                    "imported": 0,
                    "errors": [format!("No {what} found in {}", arr.name())],
                    "rootFoldersCreated": [],
                    "qualityProfilesCreated": [],
                })),
            ));
        }
    };
    if items.iter().any(Value::is_null) {
        return Err(AppError::bad_request(format!(
            "Cannot connect to {}: {} list holds a null entry",
            arr.name(),
            arr.list_path()
        )));
    }
    if arr == Arr::Sonarr
        && items
            .iter()
            .all(|s| s.get("tmdbId").is_none_or(Value::is_null))
    {
        return Err(AppError::bad_request(
            "Sonarr v4 or later is required (the series list carries no tmdbId)",
        ));
    }
    let mut errors = vec![];
    let mut created_profiles = vec![];
    let profiles = import_profiles(st, &req, &mut created_profiles).await;
    let mut imported = 0;
    let mut new_series = vec![];
    for item in &items {
        match import_one(st, arr, &req, &profiles, item).await {
            Ok(Outcome::Imported(id)) => {
                imported += 1;
                if arr == Arr::Sonarr
                    && let Some(id) = id
                {
                    new_series.push(id);
                }
            }
            Ok(Outcome::Skipped) => {}
            Err(e) => errors.push(e),
        }
    }
    if !new_series.is_empty() {
        let metadata = st.seams.metadata.clone();
        tokio::spawn(async move {
            for id in new_series {
                if let Err(e) = metadata.refresh(id).await {
                    tracing::warn!(media_id = id, error = %e, "metadata refresh after Sonarr import");
                }
            }
        });
    }
    let mut result = json!({
        "imported": imported,
        "errors": errors,
        "rootFoldersCreated": [],
        "qualityProfilesCreated": created_profiles,
        "subtitlesImported": 0,
    });
    if b.subtitles {
        let n = if arr == Arr::Radarr {
            radarr_subtitles(st, &req, &items, &mut errors).await
        } else {
            sonarr_subtitles(st, &req, &items, &mut errors).await
        };
        result["subtitlesImported"] = n.into();
        result["errors"] = json!(errors);
    }
    tracing::info!(imported, errors = errors.len(), "{} API import", arr.name());
    Ok((StatusCode::CREATED, Json(result)))
}

enum Outcome {
    /// The new row's id for an insert.
    Imported(Option<i32>),
    Skipped,
}

/// One title; every `Err` is that title's entry of `errors`.
async fn import_one(
    st: &AppState,
    arr: Arr,
    req: &Request<'_>,
    profiles: &HashMap<i64, i32>,
    item: &Value,
) -> Result<Outcome, String> {
    let title = str_of(item, "title").unwrap_or_default();
    let Some(tmdb) = tmdb_id(item) else {
        return Err(format!("{}: invalid tmdbId", label(title)));
    };
    let fail = |e: sqlx::Error| format!("{title}: {e}");
    let exists = db::media_by_tmdb(&st.db, tmdb, arr.media_type())
        .await
        .map_err(fail)?;
    let local_profile = item
        .get("qualityProfileId")
        .and_then(Value::as_i64)
        .and_then(|id| profiles.get(&id).copied());
    let path = str_of(item, "path");
    let (library_id, folder) = match apply_path_mapping(path, req.mappings) {
        None => {
            return Err(format!(
                "{}: no path mapping for \"{}\"",
                label(title),
                path.unwrap_or_default()
            ));
        }
        Some(Mapped::Ignore) => return Ok(Outcome::Skipped),
        Some(Mapped::Library {
            library_id,
            folder_name,
        }) => (library_id, folder_name),
    };
    if validate_folder_name(&folder).is_err() {
        return Err(format!(
            "{}: invalid folder name for \"{}\"",
            label(title),
            path.unwrap_or_default()
        ));
    }
    let year = int_of(item, "year");
    let monitored = item.get("monitored").and_then(Value::as_bool);
    let (imdb, overview) = (truthy(item, "imdbId"), truthy(item, "overview"));
    match exists {
        Some(_) if !req.update => Ok(Outcome::Skipped),
        Some(e) => {
            db::update_media(
                &st.db,
                &db::MediaUpdate {
                    id: e.id,
                    title,
                    year: year.or(e.year),
                    monitored: monitored.unwrap_or(e.monitored),
                    folder_name: &folder,
                    imdb_id: imdb.or(e.imdb_id.as_deref()),
                    overview: overview.or(e.overview.as_deref()),
                    quality_profile_id: local_profile.or(e.quality_profile_id),
                    library_id,
                },
            )
            .await
            .map_err(fail)?;
            Ok(Outcome::Imported(None))
        }
        None => {
            let id = db::insert_media(
                &st.db,
                &db::NewMedia {
                    title,
                    tmdb_id: tmdb,
                    year,
                    media_type: arr.media_type(),
                    status: arr.status(),
                    monitored: monitored.unwrap_or(true),
                    library_id,
                    folder_name: &folder,
                    imdb_id: imdb,
                    overview,
                    quality_profile_id: local_profile,
                },
            )
            .await
            .map_err(fail)?;
            Ok(Outcome::Imported(Some(id)))
        }
    }
}

/// Remote profile id to local id; a failure midway keeps what was mapped so far (rule 14).
async fn import_profiles(
    st: &AppState,
    req: &Request<'_>,
    created: &mut Vec<String>,
) -> HashMap<i64, i32> {
    let mut map = HashMap::new();
    let url = format!("{}/api/v3/qualityprofile", req.base);
    let remote = match fetch(url, &req.key, LIST_TIMEOUT).await {
        Ok(r) if r.status().is_success() => r.json::<Value>().await,
        Ok(_) => return map,
        Err(e) => {
            tracing::warn!(error = %error_text(e), "quality profile import");
            return map;
        }
    };
    let Ok(Value::Array(remote)) = remote else {
        return map;
    };
    let run = async {
        let mut by_name: HashMap<String, i32> = HashMap::new();
        for (id, name) in db::quality_profiles(&st.db).await? {
            by_name.insert(name, id);
        }
        for p in remote.iter().filter(|p| p.is_object()) {
            let remote_id = p.get("id").and_then(Value::as_i64);
            let name = str_of(p, "name").unwrap_or_default();
            let local = if let Some(id) = by_name.get(name) {
                *id
            } else {
                let items: Vec<RemoteItem> = p
                    .get("items")
                    .and_then(|i| serde_json::from_value(i.clone()).ok())
                    .unwrap_or_default();
                let cutoff = resolve_cutoff(p.get("cutoff").and_then(Value::as_i64), &items);
                let upgrade = p
                    .get("upgradeAllowed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let id = db::insert_quality_profile(
                    &st.db,
                    name,
                    i32::try_from(cutoff).unwrap_or(16),
                    upgrade,
                    &Value::Array(map_remote_items(&items)),
                )
                .await?;
                created.push(name.to_owned());
                id
            };
            if let Some(r) = remote_id {
                map.insert(r, local);
            }
        }
        Ok::<(), sqlx::Error>(())
    };
    if let Err(e) = run.await {
        tracing::warn!(error = %e, "quality profile import");
    }
    map
}

async fn radarr_subtitles(
    st: &AppState,
    req: &Request<'_>,
    movies: &[Value],
    errors: &mut Vec<String>,
) -> i64 {
    let mut count = 0;
    for movie in movies {
        let title = str_of(movie, "title").unwrap_or("undefined");
        match radarr_movie_subtitles(st, req, movie).await {
            Ok(n) => count += n,
            Err(e) => errors.push(format!("Subtitles for \"{title}\": {e}")),
        }
    }
    count
}

async fn radarr_movie_subtitles(
    st: &AppState,
    req: &Request<'_>,
    movie: &Value,
) -> Result<i64, String> {
    let (true, Some(tmdb), Some(id)) = (has(movie, "id"), tmdb_id(movie), movie["id"].as_i64())
    else {
        return Ok(0);
    };
    let db_err = |e: sqlx::Error| e.to_string();
    let Some(media) = db::media_by_tmdb(&st.db, tmdb, "movie")
        .await
        .map_err(db_err)?
    else {
        return Ok(0);
    };
    let Some(file) = db::latest_file(&st.db, media.id).await.map_err(db_err)? else {
        return Ok(0);
    };
    let url = format!("{}/api/v3/extrafile?movieId={id}", req.base);
    let res = fetch(url, &req.key, ITEM_TIMEOUT)
        .await
        .map_err(error_text)?;
    if !res.status().is_success() {
        return Ok(0);
    }
    let extras: Value = res.json().await.map_err(error_text)?;
    let mut count = 0;
    for extra in extras.as_array().into_iter().flatten() {
        if str_of(extra, "type") != Some("subtitle") {
            continue;
        }
        let Some(raw) = str_of(extra, "relativePath") else {
            return Err("relativePath is required".into());
        };
        if !subtitles::SUBTITLE_EXTS.contains(&extname(raw).to_lowercase().as_str()) {
            continue;
        }
        let rel = raw.trim();
        if rel.is_empty() {
            continue;
        }
        let language = match extra.get("language").and_then(|l| str_of(l, "name")) {
            Some(name) => language_from_name(name),
            None => parse_language_from_path(rel),
        };
        count += subtitles::upsert(
            &st.db,
            req.update,
            &subtitles::Sidecar {
                media_id: media.id,
                media_file_id: file,
                episode_id: None,
                provider: "radarr",
                language: &language,
                relative_path: rel,
            },
        )
        .await
        .map_err(db_err)?;
    }
    Ok(count)
}

async fn sonarr_subtitles(
    st: &AppState,
    req: &Request<'_>,
    series: &[Value],
    errors: &mut Vec<String>,
) -> i64 {
    let mut count = 0;
    for s in series {
        let title = str_of(s, "title").unwrap_or("series");
        match sonarr_series_subtitles(st, req, s).await {
            Ok(n) => count += n,
            Err(e) => errors.push(format!("Subtitles for \"{title}\": {e}")),
        }
    }
    count
}

/// The subtitle files next to a video: same stem, or the stem followed by `.` or a space.
fn sidecars(dir: &str, video: &str) -> Vec<String> {
    let stem = |n: &str| {
        n.rsplit_once('.')
            .map_or(n.to_lowercase(), |(s, _)| s.to_lowercase())
    };
    let video_stem = stem(video.rsplit('/').next().unwrap_or(video));
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| subtitles::SUBTITLE_EXTS.contains(&extname(n).to_lowercase().as_str()))
        .filter(|n| {
            let s = stem(n);
            s == video_stem
                || s.starts_with(&format!("{video_stem}."))
                || s.starts_with(&format!("{video_stem} "))
        })
        .collect();
    names.sort();
    names
}

async fn sonarr_series_subtitles(
    st: &AppState,
    req: &Request<'_>,
    series: &Value,
) -> Result<i64, String> {
    let (true, Some(tmdb)) = (has(series, "id"), tmdb_id(series)) else {
        return Ok(0);
    };
    let db_err = |e: sqlx::Error| e.to_string();
    let Some(local) = db::series_by_tmdb(&st.db, tmdb).await.map_err(db_err)? else {
        return Ok(0);
    };
    let Some(root) = media_path(local.library_path.as_deref(), local.folder_name.as_deref()) else {
        return Ok(0);
    };
    let mut count = 0;
    for file in db::series_files(&st.db, local.id).await.map_err(db_err)? {
        let video = join(&root, &file.relative_path);
        let dir = video.rsplit_once('/').map_or(".", |(d, _)| d).to_owned();
        let names = {
            let (dir, video) = (dir.clone(), video.clone());
            tokio::task::spawn_blocking(move || sidecars(&dir, &video))
                .await
                .map_err(|e| e.to_string())?
        };
        for name in names {
            let abs = normalize(&format!("{dir}/{name}"));
            let Some(rel) = abs.strip_prefix(&format!("{}/", root.trim_end_matches('/'))) else {
                tracing::error!(path = %abs, "sidecar outside the media folder");
                continue;
            };
            let language = parse_language_from_path(&name);
            count += subtitles::upsert(
                &st.db,
                req.update,
                &subtitles::Sidecar {
                    media_id: local.id,
                    media_file_id: file.id,
                    episode_id: file.episode_id,
                    provider: "sonarr",
                    language: &language,
                    relative_path: &rel.replace('\\', "/"),
                },
            )
            .await
            .map_err(db_err)?;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmdb_ids_are_integers_from_one() {
        let id = |v: Value| tmdb_id(&json!({"tmdbId": v}));
        assert_eq!(id(json!(12)), Some(12));
        assert_eq!(id(json!(12.0)), Some(12));
        assert_eq!(id(json!(" 12 ")), Some(12));
        assert_eq!(id(json!(0)), None);
        assert_eq!(id(json!("abc")), None);
        assert_eq!(id(json!("1e3")), None);
        assert_eq!(id(json!(null)), None);
        assert_eq!(tmdb_id(&json!({})), None);
    }

    #[test]
    fn sidecars_match_the_video_stem() {
        let dir = std::env::temp_dir().join(format!("s5imp-sidecars-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for n in [
            "Show.S01E01.mkv",
            "Show.S01E01.en.srt",
            "show.s01e01.fr.forced.SRT",
            "Show.S01E01 x.ass",
            "Show.S01E010.srt",
            "Other.srt",
        ] {
            std::fs::write(dir.join(n), "").unwrap();
        }
        let got = sidecars(
            dir.to_str().unwrap(),
            &format!("{}/Show.S01E01.mkv", dir.display()),
        );
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(
            got,
            [
                "Show.S01E01 x.ass",
                "Show.S01E01.en.srt",
                "show.s01e01.fr.forced.SRT"
            ]
        );
    }
}
