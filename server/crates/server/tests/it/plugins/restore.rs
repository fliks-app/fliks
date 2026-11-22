//! Restore of plugin schemas under their own logins (`system.md` rules 36-38, design tests 5-7).
//! Need `pg_dump`, `pg_restore` and `psql` of the server's major version on `PATH`.
use super::harness::*;
use crate::fakes::skip;
use fliks_server::plugins::runtime::{HttpRequest, Principal};
use fliks_server::system::{backup, restore};
use serde_json::Value;
use std::{path::PathBuf, process::Command, time::Duration};

const SCHEMA: &str = "plugin_fliks_fixture";

fn tools() -> bool {
    let all = ["pg_dump", "pg_restore", "psql"]
        .iter()
        .all(|t| Command::new(t).arg("--version").output().is_ok());
    if !all {
        skip("pg_dump, pg_restore or psql missing");
    }
    all
}

async fn script(h: &H, sql: &str, name: &str) {
    let rt = h.st.plugins.rt("fliks.fixture").expect("running");
    let req = HttpRequest {
        method: "POST".into(),
        path: "/test/db/script".into(),
        query: vec![("name".into(), name.into())],
        body: sql.as_bytes().to_vec(),
        principal: Principal::Delegated(1),
    };
    let r = rt.http(req, false).await.unwrap();
    let made: Value = serde_json::from_slice(&r.body).unwrap();
    assert!(made.get("error").is_none(), "{made}");
}

async fn install(tag: &str) -> Option<(Scratch, H)> {
    let (m, w) = fixture()?;
    let s = Scratch::create(tag).await?;
    let h = harness(&s, tag, |_| {}).await;
    allow_unsigned(&h).await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    Some((s, h))
}

const SETUP: &str = r#"
CREATE FUNCTION guard() RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'escaped as %', current_user;
  END IF;
  RETURN true; END $$;
CREATE FUNCTION chk() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('fliks.break', true), '') <> 'on' $$;
CREATE FUNCTION sd() RETURNS text LANGUAGE sql SECURITY DEFINER AS $$ SELECT current_user::text $$;
CREATE DOMAIN d AS int CHECK (guard());
CREATE TABLE t (id int PRIMARY KEY, a boolean DEFAULT guard(), b d, c int CHECK (guard()));
CREATE INDEX t_idx ON t ((guard()));
CREATE TABLE t2 (id int PRIMARY KEY, t_id int REFERENCES t (id), m int);
CREATE TABLE t3 (v int CHECK (chk()));
INSERT INTO t (id, b, c) VALUES (1, 2, 3), (2, 5, 6);
INSERT INTO t2 VALUES (1, 1, NULL);
INSERT INTO t3 VALUES (7);
"#;

fn path(name: &str) -> PathBuf {
    backup::dir().join(name)
}

/// A pool on the plugin's own login: a core session would run the plugin's `guard()` and fail by design.
async fn as_plugin(s: &Scratch) -> sqlx::PgPool {
    let opts = fliks_server::plugins::db::login(&s.pool, "fliks.fixture")
        .await
        .unwrap();
    sqlx::PgPool::connect_with(opts).await.unwrap()
}

/// Rows of a plugin table, read on the plugin's login.
async fn plugin_rows(s: &Scratch, table: &str) -> i64 {
    let own = as_plugin(s).await;
    let n = rows(&own, &format!("SELECT count(*) FROM {table}")).await;
    own.close().await;
    n
}

async fn restored(h: &H, s: &Scratch, name: &str) -> restore::Outcome {
    let cfg = config_for(&s.url, &s.name);
    let out = restore::restore(
        &cfg,
        &s.pool,
        &h.st.jobs,
        &h.st.plugins,
        &path(name),
        name,
        false,
    )
    .await
    .unwrap_or_else(|e| panic!("{e}"));
    if out.plugins_not_restored.is_empty() {
        until(
            "plugin registered again",
            Duration::from_secs(60),
            async || h.st.plugins.state_of("fliks.fixture").is_some(),
        )
        .await;
    }
    out
}

