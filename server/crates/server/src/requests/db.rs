//! Queries of the `requests`, `request_comments` and `auto_approval_rules` tables (`requests.md` SQL section).
use super::TitleKey;
use crate::media::external_ids;
use fliks_domain::{external_id::ExternalProvider, media::kind::MediaKind};
use serde_json::Value;
use sqlx::{PgConnection, PgExecutor, PgPool, types::Json};

pub const ACTIVE: [&str; 4] = ["pending", "approved", "processing", "available"];
pub const IN_FLIGHT: [&str; 3] = ["pending", "approved", "processing"];

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

/// The columns the rules read; relation ids are the FK columns.
#[derive(Debug, Clone)]
pub struct Req {
    pub id: i32,
    pub user_id: Option<i32>,
    pub media_type: MediaKind,
    pub kind: String,
    pub provider: ExternalProvider,
    pub external_id: String,
    pub title: String,
    pub status: String,
    pub seasons: Option<Json<Vec<i64>>>,
    pub quality_profile_id: Option<i32>,
    pub language_profile_id: Option<i32>,
    pub library_id: Option<i32>,
    pub media_id: Option<i32>,
}

/// `Req` as the database returns it, before `media_type` is decoded.
struct RawReq {
    id: i32,
    user_id: Option<i32>,
    media_type: String,
    kind: String,
    provider: String,
    external_id: String,
    title: String,
    status: String,
    seasons: Option<Json<Vec<i64>>>,
    quality_profile_id: Option<i32>,
    language_profile_id: Option<i32>,
    library_id: Option<i32>,
    media_id: Option<i32>,
}

impl TryFrom<RawReq> for Req {
    type Error = sqlx::Error;

    fn try_from(r: RawReq) -> sqlx::Result<Self> {
        Ok(Self {
            id: r.id,
            user_id: r.user_id,
            media_type: crate::db::kind(&r.media_type)?,
            kind: r.kind,
            provider: ExternalProvider::parse(&r.provider).ok_or_else(|| {
                sqlx::Error::Decode(format!("unknown provider {}", r.provider).into())
            })?,
            external_id: r.external_id,
            title: r.title,
            status: r.status,
            seasons: r.seasons,
            quality_profile_id: r.quality_profile_id,
            language_profile_id: r.language_profile_id,
            library_id: r.library_id,
            media_id: r.media_id,
        })
    }
}

impl Req {
    pub fn key(&self) -> TitleKey {
        TitleKey {
            media_type: self.media_type,
            provider: self.provider,
            external_id: self.external_id.clone(),
        }
    }

    /// `seasonScopeOf`: `None` covers everything (null or empty `seasons`).
    pub fn scope(&self) -> Option<&[i64]> {
        self.seasons
            .as_ref()
            .map(|s| s.0.as_slice())
            .filter(|s| !s.is_empty())
    }
}

pub async fn find(db: impl PgExecutor<'_>, id: i32) -> sqlx::Result<Option<Req>> {
    sqlx::query_as!(
        RawReq,
        r#"SELECT id, "userId" AS user_id, "mediaType" AS "media_type!", kind::text AS "kind!",
        provider, "externalId" AS external_id, title, status::text AS "status!", seasons AS "seasons: Json<Vec<i64>>",
        "qualityProfileId" AS quality_profile_id, "languageProfileId" AS language_profile_id,
        "libraryId" AS library_id, "mediaId" AS media_id
        FROM requests WHERE id = $1"#,
        id
    )
    .fetch_optional(db)
    .await?
    .map(Req::try_from)
    .transpose()
}

/// Active ADD rows of a title, oldest first (the guard, `title-state` and the series profile lock).
pub async fn active_adds(db: &PgPool, t: &TitleKey) -> sqlx::Result<Vec<Req>> {
    sqlx::query_as!(
        RawReq,
        r#"SELECT id, "userId" AS user_id, "mediaType" AS "media_type!", kind::text AS "kind!",
        provider, "externalId" AS external_id, title, status::text AS "status!", seasons AS "seasons: Json<Vec<i64>>",
        "qualityProfileId" AS quality_profile_id, "languageProfileId" AS language_profile_id,
        "libraryId" AS library_id, "mediaId" AS media_id
        FROM requests
        WHERE "mediaType" = $1 AND provider = $2 AND "externalId" = $3 AND kind = 'add'
        AND status::text = ANY($4) ORDER BY "createdAt" ASC, id ASC"#,
        t.media_type.as_str(),
        t.provider.as_str(),
        t.external_id,
        &strs(&ACTIVE)
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(Req::try_from)
    .collect()
}

pub async fn pending_delete_exists(db: &PgPool, t: &TitleKey) -> sqlx::Result<bool> {
    sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM requests WHERE "mediaType" = $1 AND provider = $2
        AND "externalId" = $3 AND kind = 'delete' AND status = 'pending') AS "e!""#,
        t.media_type.as_str(),
        t.provider.as_str(),
        t.external_id
    )
    .fetch_one(db)
    .await
}

