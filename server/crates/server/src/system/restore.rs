//! Restore (`docs/spec/system.md` rules 22-25, 36-40): the core pass runs as the core login, every plugin
//! schema as that plugin's own login, so no plugin object ever executes in a core session.
use super::backup::{
    PARTIAL, ToolFail, conn_args, conn_args_as, create_private, exec, internal, mkdir_private,
    run_tool,
};
use crate::{
    config::Config,
    db,
    http::AppError,
    jobs,
    plugins::{Plugins, db as plugin_db, packages},
};
use serde::Serialize;
use sqlx::PgPool;
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};
use tokio::io::{AsyncBufReadExt, BufReader};

/// A plugin whose data the restore could not bring back (rule 38).
#[derive(Debug, Serialize, PartialEq)]
pub struct NotRestored {
    pub schema: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub plugins_not_restored: Vec<NotRestored>,
    /// The process is about to restart: the supervisor starts the restored database's host.
    pub restarting: bool,
}

/// Rule 23: the dump of earlier builds names plugin roles and schemas; a role grant is the only line
/// that names a role.
fn plugin_role(line: &str) -> Option<&str> {
    let body = line.strip_prefix("GRANT ")?.strip_suffix(';')?;
    let (head, role) = body.rsplit_once(" TO ")?;
    let tail_ok = |t: &str, max: usize| {
        (1..=max).contains(&t.len())
            && t.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    };
    let ok = match (role.strip_prefix("plugin_"), role.strip_prefix("fp_")) {
        (Some(t), _) => tail_ok(t, 56),
        (_, Some(r)) => {
            r.get(..9).is_some_and(|h| {
                h.ends_with('_')
                    && h[..8]
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }) && tail_ok(&r[9..], 51)
        }
        _ => false,
    };
    (!head.is_empty() && ok).then_some(role)
}

#[derive(Debug, Default)]
struct Scan {
    /// The file creates a plugin schema or grants to a plugin role.
    plugin_data: bool,
}

enum Copy {
    Other,
    /// `COPY public._sqlx_migrations`, the index of its `version` column.
    Versions(usize),
}

/// `COPY public._sqlx_migrations (version, ...) FROM stdin;`
fn versions_column(line: &str) -> Option<usize> {
    let rest = line.strip_prefix("COPY public._sqlx_migrations")?;
    let Some(cols) = rest.strip_prefix(" (") else {
        return rest.starts_with(" FROM ").then_some(0);
    };
    cols.split_once(')')?
        .0
        .split(", ")
        .position(|c| c == "version")
}

/// Rule 24 in one pass: refuses a line-start psql meta-command outside a COPY block (best effort, no
/// SQL lexing), a migration this build does not know (rule 39), and reports plugin data.
async fn screen(path: &Path) -> Result<Scan, AppError> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| internal(e.to_string()))?;
    let mut lines = BufReader::new(file).split(b'\n');
    let (mut scan, mut copy) = (Scan::default(), None);
    while let Some(raw) = lines
        .next_segment()
        .await
        .map_err(|e| internal(e.to_string()))?
    {
        let line = String::from_utf8_lossy(&raw);
        let line = line.strip_suffix('\r').unwrap_or(&line);
        if let Some(c) = &copy {
            if line == "\\." {
                copy = None;
            } else if let Copy::Versions(col) = c {
                let v = line
                    .split('\t')
                    .nth(*col)
                    .and_then(|v| v.parse::<i64>().ok());
                if let Some(v) = v.filter(|v| !db::known_version(*v)) {
                    return Err(AppError::bad_request(format!(
                        "This backup comes from a newer Fliks (migration {v} is unknown to this version)"
                    )));
                }
            }
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
            copy = Some(versions_column(line).map_or(Copy::Other, Copy::Versions));
        } else if line.starts_with("CREATE SCHEMA plugin_") || plugin_role(line).is_some() {
            scan.plugin_data = true;
        }
    }
    Ok(scan)
}

/// Rule 24: in the replay's transaction, drops `public` and every plugin schema so a dump older
/// than the database restores into an empty schema.
const CLEAN_SCHEMAS: &str = r"DO $$ DECLARE s text; BEGIN
FOR s IN SELECT nspname FROM pg_namespace WHERE nspname = 'public' OR nspname LIKE 'plugin\_%' LOOP
EXECUTE format('DROP SCHEMA %I CASCADE', s);
END LOOP;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO PUBLIC;
END $$";

