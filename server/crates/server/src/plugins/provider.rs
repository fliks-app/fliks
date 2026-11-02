//! A provider plugin as a `MetadataProvider` (`docs/spec/provider-plugins.md`): calls on its
//! `provider` lane, errors mapped by rule 15, records validated by rule 14.
use super::runtime::{
    Budget, CallError, Inst, PluginRt, State, fliks::plugin::types::ExternalId, wit_provider as wit,
};
use super::{Plugins, packages};
use crate::metadata::{
    Call, Credits, EditionRef, Metadata, MetadataProvider, PersonDetails, Search, Upstream,
};
use fliks_domain::{
    external_id::ExternalProvider,
    media::kind::MediaKind,
    metadata::{
        language::Resolved,
        limiter::{Limits, Priority},
    },
};
use futures_util::{FutureExt, future::BoxFuture};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, atomic::Ordering};
use std::time::Duration;

/// Rule 49: a call that arrives while the provider starts waits this long for `ready`.
const READY_WAIT: Duration = Duration::from_secs(30);
/// Rule 14.
const MAX_RECORD: usize = 16 << 20;

/// What the manifest's `provider` block says, read once.
struct Block {
    namespaces: Vec<String>,
    kinds: Vec<(MediaKind, Vec<String>)>,
    find_by: Vec<String>,
    edition: Vec<String>,
    chapters: Vec<String>,
    image_hosts: Vec<String>,
    limits: Limits,
    /// `snapshotTtlSecs`: a resource it does not name is zero.
    ttl: HashMap<String, Option<Duration>>,
}

impl Block {
    fn parse(b: &Value) -> Self {
        let strs = |v: &Value| -> Vec<String> {
            v.as_array()
                .into_iter()
                .flatten()
                .filter_map(|n| n.as_str().map(str::to_owned))
                .collect()
        };
        let l = &b["limits"];
        Block {
            namespaces: b["namespaces"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|n| n["name"].as_str().map(str::to_owned))
                .collect(),
            kinds: b["kinds"]
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(k, caps)| Some((MediaKind::parse(k)?, strs(caps))))
                .collect(),
            find_by: strs(&b["findBy"]),
            edition: strs(&b["editionNamespaces"]),
            chapters: strs(&b["chapterNamespaces"]),
            image_hosts: strs(&b["imageHosts"]),
            limits: Limits {
                rate_per_sec: l["ratePerSec"].as_f64().unwrap_or(1.0),
                burst: l["burst"]
                    .as_u64()
                    .and_then(|b| u32::try_from(b).ok())
                    .filter(|b| *b >= 1)
                    .unwrap_or(1),
                daily_quota: l["dailyQuota"].as_u64().and_then(|q| u32::try_from(q).ok()),
                background_share: l["backgroundShare"].as_f64().unwrap_or(0.75),
            },
            ttl: b["snapshotTtlSecs"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.clone(), v.as_u64().map(Duration::from_secs)))
                .collect(),
        }
    }
}

pub struct PluginProvider {
    rt: Arc<PluginRt>,
    key: ExternalProvider,
    block: Block,
    /// The configured built-in of the same key: it answers what the plugin does not declare.
    shadow: Option<Arc<dyn MetadataProvider>>,
}

fn bad(why: &str) -> Upstream {
    Upstream::new(
        Some(502),
        format!("provider answered a malformed record: {why}"),
    )
}

fn undeclared() -> Upstream {
    Upstream::new(Some(404), "the provider does not declare this call")
}

/// Rule 14: a JSON document of at most 16 MiB, an object or (`array`) an array.
fn parse(json: &str, array: bool) -> Result<Value, Upstream> {
    if json.len() > MAX_RECORD {
        return Err(bad("over 16 MiB"));
    }
    let v: Value = serde_json::from_str(json).map_err(|_| bad("not JSON"))?;
    if array != v.is_array() || !(v.is_array() || v.is_object()) {
        return Err(bad(if array {
            "not an array"
        } else {
            "not an object"
        }));
    }
    Ok(v)
}

fn parse_list(json: &str) -> Result<Vec<Value>, Upstream> {
    match parse(json, true)? {
        Value::Array(a) if a.iter().all(Value::is_object) => Ok(a),
        Value::Array(_) => Err(bad("an element is not an object")),
        _ => unreachable!("checked"),
    }
}

