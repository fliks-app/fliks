//! Search, download, upgrade, upload and the small row edits (`subtitles.md` rules 7-19).
use super::{
    files::{self, FileRow, MediaCtx},
    model::{self, Inserted, New},
    providers::{Provider, Query, redact},
};
use crate::{http::AppError, state::AppState};
use chrono::{DateTime, Utc};
use fliks_domain::{
    language::normalize_language_code,
    srt::decode_text,
    subtitle_clean::{CleanOptions, clean_subtitle},
    subtitle_flags::HiMode,
    subtitle_path::sidecar_lang_suffix,
    subtitle_score::{Candidate, Scored, SearchParams, rank_candidates},
};
use serde_json::Value;
use sqlx::{FromRow, PgExecutor};
use std::{collections::HashSet, time::Instant};

pub const UPLOAD_MAX_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, FromRow)]
pub struct ProviderRow {
    pub id: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub settings: Value,
    pub priority: i32,
}

pub const PROVIDER_COLS: &str = r#"id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, "type"::text AS kind,
  enabled, settings, priority"#;

pub async fn enabled_providers(db: impl PgExecutor<'_>) -> sqlx::Result<Vec<ProviderRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {PROVIDER_COLS} FROM subtitle_providers WHERE enabled = true ORDER BY priority ASC, id ASC"
    )))
    .fetch_all(db)
    .await
}

/// A search as providers and the ranking read it.
#[derive(Debug, Clone, Default)]
pub struct Search {
    pub query: Query,
    pub video_release_name: Option<String>,
    pub forced: Option<bool>,
    pub hi_mode: Option<HiMode>,
}

fn record_stat(
    st: &AppState,
    provider: i32,
    kind: &'static str,
    ms: i64,
    count: i32,
    err: Option<String>,
) {
    let db = st.db.clone();
    tokio::spawn(async move {
        let r = sqlx::query(
            r#"INSERT INTO subtitle_provider_stats ("providerId", "queryType", "responseTimeMs", "resultCount", "errorMessage")
               VALUES ($1, $2, $3, $4, $5)"#,
        )
        .bind(provider)
        .bind(kind)
        .bind(ms as i32)
        .bind(count)
        .bind(err)
        .execute(&db)
        .await;
        if let Err(e) = r {
            tracing::warn!("Provider stat not stored: {e}");
        }
    });
}

pub async fn blacklist_keys(db: impl PgExecutor<'_>) -> sqlx::Result<HashSet<String>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as(r#"SELECT "providerType", "providerFileId" FROM subtitle_blacklist"#)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().map(|(t, f)| format!("{t}:{f}")).collect())
}

/// Sequential provider queries in priority order, then the ranking of rule 11.
pub async fn search(st: &AppState, s: &Search) -> Result<Vec<Scored>, AppError> {
    if s.query.moviehash.is_none() && s.query.imdb_id.is_none() && s.query.tmdb_id.is_none() {
        tracing::warn!(
            "Subtitle search for \"{}\" has no hash and no provider id, title-only match",
            s.query.title
        );
    }
    let providers = enabled_providers(&st.db).await?;
    let mut all: Vec<Candidate> = vec![];
    for p in &providers {
        let start = Instant::now();
        let res = match Provider::new(&p.kind, &p.settings, &st.subtitles) {
            Ok(imp) => imp.search(&s.query).await,
            Err(e) => Err(e),
        };
        let ms = start.elapsed().as_millis() as i64;
        match res {
            Ok(found) => {
                record_stat(st, p.id, "search", ms, found.len() as i32, None);
                all.extend(found);
            }
            Err(e) => {
                let e = redact(&e, &p.settings);
                record_stat(st, p.id, "search", ms, 0, Some(e.clone()));
                tracing::warn!("Search failed for provider {}: {e}", p.name);
            }
        }
    }
    tracing::info!(
        "Subtitle search for \"{}\" [{}]: {} result(s) from {} provider(s)",
        s.query.title,
        s.query.language,
        all.len(),
        providers.len()
    );
    let blacklist = blacklist_keys(&st.db).await?;
    Ok(rank_candidates(
        all,
        &blacklist,
        &SearchParams {
            imdb_id: s.query.imdb_id.clone(),
            title: s.query.title.clone(),
            year: s.query.year,
            season: s.query.season,
            episode: s.query.episode,
            language: s.query.language.clone(),
            video_release_name: s.video_release_name.clone(),
            forced: s.forced,
            hi_mode: s.hi_mode,
        },
    ))
}

pub async fn flag_on(st: &AppState, key: &str) -> Result<bool, AppError> {
    Ok(crate::settings::setting_value(&st.db, key)
        .await?
        .as_deref()
        == Some("true"))
}

