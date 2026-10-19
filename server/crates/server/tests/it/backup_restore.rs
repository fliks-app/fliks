//! Backup and restore through the real router on a scratch database (`docs/spec/system.md`, Vectors).
//! Skipped without `DATABASE_URL`, `pg_dump` or `psql`; refuses to touch a database named `fliks`.
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, db, state::AppState};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection, PgPool, postgres::PgPoolOptions};
use std::{collections::HashMap, os::unix::fs::PermissionsExt, path::PathBuf, process::Command};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

/// `postgres://user:pass@host:port/db` into the `DB_*` variables.
fn db_env(url: &str, name: &str) -> HashMap<String, String> {
    let rest = url.strip_prefix("postgres://").expect("postgres url");
    let (auth, host) = rest.split_once('@').expect("credentials");
    let (user, pass) = auth.split_once(':').unwrap_or((auth, ""));
    let (hostport, _) = host.split_once('/').unwrap_or((host, ""));
    let (h, p) = hostport.split_once(':').unwrap_or((hostport, "5432"));
    [
        ("DB_HOST", h),
        ("DB_PORT", p),
        ("DB_USERNAME", user),
        ("DB_PASSWORD", pass),
        ("DB_NAME", name),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect()
}

fn have(tool: &str) -> bool {
    Command::new(tool).arg("--version").output().is_ok()
}

struct Scratch {
    url: String,
    name: String,
    pool: PgPool,
}

impl Scratch {
    async fn create(url: &str, migrate: Option<usize>) -> Self {
        let name = format!("s5sys_{}", fliks_server::config::random_hex(6));
        assert_ne!(name, "fliks");
        let admin = url.rsplit_once('/').unwrap().0.to_owned() + "/postgres";
        let mut c = PgConnection::connect(&admin).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&mut c)
            .await
            .unwrap();
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect(&format!("{}/{name}", url.rsplit_once('/').unwrap().0))
            .await
            .unwrap();
        match migrate {
            None => db::migrate(&pool).await.unwrap(),
            Some(n) => {
                let mut m = sqlx::migrate!("../../migrations");
                m.migrations = std::borrow::Cow::Owned(m.migrations[..n].to_vec());
                m.run(&pool).await.unwrap();
            }
        }
        Self {
            url: url.into(),
            name,
            pool,
        }
    }

    async fn drop_db(self) {
        self.pool.close().await;
        let admin = self.url.rsplit_once('/').unwrap().0.to_owned() + "/postgres";
        let mut c = PgConnection::connect(&admin).await.unwrap();
        sqlx::query(&format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        ))
        .execute(&mut c)
        .await
        .unwrap();
    }
}

struct Ctx {
    app: Router,
    st: AppState,
    admin: String,
    limited: String,
    dir: PathBuf,
}

async fn ctx(s: &Scratch, url: &str) -> Ctx {
    let env = db_env(url, &s.name);
    let st = AppState::new(
        s.pool.clone(),
        Config::from_lookup(|k| env.get(k).cloned()),
        SECRET,
    );
    sqlx::query(
        r#"INSERT INTO roles (name, permissions) VALUES ('limited', '["settings.access"]')"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();
    let mut toks = vec![];
    for (name, admin) in [("admin", true), ("limited", false)] {
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin", "roleId") VALUES ($1, $2, (SELECT id FROM roles WHERE name = 'limited' AND NOT $2)) RETURNING id"#,
        )
        .bind(name)
        .bind(admin)
        .fetch_one(&s.pool)
        .await
        .unwrap();
        toks.push(st.jwt.sign_access(id, name).unwrap().token);
    }
    Ctx {
        app: app::router(st.clone(), None, "/nonexistent".into(), None),
        st,
        limited: toks.pop().unwrap(),
        admin: toks.pop().unwrap(),
        dir: fliks_server::system::backup::dir(),
    }
}

async fn call(
    c: &Ctx,
    method: &str,
    uri: &str,
    tok: &str,
    body: Value,
) -> (u16, axum::http::HeaderMap, Vec<u8>) {
    call_with(c, method, uri, tok, body, &[]).await
}

