//! Engine glue (`docs/spec/engine-glue.md`): hello/adopt state machine, config owner, calls, job
//! waiters, events feed, the resolver and the remote-engine admin routes.
mod calls;
mod client;
mod config;
mod events;
mod jobs;
pub mod remote;
pub mod resolve;
mod store;
#[cfg(test)]
mod testkit;

pub use calls::{ConnectionTest, EngineError, SessionFilter};
pub use config::{lifetime, validate_streaming_setting};
pub use events::Feed;
pub use jobs::Progress;
pub use remote::router;

use client::Client;
use fliks_engine_core::api::{Hello, LiveTvConfig, PathMapping};
use serde::Serialize;
use sqlx::PgPool;
use std::{
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::Duration,
};
use tokio::{
    sync::{broadcast, watch},
    task::JoinHandle,
};

const MIN_PROTOCOL: u32 = 1;
const REQUIRED_FEATURES: [&str; 2] = ["probe", "capabilities"];
/// Playback (sessions, data plane, events) runs only when the engine announces all three.
const RUNTIME_FEATURES: [&str; 3] = ["sessions", "serve", "events"];

/// What this build advertises, and the engine feature each needs (`server-features.ts`).
const SERVER_FEATURES: [(&str, &str); 3] = [
    ("deviceProfileExtensions", "decide"),
    ("hlsSubtitleRequest", "serve"),
    ("muxedAudioRendition", "serve"),
];

/// Deadlines and intervals; tests shrink them, the real ones are the contract.
#[derive(Clone, Copy)]
pub(crate) struct Timing {
    pub hello_attempts: u32,
    pub hello_retry: Duration,
    pub poll: Duration,
    pub events_idle: Duration,
    pub events_min: Duration,
    pub events_max: Duration,
    /// One second: the unit of `Retry-After` and of the GPU re-pin poll.
    pub second: Duration,
    pub capabilities_deadline: Duration,
    pub open_deadline: Duration,
    pub conflict_backoff: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            hello_attempts: 20,
            hello_retry: Duration::from_millis(500),
            poll: Duration::from_secs(10),
            events_idle: Duration::from_secs(45),
            events_min: Duration::from_millis(500),
            events_max: Duration::from_secs(15),
            second: Duration::from_secs(1),
            capabilities_deadline: Duration::from_secs(5 * 60),
            open_deadline: Duration::from_secs(15),
            conflict_backoff: Duration::from_millis(100),
        }
    }
}

/// `off`: nothing configured; `down`: configured but not answering or refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Off,
    Up,
    Down,
}

struct State {
    epoch: u64,
    client: Option<Client>,
    candidate: Option<Client>,
    hello: Option<Hello>,
    reachable: bool,
    stored_url: String,
    stored_token: String,
    path_mappings: Vec<PathMapping>,
    delay: Duration,
    poll: Option<JoinHandle<()>>,
    refusal: Option<String>,
    push_needed: bool,
}

/// Revision and dedupe key of the last accepted `PUT /v1/config`.
#[derive(Default)]
struct Pushed {
    revision: u32,
    last_pushed: String,
}

struct Inner {
    host_token: String,
    env_url: String,
    env_token: String,
    timing: Timing,
    db: OnceLock<Option<PgPool>>,
    host_url: OnceLock<String>,
    state: Mutex<State>,
    pushed: tokio::sync::Mutex<Pushed>,
    livetv: Mutex<Option<LiveTvConfig>>,
    feed: broadcast::Sender<Feed>,
    adoptions: watch::Sender<u64>,
    jobs: jobs::Waiters,
}

/// The one engine of the process: cheap to clone, every clone shares the state machine.
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

impl Engine {
    /// `url`/`token` are the process env (`FLIKS_ENGINE_URL`/`_TOKEN`); saved settings win once `start` ran.
    pub fn new(url: &str, token: &str) -> Self {
        Self::with_timing(url, token, Timing::default())
    }

