//! Rule, candidate and exclusion rows; entities built in SQL like `requests/db.rs`.
use super::dto::Rule;
use serde_json::Value;
use sqlx::{FromRow, PgPool, types::Json};

const RULE: &str = r#"jsonb_build_object('id', id, 'createdAt', iso_ms("createdAt"), 'updatedAt', iso_ms("updatedAt"),
  'name', name, 'enabled', enabled, 'levels', levels, 'criteria', criteria, 'action', action,
  'graceDays', "graceDays", 'deleteSeriesWhenEmpty', "deleteSeriesWhenEmpty",
  'reminderDays', "reminderDays")"#;

/// What a candidate or an exclusion covers: a whole media, a season or an episode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Scope {
    pub season: Option<i32>,
    pub episode: Option<i32>,
}

#[derive(FromRow)]
pub struct RuleRow {
    pub id: i32,
    pub levels: Vec<String>,
    pub criteria: Json<Value>,
    pub action: String,
    #[sqlx(rename = "graceDays")]
    pub grace_days: Option<i32>,
}

pub async fn rules_enabled(db: &PgPool) -> sqlx::Result<Vec<RuleRow>> {
    sqlx::query_as(
        r#"SELECT id, levels, criteria, action, "graceDays" FROM cleanup_rules WHERE enabled ORDER BY id"#,
    )
    .fetch_all(db)
    .await
}

pub async fn rule_row(db: &PgPool, id: i32) -> sqlx::Result<Option<RuleRow>> {
    sqlx::query_as(
        r#"SELECT id, levels, criteria, action, "graceDays" FROM cleanup_rules WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn rule_list(db: &PgPool) -> sqlx::Result<Vec<Value>> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT {RULE} FROM cleanup_rules ORDER BY name ASC, id ASC"
    )))
    .fetch_all(db)
    .await
}

pub async fn rule_find(db: &PgPool, id: i32) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT {RULE} FROM cleanup_rules WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn rule_insert(db: &PgPool, r: &Rule) -> sqlx::Result<Value> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"WITH r AS (INSERT INTO cleanup_rules (name, enabled, levels, criteria, action, "graceDays", "deleteSeriesWhenEmpty", "reminderDays")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *) SELECT {RULE} FROM r"#
    )))
    .bind(&r.name)
    .bind(r.enabled)
    .bind(&r.levels)
    .bind(&r.criteria)
    .bind(&r.action)
    .bind(r.grace_days)
    .bind(r.delete_series_when_empty)
    .bind(&r.reminder_days)
    .fetch_one(db)
    .await
}

pub async fn rule_update(db: &PgPool, id: i32, r: &Rule) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"WITH r AS (UPDATE cleanup_rules SET name = $2, enabled = $3, levels = $4, criteria = $5, action = $6,
        "graceDays" = $7, "deleteSeriesWhenEmpty" = $8, "reminderDays" = $9 WHERE id = $1 RETURNING *) SELECT {RULE} FROM r"#
    )))
    .bind(id)
    .bind(&r.name)
    .bind(r.enabled)
    .bind(&r.levels)
    .bind(&r.criteria)
    .bind(&r.action)
    .bind(r.grace_days)
    .bind(r.delete_series_when_empty)
    .bind(&r.reminder_days)
    .fetch_optional(db)
    .await
}

