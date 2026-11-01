//! Queries and row shapes of the four tables (`profiles.md` SQL section).
use super::dto::{DefinitionValues, FormatValues, LanguageValues, QualityValues};
use crate::http::json::iso_ms;
use chrono::{DateTime, Utc};
use fliks_domain::{media::family::Family, profiles::seed_rows};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgPool, types::Json};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityProfile {
    pub id: i32,
    #[serde(with = "iso_ms")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub cutoff: i32,
    pub items: Json<Value>,
    pub upgrade_allowed: bool,
    pub resolution_upgrade_only: bool,
    pub min_custom_format_score: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageProfile {
    pub id: i32,
    #[serde(with = "iso_ms")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub audio_languages: Json<Value>,
    pub subtitle_languages: Json<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFormat {
    pub id: i32,
    #[serde(with = "iso_ms")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub score: i32,
    pub specs: Json<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityDefinition {
    pub id: i32,
    #[serde(with = "iso_ms")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub updated_at: DateTime<Utc>,
    pub quality_id: i32,
    pub title: String,
    pub min_size: f64,
    pub preferred_size: f64,
    pub max_size: f64,
}

pub async fn quality_list(db: &PgPool) -> sqlx::Result<Vec<QualityProfile>> {
    sqlx::query_as!(
        QualityProfile,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, cutoff,
        items AS "items: Json<Value>", "upgradeAllowed" AS upgrade_allowed,
        "resolutionUpgradeOnly" AS resolution_upgrade_only,
        "minCustomFormatScore" AS min_custom_format_score
        FROM quality_profiles ORDER BY name ASC, id ASC"#
    )
    .fetch_all(db)
    .await
}

pub async fn quality_find(db: &PgPool, id: i32) -> sqlx::Result<Option<QualityProfile>> {
    sqlx::query_as!(
        QualityProfile,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, cutoff,
        items AS "items: Json<Value>", "upgradeAllowed" AS upgrade_allowed,
        "resolutionUpgradeOnly" AS resolution_upgrade_only,
        "minCustomFormatScore" AS min_custom_format_score
        FROM quality_profiles WHERE id = $1"#,
        id
    )
    .fetch_optional(db)
    .await
}

pub async fn quality_insert(db: &PgPool, v: QualityValues) -> sqlx::Result<QualityProfile> {
    sqlx::query_as!(
        QualityProfile,
        r#"INSERT INTO quality_profiles (name, cutoff, items, "upgradeAllowed",
        "resolutionUpgradeOnly", "minCustomFormatScore")
        VALUES ($1, $2, $3, COALESCE($4, false), COALESCE($5, false), COALESCE($6, 0))
        RETURNING id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, cutoff,
        items AS "items: Json<Value>", "upgradeAllowed" AS upgrade_allowed,
        "resolutionUpgradeOnly" AS resolution_upgrade_only,
        "minCustomFormatScore" AS min_custom_format_score"#,
        v.name,
        v.cutoff,
        v.items,
        v.upgrade_allowed,
        v.resolution_upgrade_only,
        v.min_custom_format_score
    )
    .fetch_one(db)
    .await
}

pub async fn quality_update(
    db: &PgPool,
    id: i32,
    v: QualityValues,
) -> sqlx::Result<Option<QualityProfile>> {
    sqlx::query_as!(
        QualityProfile,
        r#"UPDATE quality_profiles SET name = $2, cutoff = $3, items = $4,
        "upgradeAllowed" = COALESCE($5, "upgradeAllowed"),
        "resolutionUpgradeOnly" = COALESCE($6, "resolutionUpgradeOnly"),
        "minCustomFormatScore" = COALESCE($7, "minCustomFormatScore")
        WHERE id = $1
        RETURNING id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, cutoff,
        items AS "items: Json<Value>", "upgradeAllowed" AS upgrade_allowed,
        "resolutionUpgradeOnly" AS resolution_upgrade_only,
        "minCustomFormatScore" AS min_custom_format_score"#,
        id,
        v.name,
        v.cutoff,
        v.items,
        v.upgrade_allowed,
        v.resolution_upgrade_only,
        v.min_custom_format_score
    )
    .fetch_optional(db)
    .await
}

pub async fn quality_delete(db: &PgPool, id: i32) -> sqlx::Result<bool> {
    let r = sqlx::query_scalar!(
        "DELETE FROM quality_profiles WHERE id = $1 RETURNING id",
        id
    )
    .fetch_optional(db)
    .await?;
    Ok(r.is_some())
}

pub async fn quality_first_id(db: &PgPool) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar!("SELECT id FROM quality_profiles ORDER BY id ASC LIMIT 1")
        .fetch_optional(db)
        .await
}

pub async fn language_list(db: &PgPool) -> sqlx::Result<Vec<LanguageProfile>> {
    sqlx::query_as!(
        LanguageProfile,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, name,
        "audioLanguages" AS "audio_languages: Json<Value>",
        "subtitleLanguages" AS "subtitle_languages: Json<Value>"
        FROM language_profiles ORDER BY name ASC, id ASC"#
    )
    .fetch_all(db)
    .await
}

pub async fn language_find(db: &PgPool, id: i32) -> sqlx::Result<Option<LanguageProfile>> {
    sqlx::query_as!(
        LanguageProfile,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, name,
        "audioLanguages" AS "audio_languages: Json<Value>",
        "subtitleLanguages" AS "subtitle_languages: Json<Value>"
        FROM language_profiles WHERE id = $1"#,
        id
    )
    .fetch_optional(db)
    .await
}

pub async fn language_insert(db: &PgPool, v: LanguageValues) -> sqlx::Result<LanguageProfile> {
    sqlx::query_as!(
        LanguageProfile,
        r#"INSERT INTO language_profiles (name, "audioLanguages", "subtitleLanguages")
        VALUES ($1, $2, $3)
        RETURNING id, "createdAt" AS created_at, "updatedAt" AS updated_at, name,
        "audioLanguages" AS "audio_languages: Json<Value>",
        "subtitleLanguages" AS "subtitle_languages: Json<Value>""#,
        v.name,
        v.audio,
        v.subtitles
    )
    .fetch_one(db)
    .await
}

pub async fn language_update(
    db: &PgPool,
    id: i32,
    v: LanguageValues,
) -> sqlx::Result<Option<LanguageProfile>> {
    sqlx::query_as!(
        LanguageProfile,
        r#"UPDATE language_profiles SET name = $2, "audioLanguages" = $3, "subtitleLanguages" = $4
        WHERE id = $1
        RETURNING id, "createdAt" AS created_at, "updatedAt" AS updated_at, name,
        "audioLanguages" AS "audio_languages: Json<Value>",
        "subtitleLanguages" AS "subtitle_languages: Json<Value>""#,
        id,
        v.name,
        v.audio,
        v.subtitles
    )
    .fetch_optional(db)
    .await
}

pub async fn language_delete(db: &PgPool, id: i32) -> sqlx::Result<bool> {
    let r = sqlx::query_scalar!(
        "DELETE FROM language_profiles WHERE id = $1 RETURNING id",
        id
    )
    .fetch_optional(db)
    .await?;
    Ok(r.is_some())
}

pub async fn language_first_id(db: &PgPool) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar!("SELECT id FROM language_profiles ORDER BY id ASC LIMIT 1")
        .fetch_optional(db)
        .await
}