pub async fn clean_options(st: &AppState, ads: bool) -> Result<CleanOptions, AppError> {
    let remove_hi_tags = flag_on(st, "subtitle_remove_hi_tags").await?;
    let exclusions = crate::settings::setting_value(&st.db, "subtitle_custom_exclusions")
        .await?
        .unwrap_or_default();
    let custom_exclusions: Vec<String> = exclusions
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .map(str::to_owned)
        .collect();
    let (_, skipped) = fliks_domain::subtitle_clean::compile_exclusions(&custom_exclusions);
    if skipped > 0 {
        tracing::warn!(
            skipped,
            "subtitle exclusion patterns skipped (invalid regex)"
        );
    }
    Ok(CleanOptions {
        remove_ads: ads,
        remove_hi_tags,
        custom_exclusions,
    })
}

/// `resolveMediaFilePath`: the media with its folder and the file, which must belong to it.
pub async fn resolve_file(
    st: &AppState,
    media_id: i32,
    file_id: i32,
    episode_id: Option<i32>,
) -> Result<(MediaCtx, FileRow), AppError> {
    let media = files::load_media(&st.db, media_id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(media_id))?;
    if media
        .library_path
        .as_deref()
        .is_none_or(|p| p.trim().is_empty())
    {
        return Err(AppError::bad_request(files::NO_ROOT_DOWNLOAD));
    }
    let file = files::file_by_id(&st.db, file_id).await?.filter(|f| {
        f.media_id == Some(media_id) && episode_id.is_none_or(|e| f.episode_id == Some(e))
    });
    let file =
        file.ok_or_else(|| AppError::not_found(format!("MediaFile #{file_id} not found")))?;
    Ok((media, file))
}

/// The saved row of a download, as the route answers it.
pub struct Saved {
    pub new: New,
    pub inserted: Inserted,
}

impl Saved {
    pub fn json(&self) -> Value {
        self.new.saved_json(&self.inserted)
    }
}

/// `downloadSubtitle`: provider, download, clean, confined write, row (rule 16).
pub async fn download(
    st: &AppState,
    media_id: i32,
    file_id: i32,
    episode_id: Option<i32>,
    c: &Candidate,
) -> Result<Saved, AppError> {
    let providers = enabled_providers(&st.db).await?;
    let provider = providers
        .iter()
        .find(|p| p.kind == c.provider_type)
        .ok_or_else(|| AppError::not_found("No matching provider found"))?;
    let (media, file) = resolve_file(st, media_id, file_id, episode_id).await?;
    let start = Instant::now();
    let got = match Provider::new(&provider.kind, &provider.settings, &st.subtitles) {
        Ok(imp) => imp.download(c).await,
        Err(e) => Err(e),
    };
    let ms = start.elapsed().as_millis() as i64;
    let bytes = match got {
        Ok(b) if b.len() > UPLOAD_MAX_BYTES => {
            let e = "Subtitle file is too large".to_owned();
            record_stat(st, provider.id, "download", ms, 0, Some(e.clone()));
            return Err(AppError::bad_request(format!(
                "Download failed ({}): {e}",
                provider.name
            )));
        }
        Ok(b) => {
            record_stat(st, provider.id, "download", ms, 1, None);
            b
        }
        Err(e) => {
            let e = redact(&e, &provider.settings);
            record_stat(st, provider.id, "download", ms, 0, Some(e.clone()));
            return Err(AppError::bad_request(format!(
                "Download failed ({}): {e}",
                provider.name
            )));
        }
    };
    let opts = clean_options(st, true).await?;
    let lang = normalize_language_code(Some(&c.language));
    let hearing_impaired = c.hearing_impaired && !opts.remove_hi_tags;
    let suffix = sidecar_lang_suffix(&lang, c.forced, hearing_impaired);
    let cleaned = clean_subtitle(&decode_text(&bytes), &opts);
    let dirs = media.dirs(files::NO_ROOT_ADD)?;
    let rel = { dirs.write_sidecar(&file.relative_path, &suffix, ".srt", cleaned.as_bytes())? };
    let new = New {
        media_id,
        media_file_id: file_id,
        episode_id: episode_id.filter(|e| *e != 0),
        language: lang,
        forced: c.forced,
        hearing_impaired,
        provider_type: provider.kind.clone(),
        provider_file_id: Some(c.provider_file_id.clone()),
        file_path: Some(rel.clone()),
        status: "downloaded".into(),
        score: c.score.clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32,
        hash_matched: c.hash_matched.unwrap_or(false),
        synced: false,
        ..New::default()
    };
    match model::insert(&st.db, &new).await {
        Ok(inserted) => Ok(Saved { new, inserted }),
        Err(e) => {
            // A row that failed to insert leaves no orphan file.
            let _ = dirs.unlink(&rel);
            Err(e.into())
        }
    }
}

