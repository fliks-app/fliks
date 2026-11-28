//! `derived_audio`: rows, eviction, invalidation and the file sweep (`docs/spec/karaoke.md` rules 11-15).
use crate::sync::MutexExt;
use crate::{paths, state::AppState};
use sqlx::PgPool;
use std::path::{Path, PathBuf};

pub const KINDS: [&str; 2] = ["vocals", "instrumental"];
/// A row this young is in use by the run that made it: eviction leaves it.
const EVICT_GRACE_MINUTES: i32 = 10;
/// A drift above this between the file and its stems is a different recording (`music.md` rule 65).
const REPLACED_TOLERANCE_MS: i32 = 2000;

#[derive(sqlx::FromRow, Debug, Clone)]
pub struct Row {
    pub kind: String,
    pub model: String,
    #[sqlx(rename = "modelVersion")]
    pub model_version: String,
    pub provider: String,
    pub path: String,
    pub size: i64,
    #[sqlx(rename = "durationMs")]
    pub duration_ms: i32,
}

pub fn dir() -> PathBuf {
    paths::cache_dir().join("karaoke")
}

pub fn file_dir(file: i32) -> PathBuf {
    dir().join(file.to_string())
}

pub async fn rows(db: &PgPool, file: i32) -> sqlx::Result<Vec<Row>> {
    sqlx::query_as(
        r#"SELECT kind, model, "modelVersion", provider, path, size, "durationMs"
           FROM derived_audio WHERE "mediaFileId" = $1 ORDER BY kind"#,
    )
    .bind(file)
    .fetch_all(db)
    .await
}

/// The provider of an imported stem (an UltraStar `#VOCALS`/`#INSTRUMENTAL` file), kept by eviction and model changes.
pub const IMPORT: &str = "import";

/// The file a track's stems derive from, as SQL over the item expression `item`: its newest version, what plays.
pub(crate) fn track_file_sql(item: &str) -> String {
    format!(
        r#"SELECT ip."mediaFileId" FROM item_parts ip WHERE ip."itemId" = {item}
           ORDER BY ip.version DESC, ip.position LIMIT 1"#
    )
}

pub async fn track_file(db: &PgPool, item: i32) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(track_file_sql("$1")))
        .bind(item)
        .fetch_optional(db)
        .await
}

/// The track whose stems `file` holds: the item it is the [`track_file`] of.
pub async fn track_of(db: &PgPool, file: i32) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"SELECT p."itemId" FROM item_parts p WHERE p."mediaFileId" = $1
           AND p."mediaFileId" = ({}) ORDER BY p."itemId" LIMIT 1"#,
        track_file_sql(r#"p."itemId""#)
    )))
    .bind(file)
    .fetch_optional(db)
    .await
}

/// The kinds `file` still needs from `Separate`: neither imported nor made by `model` (`None`: only imports count).
pub async fn missing(
    db: &PgPool,
    file: i32,
    model: Option<(&str, &str)>,
) -> sqlx::Result<Vec<&'static str>> {
    let rows = rows(db, file).await?;
    let mut out = vec![];
    for k in KINDS {
        let mut held = false;
        for r in rows.iter().filter(|r| r.kind == k) {
            let current = r.provider == IMPORT
                || model.is_some_and(|(m, v)| r.model == m && r.model_version == v);
            if current && tokio::fs::try_exists(&r.path).await.unwrap_or(false) {
                held = true;
            }
        }
        if !held {
            out.push(k);
        }
    }
    Ok(out)
}

/// Every kind of `file` is imported or made by `model`, on disk.
pub async fn valid(db: &PgPool, file: i32, model: &str, version: &str) -> sqlx::Result<bool> {
    Ok(missing(db, file, Some((model, version))).await?.is_empty())
}

pub struct New<'a> {
    pub file: i32,
    pub kind: &'a str,
    pub model: &'a str,
    pub model_version: &'a str,
    pub provider: &'a str,
    pub path: &'a str,
    pub size: i64,
    pub duration_ms: i32,
}

/// Replaces the row of `(file, kind)`; the file it named before is removed.
pub async fn put(db: &PgPool, n: &New<'_>) -> sqlx::Result<()> {
    put_all(db, std::slice::from_ref(n)).await
}