/// The core login replays `script` (rule 24).
async fn replay(cfg: &Config, script: &Path) -> Result<(), AppError> {
    let mut args = vec!["-X".to_owned()];
    args.extend(conn_args(cfg));
    args.extend(["--single-transaction", "-v", "ON_ERROR_STOP=1", "-c"].map(String::from));
    args.extend([CLEAN_SCHEMAS.to_owned(), "-f".to_owned()]);
    args.push(script.to_string_lossy().into_owned());
    run_tool(cfg, "psql", &args, Stdio::null()).await
}

/// What follows the three numbers of a `pg_restore -l` line (`123; 2615 16393 SCHEMA - plugin_x owner`).
fn after_ids(line: &str) -> Option<&str> {
    let (a, rest) = line.split_once("; ")?;
    let (b, rest) = rest.split_once(' ')?;
    let (c, rest) = rest.split_once(' ')?;
    [a, b, c]
        .iter()
        .all(|n| !n.is_empty() && n.bytes().all(|x| x.is_ascii_digit()))
        .then_some(rest)
}

/// `^\d+; \d+ \d+ SCHEMA - (plugin_[a-z0-9_]{1,56}) `. `pg_restore -l` puts a newline of an object name
/// on the same line, so a plugin cannot forge a second entry.
fn plugin_schemas(list: &str) -> Vec<String> {
    list.lines()
        .filter_map(after_ids)
        .filter_map(|r| r.strip_prefix("SCHEMA - "))
        .filter_map(|r| r.split_once(' ').map(|(n, _)| n))
        .filter(|n| {
            n.strip_prefix("plugin_").is_some_and(|t| {
                (1..=56).contains(&t.len())
                    && t.bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            })
        })
        .map(str::to_owned)
        .collect()
}

/// A cast has no schema, so no `-N`/`-n` filter reaches it: one naming a plugin type is dropped.
fn is_plugin_cast(line: &str) -> bool {
    after_ids(line).is_some_and(|r| {
        r.starts_with("CAST ") && (r.contains("(plugin_") || r.contains(" AS plugin_"))
    })
}

fn is_fk_of(line: &str, schema: &str) -> bool {
    after_ids(line)
        .and_then(|r| r.strip_prefix("FK CONSTRAINT "))
        .is_some_and(|r| r.strip_prefix(schema).is_some_and(|t| t.starts_with(' ')))
}

/// The restore list of a pass: the archive's list without plugin casts and without the lines `skip` holds back.
fn restore_list(list: &str, skip: impl Fn(&str) -> bool) -> String {
    list.lines()
        .filter(|l| !is_plugin_cast(l) && !skip(l))
        .fold(String::new(), |mut out, l| {
            out.push_str(l);
            out.push('\n');
            out
        })
}

/// Private temporary files next to the backups, gone with the guard (`*.partial` is also swept at boot).
struct Scratch {
    dir: PathBuf,
    files: Vec<PathBuf>,
}

impl Scratch {
    fn new() -> Result<Self, AppError> {
        let dir = super::backup::dir();
        mkdir_private(&dir)
            .map_err(|e| internal(format!("cannot create the backup directory: {e}")))?;
        Ok(Self { dir, files: vec![] })
    }