fn lang_of(l: &Resolved) -> wit::Lang {
    wit::Lang {
        language: l.iso1.to_owned(),
        region: Some(l.region.clone()).filter(|r| !r.is_empty()),
        locale: l.tmdb_locale.clone(),
    }
}

fn call_error(e: CallError) -> Upstream {
    match e {
        CallError::Unavailable(m) => Upstream::new(Some(503), format!("provider {m}")),
        CallError::Busy => Upstream::new(Some(503), "provider busy"),
        CallError::Timeout => Upstream::new(Some(504), "provider call timed out"),
        CallError::Crashed(trap) => {
            tracing::warn!("provider call trapped: {trap}");
            Upstream::new(None, "provider crashed")
        }
        CallError::Guest(m) => Upstream::new(None, m),
    }
}

impl PluginProvider {
    /// The provider of a plugin whose first namespace is a core one; later namespaces are PV.10.
    pub fn new(rt: Arc<PluginRt>, md: &Metadata) -> Option<Self> {
        let b = rt.manifest.get("provider")?;
        let block = Block::parse(b);
        let key = ExternalProvider::parse(block.namespaces.first()?)?;
        Some(Self {
            rt,
            key,
            block,
            shadow: md.configured_builtin(key),
        })
    }

    /// `provider.imageHosts`: where the core may download this provider's images from.
    pub fn image_hosts(&self) -> &[String] {
        &self.block.image_hosts
    }

    fn declares(&self, kind: Option<MediaKind>, cap: &str) -> bool {
        self.block
            .kinds
            .iter()
            .any(|(k, caps)| kind.is_none_or(|w| w == *k) && caps.iter().any(|c| c == cap))
    }

    fn has(&self, kind: Option<MediaKind>, cap: &str) -> Result<(), Upstream> {
        self.declares(kind, cap)
            .then_some(())
            .ok_or_else(undeclared)
    }

    /// The built-in that answers a call the plugin does not declare, if there is one.
    fn built_in(&self, kind: Option<MediaKind>, cap: &str) -> Option<&Arc<dyn MetadataProvider>> {
        self.shadow.as_ref().filter(|_| !self.declares(kind, cap))
    }

    /// Rule 14, for the breaker: every record the plugin answered is counted once.
    fn checked<T>(&self, r: Result<T, Upstream>) -> Result<T, Upstream> {
        if let Some(gate) = &self.rt.sh.gate {
            gate.record_checked(r.is_ok());
        }
        r
    }

    fn record(&self, json: &str, array: bool) -> Result<Value, Upstream> {
        self.checked(parse(json, array))
    }

    fn list(&self, json: &str) -> Result<Vec<Value>, Upstream> {
        self.checked(parse_list(json))
    }

    fn own(&self, value: &str) -> ExternalId {
        ExternalId {
            provider: self.key.as_str().to_owned(),
            value: value.to_owned(),
        }
    }

    /// Rule 15 on top of the lane: the calls of one export, its deadline and queue wait by priority.
    async fn call<R: Send + 'static>(
        &self,
        long: bool,
        p: Priority,
        f: impl for<'a> FnOnce(
            &'a mut Inst,
        )
            -> BoxFuture<'a, wasmtime::Result<Result<R, wit::ProviderError>>>
        + Send
        + 'static,
    ) -> Result<R, Upstream> {
        let (secs, queue) = match (p, long) {
            (Priority::Interactive, false) => (20, 5),
            (Priority::Interactive, true) => (120, 5),
            (Priority::Background, false) => (120, 60),
            (Priority::Background, true) => (600, 60),
        };
        let budget = Budget {
            deadline: Duration::from_secs(secs),
            queue_wait: Duration::from_secs(queue),
            inclusive: false,
            soft: false,
            background: p == Priority::Background,
        };
        let cfg_gen = self.rt.config_gen();
        match self.rt.provider_call(budget, READY_WAIT, p, f).await {
            Ok(Ok(r)) => Ok(r),
            Ok(Err(e)) => Err(self.upstream(e, cfg_gen)),
            Err(e) => Err(call_error(e)),
        }
    }

    /// `cfg_gen`: the settings generation the call began under; a 401 of an older one is stale.
    fn upstream(&self, e: wit::ProviderError, cfg_gen: u64) -> Upstream {
        use wit::ProviderError as E;
        match e {
            E::NotFound | E::Unsupported => Upstream::new(Some(404), "not found"),
            E::Unauthorized => {
                self.rt
                    .sh
                    .unauthorized
                    .fetch_max(cfg_gen + 1, Ordering::SeqCst);
                Upstream::new(Some(401), "unauthorized")
            }
            E::RateLimited(retry) => {
                if let (Some(secs), Some(gate)) = (retry, &self.rt.sh.gate) {
                    gate.pause_secs(secs);
                }
                Upstream::new(Some(429), "rate limited")
            }
            E::Upstream(u) => Upstream::new(u.status, u.message),
        }
    }
}