/// [`put`] of several rows in one transaction, so a failure leaves the earlier set whole.
pub async fn put_all(db: &PgPool, rows: &[New<'_>]) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    let mut old = vec![];
    for n in rows {
        old.extend(put_in(&mut tx, n).await?);
    }
    tx.commit().await?;
    for o in old {
        let _ = tokio::fs::remove_file(o).await;
    }
    Ok(())
}

/// [`put`] on a caller's connection; the replaced file is returned, for the caller to remove once committed.
pub async fn put_in(db: &mut sqlx::PgConnection, n: &New<'_>) -> sqlx::Result<Option<String>> {
    let old: Option<String> = sqlx::query_scalar(
        r#"SELECT path FROM derived_audio WHERE "mediaFileId" = $1 AND kind = $2"#,
    )
    .bind(n.file)
    .bind(n.kind)
    .fetch_optional(&mut *db)
    .await?;
    sqlx::query(
        r#"INSERT INTO derived_audio ("mediaFileId", kind, model, "modelVersion", provider, path, size, "durationMs")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT ("mediaFileId", kind) DO UPDATE SET model = EXCLUDED.model,
             "modelVersion" = EXCLUDED."modelVersion", provider = EXCLUDED.provider, path = EXCLUDED.path,
             size = EXCLUDED.size, "durationMs" = EXCLUDED."durationMs", "lastUsedAt" = now()"#,
    )
    .bind(n.file)
    .bind(n.kind)
    .bind(n.model)
    .bind(n.model_version)
    .bind(n.provider)
    .bind(n.path)
    .bind(n.size)
    .bind(n.duration_ms)
    .execute(&mut *db)
    .await?;
    Ok(old.filter(|o| o != n.path))
}

/// The file of a served stem.
pub async fn serve(db: &PgPool, file: i32, kind: &str) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(r#"SELECT path FROM derived_audio WHERE "mediaFileId" = $1 AND kind = $2"#)
        .bind(file)
        .bind(kind)
        .fetch_optional(db)
        .await
}

/// Marks every stem of `file` as used: a karaoke request for its track (rule 14).
pub async fn touch(db: &PgPool, file: i32) -> sqlx::Result<()> {
    sqlx::query(r#"UPDATE derived_audio SET "lastUsedAt" = now() WHERE "mediaFileId" = $1"#)
        .bind(file)
        .execute(db)
        .await
        .map(drop)
}

async fn unlink(paths: Vec<String>) -> u64 {
    for p in &paths {
        let _ = tokio::fs::remove_file(p).await;
        if let Some(dir) = Path::new(p).parent() {
            let _ = tokio::fs::remove_dir(dir).await;
        }
    }
    paths.len() as u64
}

/// Copies `src` as the `kind` stem of `file`, unless that import already holds a copy of the same size.
pub async fn import(
    db: &PgPool,
    file: i32,
    kind: &str,
    src: &Path,
    duration_ms: i32,
) -> std::io::Result<()> {
    let size = tokio::fs::metadata(src).await?.len() as i64;
    let held: Option<(String, i64)> = sqlx::query_as(
        r#"SELECT path, size FROM derived_audio WHERE "mediaFileId" = $1 AND kind = $2 AND provider = $3"#,
    )
    .bind(file)
    .bind(kind)
    .bind(IMPORT)
    .fetch_optional(db)
    .await
    .map_err(std::io::Error::other)?;
    if let Some((p, s)) = held
        && s == size
        && tokio::fs::try_exists(&p).await.unwrap_or(false)
    {
        return Ok(());
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_lowercase();
    let dir = file_dir(file);
    tokio::fs::create_dir_all(&dir).await?;
    let to = dir.join(format!("{kind}-{}.{ext}", crate::config::random_hex(4)));
    tokio::fs::copy(src, &to).await?;
    let to = to.to_string_lossy().into_owned();
    put(
        db,
        &New {
            file,
            kind,
            model: "ultrastar",
            model_version: "1",
            provider: IMPORT,
            path: &to,
            size,
            duration_ms,
        },
    )
    .await
    .map_err(std::io::Error::other)
}

/// The imported stems of `file` whose kind is not in `keep`.
pub async fn drop_imports(db: &PgPool, file: i32, keep: &[&str]) -> sqlx::Result<u64> {
    let keep: Vec<String> = keep.iter().map(|k| (*k).to_owned()).collect();
    let paths = sqlx::query_scalar(
        r#"DELETE FROM derived_audio WHERE "mediaFileId" = $1 AND provider = $2 AND kind <> ALL($3) RETURNING path"#,
    )
    .bind(file)
    .bind(IMPORT)
    .bind(keep)
    .fetch_all(db)
    .await?;
    Ok(unlink(paths).await)
}

/// Every stem of these files (a replaced source, a deleted track).
pub async fn invalidate_files(db: &PgPool, files: &[i32]) -> sqlx::Result<u64> {
    let paths = sqlx::query_scalar(
        r#"DELETE FROM derived_audio WHERE "mediaFileId" = ANY($1) RETURNING path"#,
    )
    .bind(files.to_vec())
    .fetch_all(db)
    .await?;
    Ok(unlink(paths).await)
}

/// Rule 12: the audio of `file` now lasts `duration_ms`; its stems go when they were made on another length.
pub async fn invalidate_if_replaced(db: &PgPool, file: i32, duration_ms: i32) -> sqlx::Result<u64> {
    let paths = sqlx::query_scalar(
        r#"DELETE FROM derived_audio WHERE "mediaFileId" = $1 AND abs("durationMs" - $2) > $3 RETURNING path"#,
    )
    .bind(file)
    .bind(duration_ms)
    .bind(REPLACED_TOLERANCE_MS)
    .fetch_all(db)
    .await?;
    Ok(unlink(paths).await)
}

/// A `separate` job of `file` is in one of `states`.
pub async fn worker_separating(db: &PgPool, file: i32, states: &[&str]) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM jobs WHERE "mediaFileId" = $1 AND kind = 'separate'
                          AND state = ANY($2))"#,
    )
    .bind(file)
    .bind(states)
    .fetch_one(db)
    .await
}

