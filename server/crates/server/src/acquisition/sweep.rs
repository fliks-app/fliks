//! Core-driven acquisition (`plugins.md` section K): the core asks every provider to search, ranks the
//! answers and asks the best one's provider to grab.
use super::attempts::{self, Tally};
use super::{self as acquisition, picker};
use crate::ingest::KeyedLocks;
use crate::plugins::runtime::fliks::plugin::types as t;
use crate::plugins::runtime::{CallError, State};
use crate::plugins::{HttpRequest, Plugins, Principal, events};
use crate::state::AppState;
use crate::sync::MutexExt;
use chrono::{DateTime, Utc};
use fliks_domain::release::parsing::attributes::parse_revision;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Semaphore;

/// Releases tried for one media, best first, before it is given up for this pass.
const TRIES: usize = 3;
const PAGE: u32 = 200;
/// Calls of the sweeps a provider sees at once: the http lane has 4 instances, the rest stays free for users.
const CALLS_PER_PROVIDER: usize = 2;
/// A media whose providers were busy or whose check failed is asked again after this, at most `RETRIES` times.
const RETRY_DELAY: Duration = Duration::from_secs(30);
const RETRIES: u8 = 5;
/// A cooldown further away than this is not waited for: the hourly tick covers the rest.
const MAX_COOLDOWN: chrono::Duration = chrono::Duration::hours(24);

/// Media waiting for a request sweep, with the retries each has had.
#[derive(Default)]
struct Queue {
    pending: BTreeMap<u32, u8>,
    running: bool,
}

impl Queue {
    fn add(&mut self, media: u32, retries: u8) {
        let n = self.pending.entry(media).or_insert(retries);
        *n = (*n).min(retries);
    }

    fn take(&mut self, n: usize) -> Vec<(u32, u8)> {
        let ids: Vec<u32> = self.pending.keys().copied().take(n).collect();
        ids.into_iter()
            .filter_map(|m| self.pending.remove(&m).map(|r| (m, r)))
            .collect()
    }
}

/// What keeps concurrent sweeps from piling onto one provider or one media (`plugins.md` rule 66).
#[derive(Default)]
pub struct Sweeps {
    /// Held from a media's in-flight check to its grab.
    pub(crate) claims: KeyedLocks<i32>,
    slots: Mutex<HashMap<String, Arc<Semaphore>>>,
    queue: Mutex<Queue>,
    /// The instant a cooling media is asked again, by media: one timer per instant.
    wakes: Mutex<HashMap<u32, DateTime<Utc>>>,
}

impl Sweeps {
    fn slots_of(&self, provider: &str) -> Arc<Semaphore> {
        self.slots
            .lock_clean()
            .entry(provider.to_owned())
            .or_insert_with(|| Arc::new(Semaphore::new(CALLS_PER_PROVIDER)))
            .clone()
    }
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Grabbed from this provider.
    Grabbed(String),
    /// Searched, nothing worth grabbing (or every grab failed).
    NoRelease,
    /// A provider had no room: nothing was grabbed and a retry is due.
    Busy,
    /// Every provider that could answer was cooling: the media is asked again at that instant.
    Cooling(DateTime<Utc>),
    /// The in-flight check failed: nothing was grabbed and a retry is due.
    Error(String),
    /// A provider did not answer its grab in time: it may have added the release, so the target is left alone.
    TimedOut(String),
    /// Nothing asked: no profile, already satisfied, in flight, no provider.
    Skipped(&'static str),
}

/// What a provider offers: its eligible releases, in its own order.
type Offer = (String, Vec<Value>);

/// A release a provider would grab: no rejection, allowed, not blocklisted.
pub(super) fn clean(r: &Value) -> bool {
    r["rejections"].as_array().is_none_or(Vec::is_empty)
        && r["allowed"] != false
        && r["blocklisted"] != true
}

/// The releases a provider would grab.
fn eligible(list: &Value) -> Vec<Value> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter(|r| clean(r))
        .take(TRIES)
        .cloned()
        .collect()
}

