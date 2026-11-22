//! Database backups (`docs/spec/system.md` rules 14-21, 31-35): `pg_dump` to a file; the restore is `restore.rs`.
use crate::{config::Config, db, http::AppError, paths};
use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use sqlx::PgPool;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::Command;

/// The `Backup` job keeps this many (rule 20).
pub const KEEP: usize = 7;

/// The pre-migration folder keeps this many (rule 33).
const PRE_MIGRATION_KEEP: usize = 3;

pub fn dir() -> PathBuf {
    let dir = paths::data_dir().join("backups");
    std::path::absolute(&dir).unwrap_or(dir)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Made {
    pub filename: String,
    pub size: u64,
    /// Plugin schemas left out of the archive (rule 17), so a restore cannot bring them back.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub plugins_skipped: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Entry {
    pub filename: String,
    pub size: u64,
    pub date: String,
}

pub(super) fn internal(msg: impl Into<String>) -> AppError {
    AppError::internal(msg.into())
}

/// The extensions of a backup: `.dump` archives and the plain `.sql` files of earlier builds.
const EXTS: [&str; 2] = [".dump", ".sql"];

/// `^[A-Za-z0-9_.-]+\.(sql|dump)$` over ASCII, so no separator or NUL can pass (rule 15).
pub fn valid_name(name: &str) -> bool {
    EXTS.iter()
        .find_map(|e| name.strip_suffix(e))
        .is_some_and(|stem| {
            !stem.is_empty()
                && stem
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        })
}

/// Rule 15: validate, then require the file; returns its path.
pub async fn locate(dir: &Path, name: &str) -> Result<PathBuf, AppError> {
    if !valid_name(name) {
        return Err(AppError::bad_request(format!(
            "Invalid backup name \"{name}\""
        )));
    }
    let path = dir.join(name);
    match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => Ok(path),
        _ => Err(AppError::not_found(format!("Backup \"{name}\" not found"))),
    }
}

pub(super) fn conn_args(cfg: &Config) -> Vec<String> {
    conn_args_as(cfg, cfg.db.get_username())
}

pub(super) fn conn_args_as(cfg: &Config, user: &str) -> Vec<String> {
    let db = &cfg.db;
    vec![
        "-h".into(),
        db.get_host().into(),
        "-p".into(),
        db.get_port().to_string(),
        "-U".into(),
        user.into(),
        "-d".into(),
        db.get_database().unwrap_or_default().into(),
    ]
}

/// A failed tool run: the last stderr line for an answer, the whole stderr for callers that read it.
pub(super) struct ToolFail {
    pub message: String,
    pub stderr: String,
}

/// Rule 18: no shell, the password in `PGPASSWORD`, stderr captured, the last stderr line as the message.
/// Returns the stdout bytes when `stdout` is piped.
pub(super) async fn exec(
    cmd: &str,
    args: &[String],
    password: &str,
    stdout: Stdio,
) -> Result<Vec<u8>, ToolFail> {
    let fail = |message: String| ToolFail {
        message,
        stderr: String::new(),
    };
    let child = Command::new(cmd)
        .args(args)
        .env("PGPASSWORD", password)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => fail(format!("{cmd} is not available on this server")),
            _ => fail(format!("{cmd} failed: {e}")),
        })?;
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| fail(format!("{cmd} failed: {e}")))?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let code = out
        .status
        .code()
        .map_or_else(|| "a signal".to_owned(), |c| c.to_string());
    tracing::error!("{cmd} exited with {code}: {}", stderr.trim_end());
    let last = stderr.lines().rev().find(|l| !l.trim().is_empty());
    Err(ToolFail {
        message: last.map_or_else(
            || format!("{cmd} exited with code {code}"),
            |l| l.trim().to_owned(),
        ),
        stderr,
    })
}

pub(super) async fn run_tool(
    cfg: &Config,
    cmd: &str,
    args: &[String],
    stdout: Stdio,
) -> Result<(), AppError> {
    exec(cmd, args, cfg.db_password.expose(), stdout)
        .await
        .map(drop)
        .map_err(|f| internal(f.message))
}

fn stamp() -> String {
    fliks_domain::js::iso(Utc::now()).replace([':', '.'], "-")
}

/// Rule 17.
pub async fn create(cfg: &Config, pool: &PgPool, dir: &Path) -> Result<Made, AppError> {
    let name = format!("fliks-backup-{}.dump", stamp());
    dump(cfg, pool, dir, name).await
}