/// Deletes the queued `separate` jobs of `file`, for a request that runs the separation itself.
pub async fn take_queued_separation(db: &PgPool, file: i32) -> sqlx::Result<u64> {
    let n = sqlx::query(
        r#"DELETE FROM jobs WHERE "mediaFileId" = $1 AND kind = 'separate' AND state = 'queued'"#,
    )
    .bind(file)
    .execute(db)
    .await?
    .rows_affected();
    if n > 0 {
        crate::queue::watch::changed();
    }
    Ok(n)
}

/// Deletes the rows whose file is gone (a lost cache): they would report `ready` for stems that 404.
pub async fn drop_missing(db: &PgPool) -> sqlx::Result<u64> {
    let rows: Vec<(i32, String, String)> =
        sqlx::query_as(r#"SELECT "mediaFileId", kind, path FROM derived_audio"#)
            .fetch_all(db)
            .await?;
    let mut removed = 0;
    for (file, kind, path) in rows {
        if tokio::fs::try_exists(&path).await.unwrap_or(true) {
            continue;
        }
        removed += sqlx::query(
            r#"DELETE FROM derived_audio WHERE "mediaFileId" = $1 AND kind = $2 AND path = $3"#,
        )
        .bind(file)
        .bind(kind)
        .bind(path)
        .execute(db)
        .await?
        .rows_affected();
    }
    Ok(removed)
}

/// The bytes the budget can act on: imports are copies of library files that eviction never removes.
pub async fn total(db: &PgPool) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        r#"SELECT COALESCE(sum(size), 0)::bigint FROM derived_audio WHERE provider <> 'import'"#,
    )
    .fetch_one(db)
    .await
}

