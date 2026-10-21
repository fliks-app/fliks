//! Refresh-token and pairing queries. Every time rule takes `now`, so tests age rows without sleeping;
//! rotation and the pairing claim run in one transaction over `SELECT ... FOR UPDATE`.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool};

/// A rotated token is answered "already rotated" this long, then it counts as theft (`auth.md` rule 34).
const REUSE_GRACE_MS: i64 = 30_000;
pub const PAIRING_TTL_SECS: i64 = 600;
/// `accessToken` sentinel between approval and the issuing device's claim.
const APPROVED: &str = "__approved__";
const MAX_PENDING_PER_DEVICE: i64 = 3;

pub fn hash(raw: &str) -> String {
    Sha256::digest(raw.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn new_raw() -> String {
    let mut buf = [0u8; 48];
    getrandom::fill(&mut buf).expect("os rng");
    URL_SAFE_NO_PAD.encode(buf)
}

/// A freshly issued refresh token: plaintext (shown once) and its expiry.
pub struct Issued {
    pub raw: String,
    pub expires_at: DateTime<Utc>,
}

pub async fn issue(
    conn: &mut PgConnection,
    user_id: i32,
    user_agent: Option<&str>,
    ttl_days: i64,
    now: DateTime<Utc>,
) -> Result<Issued, sqlx::Error> {
    let raw = new_raw();
    let expires_at = now + Duration::days(ttl_days);
    let ua: Option<String> = user_agent.map(|u| u.chars().take(255).collect());
    sqlx::query!(
        r#"INSERT INTO refresh_tokens ("userId", "tokenHash", "expiresAt", "userAgent") VALUES ($1, $2, $3, $4)"#,
        user_id,
        hash(&raw),
        expires_at,
        ua
    )
    .execute(conn)
    .await?;
    Ok(Issued { raw, expires_at })
}

pub enum Refreshed {
    /// Rotated: the new refresh token, for the user to sign an access token for.
    Ok {
        user_id: i32,
        username: String,
        issued: Issued,
    },
    Invalid,
    AlreadyRotated,
    Reuse,
    Expired,
    Disabled,
}

/// `POST /auth/refresh` (rules 34-35): the presented token is consumed even when the account is disabled,
/// and a reuse outside the grace revokes every token of the user.
pub async fn refresh(
    db: &PgPool,
    raw: &str,
    user_agent: Option<&str>,
    ttl_days: i64,
    now: DateTime<Utc>,
) -> Result<Refreshed, sqlx::Error> {
    let mut tx = db.begin().await?;
    let Some(t) = sqlx::query!(
        r#"SELECT id, "userId" AS user_id, "revokedAt" AS revoked_at, "expiresAt" AS expires_at
           FROM refresh_tokens WHERE "tokenHash" = $1 ORDER BY id LIMIT 1 FOR UPDATE"#,
        hash(raw)
    )
    .fetch_optional(&mut *tx)
    .await?
    else {
        return Ok(Refreshed::Invalid);
    };
    if let Some(revoked) = t.revoked_at {
        if (now - revoked).num_milliseconds() <= REUSE_GRACE_MS {
            return Ok(Refreshed::AlreadyRotated);
        }
        revoke_all(&mut tx, t.user_id, now).await?;
        tx.commit().await?;
        return Ok(Refreshed::Reuse);
    }
    if t.expires_at < now {
        return Ok(Refreshed::Expired);
    }
    sqlx::query!(
        r#"UPDATE refresh_tokens SET "revokedAt" = $1, "lastUsedAt" = $1 WHERE id = $2"#,
        now,
        t.id
    )
    .execute(&mut *tx)
    .await?;
    let user = sqlx::query!(
        r#"SELECT username, enabled FROM users WHERE id = $1"#,
        t.user_id
    )
    .fetch_one(&mut *tx)
    .await?;
    if !user.enabled {
        tx.commit().await?;
        return Ok(Refreshed::Disabled);
    }
    let issued = issue(&mut tx, t.user_id, user_agent, ttl_days, now).await?;
    tx.commit().await?;
    Ok(Refreshed::Ok {
        user_id: t.user_id,
        username: user.username,
        issued,
    })
}

async fn revoke_all(
    conn: &mut PgConnection,
    user_id: i32,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"UPDATE refresh_tokens SET "revokedAt" = $2 WHERE "userId" = $1 AND "revokedAt" IS NULL"#,
        user_id,
        now
    )
    .execute(conn)
    .await?;
    Ok(())
}

/// Logout: revoke one token by its plaintext; an unknown or already revoked one is a no-op.
pub async fn revoke(db: &PgPool, raw: &str, now: DateTime<Utc>) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"UPDATE refresh_tokens SET "revokedAt" = $2 WHERE "tokenHash" = $1 AND "revokedAt" IS NULL"#,
        hash(raw),
        now
    )
    .execute(db)
    .await?;
    Ok(())
}

