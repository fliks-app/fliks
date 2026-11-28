//! The aligner of a language, the library's languages and the re-alignment (`docs/spec/karaoke.md` rules 38-41).
use super::run;
use super::{engine_err, manage_settings};
use crate::sync::MutexExt;
use crate::{
    http::{AppError, auth::Authed},
    settings,
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use fliks_domain::language::{normalize_language_code, parse_language_code};
use fliks_domain::lyrics::Doc;
use fliks_engine_core::api::{ModelInfo, ModelKind, ModelState};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::types::Json as Jsonb;
use std::{collections::BTreeMap, collections::HashMap, sync::atomic::Ordering};

/// The language of a row: its `lang` when it is a code, else what the text says.
pub(crate) fn language_of(lang: &str, doc: &Doc) -> Option<String> {
    parse_language_code(lang).or_else(|| {
        let text: Vec<&str> = doc.lines.iter().map(|l| l.text.as_str()).collect();
        let info = whatlang::detect(&text.join("\n")).filter(whatlang::Info::is_reliable)?;
        let code = match info.lang().code() {
            "cmn" => "zh",
            "pes" => "fa",
            "arb" => "ar",
            "azj" => "az",
            "uzn" => "uz",
            "ydd" => "yi",
            other => other,
        };
        Some(normalize_language_code(Some(code))).filter(|c| c.len() == 2)
    })
}

/// The opt-in model of the `quality` aligner: it times best on the full mix and is never picked by language.
pub(crate) const QUALITY_MODEL: &str = "w2v-bert-music-ctc";

/// `karaoke.aligner` is `quality`: the admin chose the quality model over the per-language choice.
pub(crate) async fn quality(st: &AppState) -> bool {
    settings::text(&st.db, "karaoke.aligner")
        .await
        .ok()
        .flatten()
        .as_deref()
        == Some("quality")
}

pub(crate) fn validate_mode(value: &str) -> Result<(), &'static str> {
    ["standard", "quality"]
        .contains(&value)
        .then_some(())
        .ok_or("karaoke.aligner must be one of the following values: standard, quality")
}

/// Alignment models that can place `language` (none: the any-language ones only).
fn candidates<'a>(
    models: &'a [ModelInfo],
    language: Option<&'a str>,
) -> impl Iterator<Item = &'a ModelInfo> {
    models.iter().filter(move |m| {
        m.kind == ModelKind::Alignment
            && m.id != QUALITY_MODEL
            && (m.languages.is_empty()
                || language.is_some_and(|l| m.languages.iter().any(|x| x == l)))
    })
}

/// Language-specific first, then a CTC network of any language, then the engine's default.
fn rank(m: &ModelInfo) -> (bool, bool) {
    (m.languages.is_empty(), m.default)
}

/// Rule 38. In quality mode the quality model while it is installed, else the standard choice.
pub(crate) fn aligner<'a>(
    models: &'a [ModelInfo],
    language: Option<&'a str>,
    overrides: &HashMap<String, String>,
    quality: bool,
) -> Option<&'a ModelInfo> {
    let installed = |m: &&ModelInfo| m.state == ModelState::Installed;
    if quality
        && let Some(q) = models
            .iter()
            .filter(installed)
            .find(|m| m.id == QUALITY_MODEL && m.kind == ModelKind::Alignment)
    {
        return Some(q);
    }
    language
        .and_then(|l| overrides.get(l))
        .and_then(|id| {
            models
                .iter()
                .find(|m| m.id == *id && m.kind == ModelKind::Alignment)
        })
        .filter(installed)
        .or_else(|| {
            candidates(models, language)
                .filter(installed)
                .min_by_key(|m| rank(m))
        })
}

/// Rule 39.
fn recommended<'a>(models: &'a [ModelInfo], language: Option<&'a str>) -> Option<&'a ModelInfo> {
    candidates(models, language)
        .filter(|m| !m.default)
        .min_by_key(|m| rank(m))
}

/// `karaoke.aligners` is a JSON object of language to model id.
pub(crate) fn validate_overrides(value: &str) -> Result<(), &'static str> {
    serde_json::from_str::<HashMap<String, String>>(value)
        .map(drop)
        .map_err(|_| "karaoke.aligners must be a JSON object of language to model id")
}