/// Rule 16: tracks lacking a stem of `model`, then with `sync` those with lyrics and no word timing.
pub async fn unprepared(
    db: &PgPool,
    skip: &[i32],
    limit: i64,
    model: (&str, &str),
    sync: bool,
) -> sqlx::Result<Vec<i32>> {
    let profile = super::remote::profile_of(&(model.0.to_owned(), model.1.to_owned()));
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"SELECT id FROM (
             SELECT i.id, f.file,
               (SELECT count(DISTINCT d.kind) FROM derived_audio d WHERE d."mediaFileId" = f.file
                  AND (d.provider = 'import' OR (d.model = $4 AND d."modelVersion" = $5))) AS held,
               EXISTS (SELECT 1 FROM derived_audio d WHERE d."mediaFileId" = f.file) AS stale
             FROM items i JOIN track_details td ON td."itemId" = i.id
             JOIN LATERAL ({}) f(file) ON true
             WHERE i.id <> ALL($1)
               AND NOT EXISTS (SELECT 1 FROM karaoke_failures kf WHERE kf."itemId" = i.id
                               AND kf.error ->> 'code' = 'failed')) t
           WHERE (held < {kinds}
                  AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j."mediaFileId" = t.file AND j.kind = 'separate'
                                  AND (j.state IN ('queued', 'leased')
                                       OR (j.state IN ('cancelled', 'failed') AND j."profileHash" = $3))))
              OR (held >= {kinds} AND $6
                  AND EXISTS (SELECT 1 FROM lyrics l WHERE l."itemId" = t.id AND l.kind = 'main'
                              AND l.source <> 'generated')
                  AND NOT EXISTS (SELECT 1 FROM lyrics l WHERE l."itemId" = t.id AND l.kind = 'main'
                                  AND l.sync = 'word'))
           ORDER BY held >= {kinds}, stale, id DESC LIMIT $2"#,
        track_file_sql("i.id"),
        kinds = KINDS.len()
    )))
    .bind(skip)
    .bind(limit)
    .bind(profile)
    .bind(model.0)
    .bind(model.1)
    .bind(sync)
    .fetch_all(db)
    .await
}

/// The tracks of `items` whose [`track_file`] holds every kind.
pub async fn ready_tracks(db: &PgPool, items: &[i32]) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"SELECT t.id FROM unnest($1::int[]) t(id)
           WHERE (SELECT count(DISTINCT d.kind) FROM derived_audio d
                  WHERE d."mediaFileId" = ({})) >= {}"#,
        track_file_sql("t.id"),
        KINDS.len()
    )))
    .bind(items)
    .fetch_all(db)
    .await
}

/// The recorded failures of a track (rule 8): wire `Failure` objects and the rejected lyrics.
#[derive(sqlx::FromRow, Debug, Clone)]
pub struct Recorded {
    pub error: Option<serde_json::Value>,
    #[sqlx(rename = "lyricsError")]
    pub lyrics_error: Option<serde_json::Value>,
    #[sqlx(rename = "rejectedBy")]
    pub rejected_by: Option<String>,
    #[sqlx(rename = "rejectedText")]
    pub rejected_text: Option<String>,
}

impl Recorded {
    /// `(aligner, text digest)` of the lyrics the aligner last rejected.
    pub fn rejected(&self) -> Option<(String, String)> {
        self.rejected_by.clone().zip(self.rejected_text.clone())
    }
}

pub async fn failure(db: &PgPool, item: i32) -> sqlx::Result<Option<Recorded>> {
    sqlx::query_as(
        r#"SELECT error, "lyricsError", "rejectedBy", "rejectedText" FROM karaoke_failures
           WHERE "itemId" = $1"#,
    )
    .bind(item)
    .fetch_optional(db)
    .await
}

/// The failures of every track whose lyrics an aligner rejected.
pub async fn rejections(db: &PgPool) -> sqlx::Result<Vec<(i32, String)>> {
    sqlx::query_as(
        r#"SELECT "itemId", "rejectedBy" FROM karaoke_failures WHERE "rejectedBy" IS NOT NULL"#,
    )
    .fetch_all(db)
    .await
}

