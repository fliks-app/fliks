//! The `lyrics` table (`docs/spec/music.md` rules 61, 65).
use fliks_domain::lyrics::{self, Doc, Parsed, Sync};
use sqlx::{PgConnection, PgPool, types::Json};

/// A timing made on audio this much longer or shorter than the file's does not carry over.
const CARRY_TOLERANCE_MS: i64 = 2000;

#[derive(sqlx::FromRow, Debug, Clone)]
pub struct Row {
    pub id: i32,
    #[sqlx(rename = "itemId")]
    pub item_id: i32,
    pub kind: String,
    pub lang: String,
    pub sync: String,
    pub source: String,
    #[sqlx(rename = "sourceRef")]
    pub source_ref: Option<String>,
    #[sqlx(rename = "offsetMs")]
    pub offset_ms: i32,
    pub doc: Json<Doc>,
    pub reviewed: bool,
    pub preferred: bool,
}

pub const COLUMNS: &str =
    r#"id, "itemId", kind, lang, sync, source, "sourceRef", "offsetMs", doc, reviewed, preferred"#;

/// What a row is stored from.
pub struct New<'a> {
    pub item: i32,
    pub file: Option<i32>,
    pub kind: &'a str,
    pub lang: &'a str,
    pub source: &'a str,
    pub source_ref: Option<&'a str>,
    pub parsed: &'a Parsed,
    pub raw: Option<&'a str>,
    pub duration_ms: Option<i32>,
    pub reviewed: bool,
}

/// The layer `(item, kind, lang, source)` replaced; its offset and `reviewed` stay while the text is the same.
pub async fn upsert(db: &PgPool, n: &New<'_>) -> sqlx::Result<i32> {
    sqlx::query_scalar(
        r#"INSERT INTO lyrics ("itemId", "mediaFileId", kind, lang, sync, source, "sourceRef", "offsetMs",
             "audioDurationMs", doc, raw, reviewed)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT ("itemId", kind, lang, source) DO UPDATE SET
             "mediaFileId" = EXCLUDED."mediaFileId", sync = EXCLUDED.sync, "sourceRef" = EXCLUDED."sourceRef",
             "audioDurationMs" = EXCLUDED."audioDurationMs", doc = EXCLUDED.doc, raw = EXCLUDED.raw,
             "offsetMs" = CASE WHEN lyrics.raw IS NOT DISTINCT FROM EXCLUDED.raw
                               THEN lyrics."offsetMs" ELSE EXCLUDED."offsetMs" END,
             reviewed = CASE WHEN lyrics.raw IS NOT DISTINCT FROM EXCLUDED.raw
                             THEN lyrics.reviewed ELSE EXCLUDED.reviewed END
           RETURNING id"#,
    )
    .bind(n.item)
    .bind(n.file)
    .bind(n.kind)
    .bind(n.lang)
    .bind(n.parsed.sync.as_str())
    .bind(n.source)
    .bind(n.source_ref)
    .bind(n.parsed.offset_ms)
    .bind(n.duration_ms)
    .bind(Json(&n.parsed.doc))
    .bind(n.raw)
    .bind(n.reviewed)
    .fetch_one(db)
    .await
}

pub async fn list(db: &PgPool, item: i32) -> sqlx::Result<Vec<Row>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM lyrics WHERE \"itemId\" = $1"
    )))
    .bind(item)
    .fetch_all(db)
    .await
}

pub async fn get(db: &PgPool, id: i32) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM lyrics WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(db)
    .await
}

fn source_rank(s: &str) -> u8 {
    match s {
        "user" => 0,
        "sidecar" => 1,
        "embedded" => 2,
        s if s.starts_with("provider:") => 3,
        _ => 4,
    }
}

fn kind_rank(k: &str) -> u8 {
    match k {
        "main" => 0,
        "translation" => 1,
        _ => 2,
    }
}

fn sync_rank(s: &str) -> u8 {
    match Sync::parse(s) {
        Some(Sync::Word) => 0,
        Some(Sync::Line) => 1,
        _ => 2,
    }
}

/// Rule 66's order: preferred, kind, source, then the better sync.
pub fn sort(rows: &mut [Row]) {
    rows.sort_by_key(|r| {
        (
            !r.preferred,
            kind_rank(&r.kind),
            source_rank(&r.source),
            sync_rank(&r.sync),
            r.id,
        )
    });
}

/// Rule 65: a new file takes the track. Timing made on audio that differs from it by more than 2 s is dropped.
pub async fn rebind(
    c: &mut PgConnection,
    item: i32,
    file: i32,
    duration_ms: Option<i32>,
) -> sqlx::Result<()> {
    let rows: Vec<(i32, String, Option<i32>, Json<Doc>)> = sqlx::query_as(
        r#"SELECT id, sync, "audioDurationMs", doc FROM lyrics WHERE "itemId" = $1"#,
    )
    .bind(item)
    .fetch_all(&mut *c)
    .await?;
    for (id, sync, stamp, doc) in rows {
        let timed = sync != "none";
        let drift = match (stamp, duration_ms) {
            (Some(a), Some(b)) => Some((i64::from(a) - i64::from(b)).abs()),
            _ => None,
        };
        if timed && drift.is_some_and(|d| d > CARRY_TOLERANCE_MS) {
            sqlx::query(
                r#"UPDATE lyrics SET "mediaFileId" = $2, sync = 'none', doc = $3, "offsetMs" = 0,
                     "audioDurationMs" = $4 WHERE id = $1"#,
            )
            .bind(id)
            .bind(file)
            .bind(Json(lyrics::without_timing(&doc.0)))
            .bind(duration_ms)
            .execute(&mut *c)
            .await?;
        } else {
            sqlx::query(
                r#"UPDATE lyrics SET "mediaFileId" = $2, "audioDurationMs" = COALESCE("audioDurationMs", $3)
                   WHERE id = $1"#,
            )
            .bind(id)
            .bind(file)
            .bind(duration_ms)
            .execute(&mut *c)
            .await?;
        }
    }
    Ok(())
}

/// Whether the track already holds a synced main document that needs no provider.
pub async fn has_synced_main(db: &PgPool, item: i32) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM lyrics WHERE "itemId" = $1 AND kind = 'main' AND sync <> 'none')"#,
    )
    .bind(item)
    .fetch_one(db)
    .await
}
