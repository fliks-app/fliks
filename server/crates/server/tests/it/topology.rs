//! Process topology the real binary on a scratch database.
use sqlx::PgPool;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Server {
    child: Child,
    base: String,
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
    extra_env: &[(&str, &std::path::Path)],
) -> Server {
    let port = free_port();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_fliks-server"));
    cmd.envs(db_env(pool))
        .env("PORT", port.to_string())
        .envs(extra_env.iter().copied())
        .env("FLIKS_CONF_DIR", conf)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = cmd.spawn().unwrap();
    let base = format!("http://127.0.0.1:{port}");
    eventually(&format!("{base}/api/system/liveness"), |r| r.0 == 200).await;
    Server { child, base }
}

#[sqlx::test(migrations = false)]
async fn boot_liveness_healthcheck_and_shutdown(pool: PgPool) {
    let conf = std::env::temp_dir().join(format!("fliks-topology-{}", std::process::id()));
    let s = start(&pool, &conf, &[]).await;
    let b = &s.base;

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
    assert_eq!(
        get_text(&format!("{b}/api/system/liveness")).await.unwrap(),
        (200, r#"{"ok":true}"#.into())
    );

    let hc = |port: &str| {
        Command::new(env!("CARGO_BIN_EXE_fliks-server"))
            .arg("healthcheck")
            .env("PORT", port)
            .status()
            .unwrap()
            .success()
    };
    assert!(hc(b.rsplit(':').next().unwrap()) && !hc(&free_port().to_string()));

    let mut s = s;
    signal("TERM", s.child.id());
    assert!(s.child.wait().unwrap().success());
    std::fs::remove_dir_all(conf).ok();
}

#[sqlx::test(migrations = false)]
async fn rust_serves_the_spa_and_the_emoji(pool: PgPool) {
    let root = std::env::temp_dir().join(format!("fliks-topology-static-{}", std::process::id()));
    let (client, cast) = (root.join("client"), root.join("cast"));
    std::fs::create_dir_all(&client).unwrap();
    std::fs::create_dir_all(&cast).unwrap();
    std::fs::write(client.join("index.html"), "<html>spa</html>").unwrap();
    std::fs::create_dir_all(cast.join("emoji")).unwrap();
    std::fs::write(cast.join("emoji/1f525.webp"), "w").unwrap();
    let env = [
        ("SERVE_STATIC_PATH", client.as_path()),
        ("FLIKS_CAST_DIR", cast.as_path()),
    ];
    let s = start(&pool, &root.join("conf"), &env).await;
    let base = &s.base;
    assert_eq!(
        get_text(&format!("{base}/some/spa/route")).await.unwrap(),
        (200, "<html>spa</html>".into())
    );
    assert_eq!(
        get_text(&format!("{base}/api/emoji/1f525.webp"))
            .await
            .unwrap(),
        (200, "w".into())
    );
    assert_eq!(
        get_text(&format!("{base}/cast/cast-receiver.html"))
            .await
            .unwrap(),
        (200, "<html>spa</html>".into())
    );
    std::fs::remove_dir_all(root).ok();
}

/// No database at boot: the server exits non-zero before it listens or loads a plugin.
#[test]
fn without_a_database_the_server_exits() {
    let dir = std::env::var("CARGO_TARGET_DIR")
        .map_or_else(|_| std::env::temp_dir(), std::path::PathBuf::from);
    let started = Instant::now();
    let out = Command::new(env!("CARGO_BIN_EXE_fliks-server"))
        .env("DB_HOST", "127.0.0.1")
        .env("DB_PORT", free_port().to_string())
        .env("PORT", free_port().to_string())
        .env("FLIKS_CONF_DIR", dir.join("no-db-conf"))
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "{stderr}");
    assert!(stderr.contains("cannot reach the database"), "{stderr}");
    assert!(!stderr.contains("plugin"), "{stderr}");
    assert!(started.elapsed() < Duration::from_secs(20));
}
