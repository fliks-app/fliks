//! Activity registry (rules 40-48): what the server is doing now, plus what is queued behind it.
use super::{
    event::{Num, Subject},
    hub::Shared,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Mutex, Weak},
    time::Duration,
};

const MAX_ENTRIES: usize = 20_000;
const DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Pending,
}

/// `ActivityEntry`; children never nest further.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<Subject>,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<Num>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<Num>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Row {
    #[serde(flatten)]
    pub entry: Entry,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Entry>,
}

#[derive(Debug, Serialize)]
pub struct List {
    pub data: Vec<Row>,
    pub total: usize,
    pub dropped: u64,
}

#[derive(Default)]
struct State {
    entries: HashMap<String, (u64, Entry)>,
    next_seq: u64,
    dropped: u64,
    cap_warned: bool,
    timer_armed: bool,
}

pub struct Activity {
    hub: Weak<Shared>,
    state: Mutex<State>,
}

impl Activity {
    pub(super) fn new(hub: Weak<Shared>) -> Self {
        Self {
            hub,
            state: Mutex::default(),
        }
    }

    /// A re-upsert of a running id returns it to pending and drops `current`/`total`.
    pub fn upsert_pending(
        &self,
        id: &str,
        r#type: &str,
        subject: Option<Subject>,
        parent_id: Option<String>,
    ) {
        self.upsert(id, r#type, subject, Status::Pending, None, None, parent_id);
    }

    pub fn upsert_running(
        &self,
        id: &str,
        r#type: &str,
        subject: Option<Subject>,
        current: Option<Num>,
        total: Option<Num>,
        parent_id: Option<String>,
    ) {
        self.upsert(
            id,
            r#type,
            subject,
            Status::Running,
            current,
            total,
            parent_id,
        );
    }

    /// Registers the work as running unless it already is, in one lock: the 409 gate of a duplicate.
    pub fn claim(
        &self,
        id: &str,
        r#type: &str,
        subject: Option<Subject>,
        current: Option<Num>,
        total: Option<Num>,
        parent_id: Option<String>,
    ) -> bool {
        let mut st = self.state();
        if st.entries.contains_key(id) {
            return false;
        }
        let running = Status::Running;
        self.put(
            &mut st, id, r#type, subject, running, current, total, parent_id,
        );
        true
    }

    pub fn remove(&self, id: &str) {
        let mut st = self.state();
        if st.entries.remove(id).is_some() {
            self.arm(&mut st);
        }
    }

    /// Running before pending, then insertion order, at top level and inside each parent; pages
    /// count top-level rows. A child whose parent is gone is a top-level row.
    pub fn list(&self, page: usize, limit: usize) -> List {
        let st = self.state();
        let mut children: HashMap<&str, Vec<&(u64, Entry)>> = HashMap::new();
        let mut top = Vec::new();
        for e in st.entries.values() {
            match e.1.parent_id.as_deref() {
                Some(p) if st.entries.contains_key(p) => children.entry(p).or_default().push(e),
                _ => top.push(e),
            }
        }
        let order = |v: &mut Vec<&(u64, Entry)>| {
            v.sort_by_key(|(seq, e)| (e.status == Status::Pending, *seq));
        };
        order(&mut top);
        let start = page.saturating_sub(1).saturating_mul(limit);
        let data = top
            .iter()
            .skip(start)
            .take(limit)
            .map(|(_, e)| {
                let mut kids = children.remove(e.id.as_str()).unwrap_or_default();
                order(&mut kids);
                Row {
                    entry: e.clone(),
                    children: kids.into_iter().map(|(_, c)| c.clone()).collect(),
                }
            })
            .collect();
        List {
            data,
            total: top.len(),
            dropped: st.dropped,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn upsert(
        &self,
        id: &str,
        r#type: &str,
        subject: Option<Subject>,
        status: Status,
        current: Option<Num>,
        total: Option<Num>,
        parent_id: Option<String>,
    ) {
        let mut st = self.state();
        self.put(
            &mut st, id, r#type, subject, status, current, total, parent_id,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn put(
        &self,
        st: &mut State,
        id: &str,
        r#type: &str,
        subject: Option<Subject>,
        status: Status,
        current: Option<Num>,
        total: Option<Num>,
        parent_id: Option<String>,
    ) {
        let existing = st.entries.get(id).map(|(s, e)| (*s, e.parent_id.clone()));
        if existing.is_none() && st.entries.len() >= MAX_ENTRIES {
            st.dropped += 1;
            if !st.cap_warned {
                st.cap_warned = true;
                tracing::warn!(
                    "Activity registry at capacity ({MAX_ENTRIES}): \"{id}\" (and further registrations) will not appear until the registry drains"
                );
            }
            return;
        }
        let (seq, kept_parent) = match existing {
            Some((seq, parent)) => (seq, parent),
            None => {
                st.next_seq += 1;
                (st.next_seq - 1, None)
            }
        };
        let parent_id = parent_id.or(kept_parent);
        let entry = Entry {
            id: id.to_owned(),
            r#type: r#type.to_owned(),
            subject,
            status,
            current,
            total,
            parent_id,
        };
        st.entries.insert(id.to_owned(), (seq, entry));
        self.arm(st);
    }

    /// One `activity.changed` per 250 ms window; the next mutation after it fires arms a new timer.
    fn arm(&self, st: &mut State) {
        if st.timer_armed {
            return;
        }
        st.timer_armed = true;
        let hub = self.hub.clone();
        tokio::spawn(async move {
            tokio::time::sleep(DEBOUNCE).await;
            if let Some(shared) = hub.upgrade() {
                shared.activity.state().timer_armed = false;
                super::Hub(shared).emit(super::SseEvent::ActivityChanged {});
            }
        });
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Hub, event::SseEvent};
    use super::*;
    use serde_json::{Value, json};

    fn titled(t: &str) -> Option<Subject> {
        Some(Subject {
            title: t.into(),
            media_id: None,
            media_type: None,
            season_number: None,
            episode_number: None,
            episode_title: None,
            episode_id: None,
        })
    }

    fn json_of(l: &List) -> Value {
        serde_json::to_value(l).unwrap()
    }

    #[tokio::test]
    async fn running_first_then_insertion_order_kept_across_upserts() {
        let hub = Hub::new();
        let a = hub.activity();
        a.upsert_pending("a", "T", None, None);
        a.upsert_pending("b", "T", None, None);
        a.upsert_running("c", "T", titled("c"), Some(1.into()), Some(2.into()), None);
        a.upsert_running("a", "T", None, None, None, None);
        let l = json_of(&a.list(1, 25));
        let ids: Vec<_> = l["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["a", "c", "b"]);
        assert_eq!(l["total"], 3);
        assert_eq!(l["data"][1]["subject"], json!({"title": "c"}));
        assert_eq!(l["data"][1]["current"], 1);
        assert!(l["data"][0].get("current").is_none() && l["data"][0].get("children").is_none());
    }

    #[tokio::test]
    async fn children_group_under_their_parent_and_orphans_surface() {
        let hub = Hub::new();
        let a = hub.activity();
        a.upsert_running("p", "T", None, None, None, None);
        a.upsert_pending("k2", "T", None, Some("p".into()));
        a.upsert_running("k1", "T", None, None, None, Some("p".into()));
        a.upsert_pending("o", "T", None, Some("gone".into()));
        a.upsert_pending("k2", "T", None, None);
        let l = json_of(&a.list(1, 25));
        assert_eq!(l["total"], 2);
        assert_eq!(l["data"][0]["children"][0]["id"], "k1");
        assert_eq!(l["data"][0]["children"][1]["id"], "k2");
        assert_eq!(l["data"][0]["children"][1]["parentId"], "p");
        assert_eq!(l["data"][1]["id"], "o");
    }

    #[tokio::test]
    async fn pagination_slices_top_level_rows_and_a_late_page_is_empty() {
        let hub = Hub::new();
        let a = hub.activity();
        for i in 0..5 {
            a.upsert_pending(&format!("i{i}"), "T", None, None);
        }
        let l = json_of(&a.list(2, 2));
        assert_eq!(l["data"].as_array().unwrap().len(), 2);
        assert_eq!(l["data"][0]["id"], "i2");
        let l = json_of(&a.list(9, 2));
        assert_eq!(
            (l["data"].as_array().unwrap().len(), l["total"].as_u64()),
            (0, Some(5))
        );
    }

    #[tokio::test]
    async fn capacity_drops_new_ids_but_updates_existing_ones() {
        let hub = Hub::new();
        let a = hub.activity();
        for i in 0..MAX_ENTRIES {
            a.upsert_pending(&i.to_string(), "T", None, None);
        }
        a.upsert_pending("extra", "T", None, None);
        a.upsert_pending("extra2", "T", None, None);
        a.upsert_running("0", "T", None, None, None, None);
        let l = a.list(1, 1);
        assert_eq!((l.dropped, l.total), (2, MAX_ENTRIES));
        assert_eq!(l.data[0].entry.id, "0");
        a.remove("0");
        assert!(a.claim("0", "T", None, None, None, None));
    }

    #[tokio::test]
    async fn a_claim_refuses_work_already_registered() {
        let hub = Hub::new();
        let a = hub.activity();
        a.upsert_pending("p", "T", None, None);
        assert!(!a.claim("p", "T", None, None, None, None));
        assert!(a.claim("r", "T", titled("r"), None, None, None));
        assert!(!a.claim("r", "T", None, None, None, None));
        let l = json_of(&a.list(1, 25));
        assert_eq!(
            l["data"][0],
            json!({"id": "r", "type": "T", "subject": {"title": "r"}, "status": "running"})
        );
        assert_eq!(l["data"][1]["status"], "pending");
    }

    #[tokio::test(start_paused = true)]
    async fn mutations_coalesce_into_one_ping_per_window() {
        let hub = Hub::new();
        let mut rx = hub.subscribe();
        let a = hub.activity();
        a.upsert_pending("a", "T", None, None);
        a.upsert_pending("b", "T", None, None);
        a.remove("nope");
        tokio::time::sleep(Duration::from_millis(249)).await;
        assert!(rx.try_recv().is_err());
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert!(matches!(
            &*rx.recv().await.unwrap(),
            super::super::Bus::Sse(SseEvent::ActivityChanged {})
        ));
        assert!(rx.try_recv().is_err());
        a.remove("a");
        tokio::time::sleep(Duration::from_millis(251)).await;
        assert!(rx.recv().await.is_ok());
    }
}
