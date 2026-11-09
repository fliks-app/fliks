//! Core-driven acquisition (`plugins.md` section K): the core asks every provider to search, ranks the
//! answers and asks the best one's provider to grab.
use super::runtime::fliks::plugin::types as t;
use super::runtime::{CallError, State};
use super::{HttpRequest, Plugins, Principal, acquisition, events, picker};
use crate::ingest::KeyedLocks;
use crate::state::AppState;
use crate::sync::MutexExt;
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
    claims: KeyedLocks<i32>,
    slots: Mutex<HashMap<String, Arc<Semaphore>>>,
    queue: Mutex<Queue>,
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
    /// The in-flight check failed: nothing was grabbed and a retry is due.
    Error(String),
    /// A provider did not answer its grab in time: it may have added the release, so the target is left alone.
    TimedOut(String),
    /// Nothing asked: no profile, already satisfied, in flight, no provider.
    Skipped(&'static str),
}

/// What a provider offers: its eligible releases, in its own order.
type Offer = (String, Vec<Value>);

/// The releases a provider would grab: no rejection, allowed, not blocklisted.
fn eligible(list: &Value) -> Vec<Value> {
    let ok = |r: &&Value| {
        r["rejections"].as_array().is_none_or(Vec::is_empty)
            && r["allowed"] != false
            && r["blocklisted"] != true
    };
    list.as_array()
        .into_iter()
        .flatten()
        .filter(ok)
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
    let key = |r: &Value| (r["rank"].as_i64(), r["customFormatScore"].as_i64());
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

/// Why a route call to a provider failed.
pub enum RouteError {
    Unavailable,
    /// The provider's lane had no room.
    Busy,
    /// The provider did not answer within its deadline.
    TimedOut,
    Failed(String),
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => f.write_str("provider not running"),
            Self::Busy => f.write_str("provider busy"),
            Self::TimedOut => f.write_str("provider timed out"),
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
            return Err(RouteError::Failed(format!(
                "status {}: {}",
                res.status,
                String::from_utf8_lossy(&res.body)
            )));
        }
        Ok(serde_json::from_slice(&res.body).unwrap_or(Value::Null))
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
    pub async fn acquire(&self, tg: &t::Target, manual: bool) -> Outcome {
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
        let (mut offers, mut busy) = (vec![], false);
        for (id, r) in futures_util::future::join_all(searched).await {
            match r {
                Ok(list) => offers.push((id, eligible(&list))),
                Err(e) => {
                    busy |= matches!(e, RouteError::Busy);
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
            match self.sweep_call(&id, "POST", grab, vec![], body).await {
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
                Err(e) => {
                    busy |= matches!(e, RouteError::Busy);
                    tracing::warn!(
                        "acquisition: grab of \"{}\" at \"{id}\" failed: {e}",
                        release["title"]
                    );
                }
            }
        }
        if busy {
            Outcome::Busy
        } else {
            Outcome::NoRelease
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
        crate::settings::setting_value(&self.db, picker::INTERVAL_KEY)
            .await
            .ok()
            .flatten()
            .and_then(|v| v.trim().parse().ok())
            .filter(|m| *m >= 1)
            .unwrap_or(picker::DEFAULT_INTERVAL_MINUTES)
    }
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
                let Some(_claim) = st.jobs.claim("AcquisitionSweep") else {
                    tracing::warn!("Scheduled AcquisitionSweep skipped: it is already running");
                    return;
                };
                last.store(now, std::sync::atomic::Ordering::Relaxed);
                st.plugins.sweep(&st, None).await;
            });
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

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
        use super::super::runtime::{QUEUE_FULL, QUEUE_WAIT};
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
}
