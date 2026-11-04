//! The wished editions of a media (`docs/spec/items.md` rules 29-34, `docs/spec/wants-follows.md`).
use crate::http::AppError;
use chrono::NaiveDate;
use fliks_domain::media::{kind::MediaKind, wants::WantSpec};
use serde::Serialize;
use sqlx::{FromRow, PgConnection, PgExecutor};

/// `LEFT JOIN` of the media's video want as `w`; `alias` is the media table or its alias.
pub fn video_want_join(alias: &str) -> String {
    format!(r#"LEFT JOIN wants w ON w."mediaId" = {alias}.id AND w.family = 'video'"#)
}

/// Sets the quality profile of the media's video want.
pub async fn set_quality_profile(
    db: impl PgExecutor<'_>,
    media: i32,
    profile: Option<i32>,
) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE wants SET "qualityProfileId" = $2 WHERE "mediaId" = $1 AND family = 'video'"#,
        media,
        profile
    )
    .execute(db)
    .await
    .map(drop)
}

/// A SQL boolean, for the want `w` of the media `m`, true when the want is satisfied (`wants-follows.md` rule 2).
pub fn satisfied_sql() -> String {
    let seasonal = MediaKind::seasonal_names()
        .iter()
        .map(|k| format!("'{k}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"(CASE
  WHEN w.family = 'video' AND m.type NOT IN ({seasonal}) THEN EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id)
  WHEN w.family = 'video' THEN NOT EXISTS (
    SELECT 1 FROM item_groups ms JOIN items me ON me."groupId" = ms.id
    WHERE ms."mediaId" = m.id AND ms."number" > 0 AND ms.monitored = true AND me.monitored = true
      AND me."airDate" <= (now() AT TIME ZONE 'UTC')::date
      AND NOT EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = me.id))
  WHEN w.family = 'image' AND m.type = 'comic' THEN NOT EXISTS (
    SELECT 1 FROM items ci JOIN comic_issues cx ON cx."itemId" = ci.id
    WHERE ci."mediaId" = m.id AND ci.monitored
      AND (ci."airDate" IS NULL OR ci."airDate" <= (now() AT TIME ZONE 'UTC')::date)
      AND NOT EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = ci.id))
  ELSE EXISTS (SELECT 1 FROM editions e JOIN items i ON i."editionId" = e.id
               JOIN item_parts ip ON ip."itemId" = i.id
               WHERE e."mediaId" = m.id AND e.family = w.family
                 AND (w.language IS NULL OR e.language = w.language))
END)"#
    )
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Want {
    pub id: i32,
    pub family: String,
    pub language: Option<String>,
    #[sqlx(rename = "qualityProfileId")]
    pub quality_profile_id: Option<i32>,
    #[sqlx(rename = "folderId")]
    pub folder_id: Option<i32>,
    pub satisfied: bool,
}

pub async fn list(db: impl PgExecutor<'_>, media: i32) -> sqlx::Result<Vec<Want>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT w.id, w.family, w.language, w."qualityProfileId", w."folderId", {} AS satisfied
           FROM wants w JOIN media m ON m.id = w."mediaId" WHERE m.id = $1
           ORDER BY w.family, w.language NULLS FIRST, w.id"#,
        satisfied_sql()
    )))
    .bind(media)
    .fetch_all(db)
    .await
}

/// The quality profile ids of `specs` that are no profile of their want's family.
async fn unknown_profiles(db: impl PgExecutor<'_>, specs: &[WantSpec]) -> sqlx::Result<Vec<i32>> {
    let ids: Vec<i32> = specs.iter().filter_map(|s| s.quality_profile_id).collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let known: Vec<(i32, String)> =
        sqlx::query_as("SELECT id, family FROM quality_profiles WHERE id = ANY($1)")
            .bind(&ids)
            .fetch_all(db)
            .await?;
    Ok(specs
        .iter()
        .filter_map(|s| {
            let q = s.quality_profile_id?;
            (!known
                .iter()
                .any(|(id, f)| *id == q && f == s.family.as_str()))
            .then_some(q)
        })
        .collect())
}

/// A 400 when a spec names a quality profile that does not exist for its family.
pub async fn check_profiles(db: impl PgExecutor<'_>, specs: &[WantSpec]) -> Result<(), AppError> {
    match unknown_profiles(db, specs).await?.first() {
        Some(q) => Err(AppError::bad_request(vec![format!(
            "qualityProfileId {q} is not a profile of the want's family"
        )])),
        None => Ok(()),
    }
}

/// Unsets the profile ids `check_profiles` would refuse (a profile deleted since the specs were saved).
pub async fn drop_unknown_profiles(
    db: impl PgExecutor<'_>,
    specs: &mut [WantSpec],
) -> sqlx::Result<()> {
    let bad = unknown_profiles(db, specs).await?;
    for s in specs.iter_mut() {
        if s.quality_profile_id.is_some_and(|q| bad.contains(&q)) {
            s.quality_profile_id = None;
        }
    }
    Ok(())
}

/// The HTTP error of a failed `replace`: a profile deleted meanwhile is a 400, a vanished media a 404.
pub fn write_error(e: sqlx::Error, media: i32) -> AppError {
    match e {
        sqlx::Error::Database(d) if d.code().as_deref() == Some("23503") => {
            AppError::bad_request(vec![
                "qualityProfileId is not a profile of the want's family",
            ])
        }
        sqlx::Error::RowNotFound => crate::libraries::media_not_found(media),
        e => e.into(),
    }
}

