//! The statements of rust-port.md section 4.

use fliks_plugin_sdk::db::{self, DbError, Param, Rows};

pub const LIVE: &str = "('pending','retrying','lost')";

pub fn insert(event: &str, host: &str, state: &str, status: &str) -> Result<i64, DbError> {
    let r = db::query(
        r#"INSERT INTO "deliveries" ("event", "targetHost", "state", "lastStatus")
           VALUES ($1, $2, $3, $4) RETURNING "id""#,
        &[event.into(), host.into(), state.into(), status.into()],
    )?;
    Ok(r.int(0, "id").unwrap_or(0))
}

/// Marks the oldest live rows beyond 200 dropped and counts them, in one statement.
pub fn drop_over_capacity() -> Result<Vec<i64>, DbError> {
    let r = db::query(
        r#"WITH over AS (
             SELECT "id" FROM "deliveries" WHERE "state" IN ('pending','retrying')
             ORDER BY "id" DESC OFFSET 200 FOR UPDATE SKIP LOCKED),
           d AS (
             UPDATE "deliveries" SET "state" = 'dropped', "lastStatus" = 'dropped:queue full',
               "updatedAt" = now()
             FROM over WHERE "deliveries"."id" = over."id" RETURNING "deliveries"."id"),
           s AS (
             UPDATE "delivery_stats" SET "droppedForCapacity" = "droppedForCapacity" + (SELECT count(*) FROM d)
             WHERE "id" = 1 AND EXISTS (SELECT 1 FROM d))
           SELECT "id" FROM d"#,
        &[],
    )?;
    Ok((0..r.len()).filter_map(|i| r.int(i, "id")).collect())
}

pub fn prune() -> Result<u64, DbError> {
    db::execute(
        r#"DELETE FROM "deliveries" WHERE "state" NOT IN ('pending','retrying','lost')
           AND "id" <= (SELECT "id" FROM "deliveries" ORDER BY "id" DESC OFFSET 200 LIMIT 1)"#,
        &[],
    )
}

pub fn sweep_stuck() -> Result<u64, DbError> {
    db::execute(
        r#"UPDATE "deliveries" SET "state" = 'lost', "lastStatus" = 'failed:lost'
           WHERE "state" IN ('pending','retrying') AND "updatedAt" < now() - interval '3 hours'"#,
        &[],
    )
}

pub fn state(id: i64) -> Result<Option<String>, DbError> {
    let r = db::query(
        r#"SELECT "state" FROM "deliveries" WHERE "id" = $1"#,
        &[id.into()],
    )?;
    Ok(r.text(0, "state"))
}

/// Conditional on the row still being live; the counter moves only with the row.
pub fn finish(
    id: i64,
    state: &str,
    status: &str,
    attempt: u32,
    counter: Option<&str>,
) -> Result<bool, DbError> {
    let update = format!(
        r#"UPDATE "deliveries" SET "state" = $2, "lastStatus" = $3, "attempt" = $4,
             "lastAttemptAt" = now(), "updatedAt" = now()
           WHERE "id" = $1 AND "state" IN {LIVE} RETURNING 1"#
    );
    let params: [Param; 4] = [
        id.into(),
        state.into(),
        status.into(),
        (attempt as i64).into(),
    ];
    let n = match counter {
        Some(c) => db::execute(
            &format!(
                r#"WITH u AS ({update}) UPDATE "delivery_stats" SET "{c}" = "{c}" + 1
                   WHERE "id" = 1 AND EXISTS (SELECT 1 FROM u)"#
            ),
            &params,
        )?,
        None => db::query(&update, &params)?.len() as u64,
    };
    Ok(n > 0)
}

pub fn entries() -> Result<Rows, DbError> {
    db::query(
        r#"SELECT "id", "event", "targetHost", "attempt", "lastStatus", "createdAt", "lastAttemptAt"
           FROM "deliveries" ORDER BY "id" DESC LIMIT 100"#,
        &[],
    )
}

pub struct Stats {
    pub queued: i64,
    pub delivered: i64,
    pub failed: i64,
    pub dropped: i64,
}

pub fn stats() -> Result<Stats, DbError> {
    let r = db::query(
        r#"SELECT s."delivered", s."failedPermanently", s."droppedForCapacity",
             (SELECT count(*) FROM "deliveries" WHERE "state" IN ('pending','retrying')) AS "queued"
           FROM "delivery_stats" s WHERE s."id" = 1"#,
        &[],
    )?;
    Ok(Stats {
        queued: r.int(0, "queued").unwrap_or(0),
        delivered: r.int(0, "delivered").unwrap_or(0),
        failed: r.int(0, "failedPermanently").unwrap_or(0),
        dropped: r.int(0, "droppedForCapacity").unwrap_or(0),
    })
}
