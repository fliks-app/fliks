//! The last core search of each media target (`plugins.md` rule 77): what the providers answered and why nothing was grabbed.
use super::sweep::clean;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool, types::Json};
use std::collections::{BTreeMap, HashMap};

/// Rejection codes kept per attempt, by count.
const TOP: usize = 3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rejection {
    pub code: String,
    pub count: i32,
}

/// What one search saw, counted from the providers' answers before any truncation.
#[derive(Default)]
pub(super) struct Tally {
    pub searched: bool,
    pub found: i32,
    pub eligible: i32,
    codes: BTreeMap<String, i32>,
    /// Ids of the providers whose search failed.
    pub failed: Vec<String>,
    /// The earliest instant a cooling provider answers again.
    pub cooling: Option<DateTime<Utc>>,
}

impl Tally {
    /// Counts one provider's list: every release, the clean ones, the codes of the rest.
    pub(super) fn count(&mut self, list: &Value) {
        for r in list.as_array().into_iter().flatten() {
            self.found += 1;
            if clean(r) {
                self.eligible += 1;
                continue;
            }
            let mut codes: Vec<&str> = r["rejections"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c["code"].as_str())
                .collect();
            if codes.is_empty() {
                if r["blocklisted"] == true {
                    codes.push("BLOCKLISTED");
                }
                if r["allowed"] == false {
                    codes.push("QUALITY_NOT_ALLOWED");
                }
            }
            codes.sort_unstable();
            codes.dedup();
            for c in codes {
                *self.codes.entry(c.to_owned()).or_default() += 1;
            }
        }
    }

    /// The earliest cooldown wins.
    pub(super) fn cool(&mut self, at: DateTime<Utc>) {
        self.cooling = Some(self.cooling.map_or(at, |c| c.min(at)));
    }

    fn top(&self) -> Vec<Rejection> {
        let mut all: Vec<Rejection> = self
            .codes
            .iter()
            .map(|(code, count)| Rejection {
                code: code.clone(),
                count: *count,
            })
            .collect();
        all.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.code.cmp(&b.code)));
        all.truncate(TOP);
        all
    }
}

/// Upserts the attempt of a target; a failed write is logged, never fatal.
pub(super) async fn record(
    db: &PgPool,
    key: (i32, &str, &str),
    outcome: &str,
    tally: &Tally,
    failed: Vec<String>,
    next_at: Option<DateTime<Utc>>,
) {
    let res = sqlx::query(
        r#"INSERT INTO acquisition_attempts ("mediaId", family, language, "at", outcome, found, eligible, rejections, failed, "nextAt")
           VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9)
           ON CONFLICT ("mediaId", family, language) DO UPDATE SET "at" = now(), outcome = $4, found = $5,
             eligible = $6, rejections = $7, failed = $8, "nextAt" = $9"#,
    )
    .bind(key.0)
    .bind(key.1)
    .bind(key.2)
    .bind(outcome)
    .bind(tally.found)
    .bind(tally.eligible)
    .bind(Json(tally.top()))
    .bind(Json(failed))
    .bind(next_at)
    .execute(db)
    .await;
    if let Err(e) = res {
        tracing::warn!("acquisition: attempt of media#{} not recorded: {e}", key.0);
    }
}

#[derive(FromRow)]
struct Row {
    #[sqlx(rename = "mediaId")]
    media_id: i32,
    family: String,
    language: String,
    at: DateTime<Utc>,
    outcome: String,
    found: i32,
    eligible: i32,
    rejections: Json<Vec<Rejection>>,
    failed: Json<Vec<String>>,
    #[sqlx(rename = "nextAt")]
    next_at: Option<DateTime<Utc>>,
}

fn iso(d: DateTime<Utc>) -> String {
    d.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The `lastSearch` wire object; `failed` names the providers, so only a caller who manages plugins gets it.
fn wire(r: &Row, show_failed: bool) -> Value {
    json!({
        "at": iso(r.at),
        "outcome": r.outcome,
        "found": r.found,
        "eligible": r.eligible,
        "rejections": r.rejections.0,
        "failed": if show_failed { r.failed.0.clone() } else { vec![] },
        "nextAt": r.next_at.map(iso),
    })
}

const SELECT: &str = r#"SELECT "mediaId", family, language, "at", outcome, found, eligible, rejections, failed, "nextAt"
    FROM acquisition_attempts"#;

/// Whether the caller sees which providers failed: only a plugin manager.
pub fn show_failed(a: &crate::http::auth::Authed) -> bool {
    a.perms.can(
        fliks_domain::acl::Action::Manage,
        &fliks_domain::acl::Subject::Settings,
    )
}

/// The attempts of these wants, by (media, family, language) with `''` for no language.
pub async fn of_wants(
    db: &PgPool,
    media: &[i32],
    show_failed: bool,
) -> sqlx::Result<HashMap<(i32, String, String), Value>> {
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"{SELECT} WHERE "mediaId" = ANY($1)"#
    )))
    .bind(media)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .map(|r| {
            (
                (r.media_id, r.family.clone(), r.language.clone()),
                wire(r, show_failed),
            )
        })
        .collect())
}

/// The latest attempt of each of these media, whatever its family.
pub async fn latest_of(
    db: &PgPool,
    media: &[i32],
    show_failed: bool,
) -> sqlx::Result<HashMap<i32, Value>> {
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"{SELECT} WHERE "mediaId" = ANY($1) ORDER BY "mediaId", "at" DESC"#
    )))
    .bind(media)
    .fetch_all(db)
    .await?;
    let mut out = HashMap::new();
    for r in &rows {
        out.entry(r.media_id)
            .or_insert_with(|| wire(r, show_failed));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(codes: &[&str]) -> Value {
        json!({"allowed": true, "rejections": codes.iter().map(|c| json!({"code": c})).collect::<Vec<_>>()})
    }

    #[test]
    fn it_counts_everything_found_and_keeps_the_top_three_codes() {
        let mut t = Tally::default();
        t.count(&json!([
            rel(&[]),
            rel(&["SIZE_TOO_HIGH", "LANGUAGE_NOT_ALLOWED"]),
            rel(&["SIZE_TOO_HIGH"]),
            rel(&["SIZE_TOO_HIGH", "MIN_SEEDERS"]),
            rel(&["MIN_SEEDERS"]),
            rel(&["TITLE_MISMATCH"]),
            {"blocklisted": true, "allowed": true, "rejections": []},
            {"allowed": false, "rejections": []},
        ]));
        t.count(&json!(null));
        assert_eq!((t.found, t.eligible), (8, 1));
        let top: Vec<_> = t.top().into_iter().map(|r| (r.code, r.count)).collect();
        assert_eq!(
            top,
            [
                ("SIZE_TOO_HIGH".to_owned(), 3),
                ("MIN_SEEDERS".to_owned(), 2),
                ("BLOCKLISTED".to_owned(), 1)
            ]
        );
    }

    #[test]
    fn the_earliest_cooldown_wins() {
        let at = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc);
        let mut t = Tally::default();
        t.cool(at("2026-01-01T10:00:00Z"));
        t.cool(at("2026-01-01T08:00:00Z"));
        t.cool(at("2026-01-01T09:00:00Z"));
        assert_eq!(t.cooling, Some(at("2026-01-01T08:00:00Z")));
    }
}