async fn call_with(
    c: &Ctx,
    method: &str,
    uri: &str,
    tok: &str,
    body: Value,
    headers: &[(&str, &str)],
) -> (u16, axum::http::HeaderMap, Vec<u8>) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {tok}"))
        .header("content-type", "application/json");
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = c
        .app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let (status, h) = (res.status().as_u16(), res.headers().clone());
    (
        status,
        h,
        axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
}

fn json_of(b: &[u8]) -> Value {
    serde_json::from_slice(b).unwrap_or(Value::Null)
}

async fn setting(pool: &PgPool, key: &str) -> Option<String> {
    sqlx::query_scalar("SELECT value FROM app_settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn backup_and_restore_on_a_scratch_database() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        return;
    };
    if !have("pg_dump") || !have("psql") {
        return;
    }
    let _ = std::fs::remove_dir_all(fliks_server::system::backup::dir());
    let scratch = Scratch::create(&url, None).await;
    let old = Scratch::create(
        &url,
        Some(sqlx::migrate!("../../migrations").migrations.len() - 1),
    )
    .await;
    let (c, c_old) = (ctx(&scratch, &url).await, ctx(&old, &url).await);
    let role = format!("plugin_s5sys_{}", fliks_server::config::random_hex(4));
    let body = tokio::spawn({
        let (url, role) = (url.clone(), role.clone());
        async move {
            run(&c, &c_old, &scratch.pool, &role).await;
            (scratch, old, url)
        }
    })
    .await;
    let _ = std::fs::remove_dir_all(fliks_server::system::backup::dir());
    let (scratch, old, url) = match body {
        Ok(t) => t,
        Err(e) => {
            // The scratch databases are only dropped once the body is known; a panic leaves them for inspection.
            std::panic::resume_unwind(e.into_panic());
        }
    };
    scratch.drop_db().await;
    old.drop_db().await;
    let mut admin =
        PgConnection::connect(&(url.rsplit_once('/').unwrap().0.to_owned() + "/postgres"))
            .await
            .unwrap();
    sqlx::query(&format!("DROP ROLE IF EXISTS {role}"))
        .execute(&mut admin)
        .await
        .unwrap();
}

