//! Process topology (plan §11): the real binary with a fake Nest it spawns itself.
//! The fake Nest is this test executable re-run on `fake_nest` (selected by `FAKE_NEST=1`).
use axum::{Json, Router, routing::get};
use sqlx::PgPool;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[tokio::test]
async fn fake_nest() {
    if std::env::var("FAKE_NEST").is_err() {
        return;
    }
    let port = std::env::var("PORT").unwrap();
    let app = Router::new()
        .route("/api/pid", get(|| async { std::process::id().to_string() }))
        .route(
            "/api/env",
            get(|| async {
                let v = |k: &str| std::env::var(k).unwrap_or_default();
                Json(serde_json::json!({
                    "host": v("FLIKS_HOST_URL"), "server": v("FLIKS_SERVER_URL"),
                    "bridge": v("FLIKS_BRIDGE_TOKEN"), "port": v("PORT"),
                }))
            }),
        )
        .fallback(|| async { "nest" });
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .unwrap();
    axum::serve(listener, app).await.unwrap();
}

struct Server {
    child: Child,
    base: String,
    nest_port: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            signal("TERM", self.child.id());
            let _ = self.child.wait();
        }
    }
}

fn signal(sig: &str, pid: u32) {
    Command::new("kill")
        .args([&format!("-{sig}"), &pid.to_string()])
        .status()
        .unwrap();
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn get_text(url: &str) -> Option<(u16, String)> {
    let res = reqwest::get(url).await.ok()?;
    Some((res.status().as_u16(), res.text().await.ok()?))
}

async fn eventually(url: &str, ok: impl Fn(&(u16, String)) -> bool) -> (u16, String) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(r) = get_text(url).await.filter(&ok) {
            return r;
        }
        assert!(Instant::now() < deadline, "timeout waiting for {url}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// `postgres://user:pass@host:port/db` from `DATABASE_URL`.
fn db_env(pool: &PgPool) -> Vec<(&'static str, String)> {
    let url = std::env::var("DATABASE_URL").unwrap();
    let rest = url.split("://").nth(1).unwrap();
    let (auth, addr) = rest.split_once('@').unwrap();
    let (user, pass) = auth.split_once(':').unwrap_or((auth, ""));
    let host_port = addr.split('/').next().unwrap();
    let (host, port) = host_port.split_once(':').unwrap_or((host_port, "5432"));
    vec![
        ("DB_HOST", host.into()),
        ("DB_PORT", port.into()),
        ("DB_USERNAME", user.into()),
        ("DB_PASSWORD", pass.into()),
        (
            "DB_NAME",
            pool.connect_options().get_database().unwrap().into(),
        ),
    ]
}

async fn start(
    pool: &PgPool,
    conf: &std::path::Path,
    nest_url: Option<&str>,
    extra_env: &[(&str, &std::path::Path)],
) -> Server {
    let port = free_port();
    let nest_port = free_port();
    let exe = std::env::current_exe().unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_fliks-server"));
    cmd.envs(db_env(pool))
        .env("PORT", port.to_string())
        .env("FLIKS_NEST_PORT", nest_port.to_string())
        .envs(extra_env.iter().copied())
        .env("FLIKS_CONF_DIR", conf)
        .env("FLIKS_ENGINE_BACKOFF_MS", "100")
        .env("FAKE_NEST", "1")
        .env(
            "FLIKS_NEST_CMD",
            format!("{} fake_nest --exact --nocapture", exe.display()),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(u) = nest_url {
        cmd.env("FLIKS_NEST_URL", u);
    }
    let child = cmd.spawn().unwrap();
    let base = format!("http://127.0.0.1:{port}");
    eventually(&format!("{base}/api/system/liveness"), |r| r.0 == 200).await;
    Server {
        child,
        base,
        nest_port,
    }
}

#[sqlx::test(migrations = false)]
async fn fallback_internal_liveness_restart_and_shutdown(pool: PgPool) {
    let conf = std::env::temp_dir().join(format!("fliks-topology-{}", std::process::id()));
    let s = start(&pool, &conf, None, &[]).await;
    let b = &s.base;

    // Boot ran the migrations and created the JWT secret Nest would read.
    let migrated: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(migrated > 0);
    assert_eq!(
        std::fs::read_to_string(conf.join(".jwt-secret"))
            .unwrap()
            .len(),
        64
    );

    // Liveness is Rust's; everything else under /api reaches Nest.
    assert_eq!(
        get_text(&format!("{b}/api/system/liveness")).await.unwrap(),
        (200, r#"{"ok":true}"#.into())
    );
    let forwarded = eventually(&format!("{b}/api/anything"), |r| r.0 == 200).await;
    assert_eq!(forwarded.1, "nest");

    let hc = |port: &str| {
        Command::new(env!("CARGO_BIN_EXE_fliks-server"))
            .arg("healthcheck")
            .env("PORT", port)
            .status()
            .unwrap()
            .success()
    };
    assert!(hc(b.rsplit(':').next().unwrap()) && !hc(&free_port().to_string()));

    // /internal never reaches Nest.
    assert_eq!(
        get_text(&format!("{b}/internal/bridge/emit"))
            .await
            .unwrap(),
        (
            404,
            r#"{"error":"Not Found","message":"Cannot GET /internal/bridge/emit","statusCode":404}"#.into()
        )
    );

    // Nest got its spawn environment.
    let env: serde_json::Value =
        serde_json::from_str(&get_text(&format!("{b}/api/env")).await.unwrap().1).unwrap();
    let port = b.rsplit(':').next().unwrap();
    assert_eq!(env["host"], format!("http://127.0.0.1:{port}"));
    assert_eq!(env["server"], env["host"]);
    assert_eq!(env["bridge"].as_str().unwrap().len(), 64);
    assert_ne!(env["port"], port);

    // Killing Nest brings it back with a new pid.
    let pid = get_text(&format!("{b}/api/pid")).await.unwrap().1;
    signal("KILL", pid.parse().unwrap());
    let url = format!("{b}/api/pid");
    let new_pid = eventually(&url, |r| r.0 == 200 && r.1 != pid).await.1;
    assert_ne!(new_pid, pid);

    // SIGTERM stops Nest and exits cleanly.
    let mut s = s;
    signal("TERM", s.child.id());
    assert!(s.child.wait().unwrap().success());
    let alive = Command::new("kill")
        .args(["-0", &new_pid])
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(!alive.success(), "nest outlived fliks-server");
    std::fs::remove_dir_all(conf).ok();
}

#[sqlx::test(migrations = false)]
async fn nest_url_spawns_nothing(pool: PgPool) {
    let conf = std::env::temp_dir().join(format!("fliks-topology-url-{}", std::process::id()));
    let s = start(&pool, &conf, Some("http://127.0.0.1:1"), &[]).await;
    // Nothing listens upstream: forwarding is attempted (502) and no fake Nest was spawned.
    assert_eq!(
        get_text(&format!("{}/api/pid", s.base)).await.unwrap().0,
        502
    );
    std::fs::remove_dir_all(conf).ok();
}

#[sqlx::test(migrations = false)]
async fn nest_url_leaves_the_nest_port_unbound(pool: PgPool) {
    let conf = std::env::temp_dir().join(format!("fliks-topology-port-{}", std::process::id()));
    let s = start(&pool, &conf, Some("http://127.0.0.1:1"), &[]).await;
    assert!(std::net::TcpStream::connect(("127.0.0.1", s.nest_port)).is_err());
    std::fs::remove_dir_all(conf).ok();
}

#[sqlx::test(migrations = false)]
async fn rust_serves_the_spa_and_the_cast_receiver(pool: PgPool) {
    let root = std::env::temp_dir().join(format!("fliks-topology-static-{}", std::process::id()));
    let (client, cast) = (root.join("client"), root.join("cast"));
    std::fs::create_dir_all(&client).unwrap();
    std::fs::create_dir_all(&cast).unwrap();
    std::fs::write(client.join("index.html"), "<html>spa</html>").unwrap();
    std::fs::write(cast.join("cast-receiver.html"), "cast").unwrap();
    let env = [
        ("SERVE_STATIC_PATH", client.as_path()),
        ("FLIKS_CAST_DIR", cast.as_path()),
    ];
    let s = start(&pool, &root.join("conf"), Some("http://127.0.0.1:1"), &env).await;
    let base = &s.base;
    assert_eq!(
        get_text(&format!("{base}/some/spa/route")).await.unwrap(),
        (200, "<html>spa</html>".into())
    );
    assert_eq!(
        get_text(&format!("{base}/cast/cast-receiver.html"))
            .await
            .unwrap(),
        (200, "cast".into())
    );
    std::fs::remove_dir_all(root).ok();
}