/// ADD requests of a user and type that still count against the quota (rule 13).
pub async fn quota_count(
    db: &PgPool,
    user_id: i32,
    media_type: MediaKind,
    since: chrono::DateTime<chrono::Utc>,
) -> sqlx::Result<i64> {
    sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM requests WHERE "userId" = $1 AND "mediaType" = $2
        AND kind = 'add' AND status IN ('pending', 'approved') AND "createdAt" >= $3"#,
        user_id,
        media_type.as_str(),
        since
    )
    .fetch_one(db)
    .await
}

/// A library media row as the request rules see it.
#[derive(Debug, Clone)]
pub struct MediaRow {
    pub id: i32,
    pub media_type: MediaKind,
    pub library_id: Option<i32>,
    pub quality_profile_id: Option<i32>,
    pub language_profile_id: Option<i32>,
    pub poster_url: Option<String>,
    pub fanart_url: Option<String>,
}

/// `MediaRow` as the database returns it, before `media_type` is decoded.
struct RawMediaRow {
    id: i32,
    media_type: String,
    library_id: Option<i32>,
    quality_profile_id: Option<i32>,
    language_profile_id: Option<i32>,
    poster_url: Option<String>,
    fanart_url: Option<String>,
}

impl TryFrom<RawMediaRow> for MediaRow {
    type Error = sqlx::Error;

    fn try_from(r: RawMediaRow) -> sqlx::Result<Self> {
        Ok(Self {
            id: r.id,
            media_type: crate::db::kind(&r.media_type)?,
            library_id: r.library_id,
            quality_profile_id: r.quality_profile_id,
            language_profile_id: r.language_profile_id,
            poster_url: r.poster_url,
            fanart_url: r.fanart_url,
        })
    }
}

pub async fn media_by_id(db: impl PgExecutor<'_>, id: i32) -> sqlx::Result<Option<MediaRow>> {
    sqlx::query_as!(
        RawMediaRow,
        r#"SELECT id, type AS "media_type!", "libraryId" AS library_id,
        "qualityProfileId" AS quality_profile_id, "languageProfileId" AS language_profile_id,
        "posterUrl" AS poster_url, "fanartUrl" AS fanart_url FROM media WHERE id = $1"#,
        id
    )
    .fetch_optional(db)
    .await?
    .map(MediaRow::try_from)
    .transpose()
}

/// The library media holding the title (rule 8).
pub async fn media_by_ref(db: &PgPool, t: &TitleKey) -> sqlx::Result<Option<MediaRow>> {
    match external_ids::find(db, t.media_type, t.provider, &t.external_id).await? {
        Some(id) => media_by_id(db, id).await,
        None => Ok(None),
    }
}

/// Libraries accepting `media_type`, by name, limited to `ids` when given (`findAccepting`).
pub async fn libraries_accepting(
    db: &PgPool,
    media_type: MediaKind,
    ids: Option<&[i32]>,
) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar!(
        r#"SELECT id AS "id!" FROM libraries
        WHERE ($2::int[] IS NULL OR id = ANY($2)) AND "mediaTypes" ? $1
        ORDER BY name ASC, id ASC"#,
        media_type.as_str(),
        ids
    )
    .fetch_all(db)
    .await
}

pub async fn library_exists(db: &PgPool, id: i32) -> sqlx::Result<bool> {
    sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM libraries WHERE id = $1) AS "e!""#,
        id
    )
    .fetch_one(db)
    .await
}

/// Serialises the duplicate check and the insert of one title's ADD requests until the transaction ends.
pub async fn lock_title(tx: &mut PgConnection, t: &TitleKey) -> sqlx::Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!(
            "requests:{}:{}:{}",
            t.media_type, t.provider, t.external_id
        ))
        .execute(tx)
        .await?;
    Ok(())
}