/// Rows expired or revoked more than 30 days ago.
pub async fn prune_refresh_tokens(db: &PgPool, now: DateTime<Utc>) -> Result<u64, sqlx::Error> {
    let cutoff = now - Duration::days(30);
    let r = sqlx::query!(
        r#"DELETE FROM refresh_tokens WHERE "expiresAt" < $1 OR ("revokedAt" IS NOT NULL AND "revokedAt" < $1)"#,
        cutoff
    )
    .execute(db)
    .await?;
    Ok(r.rows_affected())
}

/// Rows are removed 10 minutes after they expired (rule 60).
pub async fn cleanup_pairings(db: &PgPool, now: DateTime<Utc>) -> Result<u64, sqlx::Error> {
    let cutoff = now - Duration::minutes(10);
    let r = sqlx::query!(
        r#"DELETE FROM pairing_requests WHERE "expiresAt" < $1"#,
        cutoff
    )
    .execute(db)
    .await?;
    Ok(r.rows_affected())
}

pub enum Opened {
    Created(String),
    NoUser,
    TooMany,
}

/// `pairing/request`. The per-device advisory lock makes the 3-pending cap hold under concurrency.
pub async fn open_pairing(
    db: &PgPool,
    user_id: i32,
    device_id: &str,
    device_name: &str,
    system_name: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Opened, sqlx::Error> {
    let mut tx = db.begin().await?;
    let exists = sqlx::query_scalar!(
        r#"SELECT 1 AS "one!" FROM users WHERE id = $1 AND enabled = true"#,
        user_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if exists.is_none() {
        return Ok(Opened::NoUser);
    }
    sqlx::query!("SELECT pg_advisory_xact_lock(hashtext($1))", device_id)
        .execute(&mut *tx)
        .await?;
    let pending = sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM pairing_requests WHERE "deviceId" = $1 AND status = 'pending'"#,
        device_id
    )
    .fetch_one(&mut *tx)
    .await?;
    if pending >= MAX_PENDING_PER_DEVICE {
        return Ok(Opened::TooMany);
    }
    let public_id = sqlx::query_scalar!(
        r#"INSERT INTO pairing_requests ("publicId", "userId", "deviceId", "deviceName", "systemName", status, "expiresAt")
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'pending', $5) RETURNING "publicId""#,
        user_id,
        device_id,
        device_name,
        system_name,
        now + Duration::seconds(PAIRING_TTL_SECS)
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Opened::Created(public_id))
}

pub enum PairingStatus {
    Status(String),
    /// First poll of the issuing device after approval: tokens for `user_id`.
    Claimed {
        user_id: i32,
        username: String,
        issued: Issued,
    },
}

