//! Database backups (`docs/spec/system.md` rules 14-25): `pg_dump` to a file, `psql` replay.
use crate::{config::Config, db, http::AppError, jobs, paths};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::PgPool;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};

/// The `Backup` job keeps this many (rule 20).
pub const KEEP: usize = 7;

pub fn dir() -> PathBuf {
    let dir = paths::data_dir().join("backups");
    std::path::absolute(&dir).unwrap_or(dir)
}

#[derive(Debug, Serialize)]
pub struct Made {
    pub filename: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct Entry {
    pub filename: String,
    pub size: u64,
    pub date: String,
}

fn internal(msg: impl Into<String>) -> AppError {
    AppError::internal(msg.into())
}

/// `^[A-Za-z0-9_.-]+\.sql$` over ASCII, so no separator or NUL can pass (rule 15).
pub fn valid_name(name: &str) -> bool {
    name.strip_suffix(".sql").is_some_and(|stem| {
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

fn conn_args(cfg: &Config) -> Vec<String> {
    let db = &cfg.db;
    vec![
        "-h".into(),
        db.get_host().into(),
        "-p".into(),
        db.get_port().to_string(),
        "-U".into(),
        db.get_username().into(),
        "-d".into(),
        db.get_database().unwrap_or_default().into(),
    ]
}

/// Rule 18: no shell, the password in `PGPASSWORD`, stderr captured, the last stderr line as the message.
async fn run_tool(cfg: &Config, cmd: &str, args: &[String], stdout: Stdio) -> Result<(), AppError> {
    let child = Command::new(cmd)
        .args(args)
        .env("PGPASSWORD", cfg.db_password.expose())
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                internal(format!("{cmd} is not available on this server"))
            }
            _ => internal(format!("{cmd} failed: {e}")),
        })?;
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| internal(format!("{cmd} failed: {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let code = out
        .status
        .code()
        .map_or_else(|| "a signal".to_owned(), |c| c.to_string());
    tracing::error!("{cmd} exited with {code}: {}", stderr.trim_end());
    let last = stderr.lines().rev().find(|l| !l.trim().is_empty());
    Err(internal(last.map_or_else(
        || format!("{cmd} exited with code {code}"),
        |l| l.trim().to_owned(),
    )))
}

/// Rule 17.
pub async fn create(cfg: &Config, dir: &Path) -> Result<Made, AppError> {
    let stamp = Utc::now()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
        .replace([':', '.'], "-");
    let filename = format!("fliks-backup-{stamp}.sql");
    tracing::info!("Creating backup: {filename}");
    mkdir_private(dir).map_err(|e| internal(format!("cannot create the backup directory: {e}")))?;
    let path = dir.join(&filename);
    let file =
        create_private(&path).map_err(|e| internal(format!("cannot write the backup: {e}")))?;
    let mut args = conn_args(cfg);
    args.extend(["--clean", "--if-exists", "--no-owner", "--no-privileges"].map(String::from));
    if let Err(e) = run_tool(cfg, "pg_dump", &args, file.into()).await {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(e);
    }
    let size = tokio::fs::metadata(&path)
        .await
        .map_err(|e| internal(e.to_string()))?
        .len();
    tracing::info!("Backup created: {filename} ({size} bytes)");
    Ok(Made { filename, size })
}

/// F38: a `0700` directory (when created here) and `0600` files.
fn mkdir_private(dir: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)
}

fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(path)
}

/// Rule 14: newest first by `date`, then `filename` descending.
pub async fn list(dir: &Path) -> Vec<Entry> {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return vec![];
    };
    let mut out = vec![];
    while let Ok(Some(e)) = rd.next_entry().await {
        let filename = e.file_name().to_string_lossy().into_owned();
        let Ok(meta) = e.metadata().await else {
            continue;
        };
        if !filename.ends_with(".sql") || !meta.is_file() {
            continue;
        }
        let date = meta.modified().map_or_else(
            |_| String::new(),
            |t| chrono::DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Millis, true),
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

/// Rule 20: delete all but the newest `keep`; returns how many went.
pub async fn prune(dir: &Path, keep: usize) -> std::io::Result<usize> {
    let old = list(dir).await.into_iter().skip(keep);
    let mut n = 0;
    for e in old {
        tokio::fs::remove_file(dir.join(&e.filename)).await?;
        tracing::info!("Backup deleted: {}", e.filename);
        n += 1;
    }
    Ok(n)
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
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|e| {
                if e.is_null() {
                    String::new()
                } else {
                    js_string(Some(e))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(other) => other.to_string(),
    }
}

/// `^GRANT .+ TO (plugin_[a-z0-9_]{1,56});$`: the only guard of the role statement (rule 23).
fn plugin_role(line: &str) -> Option<&str> {
    let body = line.strip_prefix("GRANT ")?.strip_suffix(';')?;
    let (head, role) = body.rsplit_once(" TO ")?;
    let tail = role.strip_prefix("plugin_")?;
    let ok = (1..=56).contains(&tail.len())
        && tail
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    (!head.is_empty() && ok).then_some(role)
}

/// F37 and rule 23 in one pass: refuses a psql meta-command outside a COPY block, collects the plugin roles.
async fn screen(path: &Path) -> Result<BTreeSet<String>, AppError> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| internal(e.to_string()))?;
    let mut lines = BufReader::new(file).split(b'\n');
    let (mut roles, mut in_copy) = (BTreeSet::new(), false);
    while let Some(raw) = lines
        .next_segment()
        .await
        .map_err(|e| internal(e.to_string()))?
    {
        let line = String::from_utf8_lossy(&raw);
        let line = line.strip_suffix('\r').unwrap_or(&line);
        if in_copy {
            in_copy = line != "\\.";
        } else if line.starts_with('\\') {
            let key = line
                .strip_prefix("\\restrict ")
                .or_else(|| line.strip_prefix("\\unrestrict "));
            if line != "\\."
                && !key.is_some_and(|k| !k.is_empty() && !k.contains(char::is_whitespace))
            {
                return Err(AppError::bad_request("Backup contains psql meta-commands"));
            }
        } else if line.starts_with("COPY ") && line.ends_with(" FROM stdin;") {
            in_copy = true;
        } else if let Some(role) = plugin_role(line) {
            roles.insert(role.to_owned());
        }
    }
    Ok(roles)
}

fn create_roles_sql(roles: &BTreeSet<String>) -> String {
    let each: Vec<String> = roles
        .iter()
        .map(|r| {
            format!(
                "IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{r}') THEN CREATE ROLE \"{r}\" LOGIN; END IF;"
            )
        })
        .collect();
    format!("DO $$ BEGIN {} END $$", each.join(" "))
}

/// Rules 22-25. `name` is already validated and located.
pub async fn restore(cfg: &Config, db: &PgPool, path: &Path, name: &str) -> Result<(), AppError> {
    if jobs::any_active(db).await? {
        return Err(AppError::conflict("A command is running"));
    }
    tracing::warn!("Restoring backup: {name}");
    let roles = screen(path).await?;
    if !roles.is_empty() {
        let mut args = conn_args(cfg);
        args.extend(["-v", "ON_ERROR_STOP=1", "-c"].map(String::from));
        args.push(create_roles_sql(&roles));
        run_tool(cfg, "psql", &args, Stdio::null()).await?;
    }
    let mut args = vec!["-X".to_owned()];
    args.extend(conn_args(cfg));
    args.extend(["--single-transaction", "-v", "ON_ERROR_STOP=1", "-f"].map(String::from));
    args.push(path.to_string_lossy().into_owned());
    run_tool(cfg, "psql", &args, Stdio::null()).await?;
    tracing::info!("Backup restored: {name}");
    db::migrate(db).await.map_err(|e| internal(e.to_string()))?;
    jobs::sweep(db).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_ascii_pattern() {
        for ok in [
            "a.sql",
            "..sql",
            "fliks-backup-2026-10-16T02-00-00-123Z.sql",
            "A_b.c-d.sql",
            "a.sql.sql",
        ] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in [
            "", ".sql", "é.sql", "a/b.sql", "a.sql\n", "a.SQL", "a.sql ", "a b.sql", "../a.sql",
            "a.sqlx",
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

    #[test]
    fn plugin_roles_are_matched_tightly() {
        assert_eq!(
            plugin_role("GRANT SELECT ON x TO plugin_a1;"),
            Some("plugin_a1")
        );
        for bad in [
            "GRANT SELECT ON x TO plugin_;",
            "GRANT SELECT ON x TO plugin_A;",
            "GRANT SELECT ON x TO plugin_a;--",
            "GRANT  TO plugin_a;",
            "grant select on x to plugin_a;",
            "GRANT SELECT ON x TO plugin_a b;",
            "GRANT SELECT ON x TO plugin_a\";DROP;",
        ] {
            assert_eq!(plugin_role(bad), None, "{bad}");
        }
        let long = format!("GRANT a TO plugin_{};", "x".repeat(57));
        assert_eq!(plugin_role(&long), None);
    }

    #[tokio::test]
    async fn screening_refuses_meta_commands_outside_copy_blocks() {
        let dir = std::env::temp_dir().join(format!("fliks-screen-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let n = std::sync::atomic::AtomicUsize::new(0);
        let check = |body: &'static str| {
            let p = dir.join(format!(
                "{}.sql",
                n.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            async move {
                tokio::fs::write(&p, body).await.unwrap();
                screen(&p).await
            }
        };
        let ok = check("\\restrict abc123\nCOPY t (a) FROM stdin;\n\\! ls\n\\.\nGRANT x ON y TO plugin_p;\n\\unrestrict abc123\n").await;
        assert_eq!(ok.unwrap().into_iter().collect::<Vec<_>>(), ["plugin_p"]);
        for bad in [
            "\\! ls\n",
            "SELECT 1;\n\\i /etc/passwd\n",
            "\\copy t to program 'x'\n",
            "COPY t FROM stdin;\n\\.\n\\!x\n",
            "\\restrict\n",
        ] {
            assert!(check(bad).await.is_err(), "{bad:?}");
        }
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
