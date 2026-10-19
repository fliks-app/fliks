//! Scratch databases, a tuned plugin host and the fixture components.
use axum::{Router, body::Body, http::Request};
use ed25519_dalek::{Signer, SigningKey};
use fliks_server::plugins::{Options, Plugins, archive, fetch::Fetcher, runtime::HostConfig};
use fliks_server::{app, config::Config, state::AppState};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection, PgPool, postgres::PgPoolOptions};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;

pub const SECRET: &str = "0123456789abcdef0123456789abcdef";
pub const TEST_KEY: [u8; 32] = [7u8; 32];

/// Under CI a missing input fails the test; locally it skips it, loudly.
fn skip(what: &str) {
    if std::env::var("CI").is_ok_and(|v| !matches!(v.as_str(), "" | "0" | "false")) {
        panic!("{what}: required under CI");
    }
    eprintln!("\n\x1b[1;33mWARNING: {what}: test SKIPPED\x1b[0m\n");
}

pub fn admin_url() -> Option<String> {
    let url = std::env::var("S8_PG_ADMIN_URL").ok();
    if url.is_none() {
        skip("S8_PG_ADMIN_URL unset");
    }
    url
}

pub fn wasm(name: &str) -> Option<Vec<u8>> {
    let dir = std::env::var("FLIKS_TEST_WASM_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("CARGO_TARGET_DIR")
                .ok()
                .map(|d| PathBuf::from(d).join("wasm32-wasip2/release"))
        });
    let file = dir.map(|d| d.join(format!("{name}.wasm")));
    let w = file.as_ref().and_then(|f| std::fs::read(f).ok());
    if w.is_none() {
        skip(&format!(
            "{name}.wasm not found at {file:?} (FLIKS_TEST_WASM_DIR or $CARGO_TARGET_DIR/\
             wasm32-wasip2/release; cargo xtask build examples/fixture-guest in plugin-sdk)"
        ));
    }
    w
}

pub fn template(example: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../plugin-sdk/examples")
        .join(example)
        .join("plugin.template.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

pub const LOGO: &[u8] = b"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'></svg>";

/// A process archive of `wasm` under `manifest` (version and files filled), optionally signed.
pub fn pack(manifest: &Value, version: &str, wasm: &[u8], sign: Option<&SigningKey>) -> Vec<u8> {
    let mut m = manifest.clone();
    m["version"] = json!(version);
    m["files"] =
        json!({ "plugin.wasm": archive::sha256_hex(wasm), "logo.svg": archive::sha256_hex(LOGO) });
    let bytes = serde_json::to_vec(&m).unwrap();
    let sig = sign.map(|k| {
        use base64::Engine;
        format!(
            "{}\n",
            base64::engine::general_purpose::STANDARD.encode(k.sign(&bytes).to_bytes())
        )
    });
    let mut entries: Vec<(&str, &[u8])> = vec![("plugin.json", &bytes)];
    if let Some(s) = &sig {
        entries.push(("plugin.json.sig", s.as_bytes()));
    }
    entries.push(("plugin.wasm", wasm));
    entries.push(("logo.svg", LOGO));
    archive::pack(&entries)
}

pub fn data_archive(manifest: &Value) -> Vec<u8> {
    let bytes = serde_json::to_vec(manifest).unwrap();
    archive::pack(&[("plugin.json", &bytes), ("logo.svg", LOGO)])
}

pub fn test_key() -> SigningKey {
    SigningKey::from_bytes(&TEST_KEY)
}

pub struct Scratch {
    pub name: String,
    pub pool: PgPool,
    pub url: String,
    admin: String,
}

impl Scratch {
    pub async fn create(tag: &str) -> Option<Scratch> {
        let admin = admin_url()?;
        let name = format!("s8_{tag}_{}", fliks_server::config::random_hex(4));
        let mut c = PgConnection::connect(&admin).await.unwrap();
        sqlx::raw_sql(&format!("CREATE DATABASE {name}"))
            .execute(&mut c)
            .await
            .unwrap();
        let url = format!("{}/{name}", admin.rsplit_once('/').unwrap().0);
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(&url)
            .await
            .unwrap();
        fliks_server::db::migrate(&pool).await.unwrap();
        Some(Scratch {
            name,
            pool,
            url,
            admin,
        })
    }

    pub async fn reopen(self) -> Scratch {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(&self.url)
            .await
            .unwrap();
        Scratch { pool, ..self }
    }

    pub async fn oid(&self) -> String {
        fliks_server::plugins::db::database_oid(&self.pool)
            .await
            .unwrap()
    }

    /// Drops the database and every role named after its OID.
    pub async fn finish(self) {
        let oid = self.oid().await;
        self.pool.close().await;
        let mut c = PgConnection::connect(&self.admin).await.unwrap();
        sqlx::raw_sql(&format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        ))
        .execute(&mut c)
        .await
        .unwrap();
        let roles: Vec<String> =
            sqlx::query_scalar("SELECT rolname::text FROM pg_roles WHERE rolname LIKE $1")
                .bind(format!("fp\\_{oid}\\_%"))
                .fetch_all(&mut c)
                .await
                .unwrap();
        for r in roles {
            let _ = sqlx::raw_sql(&format!("DROP ROLE IF EXISTS \"{r}\""))
                .execute(&mut c)
                .await;
        }
    }
}

pub struct H {
    pub st: AppState,
    pub app: Router,
    pub admin: String,
    pub user: String,
    pub dir: PathBuf,
}

pub fn options(
    s: &Scratch,
    dir: &std::path::Path,
    tune: Arc<dyn Fn(&mut HostConfig) + Send + Sync>,
) -> Options {
    let opts = s.pool.connect_options();
    let mut keys = fliks_server::plugins::trust::official_keys();
    keys.push(("test-key".into(), test_key().verifying_key().to_bytes()));
    Options {
        version: "5.0.0".into(),
        runtime_dir: dir.to_path_buf(),
        disabled: false,
        pg: fliks_server::plugins::db::PgTarget {
            host: opts.get_host().to_owned(),
            port: opts.get_port(),
            dbname: s.name.clone(),
        },
        tune: Some(Arc::new(move |c: &mut HostConfig| {
            c.compiler = PathBuf::from(env!("CARGO_BIN_EXE_fliks-server"));
            tune(c);
        })),
        fetch: Fetcher::default(),
        keys,
        ready_wait: Duration::from_secs(15),
    }
}

pub async fn harness(
    s: &Scratch,
    tag: &str,
    tune: impl Fn(&mut HostConfig) + Send + Sync + 'static,
) -> H {
    harness_with(s, tag, Arc::new(tune), |_| {}).await
}

/// `tracing` feeds the log ring as in `main`.
fn init_tracing() {
    use tracing_subscriber::prelude::*;
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = tracing_subscriber::registry()
            .with(fliks_server::system::logs::RingLayer)
            .try_init();
    });
}