/// `upgradeSubtitle` (rule 17): the replacement is saved before the old file and row go.
pub async fn upgrade(st: &AppState, id: i32, c: Option<&Candidate>) -> Result<Saved, AppError> {
    let old = model::by_id(&st.db, id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("SubtitleFile #{id} not found")))?;
    if old.is_embedded() {
        return Err(AppError::bad_request("Cannot upgrade an embedded subtitle"));
    }
    if old.provider_type == "ocr" {
        return Err(AppError::bad_request("Cannot upgrade an OCR subtitle"));
    }
    let (media_id, file_id) = (
        old.media_id
            .ok_or_else(|| AppError::not_found("Media #0 not found"))?,
        old.media_file_id
            .ok_or_else(|| AppError::not_found("MediaFile #0 not found"))?,
    );
    // A missing `searchResult` is 400 only after the row checks.
    let c = c.ok_or_else(|| AppError::bad_request("searchResult should not be empty"))?;
    let mut saved = download(st, media_id, file_id, old.episode_id, c).await?;
    sqlx::query(
        "UPDATE subtitle_files SET status = 'upgraded', locked = $2, tags = $3 WHERE id = $1",
    )
    .bind(saved.inserted.id)
    .bind(old.locked)
    .bind(&old.tags)
    .execute(&st.db)
    .await?;
    saved.new.status = "upgraded".into();
    saved.new.locked = old.locked;
    saved.new.tags = Some(old.tags.clone());
    super::sidecars::unlink_unless_shared(st, &old).await?;
    sqlx::query("DELETE FROM subtitle_files WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await?;
    Ok(saved)
}

/// An uploaded sidecar (`uploadSubtitle`, files rule 8).
pub struct Upload {
    pub name: String,
    pub bytes: Vec<u8>,
    pub language: Option<String>,
    pub forced: Option<bool>,
    pub hearing_impaired: Option<bool>,
}

pub async fn upload(
    st: &AppState,
    media_id: i32,
    file_id: i32,
    episode_id: Option<i32>,
    up: Upload,
) -> Result<Saved, AppError> {
    let ext = fliks_domain::subtitle_name::ext(&up.name);
    if !fliks_domain::subtitle_name::SUBTITLE_EXTS.contains(&ext.as_str()) {
        return Err(AppError::bad_request(format!(
            "Unsupported subtitle format: {ext}"
        )));
    }
    let text = decode_text(&up.bytes);
    static CUES: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?m)-->|^Dialogue:").expect("static"));
    if !CUES.is_match(&text) {
        return Err(AppError::bad_request("File holds no subtitle cues"));
    }
    let (media, file) = resolve_file(st, media_id, file_id, episode_id).await?;
    let lang = normalize_language_code(up.language.as_deref());
    let parsed = fliks_domain::subtitle_name::parse_subtitle_filename(&up.name);
    let forced = up
        .forced
        .unwrap_or_else(|| parsed.as_ref().is_some_and(|p| p.forced));
    let opts = clean_options(st, true).await?;
    let is_srt = ext == ".srt";
    let hi = up
        .hearing_impaired
        .unwrap_or_else(|| parsed.as_ref().is_some_and(|p| p.hearing_impaired))
        && !(is_srt && opts.remove_hi_tags);
    let suffix = sidecar_lang_suffix(&lang, forced, hi);
    let data = if is_srt {
        clean_subtitle(&text, &opts).into_bytes()
    } else {
        up.bytes
    };
    let dirs = media.dirs(files::NO_ROOT_ADD)?;
    let rel = dirs.write_sidecar(&file.relative_path, &suffix, &ext, &data)?;
    let new = New {
        media_id,
        media_file_id: file_id,
        episode_id: episode_id.filter(|e| *e != 0),
        language: lang,
        forced,
        hearing_impaired: hi,
        provider_type: "disk".into(),
        file_path: Some(rel.clone()),
        status: "downloaded".into(),
        score: 100,
        synced: true,
        ..New::default()
    };
    match model::insert(&st.db, &new).await {
        Ok(inserted) => Ok(Saved { new, inserted }),
        Err(e) => {
            let _ = dirs.unlink(&rel);
            Err(e.into())
        }
    }
}

pub async fn set_language(st: &AppState, id: i32, language: &str) -> Result<Value, AppError> {
    let row = model::by_id(&st.db, id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Subtitle #{id} not found")))?;
    if language.trim().is_empty() {
        return Err(AppError::bad_request("Language is required"));
    }
    let lang = normalize_language_code(Some(language));
    if !fliks_domain::subtitle_path::is_language_code(&lang) {
        return Err(AppError::bad_request(vec![
            "language must match /^[a-z]{2,3}$/ regular expression",
        ]));
    }
    sqlx::query("UPDATE subtitle_files SET language = $2 WHERE id = $1")
        .bind(id)
        .bind(&lang)
        .execute(&st.db)
        .await?;
    Ok(model::by_id(&st.db, row.id)
        .await?
        .map_or(Value::Null, |r| r.json()))
}

pub async fn validate(st: &AppState, id: i32) -> Result<Value, AppError> {
    model::by_id(&st.db, id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Subtitle #{id} not found")))?;
    sqlx::query("UPDATE subtitle_files SET score = 100 WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await?;
    Ok(model::by_id(&st.db, id)
        .await?
        .map_or(Value::Null, |r| r.json()))
}