pub struct New<'a> {
    pub user_id: i32,
    pub kind: &'a str,
    pub title_key: &'a TitleKey,
    pub title: &'a str,
    pub seasons: Option<&'a [i64]>,
    pub status: &'a str,
    pub approved_by: Option<i32>,
    pub quality_profile_id: Option<i32>,
    pub language_profile_id: Option<i32>,
    pub library_id: Option<i32>,
    pub media_id: Option<i32>,
    pub poster_url: Option<&'a str>,
    pub fanart_url: Option<&'a str>,
}

pub async fn insert(db: impl PgExecutor<'_>, n: New<'_>) -> sqlx::Result<i32> {
    sqlx::query_scalar!(
        r#"INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, seasons, status,
        "approvedById", "qualityProfileId", "languageProfileId", "libraryId", "mediaId", "posterUrl", "fanartUrl")
        VALUES ($1, $2::text::requests_kind_enum, $3, $4, $5, $6, $7,
        $8::text::requests_status_enum, $9, $10, $11, $12, $13, $14, $15) RETURNING id"#,
        n.user_id,
        n.kind,
        n.title_key.media_type.as_str(),
        n.title_key.provider.as_str(),
        n.title_key.external_id,
        n.title,
        n.seasons.map(|s| Json(s.to_vec())) as Option<Json<Vec<i64>>>,
        n.status,
        n.approved_by,
        n.quality_profile_id,
        n.language_profile_id,
        n.library_id,
        n.media_id,
        n.poster_url,
        n.fanart_url
    )
    .fetch_one(db)
    .await
}

pub async fn set_art(
    db: &PgPool,
    id: i32,
    poster: Option<&str>,
    fanart: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE requests SET "posterUrl" = $2, "fanartUrl" = $3 WHERE id = $1"#,
        id,
        poster,
        fanart
    )
    .execute(db)
    .await?;
    Ok(())
}

/// `PATCH` of a pending row: `None` leaves a column, `Some(None)` clears it; false when it is no longer pending.
pub async fn patch(
    db: &PgPool,
    id: i32,
    quality: Option<Option<i32>>,
    language: Option<Option<i32>>,
    library: Option<Option<i32>>,
) -> sqlx::Result<bool> {
    Ok(sqlx::query!(
        r#"UPDATE requests SET
        "qualityProfileId" = CASE WHEN $2 THEN $3 ELSE "qualityProfileId" END,
        "languageProfileId" = CASE WHEN $4 THEN $5 ELSE "languageProfileId" END,
        "libraryId" = CASE WHEN $6 THEN $7 ELSE "libraryId" END WHERE id = $1 AND status = 'pending'"#,
        id,
        quality.is_some(),
        quality.flatten(),
        language.is_some(),
        language.flatten(),
        library.is_some(),
        library.flatten()
    )
    .execute(db)
    .await?
    .rows_affected()
        == 1)
}

/// Deletes the row; `pending_only` (a requester cancelling) leaves a row that moved on. False when nothing went.
pub async fn delete(db: &PgPool, id: i32, pending_only: bool) -> sqlx::Result<bool> {
    Ok(sqlx::query!(
        "DELETE FROM requests WHERE id = $1 AND (NOT $2 OR status = 'pending')",
        id,
        pending_only
    )
    .execute(db)
    .await?
    .rows_affected()
        == 1)
}

/// Declines a pending row; false when it is no longer pending.
pub async fn decline(db: &PgPool, id: i32, by: i32, reason: Option<&str>) -> sqlx::Result<bool> {
    Ok(sqlx::query!(
        r#"UPDATE requests SET status = 'declined', "approvedById" = $2, "declinedReason" = $3
           WHERE id = $1 AND status = 'pending'"#,
        id,
        by,
        reason
    )
    .execute(db)
    .await?
    .rows_affected()
        == 1)
}

/// Takes a pending row for approval; false when it is not pending.
pub async fn claim_approval(
    db: &PgPool,
    id: i32,
    by: i32,
    media_id: Option<i32>,
) -> sqlx::Result<bool> {
    let r = sqlx::query!(
        r#"UPDATE requests SET status = 'approved', "approvedById" = $2, "declinedReason" = NULL,
        "mediaId" = COALESCE($3, "mediaId") WHERE id = $1 AND status = 'pending'"#,
        id,
        by,
        media_id
    )
    .execute(db)
    .await?;
    Ok(r.rows_affected() == 1)
}

