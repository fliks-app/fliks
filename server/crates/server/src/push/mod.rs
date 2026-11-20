//! Push notifications (`docs/spec/push.md`): the pipeline, the relay connection, Web Push.
mod act;
mod catalogue;
mod crypto;
mod db;
mod identity;
mod relay;
mod routes;
mod text;
mod webpush;

pub use act::{ACTIONS, Grant, mint as mint_action};
pub use catalogue::{ReqRef, media_url, poster, request_event};
pub use routes::{
    __path_act, __path_config, __path_pending_drop, __path_status, __path_subscribe, __path_test,
    __path_unsubscribe, router,
};
pub use text::Msg;

use crate::{
    config::Config,
    events::SseEvent,
    http::auth::Authed,
    state::AppState,
    sync::{MutexExt, RwLockExt},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use db::Sub;
use fliks_domain::push::{PLAINTEXT_MAX, fit};
use relay::Relay;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::{
    sync::{Arc, Mutex, OnceLock, RwLock},
    time::Duration,
};
use tokio::sync::Semaphore;

/// The official relay; the Android and iOS apps compile in the same host.
pub const DEFAULT_RELAY_URL: &str = "https://push-relay.fliks.media";
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const CONCURRENT_SENDS: usize = 8;
const TICK: Duration = Duration::from_secs(600);
/// Subscriptions one user may hold, any platform.
pub const USER_CAP: i64 = 10;
const MAX_TTL: u32 = 259_200;

pub enum ActionSpec {
    Open {
        id: &'static str,
        url: String,
    },
    Call {
        id: &'static str,
        action: &'static str,
        target: i32,
    },
}

/// What the pipeline sends; text is rendered per recipient language.
pub struct Notification {
    pub category: String,
    pub title: Msg,
    pub body: Msg,
    pub url: String,
    pub image: Option<String>,
    pub actions: Vec<ActionSpec>,
    pub ttl: u32,
    pub urgent: bool,
    pub tag: Option<String>,
}

impl Notification {
    /// A core notification whose title and body are `push.<key>.title` and `.body`.
    pub fn core(
        category: &str,
        key: &str,
        params: &Map<String, Value>,
        url: String,
        ttl: u32,
    ) -> Self {
        Self {
            category: category.to_owned(),
            title: Msg::core(format!("{key}.title"), params),
            body: Msg::core(format!("{key}.body"), params),
            url,
            image: None,
            actions: vec![],
            ttl,
            urgent: false,
            tag: None,
        }
    }
}

#[derive(Default)]
struct State {
    registered: bool,
    error: Option<String>,
    pending_error: Option<String>,
}

pub struct Push {
    cfg: Config,
    identity: OnceLock<identity::Identity>,
    pub(crate) texts: text::Texts,
    client: RwLock<Option<Arc<Relay>>>,
    state: Mutex<State>,
    reconciling: tokio::sync::Mutex<()>,
    sends: Arc<Semaphore>,
    vapid: webpush::Tokens,
    pub(crate) episodes: catalogue::Episodes,
}

pub enum Unready {
    Disabled,
    Unavailable,
}

/// The plaintext of one notification for one recipient: also the `notification` SSE event.
#[derive(Serialize)]
struct Plain {
    v: u8,
    id: String,
    ts: i64,
    ttl: u32,
    cat: String,
    title: String,
    body: String,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    actions: Vec<Value>,
    badge: i64,
    user: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    tag: Option<String>,
}

impl Plain {
    /// The JSON to encrypt, with the body then the title shortened to fit (`push.md` rule 18); `None`
    /// when even empty texts leave it too large (a huge `url` or `image`).
    fn bytes(&mut self) -> Option<Vec<u8>> {
        let (title, body) = (
            std::mem::take(&mut self.title),
            std::mem::take(&mut self.body),
        );
        let base = serde_json::to_vec(&*self).expect("typed plaintext").len() - 4;
        (self.title, self.body) = (title, body);
        let jl = |s: &str| serde_json::to_string(s).map_or(2, |j| j.len());
        fit(&mut self.title, &mut self.body, PLAINTEXT_MAX, |t, b| {
            base + jl(t) + jl(b)
        })
        .then(|| serde_json::to_vec(&*self).expect("typed plaintext"))
    }

    fn event(self) -> SseEvent {
        SseEvent::Notification {
            id: self.id,
            ts: self.ts,
            ttl: i64::from(self.ttl),
            cat: self.cat,
            title: self.title,
            body: self.body,
            url: self.url,
            image: self.image,
            actions: (!self.actions.is_empty()).then_some(Value::Array(self.actions)),
            badge: self.badge,
            tag: self.tag,
        }
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

impl Push {
    pub fn new(cfg: &Config) -> Self {
        Self {
            texts: text::Texts::new(cfg.serve_static_path.as_deref()),
            cfg: cfg.clone(),
            identity: OnceLock::new(),
            client: RwLock::new(None),
            state: Mutex::default(),
            reconciling: tokio::sync::Mutex::new(()),
            sends: Arc::new(Semaphore::new(CONCURRENT_SENDS)),
            vapid: webpush::Tokens::default(),
            episodes: catalogue::Episodes::default(),
        }
    }

    fn identity(&self) -> &identity::Identity {
        self.identity
            .get_or_init(|| identity::Identity::load(&self.cfg))
    }

    pub fn vapid_public_key(&self) -> String {
        webpush::public_key(&self.identity().vapid())
    }

    fn relay_url(&self) -> String {
        self.cfg
            .push_relay_url
            .clone()
            .unwrap_or_else(|| DEFAULT_RELAY_URL.to_owned())
    }

    fn client(&self) -> Option<Arc<Relay>> {
        self.client.read_clean().clone()
    }

    /// The relay client once registered.
    fn ready_client(&self) -> Option<Arc<Relay>> {
        self.state
            .lock_clean()
            .registered
            .then(|| self.client())
            .flatten()
    }

    fn set_error(&self, e: Option<String>) {
        let mut s = self.state.lock_clean();
        s.registered = e.is_none();
        s.error = e;
    }

    /// Compares the identity file with the connection's `enabled` flag (`push.md` rule 20).
    pub async fn reconcile(&self, st: &AppState) {
        let _one = self.reconciling.lock().await;
        let enabled = match db::relay_enabled(&st.db).await {
            Ok(e) => e,
            Err(e) => return tracing::warn!("push reconcile: {e}"),
        };
        let id = self.identity();
        if enabled {
            self.enable(id).await;
        } else {
            self.disable(st, id).await;
        }
        self.drain_pending(id).await;
    }

    async fn enable(&self, id: &identity::Identity) {
        let url = self.relay_url();
        let current = match id.snapshot().relay {
            Some(c) if c.url == url => c,
            _ => {
                let fresh = identity::Server {
                    url,
                    seed: identity::hex(&identity::random::<32>()),
                };
                let kept = fresh.clone();
                let saved = id.update(|d| {
                    if let Some(old) = d.relay.replace(kept) {
                        d.pending.push(old);
                    }
                });
                if let Err(e) = saved {
                    tracing::warn!("cannot write the push identity: {e}");
                }
                *self.client.write_clean() = None;
                self.set_error(Some("not registered yet".into()));
                fresh
            }
        };
        if self.ready_client().is_some() {
            return;
        }
        let relay = match Relay::new(&current.url, &current.seed) {
            Ok(r) => Arc::new(r),
            Err(e) => return self.set_error(Some(e)),
        };
        *self.client.write_clean() = Some(relay.clone());
        let registered = async {
            let info = relay.info().await?;
            if info["api"] != 1 {
                return Ok(Some("the relay speaks another protocol version".to_owned()));
            }
            relay.register().await.map(|()| None)
        }
        .await;
        match registered {
            Ok(None) => self.set_error(None),
            Ok(Some(e)) => self.set_error(Some(e)),
            Err(e) => {
                tracing::warn!("relay registration failed: {e}");
                self.set_error(Some(e.to_string()));
            }
        }
    }

    async fn disable(&self, st: &AppState, id: &identity::Identity) {
        let had = id.snapshot().relay.is_some();
        if had {
            if let Err(e) = db::delete_mobile(&st.db).await {
                return tracing::warn!("cannot delete the mobile subscriptions: {e}");
            }
            let saved = id.update(|d| {
                if let Some(old) = d.relay.take() {
                    d.pending.push(old);
                }
            });
            if let Err(e) = saved {
                tracing::warn!("cannot write the push identity: {e}");
            }
        }
        *self.client.write_clean() = None;
        let mut s = self.state.lock_clean();
        s.registered = false;
        s.error = None;
    }

    async fn drain_pending(&self, id: &identity::Identity) {
        let mut error = None;
        for p in id.snapshot().pending {
            let done = match Relay::new(&p.url, &p.seed) {
                Ok(r) => r.delete_self().await.map_err(|e| e.to_string()),
                Err(e) => Err(e),
            };
            match done {
                Ok(()) => {
                    let _ = id.update(|d| d.pending.retain(|x| *x != p));
                }
                Err(e) => {
                    tracing::warn!("relay deletion pending: {e}");
                    error = Some(e);
                }
            }
        }
        self.state.lock_clean().pending_error = error;
    }

    pub fn spawn_reconcile(&self, st: &AppState) {
        let st = st.clone();
        tokio::spawn(async move { st.push.reconcile(&st).await });
    }

    /// The registered relay client, trying one inline reconcile when the connection is on but not registered.
    pub async fn ready(&self, st: &AppState) -> Result<Arc<Relay>, Unready> {
        if !db::relay_enabled(&st.db).await.unwrap_or(false) {
            return Err(Unready::Disabled);
        }
        if let Some(r) = self.ready_client() {
            return Ok(r);
        }
        self.reconcile(st).await;
        self.ready_client().ok_or(Unready::Unavailable)
    }

    /// The client that can delete subscriptions: the live one, else one built from the identity file
    /// (a request can come before the first reconcile); `None` when there is no relay identity.
    fn delete_client(&self) -> Option<Arc<Relay>> {
        self.client().or_else(|| {
            let r = self.identity().snapshot().relay?;
            Relay::new(&r.url, &r.seed).ok().map(Arc::new)
        })
    }

    /// Deletes rows, mobile ones at the relay first; a row stays when the relay did not answer. False
    /// when a row stayed.
    pub async fn remove_rows(&self, st: &AppState, rows: Vec<Sub>) -> bool {
        let mut all = true;
        for row in rows {
            if let (true, Some(sub)) = (row.is_mobile(), &row.sub) {
                // With no relay identity the relay holds nothing of ours: the row goes alone.
                if let Some(relay) = self.delete_client() {
                    match relay.delete_subscription(sub).await {
                        Ok(()) => {}
                        Err(e) if matches!(e.status(), Some(401 | 404)) => {}
                        Err(e) => {
                            tracing::warn!("relay subscription deletion: {e}");
                            all = false;
                            continue;
                        }
                    }
                }
            }
            if let Err(e) = db::delete(&st.db, row.id).await {
                tracing::warn!("push row deletion: {e}");
                all = false;
            }
        }
        all
    }

    /// Deletes a replaced mobile subscription at the relay; its row is already gone.
    pub async fn forget_at_relay(&self, row: &Sub) {
        if let (Some(sub), Some(relay)) = (&row.sub, self.delete_client())
            && let Err(e) = relay.delete_subscription(sub).await
        {
            tracing::warn!("relay subscription deletion: {e}");
        }
    }

    /// Rows of revoked sessions and disabled users (`push.md` rule 45).
    pub async fn sweep(&self, st: &AppState) {
        match db::dead(&st.db).await {
            Ok(rows) if !rows.is_empty() => drop(self.remove_rows(st, rows).await),
            Ok(_) => {}
            Err(e) => tracing::warn!("push sweep: {e}"),
        }
    }

    pub fn spawn_sweep(&self, st: &AppState) {
        let st = st.clone();
        tokio::spawn(async move { st.push.sweep(&st).await });
    }

    /// Before a user row goes: their relay subscriptions first.
    pub async fn forget_user(&self, st: &AppState, user: i32) {
        if let Ok(rows) = db::of_user(&st.db, user).await {
            self.remove_rows(st, rows).await;
        }
    }

    fn build(
        &self,
        n: &Notification,
        user: i32,
        lang: &str,
        badge: i64,
        ts: i64,
        key: &[u8],
    ) -> Plain {
        let mut actions = vec![];
        for a in &n.actions {
            actions.push(match a {
                ActionSpec::Open { id, url } => json!({
                    "id": id, "title": self.texts.render(&Msg::core(format!("action.{id}"), &Map::new()), lang),
                    "kind": "open", "url": url,
                }),
                ActionSpec::Call { id, action, target } => json!({
                    "id": id, "title": self.texts.render(&Msg::core(format!("action.{id}"), &Map::new()), lang),
                    "kind": "call",
                    "token": act::mint(key, &Grant { user, action: (*action).to_owned(), target: *target, exp: ts + i64::from(n.ttl) }),
                }),
            });
        }
        Plain {
            v: 1,
            id: B64.encode(identity::random::<16>()),
            ts,
            ttl: n.ttl,
            cat: n.category.clone(),
            title: self.texts.render(&n.title, lang),
            body: self.texts.render(&n.body, lang),
            url: n.url.clone(),
            image: n.image.clone(),
            actions,
            badge,
            user,
            tag: n.tag.clone(),
        }
    }

    async fn vapid_sub(&self, db: &PgPool) -> String {
        if let Ok(Some(u)) = crate::auth::oidc::db::public_url(db).await {
            return u;
        }
        match db::admin_email(db).await {
            Ok(Some(e)) => format!("mailto:{e}"),
            _ => "mailto:admin@localhost.invalid".to_owned(),
        }
    }

    /// One encrypted send to one subscription; the row is deleted when its endpoint is gone.
    async fn deliver(
        &self,
        st: &AppState,
        row: &Sub,
        nid: &str,
        n: &Notification,
        plain: &[u8],
        vapid_sub: &str,
    ) -> Result<(), String> {
        let to = crypto::Recipient::parse(&row.p256dh, &row.auth).ok_or("bad subscription keys")?;
        let body = crypto::encrypt(plain, &to)?;
        if row.is_mobile() {
            self.deliver_mobile(st, row, nid, n.ttl.min(MAX_TTL), &body)
                .await
        } else {
            self.deliver_web(st, row, n, body, vapid_sub).await
        }
    }

    async fn deliver_mobile(
        &self,
        st: &AppState,
        row: &Sub,
        nid: &str,
        ttl: u32,
        body: &[u8],
    ) -> Result<(), String> {
        let relay = self.ready_client().ok_or("the relay is not available")?;
        let sub = row.sub.as_deref().ok_or("mobile row without sub")?;
        let mut res = relay.push(nid, sub, body, ttl).await;
        if matches!(&res, Err(e) if e.status() == Some(401) && e.code() == Some("unknown_server")) {
            relay.register().await.map_err(|e| e.to_string())?;
            res = relay.push(nid, sub, body, ttl).await;
        }
        match res {
            Ok(()) => Ok(()),
            Err(e) if e.code() == Some("duplicate") => Ok(()),
            Err(e) if e.code() == Some("unknown_subscription") => {
                let _ = db::delete(&st.db, row.id).await;
                Err("the device is no longer subscribed".into())
            }
            Err(e) => Err(e.to_string()),
        }
    }

    async fn deliver_web(
        &self,
        st: &AppState,
        row: &Sub,
        n: &Notification,
        body: Vec<u8>,
        vapid_sub: &str,
    ) -> Result<(), String> {
        let url = row
            .endpoint
            .as_deref()
            .and_then(webpush::endpoint)
            .ok_or("endpoint refused")?;
        let authorization =
            self.vapid
                .header(&self.identity().vapid(), &webpush::origin(&url), vapid_sub);
        match webpush::send(webpush::Request {
            url: &url,
            authorization,
            ttl: n.ttl.min(MAX_TTL),
            urgent: n.urgent,
            body,
        })
        .await
        {
            webpush::Outcome::Sent => Ok(()),
            webpush::Outcome::Gone => {
                let _ = db::delete(&st.db, row.id).await;
                Err("the browser is no longer subscribed".into())
            }
            webpush::Outcome::Failed(e) => Err(e),
        }
    }

    /// `POST /api/push/test`: sends to every subscription of `user` and reports each.
    pub async fn test(&self, st: &AppState, user: i32) -> sqlx::Result<Vec<Value>> {
        let n = Notification::core("account", "test", &Map::new(), "/".into(), 300);
        let rows = db::of_user(&st.db, user).await?;
        let nid = B64.encode(identity::random::<16>());
        let key = st.grant_key.clone();
        let (ts, badge) = (now(), self.attention_of(st, user).await);
        let vapid_sub = self.vapid_sub(&st.db).await;
        let n = &n;
        let (nid, key, vapid_sub) = (&nid, &key, &vapid_sub);
        self.texts.warm().await;
        let sends = rows.iter().map(|row| async move {
            let mut plain = self.build(n, user, &row.locale, badge, ts, key);
            let res = match plain.bytes() {
                None => Err("the notification is too large".to_owned()),
                Some(bytes) => {
                    let _slot = self.sends.acquire().await.map_err(|e| e.to_string())?;
                    tokio::time::timeout(
                        SEND_TIMEOUT,
                        self.deliver(st, row, nid, n, &bytes, vapid_sub),
                    )
                    .await
                    .unwrap_or_else(|_| Err("timeout".to_owned()))
                }
            };
            let mut out = json!({"platform": row.platform, "ok": res.is_ok()});
            if let Err(e) = res {
                out["error"] = e.into();
            }
            Ok::<_, String>(out)
        });
        let out: Vec<Value> = futures_util::future::join_all(sends)
            .await
            .into_iter()
            .flatten()
            .collect();
        st.hub.emit_to_user_langs(user, |lang| {
            self.build(n, user, lang.unwrap_or("en"), badge, ts, key)
                .event()
        });
        Ok(out)
    }

    async fn attention_of(&self, st: &AppState, user: i32) -> i64 {
        match Authed::load(&st.db, user).await {
            Ok(Some(a)) => attention(&st.db, &a).await.unwrap_or(0),
            _ => 0,
        }
    }

    async fn run(&self, st: &AppState, recipients: Vec<i32>, n: Notification) -> sqlx::Result<()> {
        let users = db::recipients(&st.db, &recipients, &n.category).await?;
        if users.is_empty() {
            return Ok(());
        }
        self.texts.warm().await;
        let rows = db::live(&st.db, &users).await?;
        let nid = B64.encode(identity::random::<16>());
        let ts = now();
        let vapid_sub = if rows.iter().any(|r| !r.is_mobile()) {
            self.vapid_sub(&st.db).await
        } else {
            String::new()
        };
        let n = Arc::new(n);
        for user in users {
            let badge = self.attention_of(st, user).await;
            st.hub.emit_to_user_langs(user, |lang| {
                self.build(&n, user, lang.unwrap_or("en"), badge, ts, &st.grant_key)
                    .event()
            });
            for row in rows.iter().filter(|r| r.user_id == user).cloned() {
                let Some(bytes) = self
                    .build(&n, user, &row.locale, badge, ts, &st.grant_key)
                    .bytes()
                else {
                    tracing::warn!("push notification too large for subscription {}", row.id);
                    continue;
                };
                // No queue: past the concurrent sends the device is skipped.
                let Ok(slot) = self.sends.clone().try_acquire_owned() else {
                    tracing::warn!("push sends are saturated: subscription {} skipped", row.id);
                    continue;
                };
                let (st, n, nid, vapid_sub) =
                    (st.clone(), n.clone(), nid.clone(), vapid_sub.clone());
                tokio::spawn(async move {
                    let _slot = slot;
                    let sent = tokio::time::timeout(
                        SEND_TIMEOUT,
                        st.push.deliver(&st, &row, &nid, &n, &bytes, &vapid_sub),
                    )
                    .await;
                    match sent {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => {
                            tracing::warn!("push to {} subscription {}: {e}", row.platform, row.id);
                        }
                        Err(_) => tracing::warn!("push to subscription {} timed out", row.id),
                    }
                });
            }
        }
        Ok(())
    }

    /// The `GET /api/push/status` body.
    pub async fn status(&self, st: &AppState) -> sqlx::Result<Value> {
        let enabled = db::relay_enabled(&st.db).await?;
        let snap = self.identity().snapshot();
        let (registered, error, pending_error) = {
            let s = self.state.lock_clean();
            (s.registered, s.error.clone(), s.pending_error.clone())
        };
        let state = match (enabled, registered) {
            (false, _) => "disabled",
            (true, true) => "ready",
            (true, false) => "error",
        };
        let stats = match (registered, self.client()) {
            (true, Some(r)) => r.stats().await.ok(),
            _ => None,
        };
        let pending: Vec<Value> = snap
            .pending
            .iter()
            .map(|p| json!({"relay": pending_host(&p.url), "key": relay::key_of_seed(&p.seed)}))
            .collect();
        Ok(json!({
            "relay": {
                "state": state,
                "url": self.relay_url(),
                "key": snap.relay.as_ref().and_then(|r| relay::key_of_seed(&r.seed)),
                "error": error.or(pending_error.filter(|_| !pending.is_empty())),
                "pendingDeletions": pending,
                "stats": stats,
            },
            "web": {"subscriptions": db::count(&st.db, true).await?},
            "mobile": {"subscriptions": db::count(&st.db, false).await?},
        }))
    }

    /// Drops the pending deletions of the relay at `host`; false when none matched.
    pub fn drop_pending(&self, host: &str) -> bool {
        let id = self.identity();
        let before = id.snapshot().pending.len();
        let _ = id.update(|d| d.pending.retain(|p| pending_host(&p.url) != host));
        id.snapshot().pending.len() < before
    }

    /// The `POST /api/notifications/:id/test` of the built-in connection.
    pub async fn check(&self, st: &AppState) -> Value {
        let relay = match self.ready(st).await {
            Ok(r) => r,
            Err(Unready::Disabled) => {
                return json!({"ok": false, "message": "Fliks Relay is disabled"});
            }
            Err(Unready::Unavailable) => {
                let e = self.state.lock_clean().error.clone().unwrap_or_default();
                return json!({"ok": false, "message": e});
            }
        };
        match relay.stats().await {
            Ok(_) => json!({"ok": true, "message": "Registered at the relay"}),
            Err(e) => json!({"ok": false, "message": e.to_string()}),
        }
    }
}

fn pending_host(url: &str) -> String {
    reqwest::Url::parse(url).map_or_else(|_| url.to_owned(), |u| relay::canonical_host(&u))
}

/// The enabled users of `ids` who have not muted `category`: who a send would reach.
pub async fn eligible(st: &AppState, ids: &[i32], category: &str) -> sqlx::Result<Vec<i32>> {
    db::recipients(&st.db, ids, category).await
}

/// The one entry point: filters the recipients and sends everywhere (`push.md` rule 1).
pub fn notify(st: &AppState, recipients: Vec<i32>, n: Notification) {
    if recipients.is_empty() {
        return;
    }
    let st = st.clone();
    tokio::spawn(async move {
        if let Err(e) = st.push.run(&st, recipients, n).await {
            tracing::warn!("push notify: {e}");
        }
    });
}

/// `counts.md` rule 16: requests waiting for this user's decision plus follow requests waiting for an answer.
pub async fn attention(db: &PgPool, a: &Authed) -> sqlx::Result<i64> {
    use crate::requests::flow;
    let requests = if flow::can_manage(a) {
        let libraries = match flow::is_super(a) {
            true => None,
            false => Some(crate::libraries::acl::accessible_library_ids(db, a).await?),
        };
        flow::pending_count(db, a, true, libraries.as_deref()).await?
    } else {
        0
    };
    let follows: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM user_follows WHERE "followingId" = $1 AND status = 'pending'"#,
    )
    .bind(a.user.id)
    .fetch_one(db)
    .await?;
    Ok(i64::from(requests) + follows)
}

/// Reconcile and sweep at boot, then every 10 minutes; the catalogue hooks.
pub fn init(st: &AppState) {
    catalogue::init(st);
    let st = st.clone();
    tokio::spawn(async move {
        loop {
            st.push.reconcile(&st).await;
            st.push.sweep(&st).await;
            tokio::time::sleep(TICK).await;
        }
    });
}