/// Every offer's releases by rank then custom-format score; the stable sort keeps the offers' order
/// (provider order) on a tie.
fn merge(offers: Vec<Offer>) -> Vec<(String, Value)> {
    let mut all: Vec<(String, Value)> = offers
        .into_iter()
        .flat_map(|(p, rs)| rs.into_iter().map(move |r| (p.clone(), r)))
        .collect();
    let key = |r: &Value| {
        let revision = r["title"].as_str().map(parse_revision);
        (
            r["rank"].as_i64(),
            r["customFormatScore"].as_i64(),
            revision,
        )
    };
    all.sort_by_key(|(_, r)| std::cmp::Reverse(key(r)));
    all
}

fn level(tg: &t::Target) -> &'static str {
    match tg.scope.first() {
        None => "work",
        Some(u) if u.item_id.is_some() => "item",
        Some(_) => "group",
    }
}

/// A picker route with the target's ids in place of its parameters.
fn path(tpl: &str, tg: &t::Target) -> String {
    let unit = tg.scope.first();
    let id = |v: Option<u32>| v.unwrap_or_default().to_string();
    tpl.replace(":groupId", &id(unit.and_then(|u| u.group_id)))
        .replace(":itemId", &id(unit.and_then(|u| u.item_id)))
        .replace(":id", &tg.media_id.to_string())
}

/// When the target is searched again: the retry delay when busy, the cooldown, else the next sweep.
fn next_search(
    out: &Outcome,
    cooling: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
    interval_minutes: i64,
) -> Option<DateTime<Utc>> {
    let by_interval = now + chrono::Duration::minutes(interval_minutes);
    match out {
        Outcome::Grabbed(_) => None,
        Outcome::Busy => Some(now + chrono::Duration::from_std(RETRY_DELAY).unwrap_or_default()),
        Outcome::Cooling(at) => Some((*at).min(now + MAX_COOLDOWN)),
        _ => Some(cooling.unwrap_or(by_interval)),
    }
}

/// A cooling provider is waited for, not reported as failed.
fn note_failure(tally: &mut Tally, id: &str, e: &RouteError) {
    match e {
        RouteError::Cooling(at) => tally.cool(*at),
        _ => tally.failed.push(id.to_owned()),
    }
}

/// Why a route call to a provider failed.
pub enum RouteError {
    Unavailable,
    /// The provider's lane had no room.
    Busy,
    /// The provider did not answer within its deadline.
    TimedOut,
    /// The provider refused the grab: another one of the title is already under way.
    InFlight,
    /// The provider answered 503 with the instant its indexers are ready again.
    Cooling(DateTime<Utc>),
    Failed(String),
}

/// A 503 body `{"error":{"cooldownUntil":"<RFC 3339>"}}`.
fn cooldown_until(body: &[u8]) -> Option<DateTime<Utc>> {
    let v: Value = serde_json::from_slice(body).ok()?;
    DateTime::parse_from_rfc3339(v["error"]["cooldownUntil"].as_str()?)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// A 409 whose error key ends in `already_in_flight`.
fn is_in_flight(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| {
            v["error"]["key"]
                .as_str()
                .map(|k| k.ends_with(".already_in_flight"))
        })
        .unwrap_or(false)
}

impl RouteError {
    /// A search that may answer later: the lane was full, the provider is not running or did not answer in time.
    fn is_transient(&self) -> bool {
        matches!(self, Self::Busy | Self::Unavailable | Self::TimedOut)
    }
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => f.write_str("provider not running"),
            Self::Busy => f.write_str("provider busy"),
            Self::TimedOut => f.write_str("provider timed out"),
            Self::InFlight => f.write_str("a grab is already in flight"),
            Self::Cooling(at) => write!(f, "provider cooling until {at}"),
            Self::Failed(m) => f.write_str(m),
        }
    }
}