/// Gives back the approval `by` claimed, unless the row moved on since.
pub async fn rollback_to_pending(db: &PgPool, id: i32, by: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE requests SET status = 'pending', "approvedById" = NULL
           WHERE id = $1 AND status = 'approved' AND "approvedById" = $2"#,
        id,
        by
    )
    .execute(db)
    .await?;
    Ok(())
}

/// Links the media of an approval that imported nothing itself (rule 23 step 8).
pub async fn link_if_unlinked(db: &PgPool, id: i32, media_id: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE requests SET "mediaId" = $2 WHERE id = $1 AND status = 'approved' AND "mediaId" IS NULL"#,
        id,
        media_id
    )
    .execute(db)
    .await?;
    Ok(())
}

/// In-flight requests whose title the media holds (`onMediaImported`).
pub async fn in_flight_for_media(db: &PgPool, media_id: i32) -> sqlx::Result<Vec<Req>> {
    sqlx::query_as!(
        RawReq,
        r#"SELECT id, "userId" AS user_id, "mediaType" AS "media_type!", kind::text AS "kind!",
        provider, "externalId" AS external_id, title, status::text AS "status!", seasons AS "seasons: Json<Vec<i64>>",
        "qualityProfileId" AS quality_profile_id, "languageProfileId" AS language_profile_id,
        "libraryId" AS library_id, "mediaId" AS media_id
        FROM requests r WHERE status::text = ANY($2) AND EXISTS (SELECT 1 FROM media_external_ids e
          WHERE e."mediaId" = $1 AND e.kind = r."mediaType" AND e.provider = r.provider
          AND e.value = r."externalId")
        ORDER BY id"#,
        media_id,
        &strs(&IN_FLIGHT)
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(Req::try_from)
    .collect()
}

/// Rows linked by FK to `media_id` in one of `statuses`, optionally of one `kind`.
pub async fn linked(
    db: impl PgExecutor<'_>,
    media_id: i32,
    kind: Option<&str>,
    statuses: &[&str],
) -> sqlx::Result<Vec<Req>> {
    sqlx::query_as!(
        RawReq,
        r#"SELECT id, "userId" AS user_id, "mediaType" AS "media_type!", kind::text AS "kind!",
        provider, "externalId" AS external_id, title, status::text AS "status!", seasons AS "seasons: Json<Vec<i64>>",
        "qualityProfileId" AS quality_profile_id, "languageProfileId" AS language_profile_id,
        "libraryId" AS library_id, "mediaId" AS media_id
        FROM requests WHERE "mediaId" = $1 AND ($2::text IS NULL OR kind::text = $2)
        AND status::text = ANY($3) ORDER BY id"#,
        media_id,
        kind,
        &strs(statuses)
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(Req::try_from)
    .collect()
}

/// Media that still have an `approved` or `processing` ADD request linked (the reconcile's work list).
pub async fn media_with_open_adds(db: &PgPool) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar!(
        r#"SELECT DISTINCT "mediaId" AS "id!" FROM requests
        WHERE kind = 'add' AND "mediaId" IS NOT NULL AND status IN ('approved', 'processing')"#
    )
    .fetch_all(db)
    .await
}

/// `onMediaImported`: link, and approve a pending row (the importer approves when known).
pub async fn adopt(db: &PgPool, id: i32, media_id: i32, approver: Option<i32>) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE requests SET "mediaId" = $2,
        "approvedById" = CASE WHEN status = 'pending' AND $3::int IS NOT NULL THEN $3 ELSE "approvedById" END,
        status = CASE WHEN status = 'pending' THEN 'approved'::requests_status_enum ELSE status END
        WHERE id = $1 AND status::text = ANY('{pending,approved,processing}')"#,
        id,
        media_id,
        approver
    )
    .execute(db)
    .await?;
    Ok(())
}

/// Moves a row from one of `from` to `to`; false when another event already moved it.
pub async fn set_status(db: &PgPool, id: i32, to: &str, from: &[&str]) -> sqlx::Result<bool> {
    let from: Vec<String> = from.iter().map(|s| (*s).to_owned()).collect();
    Ok(sqlx::query!(
        "UPDATE requests SET status = $2::text::requests_status_enum WHERE id = $1 AND status::text = ANY($3)",
        id,
        to,
        &from
    )
    .execute(db)
    .await?
    .rows_affected()
        == 1)
}

