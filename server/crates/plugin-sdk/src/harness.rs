//! Component tests (SDK-11): a built guest under the real host on a scratch database named
//! `FLIKS_HARNESS_DB_PREFIX` + hex, created through the superuser `FLIKS_HARNESS_PG_URL`.

use crate::build::Crate;
use fliks_server::net::guard::{Net, SystemNet};
use fliks_server::plugins::runtime::{CallError, HostConfig, PluginRt, State};
use fliks_server::plugins::{HealthReport, HttpRequest, HttpResponse, Options, Plugins, Principal};
use fliks_server::{config::Config, state::AppState};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Connection, PgConnection, PgPool};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpStream;

pub use fliks_server;

pub type Tune = Arc<dyn Fn(&mut HostConfig) + Send + Sync>;

/// What to install and how to run it.
pub struct Setup {
    pub template: Value,
    pub version: String,
    pub wasm: Vec<u8>,
    pub logo: Option<(String, Vec<u8>)>,
    /// `plugin.<id>.<key>` values written before the install, so `hello` and `start` see them.
    pub config: Vec<(String, String)>,
    /// Adds `network: {internal: true}` to the manifest (rule 4).
    pub network_internal: bool,
    pub tune: Option<Tune>,
    pub targets: Arc<Targets>,
}

impl Setup {
    /// The crate's template, logo, version and its already built release component.
    pub fn from_crate(dir: impl Into<PathBuf>) -> Setup {
        let c = Crate::at(&dir.into()).expect("a plugin crate");
        let wasm = std::fs::read(c.wasm_path()).unwrap_or_else(|e| {
            panic!(
                "{}: {e}; build it first (cargo build --release --target wasm32-wasip2)",
                c.wasm_path().display()
            )
        });
        let template = c.template().expect("plugin.template.json");
        let logo = template["logo"].as_str().map(|n| {
            let n = crate::build::logo_name(n).unwrap_or_else(|e| panic!("{e}"));
            (
                n.to_owned(),
                std::fs::read(c.dir.join(n)).expect("the logo"),
            )
        });
        Setup {
            template,
            version: c.version,
            wasm,
            logo,
            config: vec![],
            network_internal: false,
            tune: None,
            targets: Targets::new(),
        }
    }
}

/// Outbound name answers and connection routes for guest `wasi:http` requests. The host guard
/// still vets every answered address, so a private one is refused without `network.internal`.
pub struct Targets {
    names: Mutex<HashMap<String, Vec<IpAddr>>>,
    routes: Mutex<HashMap<SocketAddr, SocketAddr>>,
    /// Every vetted address a guest connected to, in order.
    pub connects: Mutex<Vec<SocketAddr>>,
    tls: SystemNet,
}

impl Targets {
    pub fn new() -> Arc<Targets> {
        Arc::new(Targets {
            names: Mutex::default(),
            routes: Mutex::default(),
            connects: Mutex::default(),
            tls: SystemNet::new(),
        })
    }

    /// `name` resolves to `ips`; an unknown name is not found (`DNS-error`).
    pub fn answer(&self, name: &str, ips: &[&str]) {
        let ips = ips.iter().map(|i| i.parse().expect("an IP")).collect();
        self.names.lock().unwrap().insert(name.to_owned(), ips);
    }

    /// Connections to `to` (as vetted) go to `local` instead, e.g. a stub server.
    pub fn route(&self, to: &str, local: SocketAddr) {
        let to = to.parse().expect("ip:port");
        self.routes.lock().unwrap().insert(to, local);
    }
}

impl Net for Targets {
    fn lookup(
        &self,
        host: &str,
        port: u16,
    ) -> BoxFuture<'static, std::io::Result<Vec<SocketAddr>>> {
        let r = match self.names.lock().unwrap().get(host) {
            Some(ips) => Ok(ips.iter().map(|ip| SocketAddr::new(*ip, port)).collect()),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no such host",
            )),
        };
        Box::pin(async move { r })
    }

    fn connect(&self, addr: SocketAddr) -> BoxFuture<'static, std::io::Result<TcpStream>> {
        self.connects.lock().unwrap().push(addr);
        let to = self
            .routes
            .lock()
            .unwrap()
            .get(&addr)
            .copied()
            .unwrap_or(addr);
        Box::pin(TcpStream::connect(to))
    }

    fn tls(&self) -> Arc<tokio_rustls::rustls::ClientConfig> {
        self.tls.tls()
    }
}