pub async fn harness_with(
    s: &Scratch,
    tag: &str,
    tune: Arc<dyn Fn(&mut HostConfig) + Send + Sync>,
    edit: impl FnOnce(&mut Options),
) -> H {
    // Runtime dirs, not media: the target dir keeps them off the shared tmpfs.
    let root =
        std::env::var("CARGO_TARGET_DIR").map_or_else(|_| std::env::temp_dir(), PathBuf::from);
    let dir = root.join(format!(
        "plugin-tests/{tag}-{}",
        fliks_server::config::random_hex(3)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    init_tracing();
    let mut st = AppState::new(s.pool.clone(), Config::from_lookup(|_| None), SECRET);
    let mut opts = options(s, &dir, tune);
    edit(&mut opts);
    st.plugins = Arc::new(Plugins::new(s.pool.clone(), opts));
    st.plugins.attach(&st);
    sqlx::query("DELETE FROM plugin_sources")
        .execute(&s.pool)
        .await
        .unwrap();
    st.plugins.spawn(&st);
    let mut tokens = vec![];
    for (name, admin) in [("admin", true), ("user", false)] {
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin") VALUES ($1, $2)
            ON CONFLICT (username) DO UPDATE SET "isAdmin" = EXCLUDED."isAdmin" RETURNING id"#,
        )
        .bind(name)
        .bind(admin)
        .fetch_one(&s.pool)
        .await
        .unwrap();
        tokens.push(st.jwt.sign_access(id, name).unwrap().token);
    }
    let app = app::router(st.clone(), None, "/nonexistent".into(), None);
    H {
        user: tokens.pop().unwrap(),
        admin: tokens.pop().unwrap(),
        st,
        app,
        dir,
    }
}

impl H {
    pub async fn call(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (u16, Value) {
        let (s, _, b) = self.raw(method, uri, token, body).await;
        (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
    }

    pub async fn raw(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (u16, axum::http::HeaderMap, Vec<u8>) {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        let req = match body {
            Some(b) => req
                .header("content-type", "application/json")
                .body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, headers, bytes.to_vec())
    }

    pub async fn upload(&self, bytes: &[u8]) -> (u16, Value) {
        let boundary = "fliksboundary";
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"p.fkplugin\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let req = Request::post("/api/plugins/import/inspect")
            .header("authorization", format!("Bearer {}", self.admin))
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Inspect then confirm; the confirm body.
    pub async fn install(&self, bytes: &[u8]) -> Value {
        let (s, r) = self.upload(bytes).await;
        assert_eq!(s, 201, "{r}");
        assert_eq!(r["installable"], true, "{r}");
        let (s, r) = self
            .call(
                "POST",
                "/api/plugins/import/confirm",
                Some(&self.admin),
                Some(json!({"stagingId": r["stagingId"], "sha256": r["sha256"]})),
            )
            .await;
        assert_eq!(s, 201, "{r}");
        r
    }

    pub async fn set(&self, key: &str, value: &str) {
        fliks_server::settings::write(&self.st, &[(key.to_owned(), Some(value.to_owned()))], None)
            .await
            .unwrap();
    }

    pub async fn finish(self) {
        self.st.plugins.shutdown().await;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Polls `f` until it is true, or panics after `max`.
pub async fn until(what: &str, max: Duration, mut f: impl AsyncFnMut() -> bool) {
    let end = tokio::time::Instant::now() + max;
    while tokio::time::Instant::now() < end {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

pub fn fixture() -> Option<(Value, Vec<u8>)> {
    Some((template("fixture-guest"), wasm("fixture_guest")?))
}

/// The fixture as installed by tests: unsigned process plugins allowed.
pub async fn allow_unsigned(h: &H) {
    h.set("plugins.allow_unsigned", "true").await;
}