/// The admin's per-language choices; an entry that is not a model id is skipped.
pub(crate) async fn overrides(st: &AppState) -> HashMap<String, String> {
    let Some(raw) = settings::text(&st.db, "karaoke.aligners")
        .await
        .ok()
        .flatten()
    else {
        return HashMap::new();
    };
    let Ok(entries) = serde_json::from_str::<HashMap<String, Value>>(&raw) else {
        tracing::warn!("karaoke.aligners is not a JSON object: ignored");
        return HashMap::new();
    };
    entries
        .into_iter()
        .filter_map(|(lang, id)| match id {
            Value::String(id) => Some((lang, id)),
            _ => {
                tracing::warn!("karaoke.aligners entry {lang} is not a model id: skipped");
                None
            }
        })
        .collect()
}

/// Rule 40: tracks per language of their first non-generated main row.
async fn library_languages(st: &AppState) -> sqlx::Result<BTreeMap<String, i64>> {
    let rows: Vec<(String, Option<Jsonb<Doc>>)> = sqlx::query_as(
        r#"SELECT DISTINCT ON ("itemId") lang, CASE WHEN lang = 'und' THEN doc END
           FROM lyrics WHERE kind = 'main' AND source <> 'generated'
           ORDER BY "itemId", lang = 'und', id"#,
    )
    .fetch_all(&st.db)
    .await?;
    blocking(move || {
        let mut counts = BTreeMap::new();
        for (lang, doc) in rows {
            let doc = doc.map(|d| d.0).unwrap_or_default();
            if let Some(l) = language_of(&lang, &doc) {
                *counts.entry(l).or_insert(0) += 1;
            }
        }
        counts
    })
    .await
}

/// Language detection is CPU-bound: off the async workers.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> sqlx::Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))
}

#[utoipa::path(get, path = "/api/karaoke/languages", responses((status = 200), (status = 503)))]
pub async fn languages(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    manage_settings(&a)?;
    let models = super::engine_models(&st).await.map_err(engine_err)?;
    let models = &models.models;
    let chosen = overrides(&st).await;
    let quality = quality(&st).await;
    let list: Vec<Value> = library_languages(&st)
        .await?
        .iter()
        .map(|(l, tracks)| {
            let l = Some(l.as_str());
            json!({
                "language": l,
                "tracks": tracks,
                "aligner": aligner(&models, l, &chosen, quality).map(|m| &m.id),
                "recommended": recommended(&models, l).map(|m| &m.id),
            })
        })
        .collect();
    Ok(Json(json!({ "languages": list })))
}

/// Rule 39: downloads what the library's languages are missing.
pub(super) async fn auto_download(st: &AppState) {
    if !settings::flag(&st.db, "karaoke.enabled", false).await
        || !settings::flag(&st.db, "karaoke.auto_download", false).await
    {
        return;
    }
    let Ok(models) = super::engine_models(st).await else {
        return;
    };
    let models = &models.models;
    let langs = library_languages(st).await.unwrap_or_default();
    let mut wanted: Vec<&ModelInfo> = langs
        .keys()
        .filter_map(|l| recommended(&models, Some(l)))
        .filter(|m| m.state == ModelState::Absent && m.licence.clear)
        .collect();
    let mut seen = std::collections::HashSet::new();
    wanted.retain(|m| seen.insert(&m.id));
    for m in wanted {
        if let Err(e) = st.engine.download_model(&m.id).await {
            tracing::warn!("karaoke auto-download of {} failed: {e}", m.id);
        }
    }
}