    pub(crate) fn with_timing(url: &str, token: &str, timing: Timing) -> Self {
        Self {
            inner: Arc::new(Inner {
                host_token: crate::config::random_hex(32),
                env_url: url.to_owned(),
                env_token: token.to_owned(),
                timing,
                db: OnceLock::new(),
                host_url: OnceLock::new(),
                state: Mutex::new(State {
                    epoch: 0,
                    client: None,
                    candidate: None,
                    hello: None,
                    reachable: false,
                    stored_url: String::new(),
                    stored_token: String::new(),
                    path_mappings: vec![],
                    delay: timing.hello_retry,
                    poll: None,
                    refusal: None,
                    push_needed: false,
                }),
                pushed: tokio::sync::Mutex::default(),
                livetv: Mutex::new(None),
                feed: broadcast::channel(4096).0,
                adoptions: watch::channel(0).0,
                jobs: jobs::Waiters::default(),
            }),
        }
    }

    /// Boot: reads the saved engine settings, runs the handshake (never longer than the hello retries,
    /// whatever its outcome), then keeps polling and following the events in the background.
    pub async fn start(&self, db: PgPool, port: u16) {
        self.start_with(Some(db), port).await;
    }

    pub(crate) async fn start_with(&self, db: Option<PgPool>, port: u16) {
        let i = &self.inner;
        let _ = (i.db.set(db), i.host_url.set(config::host_url(port)));
        let epoch = self.state().epoch;
        self.init(epoch).await;
        tokio::spawn(events::follow(self.clone()));
    }

    /// Random per process: the engine presents it to the resolver as its bearer.
    pub fn host_token(&self) -> &str {
        &self.inner.host_token
    }

    /// True once the engine answered `hello` with a compatible protocol.
    pub fn enabled(&self) -> bool {
        self.state().client.is_some()
    }

    /// The engine runs playback; without it playback-info answers 503.
    pub fn runtime(&self) -> bool {
        let s = self.state();
        s.client.is_some()
            && s.hello
                .as_ref()
                .is_some_and(|h| RUNTIME_FEATURES.iter().all(|f| has(h, f)))
    }

    pub fn status(&self) -> Status {
        let s = self.state();
        if self.configured_url(&s).is_empty() {
            Status::Off
        } else if s.client.is_none() {
            if s.candidate.is_some() {
                Status::Down
            } else {
                Status::Off
            }
        } else if s.reachable {
            Status::Up
        } else {
            Status::Down
        }
    }

    /// The saved URL and `FLIKS_ENGINE_URL` name two engines; video still follows the process one.
    pub fn gateway_mismatch(&self) -> bool {
        urls_differ(&self.state().stored_url, &self.inner.env_url)
    }

    /// `hello.features` of the adopted engine, empty without one.
    pub fn engine_features(&self) -> Vec<String> {
        let s = self.state();
        s.client
            .as_ref()
            .and(s.hello.as_ref())
            .map_or_else(Vec::new, |h| h.features.clone())
    }

    /// The adopted engine's last `hello` (refreshed by the 10 s poll).
    pub async fn hello(&self) -> Option<Hello> {
        let s = self.state();
        s.client.as_ref().and(s.hello.clone())
    }

