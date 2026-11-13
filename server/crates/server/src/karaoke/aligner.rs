//! The aligner of a language, the library's languages and the re-alignment (`docs/spec/karaoke.md` rules 38-41).
use super::{engine_err, flag, manage_settings};
use crate::{
    http::{AppError, auth::Authed},
    settings::setting_value,
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use fliks_domain::language::{normalize_language_code, parse_language_code};
use fliks_domain::lyrics::Doc;
use fliks_engine_core::api::{ModelInfo, ModelKind, ModelState};
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

/// Alignment models that can place `language` (none: the any-language ones only).
fn candidates<'a>(
    models: &'a [ModelInfo],
    language: Option<&'a str>,
) -> impl Iterator<Item = &'a ModelInfo> {
    models.iter().filter(move |m| {
        m.kind == ModelKind::Alignment
            && (m.languages.is_empty()
                || language.is_some_and(|l| m.languages.iter().any(|x| x == l)))
    })
}

/// Language-specific first, then a CTC network of any language, then the engine's default.
fn rank(m: &ModelInfo) -> (bool, bool) {
    (m.languages.is_empty(), m.default)
}

/// Rule 38.
pub(crate) fn aligner<'a>(
    models: &'a [ModelInfo],
    language: Option<&'a str>,
    overrides: &HashMap<String, String>,
) -> Option<&'a ModelInfo> {
    let installed = |m: &&ModelInfo| m.state == ModelState::Installed;
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
    let Some(raw) = setting_value(&st.db, "karaoke.aligners")
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
    let models = st.engine.models().await.map_err(engine_err)?.models;
    let chosen = overrides(&st).await;
    let list: Vec<Value> = library_languages(&st)
        .await?
        .iter()
        .map(|(l, tracks)| {
            let l = Some(l.as_str());
            json!({
                "language": l,
                "tracks": tracks,
                "aligner": aligner(&models, l, &chosen).map(|m| &m.id),
                "recommended": recommended(&models, l).map(|m| &m.id),
            })
        })
        .collect();
    Ok(Json(json!({ "languages": list })))
}

/// Rule 39: downloads what the library's languages are missing.
pub(super) async fn auto_download(st: &AppState) {
    if !flag(st, "karaoke.enabled", false).await || !flag(st, "karaoke.auto_download", false).await
    {
        return;
    }
    let Ok(models) = st.engine.models().await.map(|m| m.models) else {
        return;
    };
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

/// Rule 41: the items whose unreviewed generated row the current aligner of its language did not make.
/// A row the recogniser placed after a CTC failure is not stale: the same model would fail again.
async fn stale(st: &AppState, models: &[ModelInfo]) -> sqlx::Result<Vec<i32>> {
    let rows: Vec<(i32, String, String, Option<Jsonb<Doc>>)> = sqlx::query_as(
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
    Ok(languages
        .into_iter()
        .filter(|(_, language, source_ref)| {
            let model = source_ref.split('#').next().unwrap_or_default();
            aligner(models, language.as_deref(), &chosen).is_some_and(|m| m.id != model)
        })
        .map(|(item, ..)| item)
        .collect())
}

#[utoipa::path(get, path = "/api/karaoke/realign", responses((status = 200), (status = 503)))]
pub async fn realign_count(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    manage_settings(&a)?;
    let models = st.engine.models().await.map_err(engine_err)?.models;
    Ok(Json(json!({
        "tracks": stale(&st, &models).await?.len(),
        "running": st.karaoke.realigning.load(Ordering::SeqCst),
    })))
}

#[utoipa::path(post, path = "/api/karaoke/realign", responses((status = 202), (status = 409), (status = 503)))]
pub async fn realign(
    State(st): State<AppState>,
    a: Authed,
) -> Result<(StatusCode, Json<Value>), AppError> {
    manage_settings(&a)?;
    if !flag(&st, "karaoke.enabled", false).await {
        return Err(AppError::conflict("karaoke_disabled"));
    }
    if !super::caps(&st).await.align {
        return Err(AppError::with_message(
            StatusCode::SERVICE_UNAVAILABLE,
            "karaoke_unavailable",
        ));
    }
    let models = st.engine.models().await.map_err(engine_err)?.models;
    if st.karaoke.realigning.swap(true, Ordering::SeqCst) {
        return Err(AppError::conflict("karaoke_realign_running"));
    }
    let tracks = match stale(&st, &models).await {
        Ok(t) => t,
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
        aligner(models, lang, &set).map(|m| m.id.clone())
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