/// Rule 41: unreviewed generated rows another aligner made (not a recogniser fallback); `blocked` if rejected.
async fn stale(st: &AppState, models: &[ModelInfo]) -> sqlx::Result<Vec<Stale>> {
    type Row = (i32, String, String, Option<Jsonb<Doc>>);
    let rows: Vec<Row> = sqlx::query_as(
        r#"SELECT "itemId", lang, "sourceRef", CASE WHEN lang = 'und' THEN doc END FROM lyrics
           WHERE kind = 'main' AND source = 'generated' AND NOT reviewed
             AND "sourceRef" IS NOT NULL AND "sourceRef" NOT LIKE '%#fallback=%'"#,
    )
    .fetch_all(&st.db)
    .await?;
    let languages = blocking(move || {
        rows.into_iter()
            .map(|(item, lang, source_ref, doc)| {
                let doc = doc.map(|d| d.0).unwrap_or_default();
                (item, language_of(&lang, &doc), source_ref)
            })
            .collect::<Vec<_>>()
    })
    .await?;
    let chosen = overrides(st).await;
    let quality = quality(st).await;
    let rejected: HashMap<i32, String> = super::store::rejections(&st.db)
        .await?
        .into_iter()
        .collect();
    Ok(languages
        .into_iter()
        .filter_map(|(item, language, source_ref)| {
            let current = aligner(models, language.as_deref(), &chosen, quality)?
                .id
                .clone();
            let model = source_ref.split('#').next().unwrap_or_default().to_owned();
            let blocked = rejected.get(&item) == Some(&current);
            (current != model).then_some(Stale {
                item,
                language,
                model,
                aligner: current,
                blocked,
            })
        })
        .collect())
}

/// A stale track, with the model that timed it and the one that would time it now.
pub(super) struct Stale {
    pub(super) item: i32,
    language: Option<String>,
    model: String,
    aligner: String,
    blocked: bool,
}

/// The last re-alignment attempt of a track in this process; a rejection is also recorded (rule 8).
#[derive(Clone, serde::Serialize)]
pub(crate) struct RealignResult {
    status: &'static str,
    matched: Option<f64>,
    error: Option<run::Failure>,
    at: i64,
}

/// `None` is a track the run skipped: busy, or without stems where this server may not separate.
pub(super) fn result_of(run: Option<Result<run::Outcome, run::Failure>>) -> RealignResult {
    let (status, matched, error) = match run {
        None => ("skipped", None, None),
        Some(Err(e)) => ("failed", None, Some(e)),
        Some(Ok(o)) => match (o.rejected_match, o.lyrics_error) {
            (Some(m), _) => ("rejected", Some(m), None),
            (None, Some(e)) => ("failed", None, Some(e)),
            (None, None) => ("ok", None, None),
        },
    };
    RealignResult {
        status,
        matched,
        error,
        at: chrono::Utc::now().timestamp(),
    }
}

const PAGE: usize = 50;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageQuery {
    #[serde(default)]
    offset: usize,
}

fn page_of<T>(all: Vec<T>, offset: usize) -> Vec<T> {
    all.into_iter().skip(offset).take(PAGE).collect()
}

#[derive(sqlx::FromRow)]
struct Label {
    id: i32,
    title: Option<String>,
    album: Option<String>,
    artists: Option<String>,
}

/// Rule 41: the stale tracks, 50 at a time, with the outcome of their last re-alignment.
#[utoipa::path(get, path = "/api/karaoke/realign/items", responses((status = 200), (status = 503)))]
pub async fn realign_items(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Query<PageQuery>,
) -> Result<Json<Value>, AppError> {
    manage_settings(&a)?;
    let models = super::engine_models(&st).await.map_err(engine_err)?;
    let models = &models.models;
    let mut all = stale(&st, &models).await?;
    all.sort_by_key(|s| s.item);
    let total = all.len();
    let page = page_of(all, q.offset);
    let ids: Vec<i32> = page.iter().map(|s| s.item).collect();
    let labels: Vec<Label> = sqlx::query_as(
        r#"SELECT i.id, i.title, m.title AS album,
             (SELECT string_agg(COALESCE(c."creditedName", p.name), ', ' ORDER BY c.position)
              FROM item_credits c JOIN persons p ON p.id = c."personId"
              WHERE c."itemId" = i.id AND c.role = 'artist') AS artists
           FROM items i LEFT JOIN media m ON m.id = i."mediaId" WHERE i.id = ANY($1)"#,
    )
    .bind(&ids)
    .fetch_all(&st.db)
    .await?;
    let results = st.karaoke.realign_results.lock_clean();
    let items: Vec<Value> = page
        .into_iter()
        .map(|s| {
            let l = labels.iter().find(|l| l.id == s.item);
            json!({
                "itemId": s.item,
                "title": l.and_then(|l| l.title.as_deref()),
                "album": l.and_then(|l| l.album.as_deref()),
                "artist": l.and_then(|l| l.artists.as_deref()),
                "language": s.language,
                "model": s.model,
                "aligner": s.aligner,
                "result": results.get(&s.item),
            })
        })
        .collect();
    Ok(Json(
        json!({ "total": total, "minMatch": run::MIN_MATCHED, "items": items }),
    ))
}