pub async fn trim_seasons(db: &PgPool, id: i32, seasons: &[i64]) -> sqlx::Result<()> {
    sqlx::query!(
        "UPDATE requests SET seasons = $2 WHERE id = $1",
        id,
        Json(seasons.to_vec()) as Json<Vec<i64>>
    )
    .execute(db)
    .await?;
    Ok(())
}

/// Declines the rows and unlinks the media (`onSeasonMonitorChange`).
pub async fn decline_unlink(db: &PgPool, id: i32, reason: &str) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE requests SET status = 'declined', "declinedReason" = $2, "mediaId" = NULL
           WHERE id = $1 AND status IN ('pending', 'approved', 'processing')"#,
        id,
        reason
    )
    .execute(db)
    .await?;
    Ok(())
}

/// An `available` row whose season left the monitored set: terminal, no longer blocks a re-request.
pub async fn remove_unlink(db: &PgPool, id: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE requests SET status = 'removed', "mediaId" = NULL WHERE id = $1 AND status = 'available'"#,
        id
    )
    .execute(db)
    .await?;
    Ok(())
}

/// The ADD rows linked to a media that left the library or was unmonitored: in-flight are declined with
/// `reason`, `available` become `removed`, all unlinked.
pub async fn retire_linked(db: &mut PgConnection, media_id: i32, reason: &str) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE requests SET status = 'declined', "declinedReason" = $2, "mediaId" = NULL
        WHERE "mediaId" = $1 AND kind = 'add' AND status IN ('pending', 'approved', 'processing')"#,
        media_id,
        reason
    )
    .execute(&mut *db)
    .await?;
    sqlx::query!(
        r#"UPDATE requests SET status = 'removed', "mediaId" = NULL
        WHERE "mediaId" = $1 AND kind = 'add' AND status = 'available'"#,
        media_id
    )
    .execute(db)
    .await?;
    Ok(())
}

/// `onMediaRemoved` in the delete's transaction: delete rows are done, add rows are declined.
pub async fn resolve_removed(db: &mut PgConnection, media_id: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE requests SET status = 'approved', "declinedReason" = NULL, "mediaId" = NULL
        WHERE "mediaId" = $1 AND kind = 'delete' AND status IN ('pending', 'approved', 'processing')"#,
        media_id
    )
    .execute(&mut *db)
    .await?;
    retire_linked(db, media_id, "Media removed from library").await?;
    Ok(())
}

/// The monitored season numbers of a series plus `season` (just unmonitored): what a whole-series request covered.
pub async fn monitored_seasons(db: &PgPool, media_id: i32, season: i64) -> sqlx::Result<Vec<i64>> {
    let season = i32::try_from(season).unwrap_or_default();
    let nums = sqlx::query_scalar!(
        r#"SELECT "number" AS "n!" FROM item_groups
        WHERE "mediaId" = $1 AND (monitored OR "number" = $2) ORDER BY 1"#,
        media_id,
        season
    )
    .fetch_all(db)
    .await?;
    Ok(nums.into_iter().map(i64::from).collect())
}

/// Whole media monitored, and the listed seasons of a series (`applyMonitoredForRequestScope`).
pub async fn monitor_scope(
    db: &PgPool,
    media_id: i32,
    seasons: Option<&[i64]>,
) -> sqlx::Result<()> {
    sqlx::query!(
        "UPDATE media SET monitored = true WHERE id = $1 AND NOT monitored",
        media_id
    )
    .execute(db)
    .await?;
    if let Some(s) = seasons.filter(|s| !s.is_empty()) {
        let nums: Vec<i32> = s.iter().filter_map(|n| i32::try_from(*n).ok()).collect();
        sqlx::query!(
            r#"UPDATE item_groups SET monitored = true
            WHERE "mediaId" = $1 AND "number" = ANY($2) AND NOT monitored"#,
            media_id,
            &nums
        )
        .execute(db)
        .await?;
    }
    Ok(())
}

/// Episodes of a media, for the coverage check of `onImportComplete`.
pub struct Ep {
    pub season_number: i32,
    pub season_monitored: bool,
    pub number: i32,
    pub monitored: bool,
    pub has_file: bool,
}