impl MetadataProvider for PluginProvider {
    fn id(&self) -> ExternalProvider {
        self.key
    }

    fn supports(&self, kind: MediaKind) -> bool {
        self.block.kinds.iter().any(|(k, _)| *k == kind)
            || self.shadow.as_ref().is_some_and(|b| b.supports(kind))
    }

    fn has_persons(&self) -> bool {
        self.declares(None, "person") || self.shadow.as_ref().is_some_and(|b| b.has_persons())
    }

    fn limits(&self) -> Limits {
        let held = self.rt.sh.gate.as_ref().map(|g| g.limits());
        held.unwrap_or(self.block.limits)
    }

    fn available(&self) -> bool {
        let sh = &self.rt.sh;
        self.rt.state() == State::Ready
            && sh.requires_ok.load(Ordering::SeqCst)
            && sh.unauthorized.load(Ordering::SeqCst) <= self.rt.config_gen()
    }

    fn snapshot_ttl(&self, resource: &str) -> Option<Duration> {
        self.block
            .ttl
            .get(resource)
            .copied()
            .unwrap_or(Some(Duration::ZERO))
    }

    fn search<'a>(
        &'a self,
        q: &'a Search<'a>,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Vec<Value>> {
        async move {
            if let Some(b) = self.built_in(Some(q.kind), "search") {
                return b.search(q, lang, p).await;
            }
            self.has(Some(q.kind), "search")?;
            let wq = wit::SearchQuery {
                kind: q.kind.as_str().to_owned(),
                query: q.query.to_owned(),
                year: q.year.and_then(|y| i32::try_from(y).ok()),
                title: q.title.map(str::to_owned),
                author: q.author.map(str::to_owned),
                author_id: q.author_id.map(str::to_owned),
                isbn: q.isbn.map(str::to_owned),
                language: q.language.map(str::to_owned),
                page: q.page,
                extra: vec![],
            };
            let lang = lang_of(lang);
            let json = self
                .call(false, p, move |i| {
                    Box::pin(async move {
                        let (g, s) = i.provider();
                        g.call_search(s, &wq, &lang).await
                    })
                })
                .await?;
            self.list(&json)
        }
        .boxed()
    }

    fn fetch_work<'a>(
        &'a self,
        kind: MediaKind,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Value> {
        async move {
            if let Some(b) = self.built_in(Some(kind), "work") {
                return b.fetch_work(kind, id, lang, p).await;
            }
            self.has(Some(kind), "work")?;
            let (id, lang) = (self.own(id), lang_of(lang));
            let json = self
                .call(false, p, move |i| {
                    Box::pin(async move {
                        let (g, s) = i.provider();
                        g.call_fetch_work(s, &kind.as_str().to_owned(), &id, &lang)
                            .await
                    })
                })
                .await?;
            self.record(&json, false)
        }
        .boxed()
    }

    fn fetch_children<'a>(
        &'a self,
        kind: MediaKind,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Vec<Value>> {
        async move {
            if let Some(b) = self.built_in(Some(kind), "children") {
                return b.fetch_children(kind, id, lang, p).await;
            }
            self.has(Some(kind), "children")?;
            let (id, lang) = (self.own(id), lang_of(lang));
            let json = self
                .call(true, p, move |i| {
                    Box::pin(async move {
                        let (g, s) = i.provider();
                        g.call_fetch_children(s, &kind.as_str().to_owned(), &id, &lang)
                            .await
                    })
                })
                .await?;
            self.list(&json)
        }
        .boxed()
    }