/// Plugin schemas a non-superuser core cannot read: a FORCE RLS table applies to its owner, and core is a member.
async fn unreadable_schemas(pool: &PgPool) -> Result<Vec<String>, AppError> {
    Ok(sqlx::query_scalar(
        r"SELECT n.nspname::text FROM pg_namespace n
           WHERE n.nspname LIKE 'plugin\_%'
             AND NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
             AND EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relforcerowsecurity)
           ORDER BY n.nspname",
    )
    .fetch_all(pool)
    .await?)
}

/// The plugin schema a failed `pg_dump` names (its `Query was: COPY plugin_x.t ...` line), not yet excluded.
async fn named_schema(pool: &PgPool, stderr: &str, excluded: &[String]) -> Option<String> {
    let all: Vec<String> = sqlx::query_scalar(
        r"SELECT nspname::text FROM pg_namespace WHERE nspname LIKE 'plugin\_%'",
    )
    .fetch_all(pool)
    .await
    .ok()?;
    all.into_iter()
        .find(|s| !excluded.contains(s) && stderr.contains(&format!("{s}.")))
}

async fn dump(cfg: &Config, pool: &PgPool, dir: &Path, filename: String) -> Result<Made, AppError> {
    tracing::info!("Creating backup: {filename}");
    mkdir_private(dir).map_err(|e| internal(format!("cannot create the backup directory: {e}")))?;
    let path = dir.join(&filename);
    let tmp = dir.join(format!("{filename}{PARTIAL}"));
    let mut partial = Partial(Some(&tmp));
    let mut skipped = unreadable_schemas(pool).await?;
    let mut retried = false;
    loop {
        let file =
            create_private(&tmp).map_err(|e| internal(format!("cannot write the backup: {e}")))?;
        let mut args = conn_args(cfg);
        args.push("-Fc".to_owned());
        args.extend(skipped.iter().map(|s| format!("--exclude-schema={s}")));
        match exec("pg_dump", &args, cfg.db_password.expose(), file.into()).await {
            Ok(_) => break,
            // A plugin may set FORCE RLS between the pre-check and the dump: one retry without its schema.
            Err(f) => match named_schema(pool, &f.stderr, &skipped).await {
                Some(s) if !retried => {
                    tracing::warn!(
                        "Backup: skipping {s}, pg_dump could not read it: {}",
                        f.message
                    );
                    skipped.push(s);
                    retried = true;
                    let _ = tokio::fs::remove_file(&tmp).await;
                }
                _ => return Err(internal(f.message)),
            },
        }
    }
    if !skipped.is_empty() {
        tracing::warn!(
            "Backup {filename} leaves out plugin schemas: {}",
            skipped.join(", ")
        );
    }
    let size = tokio::fs::metadata(&tmp)
        .await
        .map_err(|e| internal(e.to_string()))?
        .len();
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| internal(format!("cannot write the backup: {e}")))?;
    partial.0 = None;
    tracing::info!("Backup created: {filename} ({size} bytes)");
    Ok(Made {
        filename,
        size,
        plugins_skipped: skipped,
    })
}

/// Rules 31-35: dump before pending migrations, so a destructive one can be rolled back by a restore.
pub async fn before_migration(
    cfg: &Config,
    pool: &PgPool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    sweep_partials(&dir()).await;
    let skip = std::env::var("FLIKS_SKIP_PRE_MIGRATION_BACKUP")
        .is_ok_and(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes"));
    if skip {
        tracing::warn!("FLIKS_SKIP_PRE_MIGRATION_BACKUP is set: no backup before migrations");
        return Ok(());
    }
    before_migration_in(cfg, pool, &dir().join("pre-migration")).await
}

pub async fn before_migration_in(
    cfg: &Config,
    pool: &PgPool,
    dir: &Path,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    sweep_partials(dir).await;
    let Some(version) = db::pending_version(pool).await? else {
        return Ok(());
    };
    let filename = format!("fliks-pre-migration-v{version}-{}.dump", stamp());
    tracing::info!("Migrations pending, backing up to {}", dir.display());
    dump(cfg, pool, dir, filename).await.map_err(|e| {
        format!(
            "pre-migration backup failed, migrations not applied: {e} \
             (set FLIKS_SKIP_PRE_MIGRATION_BACKUP=1 to skip it)"
        )
    })?;
    prune(dir, PRE_MIGRATION_KEEP, &[".dump"]).await?;
    // Plain-SQL dumps written by earlier 6.0 builds.
    for e in list_ext(dir, &[".sql"]).await {
        tokio::fs::remove_file(dir.join(e.filename)).await?;
    }
    Ok(())
}

/// A dump is written under this suffix and renamed once complete, so no list or prune sees a cut file.
pub(super) const PARTIAL: &str = ".partial";

/// Deletes the unfinished dumps a killed process left behind.
async fn sweep_partials(dir: &Path) {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(e)) = rd.next_entry().await {
        let name = e.file_name();
        if name.to_string_lossy().ends_with(PARTIAL) {
            match tokio::fs::remove_file(e.path()).await {
                Ok(()) => tracing::info!("Removed unfinished backup {}", name.to_string_lossy()),
                Err(err) => tracing::warn!("cannot remove {}: {err}", name.to_string_lossy()),
            }
        }
    }
}