pub async fn episodes(db: &PgPool, media_id: i32) -> sqlx::Result<Vec<Ep>> {
    sqlx::query_as!(
        Ep,
        r#"SELECT s."number" AS season_number, s.monitored AS season_monitored,
        e."number" AS "number!", e.monitored,
        EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id) AS "has_file!"
        FROM item_groups s JOIN items e ON e."groupId" = s.id WHERE s."mediaId" = $1
        ORDER BY s."number", e."number", e.id"#,
        media_id
    )
    .fetch_all(db)
    .await
}

pub async fn file_count(db: &PgPool, media_id: i32) -> sqlx::Result<i64> {
    sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM media_files WHERE "mediaId" = $1"#,
        media_id
    )
    .fetch_one(db)
    .await
}

/// Where the list and the resolved row share one query: `id`, scope and filters are all optional.
pub struct Filter<'a> {
    pub id: Option<i32>,
    pub user_id: Option<i32>,
    pub libraries: Option<&'a [i32]>,
    pub status: Option<&'a str>,
    pub kind: Option<&'a str>,
    pub tmdb_id: Option<i32>,
    pub media_type: Option<MediaKind>,
}

pub async fn count(db: &PgPool, f: &Filter<'_>) -> sqlx::Result<i64> {
    sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM requests r
        WHERE ($1::int IS NULL OR r.id = $1) AND ($2::int IS NULL OR r."userId" = $2)
        AND ($3::int[] IS NULL OR r."libraryId" IS NULL OR r."libraryId" = ANY($3))
        AND ($4::text IS NULL OR r.status::text = $4) AND ($5::text IS NULL OR r.kind::text = $5)
        AND ($6::text IS NULL OR (r.provider = $8 AND r."externalId" = $6))
        AND ($7::text IS NULL OR r."mediaType" = $7)"#,
        f.id,
        f.user_id,
        f.libraries,
        f.status,
        f.kind,
        f.tmdb_id.map(|t| t.to_string()),
        f.media_type.map(MediaKind::as_str),
        external_ids::TMDB
    )
    .fetch_one(db)
    .await
}

/// Request rows as JSON with the embedded public identities and the library media joined by
/// the title they name (rules 5, 6, 8), newest first.
pub async fn rows(
    db: &PgPool,
    f: &Filter<'_>,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<Value>> {
    sqlx::query_scalar!(
        r#"SELECT jsonb_build_object(
  'id', r.id, 'createdAt', iso_ms(r."createdAt"), 'updatedAt', iso_ms(r."updatedAt"),
  'user', CASE WHEN u.id IS NULL THEN 'null'::jsonb
    ELSE jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar) END,
  'userId', r."userId", 'mediaType', r."mediaType", 'kind', r.kind::text,
  'tmdbId', CASE WHEN r.provider = $10 THEN r."externalId"::int END,
  'title', r.title, 'status', r.status::text,
  'approvedBy', CASE WHEN ab.id IS NULL THEN 'null'::jsonb
    ELSE jsonb_build_object('id', ab.id, 'username', ab.username, 'avatar', ab.avatar) END,
  'approvedById', r."approvedById", 'declinedReason', r."declinedReason",
  'qualityProfileId', r."qualityProfileId", 'languageProfileId', r."languageProfileId",
  'libraryId', r."libraryId",
  'media', CASE WHEN m.id IS NULL THEN 'null'::jsonb ELSE
    jsonb_build_object('id', m.id, 'createdAt', iso_ms(m."createdAt"), 'updatedAt', iso_ms(m."updatedAt"),
      'title', m.title, 'originalTitle', m."originalTitle", 'alternativeTitles', m."alternativeTitles",
      'year', m.year, 'type', m.type, 'tmdbId', ids.tmdb, 'imdbId', ids.imdb, 'tvdbId', ids.tvdb,
      'overview', m.overview, 'status', m.status::text, 'monitored', m.monitored,
      'libraryId', m."libraryId", 'preferredProvider', m."preferredProvider", 'folderName', m."folderName",
      'posterUrl', m."posterUrl", 'metadataRefreshedAt', iso_ms(m."metadataRefreshedAt"),
      'fanartUrl', m."fanartUrl", 'logoUrl', m."logoUrl", 'additionalFanartUrls', to_jsonb(m."additionalFanartUrls"))
    || jsonb_build_object('rating', m.rating, 'genres', m.genres, 'tmdbCollectionId', m."tmdbCollectionId",
      'tmdbCollectionName', m."tmdbCollectionName", 'runtime', m.runtime, 'releaseDate', dates.release_date,
      'inCinemas', dates.cinema_date, 'digitalRelease', dates.digital_date, 'physicalRelease', dates.physical_date,
      'minimumAvailability', m."minimumAvailability", 'qualityProfileId', m."qualityProfileId",
      'languageProfileId', m."languageProfileId", 'addedById', m."addedById", 'path', NULL) END,
  'mediaId', r."mediaId", 'seasons', r.seasons, 'posterUrl', r."posterUrl", 'fanartUrl', r."fanartUrl"
) AS "json!: Value"
FROM requests r
LEFT JOIN users u ON u.id = r."userId"
LEFT JOIN users ab ON ab.id = r."approvedById"
LEFT JOIN media m ON m.id = (SELECT e."mediaId" FROM media_external_ids e
  WHERE e.kind = r."mediaType" AND e.provider = r.provider AND e.value = r."externalId"
  ORDER BY e."mediaId" LIMIT 1)