/// Keeps what a run ended with: its failure, or none; the lyrics part only when a lyrics step ran.
pub async fn record(
    db: &PgPool,
    item: i32,
    done: &Result<super::run::Outcome, super::run::Failure>,
) -> sqlx::Result<()> {
    let json = |f: &super::run::Failure| serde_json::to_value(f).ok();
    let (error, lyrics, lyrics_ran, rejected) = match done {
        Err(e) => (json(e), None, false, None),
        Ok(o) => (
            None,
            o.lyrics_error.as_ref().and_then(json),
            o.lyrics_ran,
            o.rejected.clone(),
        ),
    };
    let (by, text) = rejected.unzip();
    let mut tx = db.begin().await?;
    sqlx::query(
        r#"INSERT INTO karaoke_failures ("itemId", error, "lyricsError", "rejectedBy", "rejectedText")
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT ("itemId") DO UPDATE SET error = EXCLUDED.error,
             "lyricsError" = CASE WHEN $6 THEN EXCLUDED."lyricsError" ELSE karaoke_failures."lyricsError" END,
             "rejectedBy" = CASE WHEN $6 THEN EXCLUDED."rejectedBy" ELSE karaoke_failures."rejectedBy" END,
             "rejectedText" = CASE WHEN $6 THEN EXCLUDED."rejectedText" ELSE karaoke_failures."rejectedText" END"#,
    )
    .bind(item)
    .bind(error)
    .bind(lyrics)
    .bind(by)
    .bind(text)
    .bind(lyrics_ran)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"DELETE FROM karaoke_failures WHERE "itemId" = $1 AND error IS NULL
             AND "lyricsError" IS NULL AND "rejectedBy" IS NULL"#,
    )
    .bind(item)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

pub async fn forget_failure(db: &PgPool, item: i32) -> sqlx::Result<()> {
    sqlx::query(r#"DELETE FROM karaoke_failures WHERE "itemId" = $1"#)
        .bind(item)
        .execute(db)
        .await
        .map(drop)
}

/// Rule 14: the file last used longest ago first, all its rows at once, until the total fits `budget` bytes.
pub async fn evict(db: &PgPool, budget: i64) -> sqlx::Result<u64> {
    let mut removed = 0;
    while total(db).await? > budget {
        let paths: Vec<String> = sqlx::query_scalar(
            r#"DELETE FROM derived_audio WHERE "mediaFileId" = (
                 SELECT "mediaFileId" FROM derived_audio GROUP BY "mediaFileId"
                 HAVING bool_and(provider <> 'import') AND max("lastUsedAt") < now() - make_interval(mins => $1)
                 ORDER BY max("lastUsedAt") LIMIT 1)
               RETURNING path"#,
        )
        .bind(EVICT_GRACE_MINUTES)
        .fetch_all(db)
        .await?;
        if paths.is_empty() {
            break;
        }
        removed += unlink(paths).await;
    }
    Ok(removed)
}

/// Rule 15: directories of vanished files and files no row names.
pub async fn sweep(st: &AppState) -> std::io::Result<()> {
    let Ok(mut top) = tokio::fs::read_dir(dir()).await else {
        return Ok(());
    };
    while let Some(entry) = top.next_entry().await? {
        let path = entry.path();
        let Some(file) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<i32>().ok())
        else {
            continue;
        };
        if st.karaoke.separating.lock_clean().contains(&file) {
            continue;
        }
        let known: Vec<String> =
            sqlx::query_scalar(r#"SELECT path FROM derived_audio WHERE "mediaFileId" = $1"#)
                .bind(file)
                .fetch_all(&st.db)
                .await
                .map_err(std::io::Error::other)?;
        if known.is_empty() && !is_young(&path).await {
            let _ = tokio::fs::remove_dir_all(&path).await;
            continue;
        }
        let Ok(mut inner) = tokio::fs::read_dir(&path).await else {
            continue;
        };
        while let Some(f) = inner.next_entry().await? {
            let p = f.path();
            let named = known.iter().any(|k| Path::new(k) == p);
            if !named && !is_young(&p).await {
                let _ = tokio::fs::remove_file(&p).await;
            }
        }
    }
    Ok(())
}

/// A file a run is still writing or has not recorded yet.
async fn is_young(p: &Path) -> bool {
    tokio::fs::metadata(p)
        .await
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_none_or(|age| {
            age < std::time::Duration::from_secs(60 * u64::from(EVICT_GRACE_MINUTES.unsigned_abs()))
        })
}
