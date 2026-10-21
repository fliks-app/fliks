//! Rule, candidate and exclusion rows; entities built in SQL like `requests/db.rs`.
use super::dto::Rule;
use serde_json::Value;
use sqlx::{FromRow, PgPool, types::Json};

const RULE: &str = r#"jsonb_build_object('id', id, 'createdAt', iso_ms("createdAt"), 'updatedAt', iso_ms("updatedAt"),
  'name', name, 'enabled', enabled, 'criteria', criteria, 'action', action, 'graceDays', "graceDays")"#;

#[derive(FromRow)]
pub struct RuleRow {
    pub id: i32,
    pub criteria: Json<Value>,
    pub action: String,
    #[sqlx(rename = "graceDays")]
    pub grace_days: Option<i32>,
}

pub async fn rules_enabled(db: &PgPool) -> sqlx::Result<Vec<RuleRow>> {
    sqlx::query_as(
        r#"SELECT id, criteria, action, "graceDays" FROM cleanup_rules WHERE enabled ORDER BY id"#,
    )
    .fetch_all(db)
    .await
}

pub async fn rule_row(db: &PgPool, id: i32) -> sqlx::Result<Option<RuleRow>> {
    sqlx::query_as(r#"SELECT id, criteria, action, "graceDays" FROM cleanup_rules WHERE id = $1"#)
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn rule_list(db: &PgPool) -> sqlx::Result<Vec<Value>> {
    sqlx::query_scalar(&format!(
        "SELECT {RULE} FROM cleanup_rules ORDER BY name ASC, id ASC"
    ))
    .fetch_all(db)
    .await
}

pub async fn rule_find(db: &PgPool, id: i32) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar(&format!("SELECT {RULE} FROM cleanup_rules WHERE id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn rule_insert(db: &PgPool, r: &Rule) -> sqlx::Result<Value> {
    sqlx::query_scalar(&format!(
        r#"WITH r AS (INSERT INTO cleanup_rules (name, enabled, criteria, action, "graceDays")
        VALUES ($1, $2, $3, $4, $5) RETURNING *) SELECT {RULE} FROM r"#
    ))
    .bind(&r.name)
    .bind(r.enabled)
    .bind(&r.criteria)
    .bind(&r.action)
    .bind(r.grace_days)
    .fetch_one(db)
    .await
}

pub async fn rule_update(db: &PgPool, id: i32, r: &Rule) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar(&format!(
        r#"WITH r AS (UPDATE cleanup_rules SET name = $2, enabled = $3, criteria = $4, action = $5,
        "graceDays" = $6 WHERE id = $1 RETURNING *) SELECT {RULE} FROM r"#
    ))
    .bind(id)
    .bind(&r.name)
    .bind(r.enabled)
    .bind(&r.criteria)
    .bind(&r.action)
    .bind(r.grace_days)
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

pub async fn candidates(db: &PgPool) -> sqlx::Result<Vec<Value>> {
    sqlx::query_scalar(
        r#"SELECT jsonb_build_object('mediaId', m.id, 'title', m.title, 'type', m."type"::text,
          'posterUrl', m."posterUrl", 'ruleId', r.id, 'ruleName', r.name, 'action', r.action,
          'size', COALESCE((SELECT SUM(f.size) FROM media_files f WHERE f."mediaId" = m.id), 0),
          'flaggedAt', iso_ms(c."flaggedAt"), 'deleteAt', iso_ms(c."deleteAt"))
        FROM cleanup_candidates c JOIN media m ON m.id = c."mediaId" JOIN cleanup_rules r ON r.id = c."ruleId"
        ORDER BY c."deleteAt" ASC NULLS LAST, m.id ASC"#,
    )
    .fetch_all(db)
    .await
}

/// The candidate's media with the action of its rule.
pub async fn candidate_action(db: &PgPool, media_id: i32) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(
        r#"SELECT r.action FROM cleanup_candidates c JOIN cleanup_rules r ON r.id = c."ruleId"
        WHERE c."mediaId" = $1"#,
    )
    .bind(media_id)
    .fetch_optional(db)
    .await
}

/// Candidates past their `deleteAt` whose rule acts, oldest first.
pub async fn due(db: &PgPool, limit: i64) -> sqlx::Result<Vec<(i32, String)>> {
    sqlx::query_as(
        r#"SELECT c."mediaId", r.action FROM cleanup_candidates c JOIN cleanup_rules r ON r.id = c."ruleId"
        WHERE c."deleteAt" <= now() AND r.action <> 'none'
        ORDER BY c."deleteAt", c."mediaId" LIMIT $1"#,
    )
    .bind(limit)
    .fetch_all(db)
    .await
}

pub async fn exclude(db: &PgPool, media_id: i32, user_id: i32) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query(
        r#"INSERT INTO cleanup_exclusions ("mediaId", "userId") VALUES ($1, $2) ON CONFLICT DO NOTHING"#,
    )
    .bind(media_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(r#"DELETE FROM cleanup_candidates WHERE "mediaId" = $1"#)
        .bind(media_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

pub async fn unexclude(db: &PgPool, media_id: i32) -> sqlx::Result<bool> {
    Ok(
        sqlx::query(r#"DELETE FROM cleanup_exclusions WHERE "mediaId" = $1"#)
            .bind(media_id)
            .execute(db)
            .await?
            .rows_affected()
            == 1,
    )
}

/// `deleteAt` of one media (ISO), when it is flagged with a date.
pub async fn delete_at(db: &PgPool, media_id: i32) -> sqlx::Result<Option<String>> {
    Ok(sqlx::query_scalar(
        r#"SELECT iso_ms("deleteAt") FROM cleanup_candidates WHERE "mediaId" = $1"#,
    )
    .bind(media_id)
    .fetch_optional(db)
    .await?
    .flatten())
}