LEFT JOIN LATERAL (SELECT max(value) FILTER (WHERE provider = $10)::int AS tmdb,
  max(value) FILTER (WHERE provider = $11)::int AS tvdb,
  max(value) FILTER (WHERE provider = $12) AS imdb
  FROM media_external_ids WHERE "mediaId" = m.id) ids ON true
LEFT JOIN LATERAL (SELECT max(date) FILTER (WHERE kind = 'cinema') AS cinema_date,
             max(date) FILTER (WHERE kind = 'digital') AS digital_date,
             max(date) FILTER (WHERE kind = 'physical') AS physical_date,
             max(date) FILTER (WHERE kind = 'release') AS release_date
           FROM media_release_dates WHERE "mediaId" = m.id) dates ON true
WHERE ($1::int IS NULL OR r.id = $1) AND ($2::int IS NULL OR r."userId" = $2)
AND ($3::int[] IS NULL OR r."libraryId" IS NULL OR r."libraryId" = ANY($3))
AND ($4::text IS NULL OR r.status::text = $4) AND ($5::text IS NULL OR r.kind::text = $5)
AND ($6::text IS NULL OR (r.provider = $10 AND r."externalId" = $6))
AND ($7::text IS NULL OR r."mediaType" = $7)
ORDER BY r."createdAt" DESC, r.id ASC LIMIT $8 OFFSET $9"#,
        f.id,
        f.user_id,
        f.libraries,
        f.status,
        f.kind,
        f.tmdb_id.map(|t| t.to_string()),
        f.media_type.map(MediaKind::as_str),
        limit,
        offset,
        external_ids::TMDB,
        external_ids::TVDB,
        external_ids::IMDB
    )
    .fetch_all(db)
    .await
}

/// Comments of a request with their authors, oldest first.
pub async fn comments(db: &PgPool, request_id: i32) -> sqlx::Result<Vec<Value>> {
    sqlx::query_scalar!(
        r#"SELECT jsonb_build_object('id', c.id, 'createdAt', iso_ms(c."createdAt"), 'updatedAt', iso_ms(c."updatedAt"),
  'requestId', c."requestId",
  'user', CASE WHEN u.id IS NULL THEN 'null'::jsonb
    ELSE jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar) END,
  'userId', c."userId", 'message', c.message) AS "json!: Value"
FROM request_comments c LEFT JOIN users u ON u.id = c."userId"
WHERE c."requestId" = $1 ORDER BY c."createdAt" ASC, c.id ASC"#,
        request_id
    )
    .fetch_all(db)
    .await
}

pub struct Comment {
    pub id: i32,
    pub user_id: Option<i32>,
    pub request_id: Option<i32>,
}

pub async fn comment_find(db: &PgPool, id: i32) -> sqlx::Result<Option<Comment>> {
    sqlx::query_as!(
        Comment,
        r#"SELECT id, "userId" AS user_id, "requestId" AS request_id FROM request_comments WHERE id = $1"#,
        id
    )
    .fetch_optional(db)
    .await
}