impl Plugins {
    pub async fn call_route(
        &self,
        id: &str,
        method: &str,
        path: String,
        query: Vec<(String, String)>,
        body: Value,
    ) -> Result<Value, RouteError> {
        let rt = self
            .rt(id)
            .filter(|r| r.state() == State::Ready)
            .ok_or(RouteError::Unavailable)?;
        let req = HttpRequest {
            method: method.into(),
            path,
            query,
            body: serde_json::to_vec(&body).unwrap_or_default(),
            principal: Principal::System,
        };
        let res = rt.http(req, false).await.map_err(|e| match e {
            CallError::Timeout => RouteError::TimedOut,
            e if e.is_saturated() => RouteError::Busy,
            e => RouteError::Failed(format!("{e:?}")),
        })?;
        if !(200..300).contains(&res.status) {
            if res.status == 409 && is_in_flight(&res.body) {
                return Err(RouteError::InFlight);
            }
            if res.status == 503
                && let Some(at) = cooldown_until(&res.body)
            {
                return Err(RouteError::Cooling(at));
            }
            return Err(RouteError::Failed(format!(
                "status {}: {}",
                res.status,
                String::from_utf8_lossy(&res.body)
            )));
        }
        if res.body.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&res.body)
            .map_err(|e| RouteError::Failed(format!("malformed JSON from {id}: {e}")))
    }

    /// A sweep's call to a provider, one of at most `CALLS_PER_PROVIDER` at a time.
    async fn sweep_call(
        &self,
        id: &str,
        method: &str,
        path: String,
        query: Vec<(String, String)>,
        body: Value,
    ) -> Result<Value, RouteError> {
        let _slot = self.sweeps.slots_of(id).acquire_owned().await;
        self.call_route(id, method, path, query, body).await
    }

    /// Searches, ranks across providers and grabs the best release of one target; `manual` when a user asked.
    /// The outcome of a search is kept as the target's last attempt.
    pub async fn acquire(&self, tg: &t::Target, manual: bool) -> Outcome {
        let mut tally = Tally::default();
        let out = self.search_and_grab(tg, manual, &mut tally).await;
        if tally.searched {
            self.remember(tg, &out, &tally).await;
        }
        out
    }

    async fn remember(&self, tg: &t::Target, out: &Outcome, tally: &Tally) {
        let outcome = match out {
            Outcome::Grabbed(_) => "grabbed",
            Outcome::NoRelease => "none",
            Outcome::Busy | Outcome::Cooling(_) => "busy",
            Outcome::TimedOut(_) => "timed_out",
            Outcome::Skipped(_) | Outcome::Error(_) => return,
        };
        let next_at = next_search(
            out,
            tally.cooling,
            Utc::now(),
            self.sweep_interval_minutes().await,
        );
        let failed = tally
            .failed
            .iter()
            .map(|id| {
                let name = self.registry.get(id);
                let name = name.as_ref().and_then(|r| r.manifest["name"].as_str());
                name.unwrap_or(id).to_owned()
            })
            .collect();
        let family = fliks_domain::media::family::Family::from(tg.family);
        let language = tg.language.as_deref().unwrap_or_default();
        attempts::record(
            &self.db,
            (tg.media_id as i32, family.as_str(), language),
            outcome,
            tally,
            failed,
            next_at,
        )
        .await;
        if let Outcome::Cooling(at) = out {
            self.wake_at(tg.media_id, *at);
        }
    }

    /// Asks `media` again at `at` (capped), once per instant.
    fn wake_at(&self, media: u32, at: DateTime<Utc>) {
        let Some(app) = self.app() else { return };
        let at = at.min(Utc::now() + MAX_COOLDOWN);
        if self.sweeps.wakes.lock_clean().insert(media, at) == Some(at) {
            return;
        }
        let delay = (at - Utc::now()).to_std().unwrap_or_default();
        let (me, st) = (app.plugins.clone(), app.clone());
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let due = {
                let mut wakes = me.sweeps.wakes.lock_clean();
                let due = wakes.get(&media) == Some(&at);
                if due {
                    wakes.remove(&media);
                }
                due
            };
            if due {
                me.enqueue(&st, vec![(media, 0)]);
            }
        });
    }

    async fn search_and_grab(&self, tg: &t::Target, manual: bool, tally: &mut Tally) -> Outcome {
        if tg
            .want
            .as_ref()
            .is_none_or(|w| w.decision == t::WantDecision::Skip)
        {
            return Outcome::Skipped("no want");
        }
        // Only video units are whole numbers the host matches: any other kind asks for the whole media.
        let unit = tg
            .scope
            .first()
            .map(|u| &u.ref_)
            .filter(|_| tg.kind == "series");
        let Some(app) = self.app() else {
            return Outcome::Skipped("not ready");
        };
        // The claim spans the in-flight check and the grab, so two sweeps never grab one media twice.
        let _claim = self.sweeps.claims.lock(tg.media_id as i32).await;
        match events::in_flight(app, "", tg.media_id as i32, unit).await {
            Ok(v) if v.is_empty() => {}
            Ok(_) => return Outcome::Skipped("in flight"),
            Err(e) => {
                tracing::warn!(
                    "acquisition: in-flight check of \"{}\" failed: {}",
                    tg.title,
                    e.message
                );
                return Outcome::Error(e.message);
            }
        }
        let lvl = level(tg);
        let mut routes = vec![];
        for id in self.eligible(&tg.kind) {
            let r = self.registry.release_picker_of(&id);
            let r = r.as_ref().map(|r| &r[tg.kind.as_str()][lvl]);
            if let Some(s) = r.and_then(|r| r["search"].as_str()) {
                let g = r.and_then(|r| r["grab"].as_str());
                routes.push((id, path(s, tg), g.map(|g| path(g, tg))));
            }
        }
        if routes.is_empty() {
            return Outcome::Skipped("no provider");
        }
        let mut query = vec![(
            "family".to_owned(),
            fliks_domain::media::family::Family::from(tg.family)
                .as_str()
                .to_owned(),
        )];
        query.extend(tg.language.clone().map(|l| ("language".to_owned(), l)));
        let searched = routes.iter().map(|(id, search, _)| async {
            let r = self
                .sweep_call(id, "GET", search.clone(), query.clone(), Value::Null)
                .await;
            (id.clone(), r)
        });
        tally.searched = true;
        let (mut offers, mut busy) = (vec![], false);
        for (id, r) in futures_util::future::join_all(searched).await {
            match r {
                Ok(list) => {
                    tally.count(&list);
                    offers.push((id, eligible(&list)));
                }
                Err(e) => {
                    busy |= e.is_transient();
                    note_failure(tally, &id, &e);
                    tracing::warn!(
                        "acquisition: search of \"{}\" at \"{id}\" failed: {e}",
                        tg.title
                    );
                }
            }
        }
        for (id, release) in merge(offers).into_iter().take(TRIES) {
            let Some(grab) = routes.iter().find(|r| r.0 == id).and_then(|r| r.2.clone()) else {
                continue;
            };
            let body = json!({
                "downloadUrl": release["downloadUrl"],
                "sourceTitle": release["title"],
                "sourceId": release["sourceId"],
                "infoUrl": release["infoUrl"],
                "family": fliks_domain::media::family::Family::from(tg.family).as_str(),
                "language": tg.language,
                "method": if manual { "manual" } else { "auto" },
            });
            // A one-track album target is held for the queue row the grab leads to.
            let items: Vec<i32> = match tg.scope.as_slice() {
                [u] if tg.kind == "album" => u.item_id.map(|i| i as i32).into_iter().collect(),
                _ => vec![],
            };
            let media = tg.media_id as i32;
            if !items.is_empty() {
                self.item_claims.claim(&id, media, items.clone());
            }
            let grabbed = self.sweep_call(&id, "POST", grab, vec![], body).await;
            if !items.is_empty() && !matches!(grabbed, Ok(_) | Err(RouteError::TimedOut)) {
                self.item_claims.unclaim(&id, media);
            }
            match grabbed {
                Ok(_) => {
                    tracing::info!("acquisition: \"{}\" grabbed at \"{id}\"", tg.title);
                    return Outcome::Grabbed(id);
                }
                Err(RouteError::TimedOut) => {
                    tracing::warn!(
                        "acquisition: grab of \"{}\" at \"{id}\" timed out, left alone",
                        release["title"]
                    );
                    return Outcome::TimedOut(id);
                }
                Err(RouteError::InFlight) => return Outcome::Skipped("in flight"),
                Err(e) => {
                    busy |= matches!(e, RouteError::Busy | RouteError::Unavailable);
                    if let RouteError::Cooling(at) = e {
                        tally.cool(at);
                    }
                    tracing::warn!(
                        "acquisition: grab of \"{}\" at \"{id}\" failed: {e}",
                        release["title"]
                    );
                }
            }
        }
        match (busy, tally.cooling) {
            (true, _) => Outcome::Busy,
            (false, Some(at)) => Outcome::Cooling(at),
            (false, None) => Outcome::NoRelease,
        }
    }

    /// One pass over the wanted targets of `media` (all of them when `None`): the number grabbed, and the
    /// media to ask again because a provider was busy or a check failed.
    async fn pass(&self, st: &AppState, media: Option<Vec<u32>>) -> (usize, BTreeSet<u32>) {
        let today = chrono::Local::now().date_naive();
        let (mut grabbed, mut checked, mut cursor) = (0, 0, None);
        let mut again = BTreeSet::new();
        loop {
            let q = t::CandidatesQuery {
                kind: None,
                family: None,
                media_ids: media.clone(),
                available_on: today.to_string(),
                limit: PAGE,
                cursor: cursor.take(),
            };
            let page = match acquisition::candidates(&st.db, q, today).await {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!("acquisition sweep: candidates failed: {e}");
                    return (grabbed, again);
                }
            };
            for tg in &page.items {
                if st.jobs.is_restoring() {
                    return (grabbed, again);
                }
                checked += 1;
                match self.acquire(tg, false).await {
                    Outcome::Grabbed(_) => grabbed += 1,
                    Outcome::Busy | Outcome::Error(_) => {
                        again.insert(tg.media_id);
                    }
                    _ => {}
                }
            }
            match page.cursor {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }
        tracing::info!("acquisition sweep: {checked} candidate(s) checked, {grabbed} grabbed");
        (grabbed, again)
    }

    /// A pass over the targets of `media` (all when `None`); what it could not settle is asked again later.
    pub async fn sweep(self: &Arc<Self>, st: &AppState, media: Option<Vec<u32>>) -> usize {
        let (grabbed, again) = self.pass(st, media).await;
        self.retry_later(st, again.into_iter().map(|m| (m, 0)));
        grabbed
    }

    /// Asks again after `RETRY_DELAY` for the media that have retries left.
    fn retry_later(self: &Arc<Self>, st: &AppState, media: impl Iterator<Item = (u32, u8)>) {
        let due: Vec<(u32, u8)> = media
            .filter(|(_, n)| *n < RETRIES)
            .map(|(m, n)| (m, n + 1))
            .collect();
        if due.is_empty() {
            return;
        }
        let (me, st) = (self.clone(), st.clone());
        tokio::spawn(async move {
            tokio::time::sleep(RETRY_DELAY).await;
            me.enqueue(&st, due);
        });
    }

    /// A request for `media`: queued with the others, swept in batches by one worker.
    pub fn request_sweep(self: &Arc<Self>, st: &AppState, media: Vec<u32>) {
        self.enqueue(st, media.into_iter().map(|m| (m, 0)).collect());
    }

    fn enqueue(self: &Arc<Self>, st: &AppState, items: Vec<(u32, u8)>) {
        let start = {
            let mut q = self.sweeps.queue.lock_clean();
            for (m, n) in items {
                q.add(m, n);
            }
            !q.pending.is_empty() && !std::mem::replace(&mut q.running, true)
        };
        if start {
            let (me, st) = (self.clone(), st.clone());
            tokio::spawn(async move { me.drain(st).await });
        }
    }

    /// The one worker of the request queue: batches until it is empty.
    async fn drain(self: Arc<Self>, st: AppState) {
        loop {
            let batch = {
                let mut q = self.sweeps.queue.lock_clean();
                if st.jobs.is_restoring() {
                    q.pending.clear();
                }
                let batch = q.take(PAGE as usize);
                if batch.is_empty() {
                    q.running = false;
                    return;
                }
                batch
            };
            let (_, again) = self
                .pass(&st, Some(batch.iter().map(|(m, _)| *m).collect()))
                .await;
            let tried: HashMap<u32, u8> = batch.into_iter().collect();
            self.retry_later(
                &st,
                again
                    .into_iter()
                    .map(|m| (m, tried.get(&m).copied().unwrap_or(0))),
            );
        }
    }

    /// The `acquisition.sweepInterval` setting, in minutes.
    pub async fn sweep_interval_minutes(&self) -> i64 {
        crate::settings::text(&self.db, picker::INTERVAL_KEY)
            .await
            .ok()
            .flatten()
            .and_then(|v| v.trim().parse().ok())
            .filter(|m| *m >= 1)
            .unwrap_or(picker::DEFAULT_INTERVAL_MINUTES)
    }
}