/// Removes an unfinished dump, also when the future is dropped mid-run (shutdown).
struct Partial<'a>(Option<&'a Path>);

impl Drop for Partial<'_> {
    fn drop(&mut self) {
        if let Some(p) = self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// A `0700` directory (when created here) and `0600` files.
pub(super) fn mkdir_private(dir: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)
}

pub(super) fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(path)
}

/// Rule 14: newest first by `date`, then `filename` descending.
pub async fn list(dir: &Path) -> Vec<Entry> {
    list_ext(dir, &EXTS).await
}

async fn list_ext(dir: &Path, exts: &[&str]) -> Vec<Entry> {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return vec![];
    };
    let mut out = vec![];
    while let Ok(Some(e)) = rd.next_entry().await {
        let filename = e.file_name().to_string_lossy().into_owned();
        let Ok(meta) = e.metadata().await else {
            continue;
        };
        if !exts.iter().any(|e| filename.ends_with(e)) || !meta.is_file() {
            continue;
        }
        let date = meta.modified().map_or_else(
            |_| String::new(),
            |t| fliks_domain::js::iso(chrono::DateTime::<Utc>::from(t)),
        );
        out.push(Entry {
            filename,
            size: meta.len(),
            date,
        });
    }
    out.sort_by(|a, b| (&b.date, &b.filename).cmp(&(&a.date, &a.filename)));
    out
}

/// Rules 20 and 33: delete all but the newest `keep`, sparing the oldest dump of the newest `v<version>`.
pub async fn prune(dir: &Path, keep: usize, exts: &[&str]) -> std::io::Result<usize> {
    let all = list_ext(dir, exts).await;
    let anchor = all
        .first()
        .and_then(|e| version_of(&e.filename))
        .and_then(|v| all.iter().rfind(|e| version_of(&e.filename) == Some(v)));
    let mut n = 0;
    for e in all.iter().skip(keep) {
        if anchor.is_some_and(|a| a.filename == e.filename) {
            continue;
        }
        tokio::fs::remove_file(dir.join(&e.filename)).await?;
        tracing::info!("Backup deleted: {}", e.filename);
        n += 1;
    }
    Ok(n)
}

/// The `<version>` of `fliks-pre-migration-v<version>-<stamp>.dump`.
fn version_of(filename: &str) -> Option<&str> {
    let v = filename
        .strip_prefix("fliks-pre-migration-v")?
        .split('-')
        .next()?;
    (!v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())).then_some(v)
}

pub async fn delete(dir: &Path, name: &str) -> Result<(), AppError> {
    let path = locate(dir, name).await?;
    tokio::fs::remove_file(path)
        .await
        .map_err(|e| internal(e.to_string()))?;
    tracing::info!("Backup deleted: {name}");
    Ok(())
}