    fn file(&mut self, name: &str, text: Option<&str>) -> Result<PathBuf, AppError> {
        let p = self.dir.join(format!(
            ".restore-{}-{name}{PARTIAL}",
            crate::config::random_hex(6)
        ));
        let mut f =
            create_private(&p).map_err(|e| internal(format!("cannot write {name}: {e}")))?;
        if let Some(t) = text {
            f.write_all(t.as_bytes())
                .map_err(|e| internal(format!("cannot write {name}: {e}")))?;
        }
        self.files.push(p.clone());
        Ok(p)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        for f in &self.files {
            let _ = std::fs::remove_file(f);
        }
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn tool(f: ToolFail) -> AppError {
    internal(f.message)
}

/// The first `pg_restore: error:` line says what failed; the last line is often a `Command was:` or a detail.
fn why(f: ToolFail) -> String {
    f.stderr
        .lines()
        .find_map(|l| l.strip_prefix("pg_restore: error: "))
        .map_or(f.message, str::to_owned)
}

/// The archive's table of contents.
async fn toc(archive: &Path) -> Result<String, AppError> {
    let out = exec(
        "pg_restore",
        &["-l".to_owned(), s(archive)],
        "",
        Stdio::piped(),
    )
    .await
    .map_err(tool)?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// `plugin_<id with . as _>` back to the plugin id (ids never contain `_`).
fn plugin_id(schema: &str) -> Option<String> {
    Some(schema.strip_prefix("plugin_")?.replace('_', "."))
}

/// What every pass reads: the archive and its (cast-free) list of entries.
#[derive(Clone, Copy)]
struct Archive<'a> {
    cfg: &'a Config,
    db: &'a PgPool,
    path: &'a Path,
    list: &'a str,
}

/// One plugin schema, restored by its own login into the empty schema the core pass left. The caller
/// holds the per-id lock. A failed pass leaves the schema empty (one transaction), or is emptied.
async fn plugin_pass(
    a: Archive<'_>,
    schema: &str,
    id: &str,
    refs: &[String],
    scratch: &mut Scratch,
) -> Result<(), String> {
    let Archive {
        cfg,
        db,
        path: archive,
        list,
    } = a;
    let msg = |e: AppError| e.text();
    let password = plugin_db::provision(db, id, refs)
        .await
        .map_err(|e| e.message)?;
    let oid = plugin_db::database_oid(db)
        .await
        .map_err(|e| e.to_string())?;
    let role = plugin_db::role(&oid, id);
    let held: Vec<&str> = list.lines().filter(|l| is_fk_of(l, schema)).collect();
    let main = restore_list(list, |l| is_fk_of(l, schema));
    let main_list = scratch.file("main.list", Some(&main)).map_err(msg)?;
    let mut base = conn_args_as(cfg, &role);
    base.extend(["-n", schema, "--no-owner", "--no-privileges"].map(String::from));
    let mut args = base.clone();
    args.extend(["--single-transaction", "--exit-on-error", "-L"].map(String::from));
    args.extend([s(&main_list), s(archive)]);
    exec("pg_restore", &args, &password, Stdio::null())
        .await
        .map_err(why)?;
    // The foreign keys come last, one by one: a key into `public` cannot be created by a plugin and is dropped.
    for line in held {
        let one = scratch
            .file("fk.list", Some(&format!("{line}\n")))
            .map_err(msg)?;
        let mut show = vec!["-n".to_owned(), schema.to_owned(), "-L".to_owned(), s(&one)];
        show.extend(["-f".into(), "-".into(), s(archive)]);
        let ddl = exec("pg_restore", &show, "", Stdio::piped())
            .await
            .map_err(|f| f.message)?;
        if String::from_utf8_lossy(&ddl).contains(" REFERENCES public.") {
            tracing::warn!("restore: {schema}: a foreign key into public is not restored: {line}");
            continue;
        }
        let mut args = base.clone();
        args.extend(["--exit-on-error", "-L"].map(String::from));
        args.extend([s(&one), s(archive)]);
        if let Err(f) = exec("pg_restore", &args, &password, Stdio::null()).await {
            // The rows are in already: empty the schema so a failed plugin never keeps half a restore.
            let mut message = why(f);
            if let Err(e) = empty_schema(db, schema, id, refs).await {
                message.push_str(&format!(
                    "; the half-restored schema could not be emptied: {e}"
                ));
            }
            return Err(message);
        }
    }
    Ok(())
}

async fn empty_schema(db: &PgPool, schema: &str, id: &str, refs: &[String]) -> Result<(), String> {
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "DROP SCHEMA IF EXISTS {} CASCADE",
        plugin_db::quote(schema)
    )))
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    plugin_db::provision(db, id, refs)
        .await
        .map(drop)
        .map_err(|e| e.message)
}

