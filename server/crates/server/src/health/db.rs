//! `health_checks`: the open checks, kept across restarts so a transition is announced once.
use super::checks::{Check, Level};
use serde_json::Value;
use sqlx::{PgPool, Row};
use std::collections::HashMap;

pub enum Kind {
    Broken,
    Fixed,
}

/// An error that opened or closed since the last run: one notification each.
pub struct Transition {
    pub kind: Kind,
    pub key: String,
    pub code: String,
    pub params: Value,
}

/// Stores `now` as the open checks and returns the error transitions against what was stored.
pub async fn reconcile(db: &PgPool, now: &[Check]) -> sqlx::Result<Vec<Transition>> {
    let mut tx = db.begin().await?;
    let rows =
        sqlx::query(r#"SELECT "key", "state", "code", "params" FROM health_checks FOR UPDATE"#)
            .fetch_all(&mut *tx)
            .await?;
    let prev: HashMap<String, (String, String, Value)> = rows
        .iter()
        .map(|r| {
            (
                r.get("key"),
                (r.get("state"), r.get("code"), r.get("params")),
            )
        })
        .collect();
    let mut out = vec![];
    for c in now {
        sqlx::query(
            r#"INSERT INTO health_checks ("key", "state", "code", "params", "link") VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT ("key") DO UPDATE SET "state" = EXCLUDED."state", "code" = EXCLUDED."code",
                 "params" = EXCLUDED."params", "link" = EXCLUDED."link", "checkedAt" = now(),
                 "since" = CASE WHEN health_checks."state" = EXCLUDED."state" THEN health_checks."since" ELSE now() END"#,
        )
        .bind(&c.key)
        .bind(c.level.as_str())
        .bind(c.code)
        .bind(&c.params)
        .bind(&c.link)
        .execute(&mut *tx)
        .await?;
        let was_error = prev.get(&c.key).is_some_and(|p| p.0 == "error");
        if c.level == Level::Error && !was_error {
            out.push(Transition {
                kind: Kind::Broken,
                key: c.key.clone(),
                code: c.code.to_owned(),
                params: c.params.clone(),
            });
        }
    }
    let keys: Vec<&str> = now.iter().map(|c| c.key.as_str()).collect();
    sqlx::query(r#"DELETE FROM health_checks WHERE "key" <> ALL($1)"#)
        .bind(&keys)
        .execute(&mut *tx)
        .await?;
    for (key, (state, code, params)) in prev {
        let still_error = now.iter().any(|c| c.key == key && c.level == Level::Error);
        if state == "error" && !still_error {
            out.push(Transition {
                kind: Kind::Fixed,
                key,
                code,
                params,
            });
        }
    }
    tx.commit().await?;
    Ok(out)
}

/// The open checks, errors first, then the oldest.
pub async fn list(db: &PgPool) -> sqlx::Result<Vec<Value>> {
    let rows = sqlx::query(
        r#"SELECT jsonb_build_object('key', "key", 'state', "state", 'code', "code", 'params', "params",
             'link', "link", 'since', iso_ms("since")) AS json
           FROM health_checks ORDER BY ("state" = 'error') DESC, "since", "key""#,
    )
    .fetch_all(db)
    .await?;
    Ok(rows.iter().map(|r| r.get("json")).collect())
}