    /// Server features the adopted engine backs (`GET /auth/me`); empty while none is adopted.
    pub async fn features(&self) -> Vec<&'static str> {
        self.hello().await.map_or_else(Vec::new, |h| {
            SERVER_FEATURES
                .iter()
                .filter(|(_, needed)| has(&h, needed))
                .map(|(name, _)| *name)
                .collect()
        })
    }

    /// Ordered events of the engine for presence, QoE and live TV; see [`Feed`].
    pub fn subscribe(&self) -> broadcast::Receiver<Feed> {
        self.inner.feed.subscribe()
    }

    /// Bumps on every adoption and on `reconfigure`: the signal "the engine (re)appeared".
    pub fn adoptions(&self) -> watch::Receiver<u64> {
        self.inner.adoptions.subscribe()
    }

    /// Drops and reopens the events connection, which resyncs the sessions (a lagged subscriber does it).
    pub fn resync_events(&self) {
        self.inner.adoptions.send_modify(|g| *g += 1);
    }

    /// Drops the engine and reconnects from the saved settings or the env; waits for the handshake.
    pub async fn reconfigure(&self) {
        let epoch = {
            let mut s = self.state();
            s.epoch += 1;
            if let Some(poll) = s.poll.take() {
                poll.abort();
            }
            (s.client, s.candidate, s.hello, s.reachable) = (None, None, None, false);
            s.epoch
        };
        self.resync_events();
        self.init(epoch).await;
    }

    /// `POST /v1/revoke` for a deleted or demoted owner when the engine announces `revoke`; never fails.
    pub async fn revoke_owner(&self, user_id: i32) {
        let (client, revoke) = {
            let s = self.state();
            let revoke = s.hello.as_ref().is_some_and(|h| has(h, "revoke"));
            (s.client.clone(), revoke)
        };
        let Some(client) = client.filter(|_| revoke) else {
            return;
        };
        let body = serde_json::json!({"ownerId": user_id.to_string()});
        match client
            .send(reqwest::Method::POST, "/v1/revoke", &body)
            .await
        {
            Ok(r) if !r.ok() => tracing::warn!("POST /v1/revoke -> {}", r.status.as_u16()),
            Err(e) => tracing::warn!("POST /v1/revoke failed: {}", e.without_url()),
            Ok(_) => {}
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().expect("engine state")
    }

    fn db(&self) -> Option<&PgPool> {
        self.inner.db.get()?.as_ref()
    }

    fn timing(&self) -> Timing {
        self.inner.timing
    }

    /// The adopted client, or a 503 for the caller.
    fn need(&self) -> Result<Client, EngineError> {
        self.state().client.clone().ok_or(EngineError::NotRunning)
    }

    fn current(&self, epoch: u64) -> bool {
        self.state().epoch == epoch
    }

    fn configured_url(&self, s: &State) -> String {
        let stored = s.stored_url.trim();
        if stored.is_empty() {
            self.inner.env_url.clone()
        } else {
            stored.to_owned()
        }
    }

    fn effective_token(&self, s: &State) -> String {
        let stored = s.stored_token.trim();
        if stored.is_empty() {
            self.inner.env_token.clone()
        } else {
            stored.to_owned()
        }
    }

    /// The URL and token a connection test falls back to when its own are blank.
    pub(crate) fn configured(&self) -> (String, String) {
        let s = self.state();
        (self.configured_url(&s), self.effective_token(&s))
    }

    async fn load_remote_settings(&self) {
        let Some(db) = self.db() else { return };
        match store::engine_settings(db).await {
            Ok((url, token, mappings)) => {
                let mut s = self.state();
                (s.stored_url, s.stored_token, s.path_mappings) = (url, token, mappings);
            }
            Err(e) => {
                tracing::warn!(error = %e, "engine settings not read: keeping the previous ones")
            }
        }
    }

    async fn init(&self, epoch: u64) {
        self.load_remote_settings().await;
        if !self.current(epoch) {
            return;
        }
        let (url, token) = self.configured();
        if url.is_empty() || token.is_empty() {
            tracing::error!(
                "FLIKS_ENGINE_URL/FLIKS_ENGINE_TOKEN unset: playback is unavailable without the engine"
            );
            return;
        }
        self.connect(Client::new(&url, &token), epoch).await;
    }

    /// Handshake: retries while the engine starts, then keeps going in the background.
    async fn connect(&self, client: Client, epoch: u64) {
        if !self.current(epoch) {
            return;
        }
        self.state().candidate = Some(client.clone());
        let t = self.timing();
        for _ in 0..t.hello_attempts {
            let hello = fetch_hello(&client).await;
            if !self.current(epoch) {
                return;
            }
            if let Some(h) = hello {
                self.adopted_or_retry(&client, &h, epoch).await;
                return;
            }
            tokio::time::sleep(t.hello_retry).await;
            if !self.current(epoch) {
                return;
            }
        }
        if self.current(epoch) {
            tracing::error!(
                "engine did not answer /v1/hello: no playback until it does, retrying in the background"
            );
            self.schedule(self.backoff(), epoch);
        }
    }

    /// A refusal or a failed `GET /v1/config` never stops the poll: it retries with the hello backoff.
    async fn adopted_or_retry(&self, client: &Client, hello: &Hello, epoch: u64) {
        match self.adopt(client, hello, epoch).await {
            Adopt::Adopted => self.schedule(self.timing().poll, epoch),
            Adopt::Refused | Adopt::Failed => self.schedule(self.backoff(), epoch),
            Adopt::Stale => {}
        }
    }

    /// Validates the engine, takes it as the current instance and pushes the config.
    async fn adopt(&self, client: &Client, h: &Hello, epoch: u64) -> Adopt {
        if !self.current(epoch) {
            return Adopt::Stale;
        }
        let missing: Vec<&str> = REQUIRED_FEATURES
            .into_iter()
            .filter(|f| !has(h, f))
            .collect();
        let refusal = if h.protocol_version < MIN_PROTOCOL {
            Some(format!(
                "engine protocol {} < {MIN_PROTOCOL} (engine {})",
                h.protocol_version, h.engine_version
            ))
        } else if !missing.is_empty() {
            Some(format!("engine lacks features {}", missing.join(", ")))
        } else {
            None
        };
        if let Some(r) = refusal {
            let was_adopted = {
                let mut s = self.state();
                // The poll keeps retrying: say it once, not every 10 s.
                if s.refusal.as_ref() != Some(&r) {
                    tracing::error!("{r}: engine disabled");
                    s.refusal = Some(r);
                }
                s.client.take().is_some()
            };
            if was_adopted {
                self.resync_events();
            }
            return Adopt::Refused;
        }
        let revision = match client.get("/v1/config", &[]).await {
            Ok(r) => r
                .ok()
                .then(|| r.body.as_ref()?.get("revision")?.as_u64())
                .flatten()
                .map_or(0, |v| v as u32),
            Err(e) => {
                tracing::warn!("GET /v1/config failed: {}", e.without_url());
                return Adopt::Failed;
            }
        };
        if !self.current(epoch) {
            return Adopt::Stale;
        }
        *self.inner.pushed.lock().await = Pushed {
            revision,
            last_pushed: String::new(),
        };
        {
            let mut s = self.state();
            if s.epoch != epoch {
                return Adopt::Stale;
            }
            s.hello = Some(h.clone());
            s.client = Some(client.clone());
            s.reachable = true;
            s.delay = self.timing().hello_retry;
            s.refusal = None;
            s.push_needed = true;
        }
        tracing::info!(
            "engine {} hello OK (protocol {}, features {})",
            h.engine_version,
            h.protocol_version,
            h.features.join(",")
        );
        self.push_logged().await;
        self.resync_events();
        Adopt::Adopted
    }

    fn backoff(&self) -> Duration {
        let cap = self.timing().poll;
        let mut s = self.state();
        s.delay = (s.delay * 2).min(cap);
        s.delay
    }

    fn schedule(&self, after: Duration, epoch: u64) {
        let engine = self.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(after).await;
            engine.tick(epoch).await;
        });
        self.state().poll = Some(task);
    }

    /// Background step: reconnect while down, otherwise detect an engine restart by its instance id.
    async fn tick(&self, epoch: u64) {
        let Some(client) = ({
            let s = self.state();
            (s.epoch == epoch).then(|| s.candidate.clone()).flatten()
        }) else {
            return;
        };
        let hello = fetch_hello(&client).await;
        if !self.current(epoch) {
            return;
        }
        let (connected, same, push_needed) = {
            let mut s = self.state();
            s.reachable = hello.is_some();
            let same = hello
                .as_ref()
                .zip(s.hello.as_ref())
                .is_some_and(|(a, b)| a.instance_id == b.instance_id);
            (s.client.is_some(), same, s.push_needed)
        };
        let poll = self.timing().poll;
        let Some(h) = hello else {
            self.schedule(if connected { poll } else { self.backoff() }, epoch);
            return;
        };
        if connected && same {
            if push_needed {
                self.push_logged().await;
            }
            self.schedule(poll, epoch);
            return;
        }
        if connected {
            tracing::info!("engine restarted: reloading config and capabilities");
        }
        self.adopted_or_retry(&client, &h, epoch).await;
    }
}

enum Adopt {
    Adopted,
    Refused,
    Failed,
    Stale,
}

fn has(h: &Hello, feature: &str) -> bool {
    h.features.iter().any(|f| f == feature)
}

/// `GET /v1/hello`; `None` when it throws or is not a 2xx JSON answer.
async fn fetch_hello(client: &Client) -> Option<Hello> {
    client.get("/v1/hello", &[]).await.ok()?.data()
}

fn origin(url: &str) -> &str {
    url.trim().trim_end_matches('/')
}

/// Both set and naming different engines (trailing slashes ignored).
pub(crate) fn urls_differ(saved: &str, process: &str) -> bool {
    let (a, b) = (origin(saved), origin(process));
    !a.is_empty() && !b.is_empty() && a != b
}

#[cfg(test)]
mod http_tests;
#[cfg(test)]
mod tests;