/// A registered package with a schema the archive does not hold (the dump left it out): the replay
/// dropped its live schema, so the plugin stays disabled instead of booting on an empty one.
async fn missing_schemas(
    db: &PgPool,
    plugins: Option<&Plugins>,
    present: &[String],
) -> Result<Vec<NotRestored>, AppError> {
    let ids: Vec<String> = sqlx::query_scalar(
        r#"SELECT "pluginId" FROM plugin_packages WHERE manifest #>> '{database,schema}' = 'true'
            AND status = 'active' ORDER BY id"#,
    )
    .fetch_all(db)
    .await?;
    let mut out = vec![];
    for id in ids {
        let schema = plugin_db::schema(&id);
        if present.contains(&schema) {
            continue;
        }
        let _lock = match plugins {
            Some(p) => Some(p.lock(&id).await),
            None => None,
        };
        packages::set_enabled(db, &id, false).await?;
        let message = "the backup does not hold its schema (the server could not read it when the backup was made)";
        packages::set_status(db, &id, Some(&format!("restore-failed: {message}"))).await?;
        tracing::warn!("restore: {schema} not restored: {message}");
        out.push(NotRestored {
            schema,
            message: message.to_owned(),
        });
    }
    Ok(out)
}

/// Rule 38: every plugin schema of the archive, one after the other.
async fn plugin_passes(
    a: Archive<'_>,
    plugins: Option<&Plugins>,
    schemas: &[String],
    scratch: &mut Scratch,
) -> Result<Vec<NotRestored>, AppError> {
    let db = a.db;
    let mut failed = vec![];
    for schema in schemas {
        let Some(id) = plugin_id(schema) else {
            continue;
        };
        let _lock = match plugins {
            Some(p) => Some(p.lock(&id).await),
            None => None,
        };
        let manifest = packages::manifest(db, &id).await?;
        let refs = manifest
            .as_ref()
            .map(packages::core_refs)
            .unwrap_or_default();
        let done = plugin_pass(a, schema, &id, &refs, scratch).await;
        match (&done, &manifest) {
            (_, None) => plugin_db::keep_orphaned(db, &id).await?,
            (Err(m), Some(_)) => {
                packages::set_enabled(db, &id, false).await?;
                packages::set_status(db, &id, Some(&format!("restore-failed: {m}"))).await?;
            }
            _ => {}
        }
        if let Err(message) = done {
            tracing::warn!("restore: {schema} not restored: {message}");
            failed.push(NotRestored {
                schema: schema.clone(),
                message,
            });
        }
    }
    failed.extend(missing_schemas(db, plugins, schemas).await?);
    Ok(failed)
}

/// What `prepare` reads of a file before anything is stopped or replaced.
enum Plan {
    /// A plain SQL file of earlier builds.
    Plain,
    /// An archive: the core script, the plugin schemas it holds and its restore list.
    Archive {
        script: PathBuf,
        schemas: Vec<String>,
        list: String,
    },
}

struct Prepared {
    plan: Plan,
    scratch: Scratch,
}

/// Rules 22-24, 39: every refusal that needs no database (plugin data in a plain file, a meta-command,
/// a newer migration), so a refused file stops nothing.
async fn prepare(cfg: &Config, path: &Path) -> Result<Prepared, AppError> {
    let mut scratch = Scratch::new()?;
    if !path.extension().is_some_and(|e| e == "dump") {
        if screen(path).await?.plugin_data {
            return Err(AppError::conflict(
                "BACKUP_HAS_PLUGIN_DATA: this backup is a plain SQL file that holds plugin data, which \
                 would run as the database owner; restore a .dump backup instead",
            ));
        }
        return Ok(Prepared {
            plan: Plan::Plain,
            scratch,
        });
    }
    let list = toc(path).await?;
    let schemas = plugin_schemas(&list);
    let kept = restore_list(&list, |_| false);
    let (script, core_list) = (
        scratch.file("core.sql", None)?,
        scratch.file("core.list", Some(&kept))?,
    );
    let mut args = ["--no-owner", "--no-privileges", "--no-comments", "-L"]
        .map(String::from)
        .to_vec();
    args.extend([s(&core_list), "-f".to_owned(), s(&script)]);
    for schema in &schemas {
        args.extend(["-N".to_owned(), schema.clone()]);
    }
    args.push(s(path));
    run_tool(cfg, "pg_restore", &args, Stdio::null()).await?;
    screen(&script).await?;
    Ok(Prepared {
        plan: Plan::Archive {
            script,
            schemas,
            list: kept,
        },
        scratch,
    })
}