    fn child_stubs<'a>(
        &'a self,
        kind: MediaKind,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Vec<Value>> {
        async move {
            if let Some(b) = self.built_in(Some(kind), "childStubs") {
                return b.child_stubs(kind, id, lang, p).await;
            }
            self.has(Some(kind), "childStubs")?;
            let (id, lang) = (self.own(id), lang_of(lang));
            let json = self
                .call(false, p, move |i| {
                    Box::pin(async move {
                        let (g, s) = i.provider();
                        g.call_child_stubs(s, &kind.as_str().to_owned(), &id, &lang)
                            .await
                    })
                })
                .await?;
            self.list(&json)
        }
        .boxed()
    }

    fn find_by<'a>(
        &'a self,
        source: ExternalProvider,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Option<(String, MediaKind)>> {
        async move {
            if let Some(b) = self.built_in(None, "findBy") {
                return b.find_by(source, id, lang, p).await;
            }
            if !self.declares(None, "findBy")
                || !self
                    .block
                    .find_by
                    .iter()
                    .any(|n| n.as_str() == source.as_str())
            {
                return Ok(None);
            }
            let source = ExternalId {
                provider: source.as_str().to_owned(),
                value: id.to_owned(),
            };
            let lang = lang_of(lang);
            let found = self
                .call(false, p, move |i| {
                    Box::pin(async move {
                        let (g, s) = i.provider();
                        g.call_find_by(s, &source, &lang).await
                    })
                })
                .await?;
            Ok(found.and_then(|(id, kind)| {
                (id.provider == self.key.as_str())
                    .then(|| MediaKind::parse(&kind).map(|k| (id.value, k)))
                    .flatten()
            }))
        }
        .boxed()
    }

    fn fetch_person<'a>(
        &'a self,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, PersonDetails> {
        async move {
            if let Some(b) = self.built_in(None, "person") {
                return b.fetch_person(id, lang, p).await;
            }
            self.has(None, "person")?;
            let (id, lang) = (self.own(id), lang_of(lang));
            let json = self
                .call(false, p, move |i| {
                    Box::pin(async move {
                        let (g, s) = i.provider();
                        g.call_fetch_person(s, &id, &lang).await
                    })
                })
                .await?;
            let v = self.record(&json, false)?;
            let s = |k: &str| v[k].as_str().map(str::to_owned);
            Ok(PersonDetails {
                name: s("name"),
                biography: s("biography"),
                birthday: s("birthday"),
                deathday: s("deathday"),
                place_of_birth: s("placeOfBirth"),
                avatar_url: s("avatarUrl"),
                known_for_department: s("knownForDepartment"),
            })
        }
        .boxed()
    }

    fn person_credits<'a>(
        &'a self,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Credits> {
        async move {
            if let Some(b) = self.built_in(None, "credits") {
                return b.person_credits(id, lang, p).await;
            }
            self.has(None, "credits")?;
            let (id, lang) = (self.own(id), lang_of(lang));
            let json = self
                .call(false, p, move |i| {
                    Box::pin(async move {
                        let (g, s) = i.provider();
                        g.call_person_credits(s, &id, &lang).await
                    })
                })
                .await?;
            let v = self.record(&json, false)?;
            let side = |k: &str| {
                v[k].as_array()
                    .cloned()
                    .ok_or_else(|| bad("credits without cast and crew"))
            };
            self.checked(side("cast").and_then(|cast| {
                Ok(Credits {
                    cast,
                    crew: side("crew")?,
                })
            }))
        }
        .boxed()
    }

    fn fetch_edition<'a>(
        &'a self,
        e: &'a EditionRef<'a>,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Option<Value>> {
        async move {
            if let Some(b) = self.built_in(None, "edition") {
                return b.fetch_edition(e, lang, p).await;
            }
            if !self.declares(None, "edition")
                || !self
                    .block
                    .edition
                    .iter()
                    .any(|n| n.as_str() == e.namespace.as_str())
            {
                return Ok(None);
            }
            let edition = ExternalId {
                provider: e.namespace.as_str().to_owned(),
                value: e.value.to_owned(),
            };
            let lang = lang_of(lang);
            let json = self
                .call(false, p, move |i| {
                    Box::pin(async move {
                        let (g, s) = i.provider();
                        g.call_fetch_edition(s, &edition, &lang).await
                    })
                })
                .await?;
            self.checked(json.map(|j| parse(&j, false)).transpose())
        }
        .boxed()
    }

    fn fetch_chapters<'a>(
        &'a self,
        asin: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Option<Value>> {
        async move {
            if let Some(b) = self.built_in(None, "chapters") {
                return b.fetch_chapters(asin, lang, p).await;
            }
            let ns = ExternalProvider::Asin.as_str();
            if !self.declares(None, "chapters") || !self.block.chapters.iter().any(|n| n == ns) {
                return Ok(None);
            }
            let edition = ExternalId {
                provider: ns.to_owned(),
                value: asin.to_owned(),
            };
            let lang = lang_of(lang);
            let json = self
                .call(false, p, move |i| {
                    Box::pin(async move {
                        let (g, s) = i.provider();
                        g.call_fetch_chapters(s, &edition, &lang).await
                    })
                })
                .await?;
            self.checked(json.map(|j| parse(&j, false)).transpose())
        }
        .boxed()
    }
}

