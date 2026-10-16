//! The `SubtitleSearch` and `SubtitleUpgrade` passes and their 6 h tick (`subtitles.md` rules 34-43, 55).
use super::{
    embedded, events,
    files::{self, MediaCtx},
    model::{self, Row},
    ocr,
    service::{self, Search},
    sync::{self, episode_of, progress_subject},
};
use crate::{http::AppError, state::AppState};
use fliks_domain::subtitle_flags::{
    Flags, LanguageItem, Servable, has_covering_sub, is_ocr_supported_codec,
    matches_requested_flags, prefers_hearing_impaired,
};
use serde_json::{Value, json};
use std::sync::Mutex;

const SEARCH_CRON: &str = "0 0-23/6 * * *";

#[derive(Debug, Clone)]
struct Opts {
    min_score: f64,
    auto_sync: bool,
    burn_in_covers: bool,
}

/// `Number(x)` finite, else the default (C59).
fn number(v: Option<String>, default: f64) -> f64 {
    v.map(|s| s.trim().to_owned())
        .and_then(|s| {
            if s.is_empty() {
                Some(0.0)
            } else {
                s.parse::<f64>().ok()
            }
        })
        .filter(|n| n.is_finite())
        .unwrap_or(default)
}

async fn setting(st: &AppState, key: &str) -> Option<String> {
    crate::settings::setting_value(&st.db, key)
        .await
        .ok()
        .flatten()
}

async fn resolve_opts(st: &AppState) -> Opts {
    Opts {
        min_score: number(setting(st, "subtitle_min_score").await, 70.0),
        auto_sync: setting(st, "subtitle_auto_sync").await.as_deref() == Some("true"),
        burn_in_covers: setting(st, "subtitle_burn_in_covers_language")
            .await
            .as_deref()
            == Some("true"),
    }
}

/// `String(err)` of a Nest exception.
fn err_string(e: &AppError) -> String {
    let name = match e.status().as_u16() {
        400 => "BadRequestException",
        404 => "NotFoundException",
        409 => "ConflictException",
        _ => "Error",
    };
    format!("{name}: {}", e.text())
}

/// A file with its episode, as the passes read it.
#[derive(Debug, Clone)]
struct FileEp {
    file: files::FileRow,
    episode: Option<(i32, i32, i32, Option<String>)>,
}

async fn file_with_episode(st: &AppState, f: files::FileRow) -> FileEp {
    let episode = match f.episode_id {
        Some(e) => episode_of(st, e).await,
        None => None,
    };
    FileEp { file: f, episode }
}