/// Rules 24 and 36-38 for a prepared file; `plugins` supplies the per-id locks (`None` offline).
async fn apply(
    cfg: &Config,
    db: &PgPool,
    path: &Path,
    plugins: Option<&Plugins>,
    prepared: Prepared,
) -> Result<Vec<NotRestored>, AppError> {
    let Prepared { plan, mut scratch } = prepared;
    match plan {
        Plan::Plain => {
            replay(cfg, path).await?;
            Ok(vec![])
        }
        Plan::Archive {
            script,
            schemas,
            list,
        } => {
            replay(cfg, &script).await?;
            plugin_passes(
                Archive {
                    cfg,
                    db,
                    path,
                    list: &list,
                },
                plugins,
                &schemas,
                &mut scratch,
            )
            .await
        }
    }
}

/// The sqlx migrations of this build, then the stale-state sweep: an older dump gets today's schema.
async fn settle(db: &PgPool) -> Result<(), AppError> {
    db::migrate(db).await.map_err(|e| internal(e.to_string()))?;
    jobs::sweep(db).await?;
    Ok(())
}

/// Rules 22-25. `name` is already validated and located; `supervised` restarts the process on success.
pub async fn restore(
    cfg: &Config,
    db: &PgPool,
    running: &Arc<jobs::Running>,
    plugins: &Arc<Plugins>,
    path: &Path,
    name: &str,
    supervised: bool,
) -> Result<Outcome, AppError> {
    let busy = || AppError::conflict("A command is running");
    let _claim = running.claim(jobs::RESTORE).ok_or_else(busy)?;
    if jobs::any_active(db).await? {
        return Err(busy());
    }
    let prepared = prepare(cfg, path).await?;
    tracing::warn!("Restoring backup: {name}");
    plugins.stop_all().await;
    let done = apply(cfg, db, path, Some(plugins), prepared).await;
    let done = match done {
        Ok(failed) => {
            tracing::info!("Backup restored: {name}");
            settle(db).await.map(|()| failed)
        }
        Err(e) => Err(e),
    };
    let restarting = supervised && done.is_ok();
    if !restarting {
        plugins.boot().await;
    }
    done.map(|plugins_not_restored| Outcome {
        plugins_not_restored,
        restarting,
    })
}