pub async fn format_list(db: &PgPool) -> sqlx::Result<Vec<CustomFormat>> {
    sqlx::query_as!(
        CustomFormat,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, score,
        specs AS "specs: Json<Value>" FROM custom_formats ORDER BY name ASC, id ASC"#
    )
    .fetch_all(db)
    .await
}

pub async fn format_find(db: &PgPool, id: i32) -> sqlx::Result<Option<CustomFormat>> {
    sqlx::query_as!(
        CustomFormat,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, score,
        specs AS "specs: Json<Value>" FROM custom_formats WHERE id = $1"#,
        id
    )
    .fetch_optional(db)
    .await
}

pub async fn format_insert(db: &PgPool, v: FormatValues) -> sqlx::Result<CustomFormat> {
    sqlx::query_as!(
        CustomFormat,
        r#"INSERT INTO custom_formats (name, score, specs) VALUES ($1, COALESCE($2, 0), $3)
        RETURNING id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, score,
        specs AS "specs: Json<Value>""#,
        v.name,
        v.score,
        v.specs
    )
    .fetch_one(db)
    .await
}

pub async fn format_update(
    db: &PgPool,
    id: i32,
    v: FormatValues,
) -> sqlx::Result<Option<CustomFormat>> {
    sqlx::query_as!(
        CustomFormat,
        r#"UPDATE custom_formats SET name = $2, score = COALESCE($3, 0), specs = $4 WHERE id = $1
        RETURNING id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, score,
        specs AS "specs: Json<Value>""#,
        id,
        v.name,
        v.score,
        v.specs
    )
    .fetch_optional(db)
    .await
}

pub async fn format_delete(db: &PgPool, id: i32) -> sqlx::Result<bool> {
    let r = sqlx::query_scalar!("DELETE FROM custom_formats WHERE id = $1 RETURNING id", id)
        .fetch_optional(db)
        .await?;
    Ok(r.is_some())
}

/// Idempotent under concurrent first calls: the guard and the conflict clause both skip.
pub async fn seed_quality_definitions(db: &PgPool) -> sqlx::Result<()> {
    let (mut ids, mut titles, mut min, mut preferred, mut max) =
        (vec![], vec![], vec![], vec![], vec![]);
    for (id, title, s) in seed_rows(Family::Video) {
        ids.push(id);
        titles.push(title.to_owned());
        min.push(s.min);
        preferred.push(s.preferred);
        max.push(s.max);
    }
    sqlx::query!(
        r#"INSERT INTO quality_definitions ("qualityId", title, "minSize", "preferredSize", "maxSize")
        SELECT * FROM unnest($1::int4[], $2::text[], $3::float8[], $4::float8[], $5::float8[])
        WHERE NOT EXISTS (SELECT 1 FROM quality_definitions WHERE family = 'video')
        ON CONFLICT (family, "qualityId") DO NOTHING"#,
        &ids,
        &titles,
        &min,
        &preferred,
        &max
    )
    .execute(db)
    .await?;
    Ok(())
}

pub async fn definition_list(db: &PgPool) -> sqlx::Result<Vec<QualityDefinition>> {
    sqlx::query_as!(
        QualityDefinition,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, "qualityId" AS quality_id,
        title, "minSize" AS min_size, "preferredSize" AS preferred_size, "maxSize" AS max_size
        FROM quality_definitions WHERE family = 'video' ORDER BY "qualityId" ASC"#
    )
    .fetch_all(db)
    .await
}

/// One transaction for the whole loop; an unknown `qualityId` updates nothing.
pub async fn definitions_update(db: &PgPool, items: Vec<DefinitionValues>) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    for it in items {
        sqlx::query!(
            r#"UPDATE quality_definitions SET title = COALESCE($2, title), "minSize" = $3,
            "preferredSize" = $4, "maxSize" = $5 WHERE family = 'video' AND "qualityId" = $1"#,
            it.quality_id,
            it.title,
            it.sizes[0],
            it.sizes[1],
            it.sizes[2]
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}