async fn language_items(st: &AppState, media: &MediaCtx) -> Vec<LanguageItem> {
    let Some(id) = media.language_profile_id else {
        return vec![];
    };
    let v: Option<Value> =
        sqlx::query_scalar(r#"SELECT "subtitleLanguages" FROM language_profiles WHERE id = $1"#)
            .bind(id)
            .fetch_optional(&st.db)
            .await
            .ok()
            .flatten();
    v.and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn servable(rows: &[Row]) -> Vec<Servable<'_>> {
    rows.iter()
        .map(|r| Servable {
            language: &r.language,
            forced: r.forced,
            hearing_impaired: r.hearing_impaired,
            codec: r.codec.as_deref(),
            status: Some(&r.status),
        })
        .collect()
}

fn base_name(rel: &str) -> String {
    let last = rel.rsplit('/').next().unwrap_or(rel);
    match last.rfind('.') {
        Some(i) if i > 0 => last[..i].to_owned(),
        _ => last.to_owned(),
    }
}

fn tag(ep: &Option<(i32, i32, i32, Option<String>)>) -> String {
    ep.as_ref()
        .map_or(String::new(), |(_, s, e, _)| format!(" S{s:02}E{e:02}"))
}

/// Gap-filling for one file (rule 36); a concurrent call on the same file returns `[]`.
async fn search_missing_for_file(
    st: &AppState,
    media: &MediaCtx,
    f: &FileEp,
    opts: &Opts,
    skip_detect: bool,
) -> Vec<String> {
    let Some(_claim) = st.subtitles.searching.claim(f.file.id) else {
        return vec![];
    };
    let id = format!("SubtitleSearch:{}", f.file.id);
    let subject = progress_subject(media, f.episode.clone());
    st.hub
        .activity()
        .upsert_running(&id, "SubtitleSearch", Some(subject), None, None, None);
    let out = do_search_missing(st, media, f, opts, skip_detect).await;
    st.hub.activity().remove(&id);
    out
}

async fn do_search_missing(
    st: &AppState,
    media: &MediaCtx,
    f: &FileEp,
    opts: &Opts,
    skip_detect: bool,
) -> Vec<String> {
    let langs = language_items(st, media).await;
    if langs.is_empty() {
        return vec![];
    }
    if !skip_detect {
        embedded::detect_and_store(st, media.id, f.file.id, f.file.episode_id).await;
    }
    let existing = model::of_file(&st.db, f.file.id).await.unwrap_or_default();
    let (season, episode) = f.episode.as_ref().map_or((None, None), |(_, s, e, _)| {
        (Some(i64::from(*s)), Some(i64::from(*e)))
    });
    let mut downloaded = vec![];
    for item in &langs {
        let sv = servable(&existing);
        if has_covering_sub(&sv, item, false) {
            continue;
        }
        if try_ocr_first(st, &existing, item).await {
            downloaded.push(item.iso_code.clone());
            continue;
        }
        if opts.burn_in_covers && has_covering_sub(&sv, item, true) {
            continue;
        }
        let tag = tag(&f.episode);
        let one = async {
            let req = Search {
                query: super::providers::Query {
                    imdb_id: media.imdb_id.clone().filter(|i| !i.is_empty()),
                    tmdb_id: media.tmdb_id.map(i64::from),
                    title: media.title.clone(),
                    year: media.year,
                    season,
                    episode,
                    language: item.iso_code.clone(),
                    moviehash: f.file.osdb_hash.clone(),
                },
                video_release_name: Some(base_name(&f.file.relative_path)),
                forced: item.request_flags().forced,
                hi_mode: item.request_flags().hearing_impaired_mode,
            };
            let results = service::search(st, &req).await?;
            let Some(best) = results.iter().find(|r| r.candidate.score >= opts.min_score) else {
                return Ok::<Option<(String, f64)>, AppError>(None);
            };
            let saved =
                service::download(st, media.id, f.file.id, f.file.episode_id, &best.candidate)
                    .await?;
            if opts.auto_sync {
                sync::do_sync(
                    st,
                    saved.inserted.id,
                    &sync::Options {
                        automatic: true,
                        ..Default::default()
                    },
                )
                .await
                .map_err(AppError::internal)?;
            }
            Ok(Some((
                best.candidate.provider_name.clone(),
                best.candidate.score,
            )))
        };
        match one.await {
            Ok(Some((provider, score))) => {
                events::notify(st, "subtitle.downloaded", json!({"title": media.title, "language": item.iso_code, "provider": provider, "score": score})).await;
                crate::media_servers::dispatch_detached(st, "subtitle.downloaded");
                downloaded.push(item.iso_code.clone());
                tracing::info!(
                    "SubtitleSearch: downloaded {} sub for \"{}\"{tag} (score: {score})",
                    item.iso_code,
                    media.title
                );
            }
            Ok(None) => {}
            Err(e) => {
                let text = err_string(&e);
                tracing::warn!(
                    "SubtitleSearch: failed for \"{}\"{tag} [{}]: {text}",
                    media.title,
                    item.iso_code
                );
                events::notify(
                    st,
                    "subtitle.failed",
                    json!({"title": media.title, "language": item.iso_code, "error": text}),
                )
                .await;
            }
        }
    }
    downloaded
}

/// OCR of an embedded image track in preference to a provider download (rule 37).
async fn try_ocr_first(st: &AppState, existing: &[Row], item: &LanguageItem) -> bool {
    if setting(st, "subtitle_ocr_burn_in_auto").await.as_deref() != Some("true") {
        return false;
    }
    if item.iso_code.is_empty() || item.iso_code == "und" {
        return false;
    }
    let req = item.request_flags();
    let matches = |s: &&Row| {
        s.language == item.iso_code
            && matches_requested_flags(
                Flags {
                    forced: s.forced,
                    hearing_impaired: s.hearing_impaired,
                },
                req,
            )
    };
    let runs: Vec<&Row> = existing
        .iter()
        .filter(matches)
        .filter(|s| s.provider_type == "ocr")
        .collect();
    if runs.iter().any(|s| s.status != "failed") {
        return true;
    }
    if !runs.is_empty() {
        return false;
    }
    let cands: Vec<&Row> = existing
        .iter()
        .filter(matches)
        .filter(|s| {
            is_ocr_supported_codec(s.codec.as_deref())
                && s.stream_index.is_some()
                && s.status != "failed"
        })
        .collect();
    let want_hi = prefers_hearing_impaired(req);
    let Some(image) = cands
        .iter()
        .find(|s| s.hearing_impaired == want_hi)
        .or(cands.first())
    else {
        return false;
    };
    match ocr::start(st, image.id, Some(&item.iso_code), true).await {
        Ok(_) => true,
        Err(e) => {
            tracing::warn!(
                "SubtitleOcr: OCR-first failed for {}: {}",
                item.iso_code,
                err_string(&e)
            );
            false
        }
    }
}

/// The manual "search missing" of one file; ignores `subtitle_auto_search`.
pub async fn search_missing_for_media(st: &AppState, media_id: i32, file_id: i32) -> Vec<String> {
    let Ok(Some(media)) = files::load_media(&st.db, media_id).await else {
        return vec![];
    };
    let Ok(Some(file)) = files::file_by_id(&st.db, file_id).await else {
        return vec![];
    };
    if file.media_id != Some(media_id) {
        return vec![];
    }
    let opts = resolve_opts(st).await;
    let f = file_with_episode(st, file).await;
    search_missing_for_file(st, &media, &f, &opts, false).await
}

/// After an import: embedded tracks first, then the same gap-filling (rule 42).
pub async fn on_media_file_imported(
    st: &AppState,
    media_id: i32,
    file_id: i32,
    episode_id: Option<i32>,
) {
    embedded::detect_and_store(st, media_id, file_id, episode_id).await;
    if setting(st, "subtitle_auto_search").await.as_deref() == Some("false") {
        return;
    }
    let Ok(Some(media)) = files::load_media(&st.db, media_id).await else {
        return;
    };
    let Ok(Some(file)) = files::file_by_id(&st.db, file_id).await else {
        return;
    };
    if file.media_id != Some(media_id) {
        return;
    }
    let opts = resolve_opts(st).await;
    let f = file_with_episode(st, file).await;
    search_missing_for_file(st, &media, &f, &opts, true).await;
}

/// The scheduled and triggered `SubtitleSearch` pass.
pub async fn search_missing(st: &AppState) -> Result<(), String> {
    if setting(st, "subtitle_auto_search").await.as_deref() == Some("false") {
        return Ok(());
    }
    let opts = resolve_opts(st).await;
    let mut last = 0;
    loop {
        let batch = files::media_batch(&st.db, last, 50)
            .await
            .map_err(|e| e.to_string())?;
        let Some(tail) = batch.last() else {
            return Ok(());
        };
        last = tail.id;
        for media in &batch {
            let mfiles = files::files_of_media(&st.db, media.id)
                .await
                .map_err(|e| e.to_string())?;
            for file in mfiles {
                let f = file_with_episode(st, file).await;
                search_missing_for_file(st, media, &f, &opts, false).await;
            }
        }
    }
}

/// The scheduled and triggered `SubtitleUpgrade` pass (rule 39).
pub async fn upgrade(st: &AppState) -> Result<(), String> {
    let sql = |e: sqlx::Error| e.to_string();
    if setting(st, "subtitle_auto_search").await.as_deref() == Some("false") {
        return Ok(());
    }
    let threshold = number(setting(st, "subtitle_upgrade_threshold").await, 90.0);
    let opts = resolve_opts(st).await;
    let mut last = 0;
    loop {
        let rows: Vec<Row> = sqlx::query_as(&format!(
            "SELECT {} FROM subtitle_files WHERE score::float8 < $1 AND status::text <> 'failed' AND locked = false AND id > $2 ORDER BY id ASC LIMIT 100",
            model::COLS
        ))
        .bind(threshold)
        .bind(last)
        .fetch_all(&st.db)
        .await
        .map_err(sql)?;
        let Some(tail) = rows.last() else {
            return Ok(());
        };
        last = tail.id;
        upgrade_batch(st, &rows, &opts).await?;
    }
}

async fn upgrade_batch(st: &AppState, rows: &[Row], opts: &Opts) -> Result<(), String> {
    let sql = |e: sqlx::Error| e.to_string();
    let mut medias: std::collections::HashMap<i32, (MediaCtx, Vec<LanguageItem>)> =
        Default::default();
    let mut missing: std::collections::HashMap<i32, bool> = Default::default();
    for r in rows {
        let (Some(mid), Some(fid)) = (r.media_id, r.media_file_id) else {
            continue;
        };
        if !medias.contains_key(&mid)
            && let Some(m) = files::load_media(&st.db, mid).await.map_err(sql)?
        {
            let items = language_items(st, &m).await;
            medias.insert(mid, (m, items));
        }
        if let (false, Some((_, items))) = (missing.contains_key(&fid), medias.get(&mid)) {
            let subs = model::of_file(&st.db, fid).await.map_err(sql)?;
            let present: std::collections::HashSet<&str> = subs
                .iter()
                .filter(|s| s.status != "failed")
                .map(|s| s.language.as_str())
                .collect();
            missing.insert(
                fid,
                items.iter().any(|l| !present.contains(l.iso_code.as_str())),
            );
        }
    }
    for sub in rows {
        let (Some(mid), Some(fid)) = (sub.media_id, sub.media_file_id) else {
            continue;
        };
        let Some((media, items)) = medias.get(&mid) else {
            continue;
        };
        let flags = Flags {
            forced: sub.forced,
            hearing_impaired: sub.hearing_impaired,
        };
        let Some(item) = items.iter().find(|l| {
            l.iso_code == sub.language && matches_requested_flags(flags, l.request_flags())
        }) else {
            continue;
        };
        if missing.get(&fid).copied().unwrap_or(false) {
            continue;
        }
        let Some(file) = files::file_by_id(&st.db, fid).await.map_err(sql)? else {
            continue;
        };
        let f = file_with_episode(st, file).await;
        let one = async {
            let (season, episode) = f.episode.as_ref().map_or((None, None), |(_, s, e, _)| {
                (Some(i64::from(*s)), Some(i64::from(*e)))
            });
            let req = Search {
                query: super::providers::Query {
                    imdb_id: media.imdb_id.clone().filter(|i| !i.is_empty()),
                    tmdb_id: media.tmdb_id.map(i64::from),
                    title: media.title.clone(),
                    year: media.year,
                    season,
                    episode,
                    language: sub.language.clone(),
                    moviehash: f.file.osdb_hash.clone(),
                },
                video_release_name: Some(base_name(&f.file.relative_path)),
                forced: item.request_flags().forced,
                hi_mode: item.request_flags().hearing_impaired_mode,
            };
            let results = service::search(st, &req).await?;
            let better = results
                .iter()
                .filter(|r| !sub.hash_matched || r.candidate.hash_matched == Some(true))
                .find(|r| r.candidate.score > f64::from(sub.score));
            let Some(better) = better else {
                return Ok::<Option<(String, f64)>, AppError>(None);
            };
            let up = service::upgrade(st, sub.id, Some(&better.candidate)).await?;
            if opts.auto_sync {
                sync::do_sync(
                    st,
                    up.inserted.id,
                    &sync::Options {
                        automatic: true,
                        ..Default::default()
                    },
                )
                .await
                .map_err(AppError::internal)?;
            }
            Ok(Some((
                better.candidate.provider_name.clone(),
                better.candidate.score,
            )))
        };
        match one.await {
            Ok(Some((provider, new))) => {
                events::notify(
                    st,
                    "subtitle.upgraded",
                    json!({"title": media.title, "language": sub.language, "oldScore": sub.score, "newScore": new, "provider": provider}),
                )
                .await;
                crate::media_servers::dispatch_detached(st, "subtitle.upgraded");
                tracing::info!(
                    "SubtitleUpgrade: upgraded {} for \"{}\"{} ({} -> {new})",
                    sub.language,
                    media.title,
                    tag(&f.episode),
                    sub.score
                );
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(
                "SubtitleUpgrade: failed for sub #{}: {}",
                sub.id,
                err_string(&e)
            ),
        }
    }
    Ok(())
}

/// The 6 h tick: each due pass holds its name's claim for its whole run (C-DRIFT-1).
pub fn spawn_tick(st: &AppState) {
    let last = std::sync::Arc::new(Mutex::new((0i64, 0i64)));
    let st = st.clone();
    let tz = crate::jobs::server_tz();
    crate::jobs::spawn_cron(SEARCH_CRON, tz, chrono::Utc::now, move || {
        let (st, last) = (st.clone(), last.clone());
        tokio::spawn(async move { tick(&st, &last).await });
    });
}

async fn tick(st: &AppState, last: &Mutex<(i64, i64)>) {
    let now = chrono::Utc::now().timestamp_millis();
    let search_interval = number(setting(st, "subtitle_search_interval").await, 360.0) * 60_000.0;
    let upgrade_interval = number(setting(st, "subtitle_upgrade_interval").await, 720.0) * 60_000.0;
    let (ls, lu) = *last.lock().unwrap_or_else(|e| e.into_inner());
    if (now - ls) as f64 >= search_interval {
        if let Some(_claim) = st.jobs.claim("SubtitleSearch") {
            last.lock().unwrap_or_else(|e| e.into_inner()).0 = now;
            if let Err(e) = search_missing(st).await {
                tracing::error!("SubtitleSearch: {e}");
            }
        } else {
            tracing::warn!("Scheduled SubtitleSearch skipped: it is already running");
        }
    }
    if (now - lu) as f64 >= upgrade_interval {
        if let Some(_claim) = st.jobs.claim("SubtitleUpgrade") {
            last.lock().unwrap_or_else(|e| e.into_inner()).1 = now;
            if let Err(e) = upgrade(st).await {
                tracing::error!("SubtitleUpgrade: {e}");
            }
        } else {
            tracing::warn!("Scheduled SubtitleUpgrade skipped: it is already running");
        }
    }
}