async fn run(c: &Ctx, c_old: &Ctx, pool: &PgPool, role: &str) {
    // F36: settings.access alone is not enough, and nothing exists yet.
    assert_eq!(
        call(c, "GET", "/api/system/backups", &c.limited, Value::Null)
            .await
            .0,
        403
    );
    assert_eq!(
        call(c, "POST", "/api/system/backup", &c.limited, Value::Null)
            .await
            .0,
        403
    );
    let (s, _, b) = call(c, "GET", "/api/system/backups", &c.admin, Value::Null).await;
    assert_eq!((s, json_of(&b)), (200, json!([])));

    // create: name pattern, size, content, F38 modes
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ('s5_marker', 'before')")
        .execute(pool)
        .await
        .unwrap();
    let (s, _, b) = call(c, "POST", "/api/system/backup", &c.admin, Value::Null).await;
    assert_eq!(s, 201, "{}", String::from_utf8_lossy(&b));
    let made = json_of(&b);
    let name = made["filename"].as_str().unwrap().to_owned();
    assert!(
        name.starts_with("fliks-backup-")
            && name.ends_with("Z.sql")
            && !name[..name.len() - 4].contains([':', '.'])
    );
    let file = c.dir.join(&name);
    let text = std::fs::read_to_string(&file).unwrap();
    assert_eq!(made["size"].as_u64().unwrap(), text.len() as u64);
    assert!(text.contains("CREATE TABLE") && text.contains("s5_marker"));
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(&c.dir).unwrap().permissions().mode() & 0o777,
        0o700
    );

    // download: bytes, headers, range
    let (s, h, bytes) = call(
        c,
        "GET",
        &format!("/api/system/backups/{name}"),
        &c.admin,
        Value::Null,
    )
    .await;
    assert_eq!((s, bytes.as_slice()), (200, text.as_bytes()));
    assert_eq!(h["content-type"], "application/sql");
    assert_eq!(
        h["content-disposition"],
        format!("attachment; filename=\"{name}\"")
    );
    assert!(h["etag"].to_str().unwrap().starts_with("W/\""));
    let (s, _, part) = call_with(
        c,
        "GET",
        &format!("/api/system/backups/{name}"),
        &c.admin,
        Value::Null,
        &[("range", "bytes=0-9")],
    )
    .await;
    assert_eq!((s, part.as_slice()), (206, &text.as_bytes()[..10]));
    assert_eq!(
        call(
            c,
            "GET",
            "/api/system/backups/a%2Fb.sql",
            &c.admin,
            Value::Null
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(
            c,
            "GET",
            "/api/system/backups/missing.sql",
            &c.admin,
            Value::Null
        )
        .await
        .0,
        404
    );

    // list order: newest first, ties by name descending
    let other = c.dir.join("aaa-older.sql");
    std::fs::write(&other, "-- x").unwrap();
    let stamp = std::fs::metadata(&file).unwrap().modified().unwrap();
    std::fs::File::options()
        .write(true)
        .open(&other)
        .unwrap()
        .set_modified(stamp)
        .unwrap();
    let (_, _, b) = call(c, "GET", "/api/system/backups", &c.admin, Value::Null).await;
    let names: Vec<String> = json_of(&b)
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["filename"].as_str().unwrap().into())
        .collect();
    assert_eq!(names, [name.clone(), "aaa-older.sql".into()]);
    std::fs::remove_file(&other).unwrap();

    // round trip
    sqlx::query("DELETE FROM app_settings WHERE key = 's5_marker'")
        .execute(pool)
        .await
        .unwrap();
    let (s, _, b) = call(
        c,
        "POST",
        "/api/system/restore",
        &c.admin,
        json!({"filename": name}),
    )
    .await;
    assert_eq!((s, b.len()), (201, 0));
    assert_eq!(setting(pool, "s5_marker").await.as_deref(), Some("before"));

    // bad bodies and names
    for (body, want) in [
        (json!({}), "undefined"),
        (json!({"filename": ["a.sql"]}), "a.sql"),
        (json!({"filename": 7}), "7"),
        (json!({"filename": "../x.sql"}), "../x.sql"),
    ] {
        let (s, _, b) = call(c, "POST", "/api/system/restore", &c.admin, body).await;
        assert_eq!(
            (s, json_of(&b)["message"].clone()),
            (400, json!(format!("Invalid backup name \"{want}\"")))
        );
    }
    assert_eq!(
        call(
            c,
            "POST",
            "/api/system/restore",
            &c.admin,
            json!({"filename": "nope.sql"})
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(
            c,
            "POST",
            "/api/system/restore",
            &c.limited,
            json!({"filename": name})
        )
        .await
        .0,
        403
    );

    // corrupt dump: 500 with the tool's last line, database unchanged (single transaction)
    let corrupt = c.dir.join("corrupt.sql");
    std::fs::write(&corrupt, "SELECT 1/0;\n").unwrap();
    let (s, _, b) = call(
        c,
        "POST",
        "/api/system/restore",
        &c.admin,
        json!({"filename": "corrupt.sql"}),
    )
    .await;
    assert_eq!(s, 500);
    assert!(
        json_of(&b)["message"]
            .as_str()
            .unwrap()
            .contains("division by zero"),
        "{}",
        String::from_utf8_lossy(&b)
    );
    assert_eq!(setting(pool, "s5_marker").await.as_deref(), Some("before"));

    // F37: meta-commands refused, \restrict accepted
    std::fs::write(&corrupt, "\\! touch /tmp/fliks-s5-pwned\n").unwrap();
    let (s, _, b) = call(
        c,
        "POST",
        "/api/system/restore",
        &c.admin,
        json!({"filename": "corrupt.sql"}),
    )
    .await;
    assert_eq!(
        (s, json_of(&b)["message"].clone()),
        (400, json!("Backup contains psql meta-commands"))
    );
    assert!(!std::path::Path::new("/tmp/fliks-s5-pwned").exists());
    std::fs::write(
        &corrupt,
        format!("{text}\\restrict k3y\n\\unrestrict k3y\n"),
    )
    .unwrap();
    assert_eq!(
        call(
            c,
            "POST",
            "/api/system/restore",
            &c.admin,
            json!({"filename": "corrupt.sql"})
        )
        .await
        .0,
        201
    );

    // a dump granting to a plugin role the cluster lacks (rule 23)
    std::fs::write(
        &corrupt,
        format!("{text}GRANT SELECT ON public.app_settings TO {role};\n"),
    )
    .unwrap();
    assert_eq!(
        call(
            c,
            "POST",
            "/api/system/restore",
            &c.admin,
            json!({"filename": "corrupt.sql"})
        )
        .await
        .0,
        201
    );
    // C119: the replay could create the role, and the host drops it as not this database's.
    let kept: bool = sqlx::query_scalar("SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = $1)")
        .bind(role)
        .fetch_one(pool)
        .await
        .unwrap();
    assert!(!kept);

    // C24: 409 while a command runs; idle restore leaves no running row, and sweeps the dump's own
    sqlx::query("INSERT INTO commands (name, status) VALUES ('X', 'running')")
        .execute(pool)
        .await
        .unwrap();
    let (s, _, b) = call(
        c,
        "POST",
        "/api/system/restore",
        &c.admin,
        json!({"filename": name}),
    )
    .await;
    assert_eq!(
        (s, json_of(&b)["message"].clone()),
        (409, json!("A command is running"))
    );
    sqlx::query("UPDATE commands SET status = 'completed'")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO commands (name, status) VALUES ('Y', 'running')")
        .execute(pool)
        .await
        .unwrap();
    let (s, _, b) = call(c, "POST", "/api/system/backup", &c.admin, Value::Null).await;
    assert_eq!(s, 201);
    let with_running = json_of(&b)["filename"].as_str().unwrap().to_owned();
    sqlx::query("DELETE FROM commands")
        .execute(pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            c,
            "POST",
            "/api/system/restore",
            &c.admin,
            json!({"filename": with_running})
        )
        .await
        .0,
        201
    );
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT name, status FROM commands")
        .fetch_all(pool)
        .await
        .unwrap();
    assert_eq!(
        rows,
        [
            ("X".to_owned(), "completed".to_owned()),
            ("Y".to_owned(), "failed".to_owned())
        ]
    );

    // C27, C98: a dump from one migration back restores into today's database, at today's schema
    let (s, _, b) = call(
        c_old,
        "POST",
        "/api/system/backup",
        &c_old.admin,
        Value::Null,
    )
    .await;
    assert_eq!(s, 201, "{}", String::from_utf8_lossy(&b));
    let old_name = json_of(&b)["filename"].as_str().unwrap().to_owned();
    let total = sqlx::migrate!("../../migrations").migrations.len() as i64;
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
        .fetch_one(&c_old.st.db)
        .await
        .unwrap();
    assert_eq!(before, total - 1);
    // the current database holds objects the old dump lacks (a plugin schema, the newest migration's)
    sqlx::query("CREATE SCHEMA plugin_s5sys_stale")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE plugin_s5sys_stale.t (a int)")
        .execute(pool)
        .await
        .unwrap();
    let (s, _, b) = call(
        c,
        "POST",
        "/api/system/restore",
        &c.admin,
        json!({"filename": old_name}),
    )
    .await;
    assert_eq!(s, 201, "{}", String::from_utf8_lossy(&b));
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(after, total);
    let stale: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'plugin_s5sys_stale')",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert!(!stale);

    // delete: 200, then 404
    let (s, _, b) = call(
        c,
        "DELETE",
        &format!("/api/system/backups/{name}"),
        &c.admin,
        Value::Null,
    )
    .await;
    assert_eq!((s, json_of(&b)), (200, json!({"ok": true})));
    assert_eq!(
        call(
            c,
            "DELETE",
            &format!("/api/system/backups/{name}"),
            &c.admin,
            Value::Null
        )
        .await
        .0,
        404
    );
}
