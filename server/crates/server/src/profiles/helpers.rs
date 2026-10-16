//! Functions the other S5 services call (`profiles.md` rules 31-34).
use super::db;
use crate::http::AppError;
use sqlx::PgPool;

type Res<T> = Result<T, AppError>;

pub fn quality_not_found(id: i32) -> AppError {
    AppError::not_found(format!("QualityProfile #{id} not found"))
}

pub fn language_not_found(id: i32) -> AppError {
    AppError::not_found(format!("LanguageProfile #{id} not found"))
}

pub fn format_not_found(id: i32) -> AppError {
    AppError::not_found(format!("Custom format #{id} not found"))
}

pub async fn find_quality_profile(db: &PgPool, id: i32) -> Res<db::QualityProfile> {
    let p = db::quality_find(db, id).await?;
    p.ok_or_else(|| quality_not_found(id))
}

pub async fn find_language_profile(db: &PgPool, id: i32) -> Res<db::LanguageProfile> {
    let p = db::language_find(db, id).await?;
    p.ok_or_else(|| language_not_found(id))
}

/// Requested must exist (400); else the library default when it still exists; else the lowest id.
pub async fn resolve_quality_profile_id_for_import(
    db: &PgPool,
    requested: Option<i32>,
    library_default: Option<i32>,
) -> Res<Option<i32>> {
    if let Some(id) = requested {
        let p = db::quality_find(db, id).await?;
        return p
            .map(|p| Some(p.id))
            .ok_or_else(|| AppError::bad_request(format!("Quality profile #{id} not found")));
    }
    if let Some(id) = library_default
        && let Some(p) = db::quality_find(db, id).await?
    {
        return Ok(Some(p.id));
    }
    Ok(db::quality_first_id(db).await?)
}

pub async fn resolve_language_profile_id_for_import(
    db: &PgPool,
    requested: Option<i32>,
    library_default: Option<i32>,
) -> Res<Option<i32>> {
    if let Some(id) = requested {
        let p = db::language_find(db, id).await?;
        return p
            .map(|p| Some(p.id))
            .ok_or_else(|| AppError::bad_request(format!("Language profile #{id} not found")));
    }
    if let Some(id) = library_default
        && let Some(p) = db::language_find(db, id).await?
    {
        return Ok(Some(p.id));
    }
    Ok(db::language_first_id(db).await?)
}

/// Resolution of the item the cutoff names, 0 when none does.
fn cutoff_resolution(p: &db::QualityProfile) -> f64 {
    p.items
        .as_array()
        .into_iter()
        .flatten()
        .find(|i| i["quality"]["id"].as_f64() == Some(f64::from(p.cutoff)))
        .and_then(|i| i["quality"]["resolution"].as_f64())
        .unwrap_or(0.0)
}

pub async fn quality_profile_covers(
    db: &PgPool,
    existing: Option<i32>,
    requested: i32,
) -> Res<bool> {
    let Some(existing) = existing else {
        return Ok(false);
    };
    if existing == requested {
        return Ok(true);
    }
    let (a, b) = (
        db::quality_find(db, existing).await?,
        db::quality_find(db, requested).await?,
    );
    Ok(matches!((a, b), (Some(a), Some(b)) if cutoff_resolution(&a) >= cutoff_resolution(&b)))
}

/// Every audio `isoCode` of the requested profile is in the existing one; subtitles are ignored.
pub async fn language_profile_covers(
    db: &PgPool,
    existing: Option<i32>,
    requested: i32,
) -> Res<bool> {
    let Some(existing) = existing else {
        return Ok(false);
    };
    if existing == requested {
        return Ok(true);
    }
    let (a, b) = (
        db::language_find(db, existing).await?,
        db::language_find(db, requested).await?,
    );
    let (Some(a), Some(b)) = (a, b) else {
        return Ok(false);
    };
    let codes = |p: &db::LanguageProfile| -> Vec<String> {
        p.audio_languages
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|l| l["isoCode"].as_str().map(str::to_owned))
            .collect()
    };
    let have = codes(&a);
    Ok(codes(&b).iter().all(|c| have.contains(c)))
}

/// A `None` requested side is no requirement on that axis.
pub async fn envelope_covers(
    db: &PgPool,
    existing: (Option<i32>, Option<i32>),
    requested: (Option<i32>, Option<i32>),
) -> Res<bool> {
    if let Some(q) = requested.0
        && !quality_profile_covers(db, existing.0, q).await?
    {
        return Ok(false);
    }
    if let Some(l) = requested.1
        && !language_profile_covers(db, existing.1, l).await?
    {
        return Ok(false);
    }
    Ok(true)
}

/// Boot check (rule 39): a stored `title_regex` the engine rejects never matches; say so once.
pub async fn warn_invalid_regexes(db: &PgPool) -> sqlx::Result<()> {
    for f in db::format_list(db).await? {
        let specs: Vec<fliks_domain::release::scoring::CustomFormatSpec> =
            serde_json::from_value(f.specs.0).unwrap_or_default();
        if let Err(pattern) = fliks_domain::release::scoring::validate_title_regexes(&specs) {
            tracing::warn!(format = f.id, %pattern, "stored title_regex does not compile");
        }
    }
    Ok(())
}