/// Re-reads whether every key of `requires` resolves non-empty.
pub async fn refresh_availability(rt: Arc<PluginRt>) {
    let sh = &rt.sh;
    let cfg = super::imports::config_for(&sh.env.core, &sh.id, &sh.defaults, None)
        .await
        .unwrap_or_default();
    let ok = rt.manifest["provider"]["requires"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .all(|k| cfg.iter().any(|(n, v)| n == k && !v.is_empty()));
    sh.requires_ok.store(ok, Ordering::SeqCst);
}

impl Plugins {
    /// A provider that turned `ready` joins the metadata registry (rule 41).
    pub(super) async fn offer_provider(&self, id: &str, rt: Option<&Arc<PluginRt>>, bundled: bool) {
        let Some(rt) = rt.filter(|r| r.sh.provider) else {
            return;
        };
        refresh_availability(rt.clone()).await;
        // No await from here to the insert: a runtime replaced meanwhile must not overwrite the newer one.
        if !self.rt(id).is_some_and(|r| Arc::ptr_eq(&r, rt)) {
            return;
        }
        if let Some(app) = self.app() {
            match PluginProvider::new(rt.clone(), &app.metadata) {
                Some(provider) => {
                    app.images.allow_hosts(id, provider.image_hosts().to_vec());
                    app.metadata.add_plugin(Arc::new(provider));
                }
                None => {
                    tracing::info!("provider \"{id}\" has no core first namespace: not registered")
                }
            }
        }
        if bundled {
            self.reregister_after_breaker(rt.clone());
        }
    }

    /// Rule 48: once `failed`, the package registers again after the first delay, then every later one,
    /// unless an admin's restart or a removal got there first.
    fn reregister_after_breaker(&self, rt: Arc<PluginRt>) {
        let Some(st) = self.app().cloned() else {
            return;
        };
        tokio::spawn(async move {
            let id = rt.sh.id.to_string();
            let mut w = rt.watch();
            match w
                .wait_for(|s| matches!(s, State::Failed | State::Stopped))
                .await
            {
                Ok(s) if *s == State::Failed => {}
                _ => return,
            }
            let (first, every) = rt.sh.env.cfg.provider_retry;
            let me = &st.plugins;
            let mut ours = Some(rt);
            let mut delay = first;
            loop {
                tokio::time::sleep(delay).await;
                delay = every;
                let pending = {
                    let _l = me.lock(&id).await;
                    // Still our failed runtime, or gone because our last attempt failed.
                    match (&ours, me.rt(&id)) {
                        (Some(o), Some(l)) if Arc::ptr_eq(o, &l) => {}
                        (None, None) => {}
                        _ => return,
                    }
                    let Ok(Some(pkg)) = packages::find(&me.db, &id).await else {
                        return;
                    };
                    if !pkg.enabled {
                        return;
                    }
                    me.register(&pkg).await
                };
                ours = None;
                match pending {
                    Ok(p) => {
                        if me.settle(p).await.is_ok() {
                            return;
                        }
                    }
                    Err(f) => {
                        tracing::warn!("provider \"{id}\" not registered again: {}", f.reason)
                    }
                }
            }
        });
    }
}