/// `fliks-server restore <file>`: the same passes with the server stopped. It never migrates, so
/// an older image still boots after a rollback; the next boot of whichever image does.
pub async fn offline(cfg: &Config, db: &PgPool, path: &Path) -> Result<Vec<NotRestored>, AppError> {
    let prepared = prepare(cfg, path).await?;
    tracing::warn!("Restoring backup: {}", path.display());
    let failed = apply(cfg, db, path, None, prepared).await?;
    tracing::info!("Backup restored: {}", path.display());
    Ok(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(
            plugin_role("GRANT USAGE ON SCHEMA public TO fp_0000a1b2_fliks_notify;"),
            Some("fp_0000a1b2_fliks_notify")
        );
        for bad in [
            "GRANT a TO fp_0000a1b_x;",
            "GRANT a TO fp_0000A1B2_x;",
            "GRANT a TO fp_0000a1b2_;",
        ] {
            assert_eq!(plugin_role(bad), None, "{bad}");
        }
        assert_eq!(
            plugin_role(&format!("GRANT a TO fp_0000a1b2_{};", "x".repeat(52))),
            None
        );
    }

    async fn screened(dir: &Path, n: usize, body: &str) -> Result<Scan, AppError> {
        let p = dir.join(format!("{n}.sql"));
        tokio::fs::write(&p, body).await.unwrap();
        screen(&p).await
    }

    #[tokio::test]
    async fn screening_refuses_meta_commands_outside_copy_blocks() {
        let dir = std::env::temp_dir().join(format!("fliks-screen-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let ok = screened(&dir, 0, "\\restrict abc123\nCOPY t (a) FROM stdin;\n\\! ls\n\\.\nGRANT x ON y TO plugin_p;\n\\unrestrict abc123\n").await;
        assert!(ok.unwrap().plugin_data);
        let plain = screened(
            &dir,
            1,
            "CREATE TABLE t (a int);\nGRANT x ON y TO public;\n",
        )
        .await;
        assert!(!plain.unwrap().plugin_data);
        let schema = screened(&dir, 2, "CREATE SCHEMA plugin_x;\n").await;
        assert!(schema.unwrap().plugin_data);
        for (i, bad) in [
            "\\! ls\n",
            "SELECT 1;\n\\i /etc/passwd\n",
            "\\copy t to program 'x'\n",
            "COPY t FROM stdin;\n\\.\n\\!x\n",
            "\\restrict\n",
        ]
        .into_iter()
        .enumerate()
        {
            assert!(screened(&dir, 10 + i, bad).await.is_err(), "{bad:?}");
        }
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn screening_refuses_a_migration_this_build_does_not_know() {
        let dir = std::env::temp_dir().join(format!("fliks-screen-v-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let first = sqlx::migrate!("../../migrations").migrations[0].version;
        let rows = |v: &str| {
            format!(
                "COPY public._sqlx_migrations (version, description, success) FROM stdin;\n\
                 {first}\tinit\tt\n{v}\tlater\tt\n\\.\n"
            )
        };
        let newer = screened(&dir, 0, &rows("99999999999999")).await;
        assert!(newer.unwrap_err().text().contains("newer Fliks"));
        assert!(screened(&dir, 1, &rows(&first.to_string())).await.is_ok());
        // Another table's first column is not a version.
        let other = screened(
            &dir,
            2,
            "COPY public.t (a) FROM stdin;\n99999999999999\n\\.\n",
        )
        .await;
        assert!(other.is_ok());
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[test]
    fn the_versions_column_is_read_from_the_header() {
        assert_eq!(
            versions_column("COPY public._sqlx_migrations (version, description) FROM stdin;"),
            Some(0)
        );
        assert_eq!(
            versions_column("COPY public._sqlx_migrations (description, version) FROM stdin;"),
            Some(1)
        );
        assert_eq!(
            versions_column("COPY public._sqlx_migrations FROM stdin;"),
            Some(0)
        );
        assert_eq!(
            versions_column("COPY public.items (version) FROM stdin;"),
            None
        );
    }

    const LIST: &str = "\
;
; Archive created at 2026-11-22
2615; 2615 16393 SCHEMA - plugin_acme_thing fliks
2616; 2615 16394 SCHEMA - public pg_database_owner
2617; 2615 16395 SCHEMA - plugin_a-b fliks
2618; 2615 16396 SCHEMA - plugin_EVIL fliks
2619; 2615 16397 SCHEMA - plugin_ x
5; 1259 20 TABLE plugin_a t 1; 2 3 SCHEMA - plugin_forged o fliks
6; 2606 21 FK CONSTRAINT plugin_a t t_m_fkey fliks
7; 2606 22 FK CONSTRAINT plugin_ab t t_m_fkey fliks
8; 2605 23 CAST pg_catalog CAST (plugin_a.t AS integer)
9; 2605 24 CAST pg_catalog CAST (public.m AS integer)
10; 2605 25 CAST pg_catalog CAST (plugin_a.\"t 1; 2 3 SCHEMA - plugin_zz\" AS integer)
11; 2605 26 CAST pg_catalog CAST (text AS public.plugin_packages_status_enum)
12; 2605 27 CAST pg_catalog CAST (integer AS plugin_a.t)
";

    #[test]
    fn plugin_schemas_come_from_schema_lines_only() {
        assert_eq!(plugin_schemas(LIST), ["plugin_acme_thing"]);
    }

    #[test]
    fn plugin_casts_and_held_back_keys_leave_the_list() {
        let kept = restore_list(LIST, |l| is_fk_of(l, "plugin_a"));
        assert!(kept.contains("CAST (public.m AS integer)"));
        assert!(!kept.contains("plugin_a.t AS integer"));
        assert!(!kept.contains("AS plugin_a.t"));
        assert!(kept.contains("AS public.plugin_packages_status_enum"));
        assert!(!kept.contains("plugin_zz"));
        assert!(!kept.contains("FK CONSTRAINT plugin_a t"));
        // plugin_ab is another schema: its key stays.
        assert!(kept.contains("FK CONSTRAINT plugin_ab"));
    }

    #[test]
    fn plugin_ids_come_back_from_their_schema() {
        assert_eq!(
            plugin_id("plugin_acme_thing").as_deref(),
            Some("acme.thing")
        );
    }
}