/// `String(value)` of a JSON value, for the 400 text of rule 22.
pub fn js_string(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), fliks_domain::js::js_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(dir: &Path, name: &str, age_s: u64) {
        let f = std::fs::File::create(dir.join(name)).unwrap();
        f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(age_s))
            .unwrap();
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "fliks-prune-{tag}-{}",
            crate::config::random_hex(6)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn sweep_removes_only_the_partials() {
        let dir = scratch("partial");
        put(&dir, "fliks-pre-migration-v1-a.dump", 10);
        put(&dir, "fliks-pre-migration-v2-b.dump.partial", 5);
        sweep_partials(&dir).await;
        assert_eq!(names(&dir), ["fliks-pre-migration-v1-a.dump"]);
    }

    #[tokio::test]
    async fn prune_spares_the_oldest_dump_of_the_newest_version() {
        let dir = scratch("pre");
        put(&dir, "fliks-pre-migration-v10-a.sql", 900);
        put(&dir, "fliks-pre-migration-v123-a.sql", 800);
        // A crash loop on v123: a dump per restart, pruned to 3 each time.
        for (i, stamp) in ["b", "c", "d", "e", "f"].into_iter().enumerate() {
            put(
                &dir,
                &format!("fliks-pre-migration-v123-{stamp}.sql"),
                700 - i as u64 * 100,
            );
            prune(&dir, 3, &[".sql"]).await.unwrap();
            assert!(names(&dir).contains(&"fliks-pre-migration-v123-a.sql".into()));
        }
        assert_eq!(
            names(&dir),
            [
                "fliks-pre-migration-v123-a.sql",
                "fliks-pre-migration-v123-d.sql",
                "fliks-pre-migration-v123-e.sql",
                "fliks-pre-migration-v123-f.sql",
            ]
        );
        // A newer version moves the exception: v123-a goes, v124-a stays.
        put(&dir, "fliks-pre-migration-v124-a.sql", 100);
        for (i, stamp) in ["b", "c", "d"].into_iter().enumerate() {
            put(
                &dir,
                &format!("fliks-pre-migration-v124-{stamp}.sql"),
                90 - i as u64 * 10,
            );
        }
        prune(&dir, 3, &[".sql"]).await.unwrap();
        assert_eq!(
            names(&dir),
            [
                "fliks-pre-migration-v124-a.sql",
                "fliks-pre-migration-v124-b.sql",
                "fliks-pre-migration-v124-c.sql",
                "fliks-pre-migration-v124-d.sql",
            ]
        );
        // keep = 0 still spares it.
        assert_eq!(prune(&dir, 0, &[".sql"]).await.unwrap(), 3);
        assert_eq!(names(&dir), ["fliks-pre-migration-v124-a.sql"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn prune_leaves_manual_backups_as_before() {
        let dir = scratch("manual");
        for i in 0..5u64 {
            put(&dir, &format!("fliks-backup-{i}.sql"), 500 - i * 100);
        }
        assert_eq!(prune(&dir, 3, &[".sql"]).await.unwrap(), 2);
        assert_eq!(
            names(&dir),
            [
                "fliks-backup-2.sql",
                "fliks-backup-3.sql",
                "fliks-backup-4.sql"
            ]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn version_is_read_from_pre_migration_names_only() {
        assert_eq!(
            version_of("fliks-pre-migration-v123-2026-10-16T02-00-00-123Z.sql"),
            Some("123")
        );
        for bad in [
            "fliks-backup-2026-10-16T02-00-00-123Z.sql",
            "fliks-pre-migration-v-x.sql",
            "fliks-pre-migration-vx1-x.sql",
            "fliks-pre-migration-v12.sql",
        ] {
            assert_eq!(version_of(bad), None, "{bad}");
        }
    }

    #[test]
    fn names_follow_the_ascii_pattern() {
        for ok in [
            "a.sql",
            "..sql",
            "fliks-backup-2026-10-16T02-00-00-123Z.sql",
            "A_b.c-d.sql",
            "a.sql.sql",
            "fliks-backup-2026-10-16T02-00-00-123Z.dump",
            "a.sql.dump",
        ] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in [
            "", ".sql", ".dump", "é.dump", "a/b.dump", "a.dump\n", "a.DUMP", "é.sql", "a/b.sql",
            "a.sql\n", "a.SQL", "a.sql ", "a b.sql", "../a.sql", "a.sqlx", "a.dumps",
        ] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn js_string_matches_string_of_a_json_value() {
        let j = |s: &str| serde_json::from_str::<Value>(s).unwrap();
        assert_eq!(js_string(None), "undefined");
        assert_eq!(js_string(Some(&j("null"))), "null");
        assert_eq!(js_string(Some(&j("12"))), "12");
        assert_eq!(js_string(Some(&j("true"))), "true");
        assert_eq!(js_string(Some(&j(r#"["a.sql","b"]"#))), "a.sql,b");
        assert_eq!(js_string(Some(&j("[null,1]"))), ",1");
        assert_eq!(js_string(Some(&j("{}"))), "[object Object]");
    }
}