/// A pass over every target under the `AcquisitionSweep` claim; false when one is already running.
pub async fn sweep_all(st: &AppState) -> bool {
    let Some(_claim) = st.jobs.claim("AcquisitionSweep") else {
        tracing::warn!("AcquisitionSweep skipped: it is already running");
        return false;
    };
    st.plugins.sweep(st, None).await;
    true
}

/// The hourly tick: the sweep runs once its interval has passed since the last one.
pub fn spawn_tick(st: &AppState) {
    let last = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0));
    let st = st.clone();
    crate::jobs::spawn_cron(
        "0 * * * *",
        crate::jobs::server_tz(),
        chrono::Utc::now,
        move || {
            let (st, last) = (st.clone(), last.clone());
            tokio::spawn(async move {
                let now = chrono::Utc::now().timestamp_millis();
                // A minute of slack: the previous tick fired a few ms after its own hour mark.
                let due = st.plugins.sweep_interval_minutes().await * 60_000 - 60_000;
                if now - last.load(std::sync::atomic::Ordering::Relaxed) < due {
                    return;
                }
                if sweep_all(&st).await {
                    last.store(now, std::sync::atomic::Ordering::Relaxed);
                }
            });
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_announces_the_retry_delay_and_cooling_is_not_a_failure() {
        let now = Utc::now();
        let at = now + chrono::Duration::minutes(10);
        assert_eq!(
            next_search(&Outcome::Busy, Some(at), now, 360),
            Some(now + chrono::Duration::seconds(30))
        );
        assert_eq!(
            next_search(&Outcome::Cooling(at), Some(at), now, 360),
            Some(at)
        );
        let mut t = Tally::default();
        note_failure(&mut t, "p", &RouteError::Cooling(at));
        assert!(t.failed.is_empty() && t.cooling == Some(at));
        note_failure(&mut t, "p", &RouteError::Busy);
        assert_eq!(t.failed, ["p"]);
    }

    fn rel(title: &str, rank: i64, cf: i64) -> Value {
        json!({"title": title, "rank": rank, "customFormatScore": cf, "allowed": true, "rejections": []})
    }

    #[test]
    fn a_provider_offers_only_what_it_would_grab() {
        let list = json!([
            rel("a", 5, 0),
            {"title": "rejected", "rank": 9, "allowed": true, "rejections": [{"code": "x"}]},
            {"title": "blocked", "rank": 9, "allowed": true, "blocklisted": true, "rejections": []},
            {"title": "refused", "rank": 9, "allowed": false, "rejections": []},
            rel("b", 4, 0),
        ]);
        let titles: Vec<_> = eligible(&list)
            .iter()
            .map(|r| r["title"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(titles, ["a", "b"]);
        assert!(eligible(&json!(null)).is_empty());
    }

    #[test]
    fn a_repack_wins_a_tie_on_rank_and_score() {
        let offers = vec![(
            "a".to_owned(),
            vec![
                rel("Show.S01E01.1080p.WEB-DL-GRP", 5, 0),
                rel("Show.S01E01.REPACK.1080p.WEB-DL-GRP", 5, 0),
            ],
        )];
        assert_eq!(
            merge(offers)[0].1["title"],
            "Show.S01E01.REPACK.1080p.WEB-DL-GRP"
        );
    }

    #[test]
    fn transient_route_errors_read_as_busy() {
        assert!(
            [
                RouteError::Busy,
                RouteError::Unavailable,
                RouteError::TimedOut
            ]
            .iter()
            .all(RouteError::is_transient)
        );
        assert!(!RouteError::Failed("x".into()).is_transient());
        assert!(!RouteError::InFlight.is_transient());
    }

    #[test]
    fn a_503_names_its_cooldown_instant() {
        let b = br#"{"error":{"key":"x.cooling","cooldownUntil":"2026-01-01T10:30:00+02:00"}}"#;
        assert_eq!(
            cooldown_until(b).map(|d| d.to_rfc3339()),
            Some("2026-01-01T08:30:00+00:00".to_owned())
        );
        assert!(cooldown_until(br#"{"error":{"key":"x.busy"}}"#).is_none());
        assert!(cooldown_until(br#"{"error":{"cooldownUntil":"soon"}}"#).is_none());
        assert!(cooldown_until(b"nope").is_none());
        assert!(!RouteError::Cooling(Utc::now()).is_transient());
    }

    #[test]
    fn a_409_in_flight_key_is_recognised() {
        let b = br#"{"error":{"key":"download.grab.errors.already_in_flight"}}"#;
        assert!(is_in_flight(b));
        assert!(!is_in_flight(
            br#"{"error":{"key":"download.grab.errors.release_expired"}}"#
        ));
        assert!(!is_in_flight(b"nope"));
    }

    #[test]
    fn the_best_score_wins_across_providers_and_a_tie_goes_to_the_first() {
        let order = |offers| {
            merge(offers)
                .into_iter()
                .map(|(p, r)| format!("{p}:{}", r["title"].as_str().unwrap()))
                .collect::<Vec<_>>()
        };
        let a = ("a".to_owned(), vec![rel("a1", 3, 0), rel("a2", 2, 0)]);
        let b = ("b".to_owned(), vec![rel("b1", 4, 0), rel("b2", 3, 10)]);
        assert_eq!(
            order(vec![a.clone(), b.clone()]),
            ["b:b1", "b:b2", "a:a1", "a:a2"]
        );
        let tie = ("b".to_owned(), vec![rel("b1", 3, 0)]);
        assert_eq!(
            order(vec![a.clone(), tie.clone()])[0],
            "a:a1",
            "tie: provider order"
        );
        assert_eq!(order(vec![tie, a])[0], "b:b1");
    }

    #[test]
    fn a_route_template_takes_the_targets_ids() {
        let unit = |group, item| t::Unit {
            ref_: t::UnitRef {
                group: None,
                number: None,
                end_number: None,
                label: None,
                absolute: None,
            },
            group_id: group,
            item_id: item,
            title: None,
            air_date: None,
            unit_count: None,
            isrc: None,
            duration_ms: None,
        };
        let mut tg = t::Target {
            media_id: 7,
            kind: "series".into(),
            family: t::Family::Video,
            language: None,
            title: "t".into(),
            original_title: None,
            alternative_titles: vec![],
            creators: vec![],
            year: None,
            runtime_minutes: None,
            external_ids: vec![],
            edition_ids: vec![],
            library_id: 1,
            want: None,
            expected_titles: vec![],
            search_title: "t".into(),
            scope: vec![],
            search_units: vec![],
        };
        assert_eq!(path("/:id/releases", &tg), "/7/releases");
        assert_eq!(level(&tg), "work");
        tg.scope = vec![unit(Some(3), None)];
        assert_eq!(path("/:id/groups/:groupId/grab", &tg), "/7/groups/3/grab");
        assert_eq!(level(&tg), "group");
        tg.scope = vec![unit(Some(3), Some(9))];
        assert_eq!(path("/:id/items/:itemId/grab", &tg), "/7/items/9/grab");
        assert_eq!(level(&tg), "item");
    }

    #[test]
    fn requests_coalesce_and_drain_in_batches() {
        let mut q = Queue::default();
        for m in [3, 1, 2, 1] {
            q.add(m, 0);
        }
        q.add(2, 4);
        assert_eq!(q.pending.len(), 3, "a media asked twice waits once");
        assert_eq!(q.take(2), [(1, 0), (2, 0)], "the fewest retries win");
        assert_eq!(q.take(2), [(3, 0)]);
        assert!(q.take(2).is_empty());
    }

    #[tokio::test]
    async fn a_provider_sees_a_bounded_number_of_sweep_calls() {
        let s = Sweeps::default();
        let slots = s.slots_of("a");
        assert!(Arc::ptr_eq(&slots, &s.slots_of("a")));
        let held: Vec<_> = (0..CALLS_PER_PROVIDER)
            .map(|_| slots.clone().try_acquire_owned().unwrap())
            .collect();
        assert!(
            slots.clone().try_acquire_owned().is_err(),
            "the next call waits"
        );
        assert!(s.slots_of("b").try_acquire_owned().is_ok(), "per provider");
        drop(held);
    }

    #[tokio::test]
    async fn two_sweeps_never_hold_one_media_at_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let s = Arc::new(Sweeps::default());
        let inside: Arc<[AtomicUsize; 2]> = Arc::default();
        let peak: Arc<[AtomicUsize; 2]> = Arc::default();
        let runs: Vec<_> = (0..8)
            .map(|i| {
                let (s, inside, peak) = (s.clone(), inside.clone(), peak.clone());
                tokio::spawn(async move {
                    let m = i % 2;
                    let _claim = s.claims.lock(m as i32).await;
                    let now = inside[m].fetch_add(1, Ordering::SeqCst) + 1;
                    peak[m].fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    inside[m].fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for r in runs {
            r.await.unwrap();
        }
        assert_eq!(peak.each_ref().map(|p| p.load(Ordering::SeqCst)), [1, 1]);
    }

    #[test]
    fn only_a_full_lane_is_saturated() {
        use crate::plugins::runtime::{QUEUE_FULL, QUEUE_WAIT};
        let un = |m: &str| CallError::Unavailable(m.into());
        for full in [CallError::Busy, un(QUEUE_FULL), un(QUEUE_WAIT)] {
            assert!(full.is_saturated(), "{full:?}");
        }
        for other in [
            CallError::Timeout,
            un("stopped"),
            CallError::Guest("x".into()),
        ] {
            assert!(!other.is_saturated(), "{other:?}");
        }
    }

    #[sqlx::test(migrations = false)]
    async fn a_full_pass_takes_the_claim_and_refuses_a_second(pool: sqlx::PgPool) {
        crate::db::migrate(&pool).await.unwrap();
        let st = crate::metadata::books::tests::state(&pool, vec![]);
        let held = st.jobs.claim("AcquisitionSweep").unwrap();
        assert!(!sweep_all(&st).await);
        drop(held);
        assert!(sweep_all(&st).await);
        assert!(st.jobs.claim("AcquisitionSweep").is_some());
    }
}