#[utoipa::path(get, path = "/api/karaoke/realign", responses((status = 200), (status = 503)))]
pub async fn realign_count(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    manage_settings(&a)?;
    let models = super::engine_models(&st).await.map_err(engine_err)?;
    let models = &models.models;
    let all = stale(&st, &models).await?;
    Ok(Json(json!({
        "tracks": all.iter().filter(|s| !s.blocked).count(),
        "refused": all.iter().filter(|s| s.blocked).count(),
        "running": st.karaoke.realigning.load(Ordering::SeqCst),
        "total": st.karaoke.realign_total.load(Ordering::SeqCst),
        "done": st.karaoke.realign_done.load(Ordering::SeqCst),
    })))
}

#[utoipa::path(post, path = "/api/karaoke/realign", responses((status = 202), (status = 409), (status = 503)))]
pub async fn realign(
    State(st): State<AppState>,
    a: Authed,
) -> Result<(StatusCode, Json<Value>), AppError> {
    manage_settings(&a)?;
    if !settings::flag(&st.db, "karaoke.enabled", false).await {
        return Err(super::disabled());
    }
    if !super::caps(&st).await.align {
        return Err(super::unavailable());
    }
    let models = super::engine_models(&st).await.map_err(engine_err)?;
    let models = &models.models;
    if st.karaoke.realigning.swap(true, Ordering::SeqCst) {
        return Err(super::refusal(
            StatusCode::CONFLICT,
            "karaoke_realign_running",
        ));
    }
    let tracks = match stale(&st, &models).await {
        Ok(t) => t.into_iter().filter(|s| !s.blocked).collect::<Vec<_>>(),
        Err(e) => {
            st.karaoke.realigning.store(false, Ordering::SeqCst);
            return Err(e.into());
        }
    };
    let n = tracks.len();
    tokio::spawn(super::background::realign(st.clone(), tracks));
    Ok((StatusCode::ACCEPTED, Json(json!({ "tracks": n }))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, languages: &[&str], default: bool, state: &str) -> ModelInfo {
        serde_json::from_value(json!({
            "id": id, "kind": "alignment", "name": id, "version": "1", "default": default,
            "state": state, "languages": languages, "files": [], "downloadedBytes": 0,
            "homepage": "", "sizeBytes": 0, "diskBytes": 0, "outdated": false, "verifying": false,
            "licence": {"name": "l", "text": "t", "clear": true}
        }))
        .unwrap()
    }

    fn zoo(fr: &str, omni: &str, whisper: &str) -> Vec<ModelInfo> {
        vec![
            model("whisper", &[], true, whisper),
            model("omni", &[], false, omni),
            model("fr", &["fr"], false, fr),
        ]
    }

    fn pick(models: &[ModelInfo], lang: Option<&str>, set: &[(&str, &str)]) -> Option<String> {
        let set = set
            .iter()
            .map(|(l, m)| ((*l).into(), (*m).into()))
            .collect();
        aligner(models, lang, &set, false).map(|m| m.id.clone())
    }

    #[test]
    fn the_aligner_is_the_specific_model_then_the_any_language_one_then_the_recogniser() {
        let all = zoo("installed", "installed", "installed");
        assert_eq!(pick(&all, Some("fr"), &[]).as_deref(), Some("fr"));
        assert_eq!(pick(&all, Some("de"), &[]).as_deref(), Some("omni"));
        assert_eq!(pick(&all, None, &[]).as_deref(), Some("omni"));
        let slim = zoo("absent", "absent", "installed");
        assert_eq!(pick(&slim, Some("fr"), &[]).as_deref(), Some("whisper"));
        assert_eq!(
            pick(&zoo("absent", "absent", "absent"), Some("fr"), &[]),
            None
        );
    }

    #[test]
    fn the_quality_model_is_never_picked_by_language_and_wins_in_quality_mode_once_installed() {
        let mut all = zoo("installed", "installed", "installed");
        all.push(model(QUALITY_MODEL, &[], false, "absent"));
        assert_eq!(pick(&all, Some("de"), &[]).as_deref(), Some("omni"));
        assert_eq!(
            recommended(&all, Some("it")).map(|m| m.id.as_str()),
            Some("omni")
        );
        let q = |all: &[ModelInfo]| {
            aligner(all, Some("fr"), &HashMap::new(), true).map(|m| m.id.clone())
        };
        assert_eq!(
            q(&all).as_deref(),
            Some("fr"),
            "absent: the standard choice"
        );
        all.pop();
        all.push(model(QUALITY_MODEL, &[], false, "installed"));
        assert_eq!(q(&all).as_deref(), Some(QUALITY_MODEL));
    }

    #[test]
    fn the_mode_is_standard_or_quality() {
        assert!(validate_mode("standard").is_ok() && validate_mode("quality").is_ok());
        assert!(validate_mode("fast").is_err());
    }

    #[test]
    fn an_installed_override_wins_and_an_absent_one_is_ignored() {
        let all = zoo("installed", "installed", "installed");
        assert_eq!(
            pick(&all, Some("fr"), &[("fr", "whisper")]).as_deref(),
            Some("whisper")
        );
        assert_eq!(
            pick(&all, Some("de"), &[("fr", "whisper")]).as_deref(),
            Some("omni")
        );
        let slim = zoo("installed", "absent", "installed");
        assert_eq!(
            pick(&slim, Some("fr"), &[("fr", "omni")]).as_deref(),
            Some("fr")
        );
    }

    #[test]
    fn the_recommendation_ignores_what_is_installed_and_the_recogniser() {
        let all = zoo("absent", "absent", "installed");
        let rec = |l| recommended(&all, l).map(|m| m.id.clone());
        assert_eq!(rec(Some("fr")).as_deref(), Some("fr"));
        assert_eq!(rec(Some("it")).as_deref(), Some("omni"));
    }

    #[test]
    fn the_details_page_by_fifty() {
        let all: Vec<usize> = (0..120).collect();
        assert_eq!(page_of(all.clone(), 0), (0..50).collect::<Vec<_>>());
        assert_eq!(page_of(all.clone(), 100), (100..120).collect::<Vec<_>>());
        assert!(page_of(all, 150).is_empty());
        assert!(page_of(Vec::<usize>::new(), 0).is_empty());
    }

    #[test]
    fn the_last_attempt_is_ok_rejected_failed_or_skipped() {
        let out = |rejected_match, lyrics_error| run::Outcome {
            rejected_match,
            lyrics_error,
            ..Default::default()
        };
        let status = |r| result_of(r).status;
        assert_eq!(status(Some(Ok(out(None, None)))), "ok");
        assert_eq!(
            status(Some(Ok(out(Some(0.18), Some("x".into()))))),
            "rejected"
        );
        assert_eq!(status(Some(Ok(out(None, Some("x".into()))))), "failed");
        assert_eq!(status(Some(Err("engine".into()))), "failed");
        assert_eq!(status(None), "skipped");
        assert_eq!(
            result_of(Some(Ok(out(Some(0.18), None)))).matched,
            Some(0.18)
        );
    }

    #[test]
    fn a_language_code_is_kept_and_und_is_detected() {
        let doc = |t: &str| {
            serde_json::from_value::<Doc>(json!({"agents": [], "lines": [{"text": t}]})).unwrap()
        };
        let fr = doc("Nous marchons ensemble sous la pluie et le vent, ce soir la ville est belle");
        assert_eq!(language_of("fr-FR", &doc("")).as_deref(), Some("fr"));
        assert_eq!(language_of("und", &fr).as_deref(), Some("fr"));
        assert_eq!(language_of("und", &doc("la")), None);
    }
}
