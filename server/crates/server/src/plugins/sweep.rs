//! Core-driven acquisition (`plugins.md` section K): the core asks every provider to search, ranks the
//! answers and asks the best one's provider to grab.
use super::runtime::State;
use super::runtime::fliks::plugin::types as t;
use super::{HttpRequest, Plugins, Principal, acquisition, events, picker};
use crate::state::AppState;
use serde_json::{Value, json};

/// Releases tried for one media, best first, before it is given up for this pass.
const TRIES: usize = 3;
const PAGE: u32 = 200;

#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Grabbed from this provider.
    Grabbed(String),
    /// Searched, nothing worth grabbing (or every grab failed).
    NoRelease,
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

impl Plugins {
    async fn call_route(
        &self,
        id: &str,
        method: &str,
        path: String,
        query: Vec<(String, String)>,
        body: Value,
    ) -> Result<Value, String> {
        let rt = self
            .rt(id)
            .filter(|r| r.state() == State::Ready)
            .ok_or("provider not running")?;
        let req = HttpRequest {
            method: method.into(),
            path,
            query,
            body: serde_json::to_vec(&body).unwrap_or_default(),
            principal: Principal::System,
        };
        let res = rt.http(req, false).await.map_err(|e| format!("{e:?}"))?;
        if !(200..300).contains(&res.status) {
            return Err(format!(
                "status {}: {}",
                res.status,
                String::from_utf8_lossy(&res.body)
            ));
        }
        Ok(serde_json::from_slice(&res.body).unwrap_or(Value::Null))
    }

    /// Searches, ranks across providers and grabs the best release of one target.
    pub async fn acquire(&self, tg: &t::Target) -> Outcome {
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
        match events::progress_gates().in_flight("", tg.media_id as i32, unit) {
            Ok(v) if v.is_empty() => {}
            _ => return Outcome::Skipped("in flight"),
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
                .call_route(id, "GET", search.clone(), query.clone(), Value::Null)
                .await;
            (id.clone(), r)
        });
        let mut offers = vec![];
        for (id, r) in futures_util::future::join_all(searched).await {
            match r {
                Ok(list) => offers.push((id, eligible(&list))),
                Err(e) => tracing::warn!(
                    "acquisition: search of \"{}\" at \"{id}\" failed: {e}",
                    tg.title
                ),
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
            });
            match self.call_route(&id, "POST", grab, vec![], body).await {
                Ok(_) => {
                    tracing::info!("acquisition: \"{}\" grabbed at \"{id}\"", tg.title);
                    return Outcome::Grabbed(id);
                }
                Err(e) => tracing::warn!(
                    "acquisition: grab of \"{}\" at \"{id}\" failed: {e}",
                    release["title"]
                ),
            }
        }
        Outcome::NoRelease
    }

    /// One pass over the wanted targets of `media` (all of them when `None`); the number grabbed.
    pub async fn sweep(&self, st: &AppState, media: Option<Vec<u32>>) -> usize {
        let today = chrono::Local::now().date_naive();
        let (mut grabbed, mut checked, mut cursor) = (0, 0, None);
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
                    return grabbed;
                }
            };
            for tg in &page.items {
                if st.jobs.is_restoring() {
                    return grabbed;
                }
                checked += 1;
                // One target at a time: a provider sees one sweep call, the rest of its lane stays free.
                if matches!(self.acquire(tg).await, Outcome::Grabbed(_)) {
                    grabbed += 1;
                }
            }
            match page.cursor {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }
        tracing::info!("acquisition sweep: {checked} candidate(s) checked, {grabbed} grabbed");
        grabbed
    }

    /// A request for `media`: one pass over them, once the host is not restoring.
    pub async fn request_sweep(&self, st: &AppState, media: Vec<u32>) {
        if !media.is_empty() && !st.jobs.is_restoring() {
            self.sweep(st, Some(media)).await;
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
}