pub async fn rule_delete(db: &PgPool, id: i32) -> sqlx::Result<bool> {
    Ok(sqlx::query("DELETE FROM cleanup_rules WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?
        .rows_affected()
        == 1)
}

/// Candidates of the media in `libraries`.
pub async fn candidates(db: &PgPool, libraries: &[i32]) -> sqlx::Result<Vec<Value>> {
    sqlx::query_scalar(
        r#"SELECT jsonb_build_object('id', c.id, 'mediaId', m.id, 'seasonId', c."seasonId", 'episodeId', c."episodeId",
          'seasonNumber', s."seasonNumber", 'episodeNumber', e."episodeNumber", 'title', m.title,
          'type', m."type", 'posterUrl', m."posterUrl", 'ruleId', r.id, 'ruleName', r.name, 'action', r.action,
          'size', COALESCE((SELECT SUM(f.size) FROM media_files f WHERE f."mediaId" = m.id
            AND (c."episodeId" IS NULL OR f."episodeId" = c."episodeId")
            AND (c."seasonId" IS NULL OR f."episodeId" IN (SELECT id FROM episodes WHERE "seasonId" = c."seasonId"))), 0),
          'flaggedAt', iso_ms(c."flaggedAt"), 'deleteAt', iso_ms(c."deleteAt"))
        FROM cleanup_candidates c JOIN media m ON m.id = c."mediaId" JOIN cleanup_rules r ON r.id = c."ruleId" AND r.enabled
        LEFT JOIN seasons s ON s.id = c."seasonId" LEFT JOIN episodes e ON e.id = c."episodeId"
        WHERE m."libraryId" = ANY($1)
        ORDER BY c."deleteAt" ASC NULLS LAST, m.id ASC, s."seasonNumber" ASC NULLS FIRST, e."episodeNumber" ASC NULLS FIRST"#,
    )
    .bind(libraries)
    .fetch_all(db)
    .await
}

/// The candidate's rule action and `deleteSeriesWhenEmpty`; `due_only` also needs it past `deleteAt`
/// under an enabled rule, as the job's pick did.
pub async fn candidate_action(
    db: &PgPool,
    media_id: i32,
    scope: Scope,
    due_only: bool,
) -> sqlx::Result<Option<(String, bool)>> {
    sqlx::query_as(
        r#"SELECT r.action, r."deleteSeriesWhenEmpty" FROM cleanup_candidates c JOIN cleanup_rules r ON r.id = c."ruleId"
        WHERE c."mediaId" = $1 AND c."seasonId" IS NOT DISTINCT FROM $2 AND c."episodeId" IS NOT DISTINCT FROM $3
        AND (NOT $4 OR (c."deleteAt" <= now() AND r.enabled))"#,
    )
    .bind(media_id)
    .bind(scope.season)
    .bind(scope.episode)
    .bind(due_only)
    .fetch_optional(db)
    .await
}

#[derive(FromRow)]
pub struct Due {
    #[sqlx(rename = "mediaId")]
    pub media: i32,
    #[sqlx(rename = "seasonId")]
    pub season: Option<i32>,
    #[sqlx(rename = "episodeId")]
    pub episode: Option<i32>,
}

impl Due {
    pub fn scope(&self) -> Scope {
        Scope {
            season: self.season,
            episode: self.episode,
        }
    }
}

/// Candidates past their `deleteAt` whose rule acts, oldest first.
pub async fn due(db: &PgPool, limit: i64) -> sqlx::Result<Vec<Due>> {
    sqlx::query_as(
        r#"SELECT c."mediaId", c."seasonId", c."episodeId"
        FROM cleanup_candidates c JOIN cleanup_rules r ON r.id = c."ruleId"
        WHERE c."deleteAt" <= now() AND r.action <> 'none'
        ORDER BY c."deleteAt", c.id LIMIT $1"#,
    )
    .bind(limit)
    .fetch_all(db)
    .await
}