async fn rows(pool: &sqlx::PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Objects of the plugin schema not owned by `role`.
async fn foreign_owned(pool: &sqlx::PgPool, role: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = $1 AND pg_get_userbyid(c.relowner)::text <> $2)
              + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = $1 AND pg_get_userbyid(p.proowner)::text <> $2)
              + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = $1 AND pg_get_userbyid(t.typowner)::text <> $2)",
    )
    .bind(SCHEMA)
    .bind(role)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn plugin_schemas_restore_under_their_own_logins() {
    if !tools() {
        return;
    }
    let Some((s, h)) = install("rstr").await else {
        return;
    };
    let cfg = config_for(&s.url, &s.name);
    script(&h, SETUP, "0100_setup").await;
    let users = rows(&s.pool, "SELECT count(*) FROM public.users").await;
    // A large object survives the replay's schema drops: the archive must not carry it.
    sqlx::query("SELECT lo_create(0)")
        .execute(&s.pool)
        .await
        .unwrap();
    let made = backup::create(&cfg, &s.pool, &backup::dir()).await.unwrap();
    assert!(made.plugins_skipped.is_empty());
    let own = as_plugin(&s).await;
    sqlx::raw_sql("DELETE FROM t2; DELETE FROM t; DROP FUNCTION sd()")
        .execute(&own)
        .await
        .unwrap();
    own.close().await;

    // Design test 5: rows back, every object owned and every check run by the plugin login.
    let out = restored(&h, &s, &made.filename).await;
    assert!(out.plugins_not_restored.is_empty(), "{out:?}");
    let role = fliks_server::plugins::db::role(&s.oid().await, "fliks.fixture");
    assert_eq!(plugin_rows(&s, "t").await, 2);
    assert_eq!(plugin_rows(&s, "t2").await, 1);
    let sd: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT {SCHEMA}.sd()")))
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(sd, role, "a SECURITY DEFINER routine runs as the plugin");
    assert_eq!(foreign_owned(&s.pool, &role).await, 0);
    assert_eq!(
        rows(&s.pool, "SELECT count(*) FROM public.users").await,
        users
    );
    let schema_owner: String = sqlx::query_scalar(
        "SELECT pg_get_userbyid(nspowner)::text FROM pg_namespace WHERE nspname = $1",
    )
    .bind(SCHEMA)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(schema_owner, role);

    // Design test 6: the same archive into a second database (new OID).
    let Some(b) = Scratch::create("rstrb").await else {
        return h.finish().await;
    };
    let failed = restore::offline(&config_for(&b.url, &b.name), &b.pool, &path(&made.filename))
        .await
        .unwrap();
    assert!(failed.is_empty(), "{failed:?}");
    let role_b = fliks_server::plugins::db::role(&b.oid().await, "fliks.fixture");
    assert_ne!(role, role_b);
    let own_b = fliks_server::plugins::db::login(&b.pool, "fliks.fixture")
        .await
        .unwrap();
    let own_b = sqlx::PgPool::connect_with(own_b).await.unwrap();
    assert_eq!(rows(&own_b, "SELECT count(*) FROM t").await, 2);
    own_b.close().await;
    let sd_b: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT {SCHEMA}.sd()")))
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(sd_b, role_b);
    assert_eq!(foreign_owned(&b.pool, &role_b).await, 0);
    b.finish().await;

    // A plugin cast is not restored; a foreign key into `public` of an older dump is skipped, the
    // others stay.
    script(
        &h,
        r"CREATE TYPE ty AS (a int);
          CREATE FUNCTION int_of(ty) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT ($1).a $$;
          CREATE CAST (ty AS int) WITH FUNCTION int_of(ty);",
        "0200_cast",
    )
    .await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "ALTER TABLE {SCHEMA}.t2 ADD CONSTRAINT t2_m_fkey FOREIGN KEY (m) REFERENCES public.media (id)"
    )))
    .execute(&s.pool)
    .await
    .unwrap();
    let old = backup::create(&cfg, &s.pool, &backup::dir()).await.unwrap();
    let out = restored(&h, &s, &old.filename).await;
    assert!(out.plugins_not_restored.is_empty(), "{out:?}");
    let casts = rows(
        &s.pool,
        &format!(
            "SELECT count(*) FROM pg_cast c JOIN pg_type t ON t.oid = c.castsource
              JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = '{SCHEMA}'"
        ),
    )
    .await;
    assert_eq!(casts, 0, "a plugin cast is dropped");
    let fks: Vec<String> = sqlx::query_scalar(
        "SELECT conname::text FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE con.contype = 'f' AND n.nspname = $1 ORDER BY conname",
    )
    .bind(SCHEMA)
    .fetch_all(&s.pool)
    .await
    .unwrap();
    assert_eq!(fks, ["t2_t_id_fkey"], "the key into public is skipped");
    assert_eq!(plugin_rows(&s, "t").await, 2);

    // A refused file stops nothing: the same plugin host is still running after the 409.
    until("plugin running", Duration::from_secs(60), async || {
        h.st.plugins.rt("fliks.fixture").is_some()
    })
    .await;
    let before = h.st.plugins.rt("fliks.fixture").expect("running");
    let plain = legacy_sql(&s, "refused.sql");
    let err = restore::restore(
        &cfg,
        &s.pool,
        &h.st.jobs,
        &h.st.plugins,
        &plain,
        "refused.sql",
        false,
    )
    .await
    .unwrap_err();
    assert_eq!(err.status(), 409, "{err}");
    let after = h.st.plugins.rt("fliks.fixture").expect("still running");
    assert!(std::sync::Arc::ptr_eq(&before, &after));

    // A dump taken before this build's columns of `plugin_packages` restores its plugin schema.
    sqlx::raw_sql(r#"ALTER TABLE plugin_packages DROP COLUMN "heldUpdate""#)
        .execute(&s.pool)
        .await
        .unwrap();
    let early = backup::create(&cfg, &s.pool, &backup::dir()).await.unwrap();
    sqlx::raw_sql(r#"ALTER TABLE plugin_packages ADD COLUMN "heldUpdate" jsonb"#)
        .execute(&s.pool)
        .await
        .unwrap();
    let Some(c) = Scratch::create("rstrold").await else {
        return h.finish().await;
    };
    let failed = restore::offline(
        &config_for(&c.url, &c.name),
        &c.pool,
        &path(&early.filename),
    )
    .await
    .unwrap();
    assert!(failed.is_empty(), "{failed:?}");
    c.finish().await;

    h.finish().await;
    s.finish().await;
}

/// A plain-SQL dump as earlier builds wrote them.
fn legacy_sql(s: &Scratch, name: &str) -> PathBuf {
    let plain = backup::dir().join(name);
    let dump = Command::new("pg_dump")
        .args(["--clean", "--if-exists", "--no-owner", "--no-privileges"])
        .args(["-h", s.pool.connect_options().get_host()])
        .args(["-p", &s.pool.connect_options().get_port().to_string()])
        .args(["-U", "fliks", "-d", &s.name])
        .env("PGPASSWORD", "fliks")
        .output()
        .unwrap();
    assert!(dump.status.success());
    std::fs::write(&plain, &dump.stdout).unwrap();
    plain
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_schema_the_backup_left_out_is_reported_and_its_plugin_disabled() {
    if !tools() {
        return;
    }
    let Some((s, h)) = install("rstrskip").await else {
        return;
    };
    let cfg = config_for(&s.url, &s.name);
    script(&h, SETUP, "0100_setup").await;
    let name = "left-out.dump";
    let dump = Command::new("pg_dump")
        .args(["-Fc", "-B", &format!("--exclude-schema={SCHEMA}")])
        .args(["-h", s.pool.connect_options().get_host()])
        .args(["-p", &s.pool.connect_options().get_port().to_string()])
        .args(["-U", "fliks", "-d", &s.name])
        .env("PGPASSWORD", "fliks")
        .output()
        .unwrap();
    assert!(dump.status.success());
    std::fs::write(path(name), &dump.stdout).unwrap();
    let out = restore::restore(
        &cfg,
        &s.pool,
        &h.st.jobs,
        &h.st.plugins,
        &path(name),
        name,
        false,
    )
    .await
    .unwrap();
    assert_eq!(out.plugins_not_restored.len(), 1, "{out:?}");
    assert_eq!(out.plugins_not_restored[0].schema, SCHEMA);
    let enabled: bool = sqlx::query_scalar(
        r#"SELECT enabled FROM plugin_packages WHERE "pluginId" = 'fliks.fixture'"#,
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert!(!enabled);
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_offline_restore_refuses_while_another_session_holds_the_instance_lock() {
    use sqlx::Connection;
    let Some(s) = Scratch::create("rstrlock").await else {
        return;
    };
    let mut held = sqlx::PgConnection::connect_with(&*s.pool.connect_options())
        .await
        .unwrap();
    assert!(
        fliks_server::system::instance::claim(&mut held)
            .await
            .unwrap()
    );
    let file = std::env::temp_dir().join(format!("fliks-lock-{}.dump", std::process::id()));
    std::fs::write(&file, b"x").unwrap();
    let err = fliks_server::restore(&config_for(&s.url, &s.name), &file)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("is running"), "{err}");
    let _ = std::fs::remove_file(file);
    drop(held);
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lost_connection_gets_the_instance_lock_back() {
    use sqlx::Connection;
    let Some(s) = Scratch::create("rstrkeep").await else {
        return;
    };
    let opts = (*s.pool.connect_options()).clone();
    let mut held = sqlx::PgConnection::connect_with(&opts).await.unwrap();
    assert!(
        fliks_server::system::instance::claim(&mut held)
            .await
            .unwrap()
    );
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut held)
        .await
        .unwrap();
    fliks_server::system::instance::keep(opts.clone(), held, std::time::Duration::from_millis(100));
    sqlx::query("SELECT pg_terminate_backend($1)")
        .bind(pid)
        .execute(&s.pool)
        .await
        .unwrap();
    let mut probe = sqlx::PgConnection::connect_with(&opts).await.unwrap();
    let mut taken = false;
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if !fliks_server::system::instance::claim(&mut probe)
            .await
            .unwrap()
        {
            taken = true;
            break;
        }
        sqlx::query("SELECT pg_advisory_unlock_all()")
            .execute(&mut probe)
            .await
            .unwrap();
    }
    assert!(taken, "the lock was never taken again");
    s.finish().await;
}

/// Below 17 the shipped `pg_restore` cannot run: the restore is refused with the version, nothing replayed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_server_before_17_refuses_a_restore_untouched() {
    if !tools() {
        return;
    }
    let Some(s) = Scratch::create("rstrold17").await else {
        return;
    };
    let version = fliks_server::db::server_version(&s.pool).await.unwrap();
    if version >= 170_000 {
        return s.finish().await;
    }
    let cfg = config_for(&s.url, &s.name);
    let made = backup::create(&cfg, &s.pool, &backup::dir()).await.unwrap();
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ('rstr_marker', 'after')")
        .execute(&s.pool)
        .await
        .unwrap();
    let err = restore::offline(&cfg, &s.pool, &path(&made.filename))
        .await
        .unwrap_err();
    assert_eq!(err.status(), 400);
    assert!(err.text().contains("PostgreSQL 17"), "{err}");
    let kept = rows(
        &s.pool,
        "SELECT count(*) FROM app_settings WHERE key = 'rstr_marker'",
    )
    .await;
    assert_eq!(kept, 1, "nothing was replayed");
    // The nightly `.sql` of earlier builds carries the same statement.
    let plain = backup::dir().join("fliks-backup-pg17-setting.sql");
    std::fs::write(&plain, "SET transaction_timeout = 0;\nSELECT 1;\n").unwrap();
    let err = restore::offline(&cfg, &s.pool, &plain).await.unwrap_err();
    let _ = std::fs::remove_file(&plain);
    assert_eq!(err.status(), 400);
    assert!(err.text().contains("PostgreSQL 17"), "{err}");
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plugin_pass_that_fails_is_reported_and_leaves_core_restored() {
    if !tools() {
        return;
    }
    let Some((s, h)) = install("rstrfail").await else {
        return;
    };
    let cfg = config_for(&s.url, &s.name);
    script(&h, SETUP, "0100_setup").await;
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ('rstr_marker', 'before')")
        .execute(&s.pool)
        .await
        .unwrap();
    let made = backup::create(&cfg, &s.pool, &backup::dir()).await.unwrap();
    sqlx::query("DELETE FROM app_settings WHERE key = 'rstr_marker'")
        .execute(&s.pool)
        .await
        .unwrap();
    // The plugin's logins now trip the CHECK that every `COPY` of `t3` evaluates.
    let role = fliks_server::plugins::db::role(&s.oid().await, "fliks.fixture");
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "ALTER ROLE \"{role}\" SET fliks.break = 'on'"
    )))
    .execute(&s.pool)
    .await
    .unwrap();
    let out = restored(&h, &s, &made.filename).await;
    assert_eq!(out.plugins_not_restored.len(), 1, "{out:?}");
    assert_eq!(out.plugins_not_restored[0].schema, SCHEMA);
    assert!(
        out.plugins_not_restored[0].message.contains("t3"),
        "{out:?}"
    );
    let marker: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_settings WHERE key = 'rstr_marker'")
            .fetch_optional(&s.pool)
            .await
            .unwrap();
    assert_eq!(marker.as_deref(), Some("before"), "core is restored");
    assert_eq!(
        rows(
            &s.pool,
            &format!(
                "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = '{SCHEMA}' AND c.relkind = 'r'"
            )
        )
        .await,
        0,
        "the failed schema stays empty"
    );
    let (enabled, reason): (bool, Option<String>) = sqlx::query_as(
        r#"SELECT enabled, "statusReason" FROM plugin_packages WHERE "pluginId" = 'fliks.fixture'"#,
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert!(!enabled);
    assert!(reason.unwrap_or_default().starts_with("restore-failed: "));

    // A plain dump holding plugin data is refused before anything runs.
    let plain = legacy_sql(&s, "legacy.sql");
    let err = restore::restore(
        &cfg,
        &s.pool,
        &h.st.jobs,
        &h.st.plugins,
        &plain,
        "legacy.sql",
        false,
    )
    .await
    .unwrap_err();
    assert_eq!(err.status(), 409);
    assert!(err.text().starts_with("BACKUP_HAS_PLUGIN_DATA"), "{err}");
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_orphaned_schema_round_trips() {
    if !tools() {
        return;
    }
    let Some((s, h)) = install("rstrorph").await else {
        return;
    };
    let cfg = config_for(&s.url, &s.name);
    script(&h, SETUP, "0100_setup").await;
    sqlx::query(r#"DELETE FROM plugin_packages WHERE "pluginId" = 'fliks.fixture'"#)
        .execute(&s.pool)
        .await
        .unwrap();
    fliks_server::plugins::db::orphan(&s.pool, "fliks.fixture", None)
        .await
        .unwrap();
    let made = backup::create(&cfg, &s.pool, &backup::dir()).await.unwrap();
    let out = restore::restore(
        &cfg,
        &s.pool,
        &h.st.jobs,
        &h.st.plugins,
        &path(&made.filename),
        &made.filename,
        false,
    )
    .await
    .unwrap();
    assert!(out.plugins_not_restored.is_empty(), "{out:?}");
    let role = fliks_server::plugins::db::role(&s.oid().await, "fliks.fixture");
    assert_eq!(foreign_owned(&s.pool, &role).await, 0);
    let login: bool = sqlx::query_scalar("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1")
        .bind(&role)
        .fetch_one(&s.pool)
        .await
        .unwrap();
    // The orphan cannot log in: open it for the read, then close it again.
    let alter =
        |what: &str| sqlx::raw_sql(sqlx::AssertSqlSafe(format!("ALTER ROLE \"{role}\" {what}")));
    alter("LOGIN").execute(&s.pool).await.unwrap();
    assert_eq!(plugin_rows(&s, "t").await, 2);
    alter("NOLOGIN").execute(&s.pool).await.unwrap();
    let note: Option<String> = sqlx::query_scalar(
        "SELECT obj_description(oid, 'pg_namespace') FROM pg_namespace WHERE nspname = $1",
    )
    .bind(SCHEMA)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert!(!login && note.unwrap_or_default().starts_with("orphaned:"));
    let kept = rows(
        &s.pool,
        r#"SELECT count(*) FROM plugin_kept_data WHERE "pluginId" = 'fliks.fixture'"#,
    )
    .await;
    assert_eq!(kept, 1, "the kept-data row came back with the dump");
    h.finish().await;
    s.finish().await;
}