/// Adds `specs` to the wants of a media (a present one takes a named profile) under the media's row lock.
pub async fn add(c: &mut PgConnection, media: i32, specs: &[WantSpec]) -> sqlx::Result<()> {
    sqlx::query_scalar::<_, i32>(
        r#"UPDATE media SET "updatedAt" = now() WHERE id = $1 RETURNING id"#,
    )
    .bind(media)
    .fetch_one(&mut *c)
    .await?;
    upsert(c, media, specs).await
}

/// Replaces the wants of a media by `specs` under the media's row lock (`wants-follows.md` rule 3).
pub async fn replace(c: &mut PgConnection, media: i32, specs: &[WantSpec]) -> sqlx::Result<()> {
    add(c, media, specs).await?;
    let families: Vec<&str> = specs.iter().map(|s| s.family.as_str()).collect();
    let languages: Vec<Option<&str>> = specs.iter().map(|s| s.language.as_deref()).collect();
    sqlx::query(
        r#"DELETE FROM wants w WHERE w."mediaId" = $1 AND NOT EXISTS (
             SELECT 1 FROM UNNEST($2::text[], $3::text[]) AS v(f, l)
             WHERE v.f = w.family AND v.l IS NOT DISTINCT FROM w.language)"#,
    )
    .bind(media)
    .bind(&families)
    .bind(&languages)
    .execute(&mut *c)
    .await
    .map(drop)
}

async fn upsert(c: &mut PgConnection, media: i32, specs: &[WantSpec]) -> sqlx::Result<()> {
    let families: Vec<&str> = specs.iter().map(|s| s.family.as_str()).collect();
    let languages: Vec<Option<&str>> = specs.iter().map(|s| s.language.as_deref()).collect();
    let profiles: Vec<Option<i32>> = specs.iter().map(|s| s.quality_profile_id).collect();
    sqlx::query(
        r#"INSERT INTO wants ("mediaId", family, language, "qualityProfileId", "folderId")
           SELECT $1, v.f, v.l, v.q,
                  COALESCE((SELECT w."folderId" FROM wants w WHERE w."mediaId" = $1 AND w."folderId" IS NOT NULL
                            ORDER BY w.id LIMIT 1),
                           (SELECT df."folderId" FROM media m
                              JOIN library_default_folders df ON df."libraryId" = m."libraryId" WHERE m.id = $1))
           FROM UNNEST($2::text[], $3::text[], $4::int[]) AS v(f, l, q)
           ON CONFLICT ON CONSTRAINT "UQ_wants_media_family_language"
           DO UPDATE SET "qualityProfileId" = COALESCE(EXCLUDED."qualityProfileId", wants."qualityProfileId")"#,
    )
    .bind(media)
    .bind(&families)
    .bind(&languages)
    .bind(&profiles)
    .execute(&mut *c)
    .await
    .map(drop)
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Wanted {
    #[sqlx(rename = "mediaId")]
    pub media_id: i32,
    #[sqlx(rename = "type")]
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub year: Option<i32>,
    #[sqlx(rename = "posterUrl")]
    pub poster_url: Option<String>,
    #[sqlx(rename = "releaseDate")]
    pub release_date: Option<NaiveDate>,
    pub family: String,
    pub language: Option<String>,
    #[sqlx(rename = "wantId")]
    pub want_id: i32,
}

/// The unsatisfied wants of monitored media in `libraries` (`wants-follows.md` rule 15), and their count.
pub async fn wanted(
    db: &sqlx::PgPool,
    libraries: &[i32],
    kind: Option<MediaKind>,
    released: Option<bool>,
    offset: i64,
    limit: i64,
) -> sqlx::Result<(Vec<Wanted>, i64)> {
    let filter = format!(
        r#"FROM wants w JOIN media m ON m.id = w."mediaId"
           LEFT JOIN LATERAL (SELECT d.date FROM media_release_dates d WHERE d."mediaId" = m.id AND d."editionId" IS NULL
                              ORDER BY (d.kind = 'release') DESC, d.date LIMIT 1) rel ON true
           WHERE m.monitored = true AND m."libraryId" = ANY($1) AND NOT {sat}
             AND ($2::text IS NULL OR m.type = $2)
             AND ($3::bool IS NULL OR $3 = (rel.date IS NULL OR rel.date <= (now() AT TIME ZONE 'UTC')::date))"#,
        sat = satisfied_sql()
    );
    let kind = kind.map(MediaKind::as_str);
    let rows = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT m.id AS "mediaId", m.type AS "type", m.title, m.year, m."posterUrl", rel.date AS "releaseDate",
                  w.family, w.language, w.id AS "wantId" {filter}
           ORDER BY rel.date DESC NULLS LAST, m.id, w.family, w.language NULLS FIRST, w.id OFFSET $4 LIMIT $5"#
    )))
    .bind(libraries)
    .bind(kind)
    .bind(released)
    .bind(offset)
    .bind(limit)
    .fetch_all(db)
    .await?;
    let total = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) {filter}")))
        .bind(libraries)
        .bind(kind)
        .bind(released)
        .fetch_one(db)
        .await?;
    Ok((rows, total))
}