/// A row of `plugin_scheduled_calls`.
#[derive(Debug, Clone, PartialEq)]
pub struct Scheduled {
    pub key: String,
    pub payload: String,
    pub attempt: i32,
    /// Milliseconds until `runAt` on the host clock; negative when due.
    pub due_in_ms: i64,
}

pub struct Harness {
    pub st: AppState,
    /// The scratch core database (superuser): plugin schemas are `plugin_<id>`.
    pub pool: PgPool,
    pub targets: Arc<Targets>,
    pub id: String,
    token: String,
    _scratch: Scratch,
}

/// Drops the scratch database, its `fp_<oid>_*` roles and the runtime dir, panicking or not.
struct Scratch {
    db: String,
    admin: PgConnectOptions,
    dir: PathBuf,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let (db, admin) = (self.db.clone(), self.admin.clone());
        // Drop can't await, and blocking inside the test's runtime would panic.
        let done = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(sqlx::Error::Io)?
                .block_on(drop_database(&admin, &db))
        })
        .join();
        if !matches!(done, Ok(Ok(()))) {
            eprintln!("harness: could not drop the database {}: {done:?}", self.db);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn drop_database(admin: &PgConnectOptions, db: &str) -> sqlx::Result<()> {
    let mut c = PgConnection::connect_with(admin).await?;
    let oid: Option<String> = sqlx::query_scalar(
        "SELECT lpad(to_hex(oid::bigint), 8, '0') FROM pg_database WHERE datname = $1",
    )
    .bind(db)
    .fetch_optional(&mut c)
    .await?;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE IF EXISTS \"{db}\" WITH (FORCE)"
    )))
    .execute(&mut c)
    .await?;
    let Some(oid) = oid else { return Ok(()) };
    let roles: Vec<String> =
        sqlx::query_scalar("SELECT rolname::text FROM pg_roles WHERE rolname LIKE $1")
            .bind(format!("fp\\_{oid}\\_%"))
            .fetch_all(&mut c)
            .await?;
    for r in roles {
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP ROLE IF EXISTS \"{r}\"")))
            .execute(&mut c)
            .await?;
    }
    Ok(())
}

/// Under CI a missing input fails the test; locally it skips it, loudly.
pub fn skip(what: &str) {
    if std::env::var("CI").is_ok_and(|v| !matches!(v.as_str(), "" | "0" | "false")) {
        panic!("{what}: required under CI");
    }
    eprintln!("\n\x1b[1;33mWARNING: {what}: test SKIPPED\x1b[0m\n");
}

fn valid_prefix(p: &str) -> bool {
    let mut c = p.chars();
    c.next().is_some_and(|f| f.is_ascii_lowercase() || f == '_')
        && c.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && p.len() <= 55
}

const SECRET: &str = "0123456789abcdef0123456789abcdef";

fn log_ring() {
    use tracing_subscriber::prelude::*;
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = tracing_subscriber::registry()
            .with(fliks_server::system::logs::RingLayer)
            .try_init();
    });
}