/// Resolves the `seasonId` / `episodeId` query of a route; `None` when the media has no such season or episode.
pub async fn resolve_scope(
    db: &PgPool,
    media_id: i32,
    season: Option<i32>,
    episode: Option<i32>,
) -> sqlx::Result<Option<Scope>> {
    if let Some(e) = episode {
        let found: Option<i32> = sqlx::query_scalar(
            r#"SELECT s.id FROM episodes e JOIN seasons s ON s.id = e."seasonId"
            WHERE e.id = $1 AND s."mediaId" = $2 AND ($3::int IS NULL OR s.id = $3)"#,
        )
        .bind(e)
        .bind(media_id)
        .bind(season)
        .fetch_optional(db)
        .await?;
        return Ok(found.map(|s| Scope {
            season: Some(s),
            episode: Some(e),
        }));
    }
    let Some(s) = season else {
        return Ok(Some(Scope::default()));
    };
    let found: Option<i32> =
        sqlx::query_scalar(r#"SELECT id FROM seasons WHERE id = $1 AND "mediaId" = $2"#)
            .bind(s)
            .bind(media_id)
            .fetch_optional(db)
            .await?;
    Ok(found.map(|s| Scope {
        season: Some(s),
        episode: None,
    }))
}

/// Excluding a scope drops the candidates it protects (spec rule 3): its own, those below and its parents.
pub async fn exclude(db: &PgPool, media_id: i32, scope: Scope, user_id: i32) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query(
        r#"INSERT INTO cleanup_exclusions ("mediaId", "seasonId", "episodeId", "userId") VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING"#,
    )
    .bind(media_id)
    .bind(scope.season)
    .bind(scope.episode)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"DELETE FROM cleanup_candidates WHERE "mediaId" = $1
        AND ($2::int IS NULL OR "seasonId" IS NULL OR "seasonId" = $2)
        AND ($3::int IS NULL OR "episodeId" IS NULL OR "episodeId" = $3)"#,
    )
    .bind(media_id)
    .bind(scope.season)
    .bind(scope.episode)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

pub async fn unexclude(db: &PgPool, media_id: i32, scope: Scope) -> sqlx::Result<bool> {
    Ok(sqlx::query(
        r#"DELETE FROM cleanup_exclusions WHERE "mediaId" = $1
        AND "seasonId" IS NOT DISTINCT FROM $2 AND "episodeId" IS NOT DISTINCT FROM $3"#,
    )
    .bind(media_id)
    .bind(scope.season)
    .bind(scope.episode)
    .execute(db)
    .await?
    .rows_affected()
        == 1)
}

/// `deleteAt` of one media (ISO), when it is flagged with a date.
pub async fn delete_at(db: &PgPool, media_id: i32) -> sqlx::Result<Option<String>> {
    Ok(sqlx::query_scalar(
        r#"SELECT iso_ms(c."deleteAt") FROM cleanup_candidates c JOIN cleanup_rules r ON r.id = c."ruleId" AND r.enabled
        WHERE c."mediaId" = $1 AND c."seasonId" IS NULL AND c."episodeId" IS NULL"#,
    )
    .bind(media_id)
    .fetch_optional(db)
    .await?
    .flatten())
}

/// `deleteAt` (ISO) of the season and episode candidates of one media, with their scope.
pub async fn scoped_delete_at(db: &PgPool, media_id: i32) -> sqlx::Result<Vec<(Scope, String)>> {
    let rows: Vec<(Option<i32>, Option<i32>, String)> = sqlx::query_as(
        r#"SELECT c."seasonId", c."episodeId", iso_ms(c."deleteAt") FROM cleanup_candidates c
        JOIN cleanup_rules r ON r.id = c."ruleId" AND r.enabled
        WHERE c."mediaId" = $1 AND c."seasonId" IS NOT NULL AND c."deleteAt" IS NOT NULL"#,
    )
    .bind(media_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(season, episode, at)| (Scope { season, episode }, at))
        .collect())
}

pub async fn library_names(db: &PgPool) -> sqlx::Result<Vec<(i32, String)>> {
    sqlx::query_as("SELECT id, name FROM libraries ORDER BY id")
        .fetch_all(db)
        .await
}

/// `(media id, deleteAt ISO)` of the dated whole-media candidates in `libraries`, soonest first.
pub async fn leaving_soon(db: &PgPool, libraries: &[i32]) -> sqlx::Result<Vec<(i32, String)>> {
    sqlx::query_as(
        r#"SELECT m.id, iso_ms(c."deleteAt") FROM cleanup_candidates c JOIN media m ON m.id = c."mediaId"
        JOIN cleanup_rules r ON r.id = c."ruleId" AND r.enabled
        WHERE c."deleteAt" IS NOT NULL AND c."seasonId" IS NULL AND m."libraryId" = ANY($1)
        ORDER BY c."deleteAt", m.id"#,
    )
    .bind(libraries)
    .fetch_all(db)
    .await
}