/// The saved comment of `POST :id/comments` (rule 27), its request embedded without relation ids.
pub async fn comment_insert(
    db: &PgPool,
    request_id: i32,
    user_id: i32,
    message: &str,
) -> sqlx::Result<Value> {
    sqlx::query_scalar!(
        r#"WITH c AS (INSERT INTO request_comments ("requestId", "userId", message) VALUES ($1, $2, $3)
          RETURNING id, "createdAt", "updatedAt", message)
        SELECT jsonb_build_object('id', c.id, 'createdAt', iso_ms(c."createdAt"), 'updatedAt', iso_ms(c."updatedAt"),
          'requestId', $1::int, 'userId', $2::int, 'message', c.message) AS "json!: Value" FROM c"#,
        request_id,
        user_id,
        message
    )
    .fetch_one(db)
    .await
}

pub async fn comment_delete(db: &PgPool, id: i32) -> sqlx::Result<()> {
    sqlx::query!("DELETE FROM request_comments WHERE id = $1", id)
        .execute(db)
        .await?;
    Ok(())
}

/// A user's public identity, as embedded everywhere (rule 6).
pub async fn identity(db: &PgPool, id: i32) -> sqlx::Result<Value> {
    Ok(sqlx::query_scalar!(
        r#"SELECT jsonb_build_object('id', id, 'username', username, 'avatar', avatar) AS "json!: Value"
        FROM users WHERE id = $1"#,
        id
    )
    .fetch_optional(db)
    .await?
    .unwrap_or(Value::Null))
}

#[derive(Debug, Clone)]
pub struct RuleRow {
    pub id: i32,
    pub name: String,
    pub criteria: Json<Value>,
}

pub async fn rules_enabled(db: &PgPool) -> sqlx::Result<Vec<RuleRow>> {
    sqlx::query_as!(
        RuleRow,
        r#"SELECT id, name, criteria AS "criteria: Json<Value>" FROM auto_approval_rules
        WHERE enabled = true ORDER BY id"#
    )
    .fetch_all(db)
    .await
}

pub async fn rule_list(db: &PgPool) -> sqlx::Result<Vec<Value>> {
    sqlx::query_scalar!(
        r#"SELECT jsonb_build_object('id', id, 'createdAt', iso_ms("createdAt"), 'updatedAt', iso_ms("updatedAt"),
        'name', name, 'enabled', enabled, 'criteria', criteria) AS "json!: Value"
        FROM auto_approval_rules ORDER BY name ASC, id ASC"#
    )
    .fetch_all(db)
    .await
}

pub async fn rule_find(db: &PgPool, id: i32) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar!(
        r#"SELECT jsonb_build_object('id', id, 'createdAt', iso_ms("createdAt"), 'updatedAt', iso_ms("updatedAt"),
        'name', name, 'enabled', enabled, 'criteria', criteria) AS "json!: Value"
        FROM auto_approval_rules WHERE id = $1"#,
        id
    )
    .fetch_optional(db)
    .await
}

pub async fn rule_insert(
    db: &PgPool,
    name: &str,
    enabled: bool,
    criteria: &Value,
) -> sqlx::Result<Value> {
    sqlx::query_scalar!(
        r#"WITH r AS (INSERT INTO auto_approval_rules (name, enabled, criteria) VALUES ($1, $2, $3) RETURNING *)
        SELECT jsonb_build_object('id', id, 'createdAt', iso_ms("createdAt"), 'updatedAt', iso_ms("updatedAt"),
        'name', name, 'enabled', enabled, 'criteria', criteria) AS "json!: Value" FROM r"#,
        name,
        enabled,
        criteria
    )
    .fetch_one(db)
    .await
}

pub async fn rule_update(
    db: &PgPool,
    id: i32,
    name: &str,
    enabled: bool,
    criteria: &Value,
) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar!(
        r#"WITH r AS (UPDATE auto_approval_rules SET name = $2, enabled = $3, criteria = $4 WHERE id = $1 RETURNING *)
        SELECT jsonb_build_object('id', id, 'createdAt', iso_ms("createdAt"), 'updatedAt', iso_ms("updatedAt"),
        'name', name, 'enabled', enabled, 'criteria', criteria) AS "json!: Value" FROM r"#,
        id,
        name,
        enabled,
        criteria
    )
    .fetch_optional(db)
    .await
}

pub async fn rule_delete(db: &PgPool, id: i32) -> sqlx::Result<bool> {
    Ok(
        sqlx::query!("DELETE FROM auto_approval_rules WHERE id = $1", id)
            .execute(db)
            .await?
            .rows_affected()
            == 1,
    )
}