impl Harness {
    /// A scratch database, the host, then the plugin installed (unsigned allowed) and ready.
    pub async fn start(setup: Setup) -> Option<Harness> {
        let Ok(url) = std::env::var("FLIKS_HARNESS_PG_URL") else {
            skip("FLIKS_HARNESS_PG_URL unset");
            return None;
        };
        let admin: PgConnectOptions = url.parse().expect("FLIKS_HARNESS_PG_URL");
        let prefix =
            std::env::var("FLIKS_HARNESS_DB_PREFIX").unwrap_or_else(|_| "fliks_harness_".into());
        assert!(
            valid_prefix(&prefix),
            "FLIKS_HARNESS_DB_PREFIX must match [a-z_][a-z0-9_]* (at most 55 characters)"
        );
        let db = format!("{prefix}{}", fliks_server::config::random_hex(4));
        let root =
            std::env::var("CARGO_TARGET_DIR").map_or_else(|_| std::env::temp_dir(), PathBuf::from);
        let dir = root.join("plugin-harness").join(&db);
        let mut c = PgConnection::connect_with(&admin)
            .await
            .expect("the admin URL");
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE \"{db}\"")))
            .execute(&mut c)
            .await
            .expect("CREATE DATABASE");
        let scratch = Scratch {
            db: db.clone(),
            admin: admin.clone(),
            dir: dir.clone(),
        };
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect_with(admin.database(&db))
            .await
            .expect("the scratch database");
        fliks_server::db::migrate(&pool)
            .await
            .expect("core migrations");
        sqlx::query("DELETE FROM plugin_sources")
            .execute(&pool)
            .await
            .expect("no catalog sources");

        std::fs::create_dir_all(&dir).expect("the runtime dir");
        log_ring();
        let mut st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
        let opts = pool.connect_options();
        let fetch = fliks_server::plugins::fetch::Fetcher {
            net: setup.targets.clone(),
            ..Default::default()
        };
        let user_tune = setup.tune.clone();
        st.plugins = Arc::new(Plugins::new(
            pool.clone(),
            Options {
                version: "6.0.0".into(),
                runtime_dir: dir,
                disabled: false,
                pg: fliks_server::plugins::db::PgTarget {
                    host: opts.get_host().to_owned(),
                    port: opts.get_port(),
                    dbname: db.clone(),
                },
                tune: Some(Arc::new(move |c: &mut HostConfig| {
                    c.compile_in_process = true;
                    if let Some(t) = &user_tune {
                        t(c);
                    }
                })),
                fetch,
                keys: fliks_server::plugins::trust::official_keys(),
                ready_wait: Duration::from_secs(15),
            },
        ));
        st.plugins.attach(&st);
        st.plugins.spawn(&st);

        let id = setup.template["id"].as_str().expect("an id").to_owned();
        let mut settings = vec![("plugins.allow_unsigned".to_owned(), Some("true".to_owned()))];
        for (k, v) in &setup.config {
            settings.push((format!("plugin.{id}.{k}"), Some(v.clone())));
        }
        fliks_server::settings::write(&st, &settings, None)
            .await
            .expect("settings");
        let mut template = setup.template.clone();
        if setup.network_internal {
            template["network"] = json!({ "internal": true });
        }
        let logo = setup.logo.as_ref().map(|(n, b)| (n.as_str(), b.as_slice()));
        let manifest = crate::build::manifest(&template, &setup.version, &setup.wasm, logo);
        let archive =
            crate::build::archive(&manifest, &setup.wasm, logo, None).expect("the archive");
        let report = st
            .plugins
            .inspect_and_stage(&archive, "manual")
            .await
            .unwrap_or_else(|e| panic!("inspect: {e:?}"));
        assert!(report.installable, "refused: {:?}", report.detail);
        let r = st
            .plugins
            .confirm(&report.staging_id.unwrap(), &report.sha256.unwrap())
            .await
            .unwrap_or_else(|e| panic!("confirm: {e:?}"));
        assert_eq!(r.status, "active", "{:?} {:?}", r.reason, r.detail);
        let uid: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin") VALUES ('admin', true)
               ON CONFLICT (username) DO UPDATE SET "isAdmin" = true RETURNING id"#,
        )
        .fetch_one(&pool)
        .await
        .expect("the admin user");
        let token = st.jwt.sign_access(uid, "admin").expect("a token").token;
        Some(Harness {
            st,
            pool,
            targets: setup.targets,
            id,
            token,
            _scratch: scratch,
        })
    }

    pub fn rt(&self) -> Arc<PluginRt> {
        self.st.plugins.rt(&self.id).expect("the plugin runs")
    }

    pub fn state(&self) -> Option<State> {
        self.st.plugins.state_of(&self.id)
    }

    /// The `http` export directly: no route resolution, policy, or response header filtering.
    pub async fn http(&self, req: HttpRequest) -> Result<HttpResponse, CallError> {
        self.rt().http(req, false).await
    }

    /// `/api/plugins/<id><path>` (with its query) through the host's proxy route, as an admin.
    pub async fn proxy(&self, method: &str, path: &str, body: Option<&Value>) -> HttpResponse {
        use axum::body::Body;
        use tower::ServiceExt;
        let req = axum::http::Request::builder()
            .method(method)
            .uri(format!("/api/plugins/{}{path}", self.id))
            .header("authorization", format!("Bearer {}", self.token));
        let req = match body {
            Some(b) => req
                .header("content-type", "application/json")
                .body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .expect("a request");
        let res = fliks_server::plugins::routes::router()
            .with_state(self.st.clone())
            .oneshot(req)
            .await
            .expect("the router is infallible");
        let status = res.status().as_u16();
        let headers = res
            .headers()
            .iter()
            .map(|(n, v)| (n.to_string(), String::from_utf8_lossy(v.as_bytes()).into()))
            .collect();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .expect("the body")
            .to_vec();
        HttpResponse {
            status,
            headers,
            body,
        }
    }

    pub async fn health(&self) -> Result<HealthReport, CallError> {
        self.rt().health().await
    }

    pub async fn job(&self, name: &str, args: Option<&str>) -> Result<(), CallError> {
        self.rt().job(name, args.map(str::to_owned)).await
    }

    /// The `scheduled` export directly, outside `plugin_scheduled_calls`.
    pub async fn scheduled(&self, key: &str, payload: &str, attempt: u32) -> Result<(), CallError> {
        self.rt()
            .scheduled(key.into(), payload.into(), attempt)
            .await
    }

    /// Queued on the `event` lane, delivered in order; observe the outcome (logs, rows).
    pub fn event(&self, name: &str, payload: &Value) {
        self.rt().push_event(name, &payload.to_string());
    }

    /// Writes `plugin.<id>.<key>`: the plugin sees `config-changed` before its next call.
    pub async fn set_config(&self, key: &str, value: Option<&str>) {
        let k = format!("plugin.{}.{key}", self.id);
        fliks_server::settings::write(&self.st, &[(k, value.map(str::to_owned))], None)
            .await
            .expect("settings");
    }

    /// `hello` and `start` again on fresh instances (the admin restart; clears the breaker).
    pub async fn restart(&self) {
        self.st
            .plugins
            .restart(&self.id)
            .await
            .unwrap_or_else(|e| panic!("restart: {e:?}"));
    }

    /// Moves the scheduled-call clock: every pending `runAt` comes `by` closer, then the
    /// claimer wakes. A lease ends the same way, so `advance` past it redelivers.
    pub async fn advance(&self, by: Duration) {
        sqlx::query(
            r#"UPDATE plugin_scheduled_calls SET "runAt" = "runAt" - $2 * interval '1 millisecond'
               WHERE "pluginId" = $1"#,
        )
        .bind(&self.id)
        .bind(by.as_millis() as f64)
        .execute(&self.pool)
        .await
        .expect("advance");
        if let Ok(h) = self.st.plugins.host() {
            h.env.wake.notify_one();
        }
    }

    pub async fn scheduled_calls(&self) -> Vec<Scheduled> {
        let rows: Vec<(String, String, i32, f64)> = sqlx::query_as(
            r#"SELECT key, payload, attempt,
                 (extract(epoch FROM "runAt" - now()) * 1000)::float8
               FROM plugin_scheduled_calls WHERE "pluginId" = $1 ORDER BY "runAt", key"#,
        )
        .bind(&self.id)
        .fetch_all(&self.pool)
        .await
        .expect("plugin_scheduled_calls");
        rows.into_iter()
            .map(|(key, payload, attempt, ms)| Scheduled {
                key,
                payload,
                attempt,
                due_in_ms: ms.round() as i64,
            })
            .collect()
    }

    /// This plugin's log lines (its `log` import and stdio), oldest first.
    pub fn logs(&self) -> Vec<String> {
        let ctx = format!("plugin:{}", self.id);
        let mut l: Vec<String> = fliks_server::system::logs::query("", "", None)
            .into_iter()
            .filter(|e| e.context == ctx)
            .map(|e| e.message)
            .collect();
        l.reverse();
        l
    }

    /// Stops the plugin (`shutdown`); dropping the harness then drops its database and roles.
    pub async fn finish(self) {
        self.st.plugins.shutdown().await;
        self.pool.close().await;
    }
}

/// A request as the proxy builds it, from user 1.
pub fn request(method: &str, path: &str, query: &[(&str, &str)], body: &[u8]) -> HttpRequest {
    HttpRequest {
        method: method.into(),
        path: path.into(),
        query: query
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect(),
        body: body.to_vec(),
        principal: Principal::Delegated(1),
    }
}

/// Polls `f` every 50 ms until it holds; panics after `max`.
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
