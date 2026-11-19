//! Queries of `push_subscriptions` and the recipient filters (`push.md` SQL section).
use sqlx::{FromRow, PgPool};

#[derive(Debug, Clone, FromRow)]
pub struct Sub {
    pub id: i32,
    pub user_id: i32,
    pub platform: String,
    pub sub: Option<String>,
    pub endpoint: Option<String>,
    pub p256dh: String,
    pub auth: String,
    pub locale: String,
}

impl Sub {
    pub fn is_mobile(&self) -> bool {
        self.platform != "web"
    }
}

const COLS: &str =
    r#"p.id, s."userId" AS user_id, p.platform, p.sub, p.endpoint, p.p256dh, p.auth, p.locale"#;

/// Enabled users of `ids` who have not muted `category`.
pub async fn recipients(db: &PgPool, ids: &[i32], category: &str) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(
        r#"SELECT id FROM users WHERE id = ANY($1) AND enabled AND NOT ($2 = ANY("pushMuted"))"#,
    )
    .bind(ids)
    .bind(category)
    .fetch_all(db)
    .await
}

/// The rows to send to: live sessions of enabled users.
pub async fn live(db: &PgPool, users: &[i32]) -> sqlx::Result<Vec<Sub>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT {COLS} FROM push_subscriptions p
           JOIN sessions s ON s.id = p."sessionId" AND s."revokedAt" IS NULL
           JOIN users u ON u.id = s."userId" AND u.enabled
           WHERE s."userId" = ANY($1) ORDER BY p.id"#
    )))
    .bind(users)
    .fetch_all(db)
    .await
}

/// Rows of revoked sessions and disabled users.
pub async fn dead(db: &PgPool) -> sqlx::Result<Vec<Sub>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT {COLS} FROM push_subscriptions p
           JOIN sessions s ON s.id = p."sessionId"
           JOIN users u ON u.id = s."userId"
           WHERE s."revokedAt" IS NOT NULL OR NOT u.enabled ORDER BY p.id"#
    )))
    .fetch_all(db)
    .await
}

pub async fn of_user(db: &PgPool, user: i32) -> sqlx::Result<Vec<Sub>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT {COLS} FROM push_subscriptions p JOIN sessions s ON s.id = p."sessionId"
           WHERE s."userId" = $1 ORDER BY p.id"#
    )))
    .bind(user)
    .fetch_all(db)
    .await
}

pub async fn of_session(db: &PgPool, session: i32, platform: &str) -> sqlx::Result<Option<Sub>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT {COLS} FROM push_subscriptions p JOIN sessions s ON s.id = p."sessionId"
           WHERE p."sessionId" = $1 AND p.platform = $2"#
    )))
    .bind(session)
    .bind(platform)
    .fetch_optional(db)
    .await
}

const DELETE_OLDEST: &str = r#"DELETE FROM push_subscriptions WHERE id = (
    SELECT p.id FROM push_subscriptions p JOIN sessions s ON s.id = p."sessionId"
    WHERE s."userId" = $1 ORDER BY p."createdAt", p.id LIMIT 1)
  RETURNING id, $1::int AS user_id, platform, sub, endpoint, p256dh, auth, locale"#;

pub struct Upsert<'a> {
    pub session: i32,
    pub platform: &'a str,
    /// A fresh id for a mobile row; the stored one wins when the row exists.
    pub sub: Option<&'a str>,
    pub endpoint: Option<&'a str>,
    pub p256dh: &'a str,
    pub auth: &'a str,
    pub locale: &'a str,
}

/// Upserts the session's row; a new row of a user already at `cap` replaces their oldest one, which is
/// returned. One transaction under a per-user advisory lock, so concurrent subscribes cannot overshoot.
pub async fn upsert(
    db: &PgPool,
    user: i32,
    cap: i64,
    u: Upsert<'_>,
) -> sqlx::Result<(i32, Option<String>, Option<Sub>)> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('push_subscriptions'), $1)")
        .bind(user)
        .execute(&mut *tx)
        .await?;
    let exists: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(SELECT 1 FROM push_subscriptions WHERE "sessionId" = $1 AND platform = $2)"#,
    )
    .bind(u.session)
    .bind(u.platform)
    .fetch_one(&mut *tx)
    .await?;
    let mut removed = None;
    if !exists {
        let held: i64 = sqlx::query_scalar(
            r#"SELECT count(*) FROM push_subscriptions p JOIN sessions s ON s.id = p."sessionId"
               WHERE s."userId" = $1"#,
        )
        .bind(user)
        .fetch_one(&mut *tx)
        .await?;
        if held >= cap {
            removed = sqlx::query_as(DELETE_OLDEST)
                .bind(user)
                .fetch_optional(&mut *tx)
                .await?;
        }
    }
    let (id, sub): (i32, Option<String>) = sqlx::query_as(
        r#"INSERT INTO push_subscriptions ("sessionId", platform, sub, endpoint, p256dh, auth, locale)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT ("sessionId", platform) DO UPDATE
           SET endpoint = EXCLUDED.endpoint, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
               locale = EXCLUDED.locale, "updatedAt" = now()
           RETURNING id, sub"#,
    )
    .bind(u.session)
    .bind(u.platform)
    .bind(u.sub)
    .bind(u.endpoint)
    .bind(u.p256dh)
    .bind(u.auth)
    .bind(u.locale)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((id, sub, removed))
}

pub async fn delete(db: &PgPool, id: i32) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM push_subscriptions WHERE id = $1")
        .bind(id)
        .execute(db)
        .await
        .map(drop)
}

pub async fn delete_mobile(db: &PgPool) -> sqlx::Result<u64> {
    sqlx::query("DELETE FROM push_subscriptions WHERE platform IN ('apns', 'fcm')")
        .execute(db)
        .await
        .map(|r| r.rows_affected())
}

pub async fn count(db: &PgPool, web: bool) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT count(*) FROM push_subscriptions WHERE (platform = 'web') = $1")
        .bind(web)
        .fetch_one(db)
        .await
}

pub async fn relay_enabled(db: &PgPool) -> sqlx::Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT enabled FROM notification_connections WHERE type = 'fliks-relay'",
    )
    .fetch_optional(db)
    .await?
    .unwrap_or(false))
}

/// The first enabled admin with an email, the VAPID `sub` fallback.
pub async fn admin_email(db: &PgPool) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(
        r#"SELECT email FROM users WHERE "isAdmin" AND enabled AND email IS NOT NULL AND email <> ''
           ORDER BY id LIMIT 1"#,
    )
    .fetch_optional(db)
    .await
}
