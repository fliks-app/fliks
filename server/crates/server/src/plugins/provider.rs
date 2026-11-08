//! A provider plugin as a `MetadataProvider` (`docs/spec/provider-plugins.md`): calls on its
//! `provider` lane, errors mapped by rule 15, records validated by rule 14.
use super::runtime::{
    Budget, CallError, Inst, PluginRt, State, fliks::plugin::types::ExternalId, wit_provider as wit,
};
use super::{Plugins, packages};
use crate::metadata::{
    Call, Credits, EditionRef, MetadataProvider, PersonDetails, Search, Upstream,
};
use fliks_domain::{
    comics::provider as comics,
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::{
        language::Resolved,
        limiter::{Limits, Priority},
    },
    music::provider as music,
    plugins::provider,
    release::scene::Entry,
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
/// Rule 14: elements of a list answer.
const MAX_LIST: usize = 10_000;
/// Rule 18a: the ids and the pairs a scene answer may hold.
const MAX_SCENE_IDS: usize = 200_000;
const MAX_SCENE_PAIRS: usize = 100_000;

/// What the manifest's `provider` block says, read once.
struct Block {
    namespaces: Vec<String>,
    /// Declares a core namespace: registration allows that only to an `official` package.
    official: bool,
    kinds: Vec<(MediaKind, Vec<String>)>,
    find_by: Vec<String>,
    edition: Vec<String>,
    chapters: Vec<String>,
    scene: Vec<String>,
    image_hosts: Vec<String>,
    /// `snapshotTtlSecs`: a resource it does not name is zero.
    ttl: HashMap<String, Option<Duration>>,
}

impl Block {
    fn own(&self) -> Vec<&str> {
        self.namespaces.iter().map(String::as_str).collect()
    }

    fn parse(b: &Value) -> Self {
        let strs = |v: &Value| -> Vec<String> {
            v.as_array()
                .into_iter()
                .flatten()
                .filter_map(|n| n.as_str().map(str::to_owned))
                .collect()
        };
        let namespaces: Vec<String> = b["namespaces"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|n| n["name"].as_str().map(str::to_owned))
            .collect();
        Block {
            official: namespaces
                .iter()
                .any(|n| matches!(provider::classify(n), Some(provider::Class::Core(_)))),
            namespaces,
            kinds: b["kinds"]
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(k, caps)| Some((MediaKind::parse(k)?, strs(caps))))
                .collect(),
            find_by: strs(&b["findBy"]),
            edition: strs(&b["editionNamespaces"]),
            chapters: strs(&b["chapterNamespaces"]),
            scene: strs(&b["sceneNamespaces"]),
            image_hosts: strs(&b["imageHosts"]),
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
    known: Arc<super::namespaces::Known>,
    key: Namespace,
    block: Block,
    gate: Arc<super::outbound::Gate>,
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
        Value::Array(a) if a.len() > MAX_LIST => Err(bad("too many elements")),
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
    /// The provider of a plugin, keyed by its first declared namespace; `None` when it has none.
    pub fn new(rt: Arc<PluginRt>, known: Arc<super::namespaces::Known>) -> Option<Self> {
        let b = rt.manifest.get("provider")?;
        let block = Block::parse(b);
        let key = known.get().parse(block.namespaces.first()?)?;
        let gate = rt.sh.gate.clone()?;
        Some(Self {
            rt,
            known,
            key,
            block,
            gate,
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

    /// Rule 14, for the breaker: every record the plugin answered is counted once.
    fn checked<T>(&self, r: Result<T, Upstream>) -> Result<T, Upstream> {
        if let Some(gate) = &self.rt.sh.gate {
            gate.record_checked(r.is_ok());
        }
        r
    }

    /// Rules 14, 26 and 28 on one record; a dropped id is warned by namespace count, never value.
    fn sanitized(&self, mut v: Value) -> Value {
        if let Value::Object(o) = &mut v {
            let n = provider::sanitize_ids(
                o,
                self.block.official,
                &self.block.own(),
                &self.known.get(),
            );
            if n > 0 {
                tracing::warn!(
                    "plugin \"{}\": {n} id(s) of a record dropped",
                    self.rt.sh.id
                );
            }
        }
        v
    }

    fn record(&self, json: &str, array: bool) -> Result<Value, Upstream> {
        self.checked(parse(json, array)).map(|v| self.sanitized(v))
    }

    /// `record` for a work: a `comic` one that breaks rule 60 is malformed (rule 14).
    fn work_record(&self, kind: MediaKind, json: &str) -> Result<Value, Upstream> {
        let checked = parse(json, false).and_then(|v| {
            match kind {
                MediaKind::Comic => drop(comics::work(&v).map_err(bad)?),
                MediaKind::Album => drop(music::album(&v).map_err(bad)?),
                _ => {}
            }
            Ok(v)
        });
        self.checked(checked).map(|v| self.sanitized(v))
    }

    /// Rule 61: the children of a comic that pass, normalised; the rest is dropped and warned.
    fn comic_children(&self, list: Vec<Value>) -> Vec<Value> {
        let got = comics::issues(&list);
        if got.invalid + got.repeats > 0 {
            tracing::warn!(
                "plugin \"{}\": {} comic issues dropped ({}), {} repeated",
                self.rt.sh.id,
                got.invalid,
                got.first_reason.unwrap_or("none"),
                got.repeats
            );
        }
        got.kept.iter().map(comics::Issue::to_value).collect()
    }

    /// `music.md` rule on releases: the children of an album that pass; the rest is dropped and warned.
    fn album_children(&self, list: Vec<Value>) -> Vec<Value> {
        let before = list.len();
        let mut first = None;
        let kept: Vec<Value> = list
            .into_iter()
            .filter(|v| match music::release(v) {
                Ok(_) => true,
                Err(why) => {
                    first.get_or_insert(why);
                    false
                }
            })
            .collect();
        if kept.len() < before {
            tracing::warn!(
                "plugin \"{}\": {} releases dropped ({})",
                self.rt.sh.id,
                before - kept.len(),
                first.unwrap_or("none")
            );
        }
        kept
    }

    /// `record` for an answer that may be absent (`fetch-edition`, `fetch-chapters`).
    fn optional_record(&self, json: Option<String>) -> Result<Option<Value>, Upstream> {
        let parsed = self.checked(json.map(|j| parse(&j, false)).transpose())?;
        Ok(parsed.map(|v| self.sanitized(v)))
    }

    fn array(&self, json: &str) -> Result<Vec<Value>, Upstream> {
        let list = self.checked(parse_list(json))?;
        Ok(list.into_iter().map(|v| self.sanitized(v)).collect())
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
    fn id(&self) -> Namespace {
        self.key
    }

    fn supports(&self, kind: MediaKind) -> bool {
        self.block
            .kinds
            .iter()
            .any(|(k, caps)| *k == kind && caps.iter().any(|c| c != "scene"))
    }

    fn has_persons(&self) -> bool {
        self.declares(None, "person")
    }

    fn serves_persons_of(&self, kind: MediaKind, ns: Namespace) -> bool {
        self.declares(Some(kind), "person")
            && (self.key == ns || self.block.find_by.iter().any(|n| n == ns.as_str()))
    }

    fn limits(&self) -> Limits {
        self.gate.limits()
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
            self.array(&json)
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
            self.work_record(kind, &json)
        }
        .boxed()
    }

    fn fetch_children<'a>(
        &'a self,
        kind: MediaKind,
        id: &'a str,
        season: Option<u32>,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Vec<Value>> {
        async move {
            self.has(Some(kind), "children")?;
            let (id, lang) = (self.own(id), lang_of(lang));
            let json = self
                .call(true, p, move |i| {
                    Box::pin(async move {
                        let (g, s) = i.provider();
                        g.call_fetch_children(s, &kind.as_str().to_owned(), &id, season, &lang)
                            .await
                    })
                })
                .await?;
            let list = self.array(&json)?;
            Ok(match kind {
                MediaKind::Comic => self.comic_children(list),
                MediaKind::Album => self.album_children(list),
                _ => list,
            })
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
            self.array(&json)
        }
        .boxed()
    }

    fn find_by<'a>(
        &'a self,
        source: Namespace,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Option<(String, MediaKind)>> {
        async move {
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
                let value = (id.provider == self.key.as_str())
                    .then(|| provider::answered_id(&self.known.get(), self.key, &id.value))
                    .flatten()?;
                Some((value, MediaKind::parse(&kind)?))
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
            if self.declares(Some(MediaKind::Album), "person") {
                let m = self.checked(music::person(&v).map_err(bad))?;
                let day = |d: Option<chrono::NaiveDate>| d.map(|d| d.to_string());
                return Ok(PersonDetails {
                    name: m.name,
                    biography: m.biography,
                    birthday: day(m.birthday),
                    deathday: day(m.deathday),
                    place_of_birth: m.place_of_birth,
                    avatar_url: m.avatar_url,
                    known_for_department: None,
                });
            }
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
            if self.declares(Some(MediaKind::Album), "credits") {
                let albums = v["albums"]
                    .as_array()
                    .filter(|a| a.len() <= MAX_LIST)
                    .ok_or_else(|| bad("credits without albums"));
                return self.checked(albums.map(|a| {
                    Credits {
                        albums: a
                            .iter()
                            .filter(|r| music::album(r).is_ok())
                            .cloned()
                            .collect(),
                        ..Credits::default()
                    }
                }));
            }
            let side = |k: &str| {
                v[k].as_array()
                    .cloned()
                    .ok_or_else(|| bad("credits without cast and crew"))
            };
            self.checked(side("cast").and_then(|cast| {
                Ok(Credits {
                    cast,
                    crew: side("crew")?,
                    ..Credits::default()
                })
            }))
        }
        .boxed()
    }

    fn has_search(&self, kind: MediaKind) -> bool {
        self.declares(Some(kind), "search")
    }

    fn has_scene(&self) -> bool {
        self.declares(None, "scene") && self.block.scene.iter().any(|n| n == "tvdb")
    }

    fn scene_mapped_ids<'a>(&'a self, p: Priority) -> Call<'a, Vec<String>> {
        async move {
            if !self.has_scene() {
                return Err(undeclared());
            }
            let ids = self
                .call(false, p, move |i| {
                    Box::pin(async move {
                        let (g, s) = i.scene();
                        g.call_scene_mapped_ids(s, "tvdb").await
                    })
                })
                .await?;
            self.checked(if ids.len() > MAX_SCENE_IDS {
                Err(bad("too many ids"))
            } else {
                Ok(ids)
            })
        }
        .boxed()
    }

    fn scene_mapping<'a>(&'a self, id: &'a str, p: Priority) -> Call<'a, Option<Vec<Entry>>> {
        async move {
            if !self.has_scene() {
                return Err(undeclared());
            }
            let source = ExternalId {
                provider: "tvdb".to_owned(),
                value: id.to_owned(),
            };
            let pairs = self
                .call(false, p, move |i| {
                    Box::pin(async move {
                        let (g, s) = i.scene();
                        g.call_scene_mapping(s, &source).await
                    })
                })
                .await?;
            let pairs = self.checked(match pairs {
                Some(p) if p.len() > MAX_SCENE_PAIRS => Err(bad("too many pairs")),
                p => Ok(p),
            })?;
            Ok(pairs.filter(|p| !p.is_empty()).map(|p| {
                p.into_iter()
                    .map(|x| Entry {
                        scene_season: x.scene_season.into(),
                        scene_episode: x.scene_episode.into(),
                        season: x.season.into(),
                        episode: x.episode.into(),
                    })
                    .collect()
            }))
        }
        .boxed()
    }

    fn has_lists(&self, kind: MediaKind) -> bool {
        self.declares(Some(kind), "lists")
    }

    fn list<'a>(
        &'a self,
        kind: MediaKind,
        name: &'a str,
        params: &'a [(String, String)],
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Value> {
        async move {
            self.has(Some(kind), "lists")?;
            let (name, params, lang) = (name.to_owned(), params.to_vec(), lang_of(lang));
            let json = self
                .call(false, p, move |i| {
                    Box::pin(async move {
                        let (g, s) = i.provider();
                        g.call_list(s, &kind.as_str().to_owned(), &name, &params, &lang)
                            .await
                    })
                })
                .await?;
            self.array(&json).map(Value::Array)
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
            let record = self.optional_record(json)?;
            if let (Some(r), true) = (&record, e.namespace == Namespace::MUSICBRAINZ) {
                self.checked(music::edition(r).map(drop).map_err(bad))?;
            }
            Ok(record)
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
            let ns = Namespace::ASIN.as_str();
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
            self.optional_record(json)
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
            match PluginProvider::new(rt.clone(), self.namespaces.clone()) {
                Some(provider) => {
                    app.images
                        .allow_hosts(id, provider.image_hosts().to_vec(), bundled);
                    let scene = provider.has_scene();
                    app.metadata.add_plugin(Arc::new(provider));
                    if scene {
                        crate::scene::spawn_boot_refresh(app);
                    }
                }
                None => {
                    tracing::info!(
                        "provider \"{id}\" has no declared first namespace: not registered"
                    )
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
                    // Still our runtime (a late start still settling waits a round), or gone.
                    match (&ours, me.rt(&id)) {
                        (Some(o), Some(l)) if Arc::ptr_eq(o, &l) => match *l.watch().borrow() {
                            State::Failed => {}
                            State::Ready | State::Degraded | State::Stopped => return,
                            _ => continue,
                        },
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
                ours = me.rt(&id);
            }
        });
    }
}
