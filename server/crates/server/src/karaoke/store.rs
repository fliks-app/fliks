//! `derived_audio`: rows, eviction, invalidation and the file sweep (`docs/spec/karaoke.md` rules 11-15).
use crate::{paths, state::AppState};
use sqlx::PgPool;
use std::path::{Path, PathBuf};

pub const KINDS: [&str; 3] = ["vocals", "instrumental", "guide"];
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

/// The stems of `file` when both imports exist on disk, or all three exist and were made by `model`.
pub async fn valid(db: &PgPool, file: i32, model: &str, version: &str) -> sqlx::Result<bool> {
    let rows = rows(db, file).await?;
    let on_disk = |k: &str, imported: bool| {
        rows.iter().any(|r| {
            r.kind == k && (r.provider == IMPORT) == imported && Path::new(&r.path).is_file()
        })
    };
    if on_disk("vocals", true) && on_disk("instrumental", true) {
        return Ok(true);
    }
    Ok(KINDS.iter().all(|k| {
        rows.iter().any(|r| {
            r.kind == *k
                && r.model == model
                && r.model_version == version
                && Path::new(&r.path).is_file()
        })
    }))
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
    let old: Option<String> = sqlx::query_scalar(
        r#"SELECT path FROM derived_audio WHERE "mediaFileId" = $1 AND kind = $2"#,
    )
    .bind(n.file)
    .bind(n.kind)
    .fetch_optional(db)
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
    .execute(db)
    .await?;
    if let Some(old) = old.filter(|o| o != n.path) {
        let _ = tokio::fs::remove_file(old).await;
    }
    Ok(())
}

/// The file of a served stem; a request that starts the file marks every stem of it as used.
pub async fn serve(
    db: &PgPool,
    file: i32,
    kind: &str,
    start: bool,
) -> sqlx::Result<Option<String>> {
    let path: Option<String> = sqlx::query_scalar(
        r#"SELECT path FROM derived_audio WHERE "mediaFileId" = $1 AND kind = $2"#,
    )
    .bind(file)
    .bind(kind)
    .fetch_optional(db)
    .await?;
    if start && path.is_some() {
        sqlx::query(r#"UPDATE derived_audio SET "lastUsedAt" = now() WHERE "mediaFileId" = $1"#)
            .bind(file)
            .execute(db)
            .await?;
    }
    Ok(path)
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
    if held.is_some_and(|(p, s)| s == size && Path::new(&p).is_file()) {
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

/// A deleted model takes its stems with it.
pub async fn invalidate_model(db: &PgPool, model: &str) -> sqlx::Result<u64> {
    let paths = sqlx::query_scalar("DELETE FROM derived_audio WHERE model = $1 RETURNING path")
        .bind(model)
        .fetch_all(db)
        .await?;
    Ok(unlink(paths).await)
}

/// Stems of another model or version than the one the host picks (rule 12).
pub async fn invalidate_stale_models(db: &PgPool, model: &str, version: &str) -> sqlx::Result<u64> {
    let paths = sqlx::query_scalar(
        r#"DELETE FROM derived_audio WHERE provider <> 'import' AND (model <> $1 OR "modelVersion" <> $2) RETURNING path"#,
    )
    .bind(model)
    .bind(version)
    .fetch_all(db)
    .await?;
    Ok(unlink(paths).await)
}

pub async fn total(db: &PgPool) -> sqlx::Result<i64> {
    sqlx::query_scalar(r#"SELECT COALESCE(sum(size), 0)::bigint FROM derived_audio"#)
        .fetch_one(db)
        .await
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
        let mut inner = tokio::fs::read_dir(&path).await?;
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