/// `pairing/status`: lazy expiry plus the one-shot claim (rule 54), atomic under the row lock.
pub async fn pairing_status(
    db: &PgPool,
    public_id: &str,
    device_id: &str,
    ttl_days: i64,
    now: DateTime<Utc>,
) -> Result<Option<PairingStatus>, sqlx::Error> {
    let mut tx = db.begin().await?;
    let Some(mut p) = sqlx::query!(
        r#"SELECT id, "deviceId" AS device_id, status, "approvedByUserId" AS approved_by,
                  "accessToken" AS access_token, "expiresAt" AS expires_at
           FROM pairing_requests WHERE "publicId" = $1 FOR UPDATE"#,
        public_id
    )
    .fetch_optional(&mut *tx)
    .await?
    else {
        return Ok(None);
    };
    let unclaimed = p.status == "approved" && p.access_token.as_deref() == Some(APPROVED);
    // An approval not claimed before `expiresAt` expires like a pending request.
    if (p.status == "pending" || unclaimed) && p.expires_at < now {
        sqlx::query!(
            r#"UPDATE pairing_requests SET status = 'expired', "accessToken" = NULL WHERE id = $1"#,
            p.id
        )
        .execute(&mut *tx)
        .await?;
        p.status = "expired".into();
    }
    let claimable = p.status == "approved" && unclaimed && p.device_id == device_id;
    let (true, Some(approver)) = (claimable, p.approved_by) else {
        tx.commit().await?;
        return Ok(Some(PairingStatus::Status(p.status)));
    };
    let Some(user) = sqlx::query_scalar!(r#"SELECT username FROM users WHERE id = $1"#, approver)
        .fetch_optional(&mut *tx)
        .await?
    else {
        return Ok(Some(PairingStatus::Status(p.status)));
    };
    sqlx::query!(
        r#"UPDATE pairing_requests SET "accessToken" = NULL WHERE id = $1"#,
        p.id
    )
    .execute(&mut *tx)
    .await?;
    let issued = issue(&mut tx, approver, None, ttl_days, now).await?;
    tx.commit().await?;
    Ok(Some(PairingStatus::Claimed {
        user_id: approver,
        username: user,
        issued,
    }))
}

pub struct PendingPairing {
    pub public_id: String,
    pub device_id: String,
    pub device_name: String,
    pub system_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

pub async fn pending(
    db: &PgPool,
    user_id: i32,
    now: DateTime<Utc>,
) -> Result<Vec<PendingPairing>, sqlx::Error> {
    sqlx::query_as!(
        PendingPairing,
        r#"SELECT "publicId" AS public_id, "deviceId" AS device_id, "deviceName" AS device_name,
                  "systemName" AS system_name, "createdAt" AS created_at, "expiresAt" AS expires_at
           FROM pairing_requests WHERE "userId" = $1 AND status = 'pending' AND "expiresAt" >= $2
           ORDER BY "createdAt" DESC"#,
        user_id,
        now
    )
    .fetch_all(db)
    .await
}

pub enum Approval {
    NotFound,
    NotPending(String),
    Expired,
    Approved,
}

/// `pairing/:id/approve`: only the request's own user (a foreign row is not found).
pub async fn approve(
    db: &PgPool,
    public_id: &str,
    user_id: i32,
    now: DateTime<Utc>,
) -> Result<Approval, sqlx::Error> {
    let mut tx = db.begin().await?;
    let Some(p) = sqlx::query!(
        r#"SELECT id, status, "expiresAt" AS expires_at FROM pairing_requests
           WHERE "publicId" = $1 AND "userId" = $2 FOR UPDATE"#,
        public_id,
        user_id
    )
    .fetch_optional(&mut *tx)
    .await?
    else {
        return Ok(Approval::NotFound);
    };
    if p.status != "pending" {
        return Ok(Approval::NotPending(p.status));
    }
    if p.expires_at < now {
        sqlx::query!(
            r#"UPDATE pairing_requests SET status = 'expired' WHERE id = $1"#,
            p.id
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(Approval::Expired);
    }
    sqlx::query!(
        r#"UPDATE pairing_requests SET status = 'approved', "approvedByUserId" = $2, "accessToken" = $3 WHERE id = $1"#,
        p.id,
        user_id,
        APPROVED
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Approval::Approved)
}

/// `pairing/:id/deny`: false when the row is not the caller's; a non-pending row is left as is.
pub async fn deny(db: &PgPool, public_id: &str, user_id: i32) -> Result<bool, sqlx::Error> {
    let mut tx = db.begin().await?;
    let Some(p) = sqlx::query!(
        r#"SELECT id, status FROM pairing_requests WHERE "publicId" = $1 AND "userId" = $2 FOR UPDATE"#,
        public_id,
        user_id
    )
    .fetch_optional(&mut *tx)
    .await?
    else {
        return Ok(false);
    };
    if p.status == "pending" {
        sqlx::query!(
            r#"UPDATE pairing_requests SET status = 'denied', "approvedByUserId" = $2 WHERE id = $1"#,
            p.id,
            user_id
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup(pool: &PgPool) -> i32 {
        crate::db::migrate(pool).await.unwrap();
        sqlx::query_scalar(r#"INSERT INTO users (username) VALUES ('u') RETURNING id"#)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn token(pool: &PgPool, user: i32, now: DateTime<Utc>) -> String {
        let mut c = pool.acquire().await.unwrap();
        issue(&mut c, user, None, 60, now).await.unwrap().raw
    }

    async fn rotate(pool: &PgPool, raw: &str, now: DateTime<Utc>) -> Refreshed {
        refresh(pool, raw, None, 60, now).await.unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn rotation_grace_is_inclusive_then_reuse_revokes_the_family(pool: PgPool) {
        let u = setup(&pool).await;
        let t0 = Utc::now();
        let a = token(&pool, u, t0).await;
        let b = token(&pool, u, t0).await;
        assert!(matches!(rotate(&pool, &a, t0).await, Refreshed::Ok { .. }));
        let edge = t0 + Duration::milliseconds(REUSE_GRACE_MS);
        assert!(matches!(
            rotate(&pool, &a, edge).await,
            Refreshed::AlreadyRotated
        ));
        let live: i64 =
            sqlx::query_scalar(r#"SELECT count(*) FROM refresh_tokens WHERE "revokedAt" IS NULL"#)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(live, 2, "grace leaves the family alone");
        let late = edge + Duration::milliseconds(1);
        assert!(matches!(rotate(&pool, &a, late).await, Refreshed::Reuse));
        assert!(matches!(
            rotate(&pool, &b, late).await,
            Refreshed::AlreadyRotated | Refreshed::Reuse
        ));
        let live: i64 =
            sqlx::query_scalar(r#"SELECT count(*) FROM refresh_tokens WHERE "revokedAt" IS NULL"#)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(live, 0);
        assert!(matches!(
            rotate(&pool, "nope", late).await,
            Refreshed::Invalid
        ));
    }

    #[sqlx::test(migrations = false)]
    async fn expired_is_not_revoked_and_disabled_consumes_the_token(pool: PgPool) {
        let u = setup(&pool).await;
        let t0 = Utc::now();
        let a = token(&pool, u, t0).await;
        let far = t0 + Duration::days(61);
        assert!(matches!(rotate(&pool, &a, far).await, Refreshed::Expired));
        let revoked: Option<DateTime<Utc>> =
            sqlx::query_scalar(r#"SELECT "revokedAt" FROM refresh_tokens"#)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(revoked.is_none());
        sqlx::query("UPDATE users SET enabled = false")
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(rotate(&pool, &a, t0).await, Refreshed::Disabled));
        assert!(matches!(
            rotate(&pool, &a, t0).await,
            Refreshed::AlreadyRotated
        ));
    }

    #[sqlx::test(migrations = false)]
    async fn concurrent_rotations_yield_one_success(pool: PgPool) {
        let u = setup(&pool).await;
        let now = Utc::now();
        let a = token(&pool, u, now).await;
        let (p1, p2) = (pool.clone(), pool.clone());
        let (a1, a2) = (a.clone(), a);
        let (r1, r2) = tokio::join!(
            tokio::spawn(async move { rotate(&p1, &a1, now).await }),
            tokio::spawn(async move { rotate(&p2, &a2, now).await })
        );
        let ok = [r1.unwrap(), r2.unwrap()]
            .iter()
            .filter(|r| matches!(r, Refreshed::Ok { .. }))
            .count();
        assert_eq!(ok, 1);
    }

    #[sqlx::test(migrations = false)]
    async fn prune_and_cleanup_use_their_cutoffs(pool: PgPool) {
        let u = setup(&pool).await;
        let now = Utc::now();
        for (exp, rev) in [
            (-31, None),
            (-1, None),
            (10, Some(-31)),
            (10, Some(-1)),
            (10, None),
        ] {
            sqlx::query(r#"INSERT INTO refresh_tokens ("userId","tokenHash","expiresAt","revokedAt") VALUES ($1, md5(random()::text), $2, $3)"#)
                .bind(u)
                .bind(now + Duration::days(exp))
                .bind(rev.map(|d| now + Duration::days(d)))
                .execute(&pool)
                .await
                .unwrap();
        }
        assert_eq!(prune_refresh_tokens(&pool, now).await.unwrap(), 2);
    }

    async fn open(pool: &PgPool, u: i32, dev: &str, at: DateTime<Utc>) -> Opened {
        open_pairing(pool, u, dev, "TV", None, at).await.unwrap()
    }

    fn created(o: Opened) -> String {
        match o {
            Opened::Created(id) => id,
            _ => panic!("not created"),
        }
    }

    #[sqlx::test(migrations = false)]
    async fn pairing_cap_counts_unflipped_expired_rows(pool: PgPool) {
        let u = setup(&pool).await;
        let old = Utc::now() - Duration::hours(2);
        for _ in 0..3 {
            created(open(&pool, u, "d", old).await);
        }
        assert!(matches!(
            open(&pool, u, "d", Utc::now()).await,
            Opened::TooMany
        ));
        assert!(matches!(
            open(&pool, u, "other", Utc::now()).await,
            Opened::Created(_)
        ));
        assert!(matches!(
            open(&pool, 999, "x", Utc::now()).await,
            Opened::NoUser
        ));
        assert_eq!(cleanup_pairings(&pool, Utc::now()).await.unwrap(), 3);
    }

    #[sqlx::test(migrations = false)]
    async fn pairing_claims_once_on_the_issuing_device_and_not_after_expiry(pool: PgPool) {
        let u = setup(&pool).await;
        let now = Utc::now();
        let id = created(open(&pool, u, "d", now).await);
        let st = |dev: &'static str, at| {
            let (pool, id) = (pool.clone(), id.clone());
            async move {
                pairing_status(&pool, &id, dev, 60, at)
                    .await
                    .unwrap()
                    .unwrap()
            }
        };
        assert!(matches!(st("d", now).await, PairingStatus::Status(s) if s == "pending"));
        assert!(matches!(
            approve(&pool, &id, u + 1, now).await.unwrap(),
            Approval::NotFound
        ));
        assert!(matches!(
            approve(&pool, &id, u, now).await.unwrap(),
            Approval::Approved
        ));
        assert!(
            matches!(approve(&pool, &id, u, now).await.unwrap(), Approval::NotPending(s) if s == "approved")
        );
        assert!(matches!(st("other", now).await, PairingStatus::Status(s) if s == "approved"));
        assert!(matches!(st("d", now).await, PairingStatus::Claimed { .. }));
        assert!(matches!(st("d", now).await, PairingStatus::Status(_)));
    }

    #[sqlx::test(migrations = false)]
    async fn approved_claim_checks_expiry(pool: PgPool) {
        let u = setup(&pool).await;
        let now = Utc::now();
        let id = created(open(&pool, u, "d", now).await);
        approve(&pool, &id, u, now).await.unwrap();
        let late = now + Duration::seconds(PAIRING_TTL_SECS + 1);
        let s = pairing_status(&pool, &id, "d", 60, late)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(s, PairingStatus::Status(s) if s == "expired"));
        let tokens: i64 = sqlx::query_scalar("SELECT count(*) FROM refresh_tokens")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tokens, 0);
    }

    #[sqlx::test(migrations = false)]
    async fn concurrent_claims_mint_one_pair(pool: PgPool) {
        let u = setup(&pool).await;
        let now = Utc::now();
        let id = created(open(&pool, u, "d", now).await);
        approve(&pool, &id, u, now).await.unwrap();
        let claim = |pool: PgPool, id: String| {
            tokio::spawn(async move {
                pairing_status(&pool, &id, "d", 60, now)
                    .await
                    .unwrap()
                    .unwrap()
            })
        };
        let (a, b) = tokio::join!(claim(pool.clone(), id.clone()), claim(pool.clone(), id));
        let n = [a.unwrap(), b.unwrap()]
            .iter()
            .filter(|s| matches!(s, PairingStatus::Claimed { .. }))
            .count();
        assert_eq!(n, 1);
    }

    #[sqlx::test(migrations = false)]
    async fn expired_pending_is_flipped_and_approve_refuses(pool: PgPool) {
        let u = setup(&pool).await;
        let t0 = Utc::now();
        let id = created(open(&pool, u, "d", t0).await);
        let late = t0 + Duration::seconds(PAIRING_TTL_SECS + 1);
        assert!(matches!(
            approve(&pool, &id, u, late).await.unwrap(),
            Approval::Expired
        ));
        assert!(
            matches!(approve(&pool, &id, u, late).await.unwrap(), Approval::NotPending(s) if s == "expired")
        );
        let id2 = created(open(&pool, u, "e", t0).await);
        assert!(pending(&pool, u, late).await.unwrap().is_empty());
        assert!(deny(&pool, &id2, u).await.unwrap());
        assert!(!deny(&pool, &id2, u + 1).await.unwrap());
    }
}
