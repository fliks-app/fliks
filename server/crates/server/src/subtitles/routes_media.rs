//! `/api/media/:id/subtitles*` and `/api/media/sync-queue` (`subtitles.md` routes 27-40).
use super::{
    files, model, postprocess,
    service::{self, Search, Upload},
};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson, from_value},
    },
    libraries::{accessible_library_ids, assert_media_accessible},
    state::AppState,
};
use axum::{
    Json,
    extract::{Multipart, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use fliks_domain::{
    acl::{Action, Subject},
    subtitle_score::Candidate,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;

type Res<T> = Result<T, AppError>;

pub fn policy(a: &Authed, action: Action) -> Res<()> {
    a.require(action, Subject::SubtitleFile)
}

pub async fn gate_media(st: &AppState, a: &Authed, id: i32) -> Res<()> {
    let ids = accessible_library_ids(&st.db, a).await?;
    assert_media_accessible(&st.db, id, &ids).await
}

/// The media gate plus the binding of the subtitle to it (rule 3).
pub async fn gate_subtitle(st: &AppState, a: &Authed, media: i32, sub: i32) -> Res<()> {
    gate_media(st, a, media).await?;
    let found: Option<i32> =
        sqlx::query_scalar(r#"SELECT id FROM subtitle_files WHERE id = $1 AND "mediaId" = $2"#)
            .bind(sub)
            .bind(media)
            .fetch_optional(&st.db)
            .await?;
    found
        .map(|_| ())
        .ok_or_else(|| AppError::not_found(format!("Subtitle #{sub} not found")))
}

type One = Result<PathParams<i32>, AppError>;
type Two = Result<PathParams<(i32, i32)>, AppError>;

/// `(season, episode)` of an episode row of the media.
pub async fn episode_numbers(st: &AppState, media: i32, episode: i32) -> Res<Option<(i64, i64)>> {
    let r: Option<(i32, i32)> = sqlx::query_as(
        r#"SELECT s."seasonNumber", e."episodeNumber" FROM episodes e JOIN seasons s ON s.id = e."seasonId"
           WHERE s."mediaId" = $1 AND e.id = $2"#,
    )
    .bind(media)
    .bind(episode)
    .fetch_optional(&st.db)
    .await?;
    Ok(r.map(|(s, e)| (i64::from(s), i64::from(e))))
}

#[utoipa::path(get, path = "/api/media/{id}/subtitles", responses((status = 200)))]
pub async fn list(State(st): State<AppState>, a: Authed, id: One) -> Res<Json<Vec<Value>>> {
    policy(&a, Action::Read)?;
    let PathParams(id) = id?;
    gate_media(&st, &a, id).await?;
    let rows = model::of_media(&st.db, id).await?;
    Ok(Json(
        rows.iter()
            .map(|r| {
                let mut v = r.json();
                if let Some(p) = st.subtitles.translation_progress(r.id) {
                    v["translationProgress"] = json!(p);
                }
                v
            })
            .collect(),
    ))
}

#[utoipa::path(get, path = "/api/media/{id}/subtitles/search", responses((status = 200)))]
pub async fn search(
    State(st): State<AppState>,
    a: Authed,
    id: One,
    Query(q): Query<HashMap<String, String>>,
) -> Res<Json<Vec<Value>>> {
    policy(&a, Action::Read)?;
    let PathParams(id) = id?;
    gate_media(&st, &a, id).await?;
    let media = files::load_media(&st.db, id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Media #{id} not found")))?;
    // A non-numeric or unknown `episodeId` is ignored: movie scoring.
    let mut resolved: Option<(i32, (i64, i64))> = None;
    if let Some(ep) = q
        .get("episodeId")
        .filter(|e| !e.is_empty())
        .and_then(|e| e.trim().parse::<i32>().ok())
        && let Some(n) = episode_numbers(&st, id, ep).await?
    {
        resolved = Some((ep, n));
    }
    let mfiles = files::files_of_media(&st.db, id).await?;
    let file = resolved
        .and_then(|(ep, _)| mfiles.iter().find(|f| f.episode_id == Some(ep)))
        .or(mfiles.first());
    let search = Search {
        query: super::providers::Query {
            imdb_id: media.imdb_id.clone().filter(|i| !i.is_empty()),
            tmdb_id: media.tmdb_id.map(i64::from),
            title: media.title.clone(),
            year: media.year,
            season: resolved.map(|(_, n)| n.0),
            episode: resolved.map(|(_, n)| n.1),
            language: q.get("language").cloned().unwrap_or_else(|| "en".into()),
            moviehash: file.and_then(|f| f.osdb_hash.clone()),
        },
        video_release_name: file.map(|f| super::scheduler::base_name(&f.relative_path)),
        ..Search::default()
    };
    let results = service::search(&st, &search).await?;
    Ok(Json(
        results
            .iter()
            .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
            .collect(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoBody {
    media_file_id: i32,
    #[serde(default)]
    episode_id: Option<i32>,
    #[serde(default)]
    language: Option<String>,
}

#[utoipa::path(post, path = "/api/media/{id}/subtitles/auto", responses((status = 201)))]
pub async fn auto(
    State(st): State<AppState>,
    a: Authed,
    id: One,
    body: ValidJson<Value>,
) -> Res<Response> {
    policy(&a, Action::Create)?;
    let PathParams(id) = id?;
    gate_media(&st, &a, id).await?;
    let b: AutoBody = from_value(body.0)?;
    let media = files::load_media(&st.db, id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Media #{id} not found")))?;
    let numbers = match b.episode_id {
        Some(ep) => episode_numbers(&st, id, ep).await?,
        None => None,
    };
    let search = Search {
        query: super::providers::Query {
            imdb_id: media.imdb_id.clone().filter(|i| !i.is_empty()),
            tmdb_id: media.tmdb_id.map(i64::from),
            title: media.title.clone(),
            year: media.year,
            season: numbers.map(|n| n.0),
            episode: numbers.map(|n| n.1),
            language: b.language.unwrap_or_else(|| "fr".into()),
            moviehash: None,
        },
        ..Search::default()
    };
    let results = service::search(&st, &search).await?;
    let Some(best) = results.first() else {
        return Ok(StatusCode::CREATED.into_response());
    };
    let saved = service::download(&st, id, b.media_file_id, b.episode_id, &best.candidate).await?;
    Ok((StatusCode::CREATED, Json(saved.json())).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileBody {
    media_file_id: i32,
}

#[utoipa::path(post, path = "/api/media/{id}/subtitles/search-missing", responses((status = 201)))]
pub async fn search_missing(
    State(st): State<AppState>,
    a: Authed,
    id: One,
    body: ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Create)?;
    let PathParams(id) = id?;
    gate_media(&st, &a, id).await?;
    let b: FileBody = from_value(body.0)?;
    let downloaded = super::scheduler::search_missing_for_media(&st, id, b.media_file_id).await;
    Ok((StatusCode::CREATED, Json(json!({"downloaded": downloaded}))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadBody {
    search_result: Candidate,
    media_file_id: i32,
    #[serde(default)]
    episode_id: Option<i32>,
}

#[utoipa::path(post, path = "/api/media/{id}/subtitles/download", responses((status = 201)))]
pub async fn download(
    State(st): State<AppState>,
    a: Authed,
    id: One,
    body: ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Create)?;
    let PathParams(id) = id?;
    gate_media(&st, &a, id).await?;
    let b: DownloadBody = from_value(body.0)?;
    let saved = service::download(&st, id, b.media_file_id, b.episode_id, &b.search_result).await?;
    Ok((StatusCode::CREATED, Json(saved.json())))
}

/// `Number(x)` kept only when it is an integer.
fn js_integer(s: &str) -> Option<i32> {
    let t = s.trim();
    let n: f64 = if t.is_empty() { 0.0 } else { t.parse().ok()? };
    (n.fract() == 0.0 && n.abs() < f64::from(i32::MAX)).then_some(n as i32)
}

fn flag(v: &str) -> Option<bool> {
    match v {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn too_large() -> AppError {
    AppError::payload_too_large("file_info.import_err_too_large")
}

#[utoipa::path(post, path = "/api/media/{id}/subtitles/upload", responses((status = 201)))]
pub async fn upload(
    State(st): State<AppState>,
    a: Authed,
    id: One,
    multipart: Result<Multipart, axum::extract::multipart::MultipartRejection>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Create)?;
    let PathParams(id) = id?;
    gate_media(&st, &a, id).await?;
    let bad = |e: &dyn std::fmt::Display| {
        tracing::warn!(error = %e, "subtitle upload");
        AppError::bad_request("No file uploaded")
    };
    let mut mp = multipart.map_err(|e| bad(&e))?;
    let mut file = None;
    let mut fields = HashMap::<String, String>::new();
    while let Some(mut field) = mp.next_field().await.map_err(|e| {
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            too_large()
        } else {
            bad(&e)
        }
    })? {
        let name = field.name().unwrap_or_default().to_owned();
        if let Some(fname) = field.file_name().map(str::to_owned) {
            if name != "file" {
                return Err(AppError::bad_request(format!("Unexpected field - {name}")));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = field.chunk().await.map_err(|e| {
                if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    too_large()
                } else {
                    bad(&e)
                }
            })? {
                bytes.extend_from_slice(&chunk);
                if bytes.len() > service::UPLOAD_MAX_BYTES {
                    return Err(too_large());
                }
            }
            file.get_or_insert((fname, bytes));
        } else {
            fields.insert(name, field.text().await.map_err(|e| bad(&e))?);
        }
    }
    let Some((name, bytes)) = file else {
        return Err(AppError::bad_request("No file uploaded"));
    };
    let file_id = fields
        .get("mediaFileId")
        .and_then(|v| js_integer(v))
        .ok_or_else(|| AppError::bad_request("mediaFileId is required"))?;
    let episode = fields
        .get("episodeId")
        .filter(|v| !v.is_empty())
        .and_then(|v| js_integer(v))
        .filter(|e| *e != 0);
    let saved = service::upload(
        &st,
        id,
        file_id,
        episode,
        Upload {
            name,
            bytes,
            language: fields.get("language").cloned(),
            forced: fields.get("forced").and_then(|v| flag(v)),
            hearing_impaired: fields.get("hearingImpaired").and_then(|v| flag(v)),
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(saved.json())))
}

#[utoipa::path(delete, path = "/api/media/{id}/subtitles/{subtitleId}", responses((status = 200)))]
pub async fn remove(State(st): State<AppState>, a: Authed, ids: Two) -> Res<StatusCode> {
    policy(&a, Action::Delete)?;
    let PathParams((id, sub)) = ids?;
    gate_subtitle(&st, &a, id, sub).await?;
    super::sidecars::delete_subtitle(&st, sub).await?;
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
struct LanguageBody {
    language: String,
}

#[utoipa::path(patch, path = "/api/media/{id}/subtitles/{subtitleId}/language", responses((status = 200)))]
pub async fn set_language(
    State(st): State<AppState>,
    a: Authed,
    ids: Two,
    body: ValidJson<Value>,
) -> Res<Json<Value>> {
    policy(&a, Action::Update)?;
    let PathParams((id, sub)) = ids?;
    gate_subtitle(&st, &a, id, sub).await?;
    let b: LanguageBody = from_value(body.0)?;
    Ok(Json(service::set_language(&st, sub, &b.language).await?))
}

#[utoipa::path(post, path = "/api/media/{id}/subtitles/{subtitleId}/validate", responses((status = 201)))]
pub async fn validate(
    State(st): State<AppState>,
    a: Authed,
    ids: Two,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Update)?;
    let PathParams((id, sub)) = ids?;
    gate_subtitle(&st, &a, id, sub).await?;
    Ok((
        StatusCode::CREATED,
        Json(service::validate(&st, sub).await?),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpgradeBody {
    #[serde(default)]
    search_result: Option<Candidate>,
}

#[utoipa::path(post, path = "/api/media/{id}/subtitles/{subtitleId}/upgrade", responses((status = 201)))]
pub async fn upgrade(
    State(st): State<AppState>,
    a: Authed,
    ids: Two,
    body: ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Create)?;
    let PathParams((id, sub)) = ids?;
    gate_subtitle(&st, &a, id, sub).await?;
    let b: UpgradeBody = from_value(body.0)?;
    let saved = service::upgrade(&st, sub, b.search_result.as_ref()).await?;
    Ok((StatusCode::CREATED, Json(saved.json())))
}

#[derive(Deserialize)]
struct PostBody {
    action: String,
    #[serde(default)]
    params: Option<Value>,
}

#[utoipa::path(post, path = "/api/media/{id}/subtitles/{subtitleId}/post-process", responses((status = 201)))]
pub async fn post_process(
    State(st): State<AppState>,
    a: Authed,
    ids: Two,
    body: ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Create)?;
    let PathParams((id, sub)) = ids?;
    gate_subtitle(&st, &a, id, sub).await?;
    let b: PostBody = from_value(body.0)?;
    let params = match b.params {
        Some(p @ Value::Object(_)) => p,
        None | Some(Value::Null) => json!({}),
        Some(_) => return Err(AppError::bad_request("params must be an object")),
    };
    Ok((
        StatusCode::CREATED,
        Json(postprocess::apply(&st, sub, &b.action, &params).await?),
    ))
}

#[derive(Deserialize, Default)]
struct OcrBody {
    #[serde(default)]
    language: Option<String>,
}

#[utoipa::path(post, path = "/api/media/{id}/subtitles/{subtitleId}/ocr", responses((status = 201)))]
pub async fn ocr(
    State(st): State<AppState>,
    a: Authed,
    ids: Two,
    body: ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Create)?;
    let PathParams((id, sub)) = ids?;
    gate_subtitle(&st, &a, id, sub).await?;
    let b: OcrBody = from_value(body.0)?;
    Ok((
        StatusCode::CREATED,
        Json(super::ocr::start(&st, sub, b.language.as_deref(), false).await?),
    ))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SyncBody {
    #[serde(default)]
    reference: Option<String>,
    #[serde(default)]
    max_offset_seconds: Option<f64>,
    #[serde(default)]
    no_fix_framerate: Option<bool>,
    #[serde(default)]
    golden_section_search: Option<bool>,
}

#[utoipa::path(post, path = "/api/media/{id}/subtitles/{subtitleId}/sync", responses((status = 201)))]
pub async fn sync(
    State(st): State<AppState>,
    a: Authed,
    ids: Two,
    body: ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Create)?;
    let PathParams((id, sub)) = ids?;
    gate_subtitle(&st, &a, id, sub).await?;
    let b: SyncBody = from_value(body.0)?;
    if b.max_offset_seconds
        .is_some_and(|m| !m.is_finite() || m < 0.0)
    {
        return Err(AppError::bad_request(
            "maxOffsetSeconds must not be less than 0",
        ));
    }
    let item = super::sync::enqueue(
        &st,
        sub,
        super::sync::Options {
            reference: b.reference,
            max_offset_seconds: b.max_offset_seconds,
            no_fix_framerate: b.no_fix_framerate,
            golden_section_search: b.golden_section_search,
            automatic: false,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(item)))
}

#[utoipa::path(get, path = "/api/media/sync-queue", responses((status = 200)))]
pub async fn sync_queue(State(st): State<AppState>, a: Authed) -> Res<Json<Vec<Value>>> {
    policy(&a, Action::Read)?;
    let all = st.subtitles.sync.snapshot();
    let ids = accessible_library_ids(&st.db, &a).await?;
    let every = a.user.is_admin || a.perms.can(Action::Manage, &Subject::All);
    if every {
        return Ok(Json(all));
    }
    // F50: only the items of media in the caller's libraries.
    let mut out = vec![];
    for item in all {
        let media = item["subject"]["mediaId"].as_i64().map(|m| m as i32);
        let ok = match media {
            Some(m) => assert_media_accessible(&st.db, m, &ids).await.is_ok(),
            None => false,
        };
        if ok {
            out.push(item);
        }
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslateBody {
    #[serde(default)]
    target_language: Option<String>,
    #[serde(default)]
    provider_id: Option<i32>,
}

#[utoipa::path(post, path = "/api/media/{id}/subtitles/{subtitleId}/translate", responses((status = 201)))]
pub async fn translate(
    State(st): State<AppState>,
    a: Authed,
    ids: Two,
    body: ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Create)?;
    let PathParams((id, sub)) = ids?;
    gate_subtitle(&st, &a, id, sub).await?;
    let b: TranslateBody = from_value(body.0)?;
    Ok((
        StatusCode::CREATED,
        Json(super::translate::start(&st, sub, b.target_language.as_deref(), b.provider_id).await?),
    ))
}
