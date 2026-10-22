//! What a source sync decides, before any row is written (`livetv-sources.md` rules 30-32 and 38).
use super::{
    m3u::{M3uEntry, is_on_demand_url},
    names::normalize_channel_name,
};
use chrono::{DateTime, Duration, Utc};
use fancy_regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// One playlist entry, whichever protocol produced it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub external_id: String,
    pub name: String,
    pub url: String,
    pub logo: Option<String>,
    pub group_name: String,
    pub tvg_id: Option<String>,
    pub number: Option<i32>,
    pub quality_label: Option<String>,
    pub shift_minutes: i32,
    pub user_agent: Option<String>,
    pub referer: Option<String>,
}

impl From<M3uEntry> for Entry {
    fn from(e: M3uEntry) -> Self {
        Self {
            quality_label: e.attrs.get("tvg-quality").cloned(),
            external_id: e.external_id,
            name: e.name,
            url: e.url,
            logo: e.logo,
            group_name: e.group_name,
            tvg_id: e.tvg_id,
            number: e.number,
            shift_minutes: e.shift_minutes,
            user_agent: e.user_agent,
            referer: e.referer,
        }
    }
}

/// A group pattern, case-insensitive, with look-around and back-references; the backtrack limit
/// bounds a catastrophic one.
#[derive(Debug, Clone)]
pub struct GroupPattern(Regex);

const BACKTRACK_LIMIT: usize = 200_000;

impl GroupPattern {
    /// `Err` is the engine's message for a pattern that does not compile.
    pub fn compile(pattern: &str) -> Result<Self, String> {
        let p = format!("(?i){}", crate::js::translate(pattern, false, true));
        RegexBuilder::new(&p)
            .backtrack_limit(BACKTRACK_LIMIT)
            .build()
            .map(Self)
            .map_err(|e| e.to_string())
    }

    /// `Err` when the match hit the backtrack limit.
    pub fn is_match(&self, text: &str) -> Result<bool, String> {
        self.0.is_match(text).map_err(|e| e.to_string())
    }
}

/// Which pattern of a source failed to match: the sync then ignores it for that run.
#[derive(Debug, PartialEq, Eq)]
pub enum PatternField {
    Include,
    Exclude,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GroupCount {
    pub name: String,
    pub count: usize,
}

#[derive(Debug)]
pub struct Classified {
    pub live: Vec<Entry>,
    pub on_demand_count: usize,
    pub groups: Vec<GroupCount>,
}

/// Drops on-demand entries, counts groups before the patterns (largest first, ties in first-seen
/// order), then applies exclude (wins) and include.
pub fn classify_entries(
    entries: Vec<Entry>,
    include: Option<&GroupPattern>,
    exclude: Option<&GroupPattern>,
) -> Result<Classified, (PatternField, String)> {
    let mut on_demand_count = 0;
    let mut candidates = vec![];
    let mut counts: Vec<GroupCount> = vec![];
    let mut index: HashMap<String, usize> = HashMap::new();
    for e in entries {
        if is_on_demand_url(&e.url) {
            on_demand_count += 1;
            continue;
        }
        let i = *index.entry(e.group_name.clone()).or_insert_with(|| {
            counts.push(GroupCount {
                name: e.group_name.clone(),
                count: 0,
            });
            counts.len() - 1
        });
        counts[i].count += 1;
        candidates.push(e);
    }
    counts.sort_by_key(|g| std::cmp::Reverse(g.count));
    let mut live = vec![];
    for e in candidates {
        if let Some(x) = exclude
            && x.is_match(&e.group_name)
                .map_err(|m| (PatternField::Exclude, m))?
        {
            continue;
        }
        if let Some(i) = include
            && !i
                .is_match(&e.group_name)
                .map_err(|m| (PatternField::Include, m))?
        {
            continue;
        }
        live.push(e);
    }
    Ok(Classified {
        live,
        on_demand_count,
        groups: counts,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountState {
    Ok,
    Expiring,
    Expired,
}

const EXPIRY_WARNING_DAYS: i64 = 7;

/// Only a status of `expired` (any case) is read from the panel; otherwise the date decides.
pub fn account_state(
    expires_at: Option<DateTime<Utc>>,
    status: Option<&str>,
    now: DateTime<Utc>,
) -> AccountState {
    if status.is_some_and(|s| s.to_lowercase() == "expired") {
        return AccountState::Expired;
    }
    let Some(at) = expires_at else {
        return AccountState::Ok;
    };
    let left = at - now;
    if left <= Duration::zero() {
        AccountState::Expired
    } else if left <= Duration::days(EXPIRY_WARNING_DAYS) {
        AccountState::Expiring
    } else {
        AccountState::Ok
    }
}

#[derive(Debug, Clone)]
pub struct StreamRow {
    pub id: i32,
    pub channel_id: i32,
    pub external_id: String,
    pub last_seen_at: Option<DateTime<Utc>>,
}

/// A channel as the sync sees it (`ORDER BY id`).
#[derive(Debug, Clone)]
pub struct ChannelRow {
    pub id: i32,
    pub name: String,
    pub group_name: Option<String>,
    pub group_is_manual: bool,
    pub guide_channel_id: Option<String>,
    /// Streams of every source.
    pub stream_count: usize,
    pub has_stream_of_source: bool,
}

#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    /// Entry indexes that become a new disabled channel with one stream, in order.
    pub new_channels: Vec<usize>,
    /// `(channel id, entry index, priority)`: the entry joins a channel of another source.
    pub folds: Vec<(i32, usize, i32)>,
    /// `(stream id, entry index)`.
    pub updates: Vec<(i32, usize)>,
    /// `(channel id, guide channel id, group name)`: the values to write, only for touched channels.
    pub patches: Vec<(i32, Option<String>, Option<String>)>,
    pub removed_streams: Vec<i32>,
    /// Channels that lost a stream: deleted when none is left.
    pub affected_channels: Vec<i32>,
}

impl Plan {
    pub fn added(&self) -> usize {
        self.new_channels.len() + self.folds.len()
    }
}

/// The upsert of rule 38: match on `externalId`, else fold onto the first same-named channel
/// without a stream of this source, else create; then drop streams unseen for `stale_days`.
pub fn plan_upsert(
    entries: &[Entry],
    existing: &[StreamRow],
    channels: &[ChannelRow],
    now: DateTime<Utc>,
    stale_days: i64,
) -> Plan {
    let by_external: HashMap<&str, &StreamRow> = existing
        .iter()
        .map(|s| (s.external_id.as_str(), s))
        .collect();
    let mut chans: HashMap<i32, ChannelRow> = channels.iter().map(|c| (c.id, c.clone())).collect();
    let mut with_source: HashSet<i32> = channels
        .iter()
        .filter(|c| c.has_stream_of_source)
        .map(|c| c.id)
        .collect();
    let mut targets: HashMap<String, i32> = HashMap::new();
    for c in channels.iter().filter(|c| !c.has_stream_of_source) {
        let key = normalize_channel_name(&c.name);
        if !key.is_empty() {
            targets.entry(key).or_insert(c.id);
        }
    }
    let mut plan = Plan::default();
    let mut touched: Vec<i32> = vec![];
    let mut seen: HashSet<&str> = HashSet::new();
    let touch =
        |chans: &mut HashMap<i32, ChannelRow>, id: i32, e: &Entry, touched: &mut Vec<i32>| {
            let Some(c) = chans.get_mut(&id) else { return };
            let mut changed = false;
            if let Some(g) = e.tvg_id.as_ref().filter(|g| !g.is_empty())
                && c.guide_channel_id.as_deref().is_none_or(str::is_empty)
            {
                c.guide_channel_id = Some(g.clone());
                changed = true;
            }
            if !c.group_is_manual && c.group_name.as_deref() != Some(e.group_name.as_str()) {
                c.group_name = Some(e.group_name.clone());
                changed = true;
            }
            if changed && !touched.contains(&id) {
                touched.push(id);
            }
        };
    for (i, e) in entries.iter().enumerate() {
        seen.insert(e.external_id.as_str());
        if let Some(s) = by_external.get(e.external_id.as_str()) {
            plan.updates.push((s.id, i));
            touch(&mut chans, s.channel_id, e, &mut touched);
            continue;
        }
        let key = normalize_channel_name(&e.name);
        let target = (!key.is_empty())
            .then(|| targets.get(&key).copied())
            .flatten()
            .filter(|t| !with_source.contains(t));
        if let Some(t) = target {
            let priority = chans.get(&t).map_or(0, |c| c.stream_count) as i32;
            with_source.insert(t);
            plan.folds.push((t, i, priority));
            touch(&mut chans, t, e, &mut touched);
        } else {
            plan.new_channels.push(i);
        }
    }
    plan.patches = touched
        .iter()
        .filter_map(|id| chans.get(id))
        .map(|c| (c.id, c.guide_channel_id.clone(), c.group_name.clone()))
        .collect();
    let cutoff = now - Duration::days(stale_days);
    for s in existing {
        if !seen.contains(s.external_id.as_str()) && s.last_seen_at.is_none_or(|t| t < cutoff) {
            plan.removed_streams.push(s.id);
            if !plan.affected_channels.contains(&s.channel_id) {
                plan.affected_channels.push(s.channel_id);
            }
        }
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn entry(ext: &str, name: &str, group: &str, tvg: Option<&str>) -> Entry {
        Entry {
            external_id: ext.into(),
            name: name.into(),
            url: format!("http://p/live/{ext}.ts"),
            logo: None,
            group_name: group.into(),
            tvg_id: tvg.map(Into::into),
            number: None,
            quality_label: None,
            shift_minutes: 0,
            user_agent: None,
            referer: None,
        }
    }

    fn channel(id: i32, name: &str, group: &str) -> ChannelRow {
        ChannelRow {
            id,
            name: name.into(),
            group_name: Some(group.into()),
            group_is_manual: false,
            guide_channel_id: None,
            stream_count: 1,
            has_stream_of_source: false,
        }
    }

    #[test]
    fn patterns_are_case_insensitive_with_lookaround() {
        let p = GroupPattern::compile("^(?!adult).*news").unwrap();
        assert!(p.is_match("World NEWS").unwrap());
        assert!(!p.is_match("Adult news").unwrap());
        assert!(GroupPattern::compile("(").is_err());
        let catastrophic = GroupPattern::compile(r"^(a|aa)+\1$").unwrap();
        assert!(
            catastrophic
                .is_match(&format!("{}b", "a".repeat(40)))
                .is_err()
        );
    }

    #[test]
    fn classify_counts_groups_before_the_patterns_and_exclude_wins() {
        let entries = vec![
            entry("1", "A", "News", None),
            entry("2", "B", "Sport", None),
            entry("3", "C", "Sport", None),
            Entry {
                url: "http://p/movie/x.mp4".into(),
                ..entry("4", "D", "Films", None)
            },
        ];
        let ex = GroupPattern::compile("^sport$").unwrap();
        let inc = GroupPattern::compile("sport|news").unwrap();
        let c = classify_entries(entries, Some(&inc), Some(&ex)).unwrap();
        assert_eq!(c.on_demand_count, 1);
        assert_eq!(
            c.groups,
            [
                GroupCount {
                    name: "Sport".into(),
                    count: 2
                },
                GroupCount {
                    name: "News".into(),
                    count: 1
                }
            ]
        );
        assert_eq!(c.live.len(), 1);
    }

    #[test]
    fn account_states() {
        let now = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let at = |d| Some(now + Duration::days(d));
        assert_eq!(
            account_state(at(30), Some("EXPIRED"), now),
            AccountState::Expired
        );
        assert_eq!(account_state(None, Some("Active"), now), AccountState::Ok);
        assert_eq!(account_state(at(0), None, now), AccountState::Expired);
        assert_eq!(account_state(at(7), None, now), AccountState::Expiring);
        assert_eq!(account_state(at(8), None, now), AccountState::Ok);
    }

    #[test]
    fn upsert_updates_folds_creates_and_removes_stale() {
        let now = Utc.with_ymd_and_hms(2026, 1, 20, 0, 0, 0).unwrap();
        let existing = vec![
            StreamRow {
                id: 10,
                channel_id: 1,
                external_id: "a".into(),
                last_seen_at: Some(now),
            },
            StreamRow {
                id: 11,
                channel_id: 2,
                external_id: "gone".into(),
                last_seen_at: Some(now - Duration::days(8)),
            },
            StreamRow {
                id: 12,
                channel_id: 3,
                external_id: "recent".into(),
                last_seen_at: Some(now - Duration::days(1)),
            },
        ];
        let mine = |id, name: &str| ChannelRow {
            has_stream_of_source: true,
            ..channel(id, name, "News")
        };
        let channels = vec![
            mine(1, "Alpha"),
            mine(2, "Beta"),
            mine(3, "Gamma"),
            channel(4, "Canal+ Décalé", "Other"),
            channel(5, "canal decale", "Other"),
        ];
        let entries = vec![
            entry("a", "Alpha", "Sport", Some("alpha.fr")),
            entry("n1", "FR: Canal+ Decale FHD", "Fun", None),
            entry("n2", "FR: Canal+ Decale HD", "Fun", None),
            entry("n3", "Brand new", "Fun", None),
        ];
        let plan = plan_upsert(&entries, &existing, &channels, now, 7);
        assert_eq!(plan.updates, [(10, 0)]);
        assert_eq!(plan.folds, [(4, 1, 1)]);
        assert_eq!(plan.new_channels, [2, 3]);
        assert_eq!(plan.removed_streams, [11]);
        assert_eq!(plan.affected_channels, [2]);
        assert_eq!(plan.added(), 3);
        assert_eq!(
            plan.patches,
            [
                (1, Some("alpha.fr".into()), Some("Sport".into())),
                (4, None, Some("Fun".into()))
            ]
        );
    }

    #[test]
    fn a_manual_group_is_never_realigned_and_a_guide_id_never_overwritten() {
        let now = Utc.with_ymd_and_hms(2026, 1, 20, 0, 0, 0).unwrap();
        let existing = vec![StreamRow {
            id: 1,
            channel_id: 1,
            external_id: "a".into(),
            last_seen_at: None,
        }];
        let channels = vec![ChannelRow {
            group_is_manual: true,
            guide_channel_id: Some("kept".into()),
            has_stream_of_source: true,
            ..channel(1, "A", "Mine")
        }];
        let plan = plan_upsert(
            &[entry("a", "A", "Theirs", Some("new"))],
            &existing,
            &channels,
            now,
            7,
        );
        assert!(plan.patches.is_empty());
    }

    #[test]
    fn stale_days_zero_removes_every_unseen_stream() {
        let now = Utc.with_ymd_and_hms(2026, 1, 20, 0, 0, 0).unwrap();
        let existing = vec![StreamRow {
            id: 1,
            channel_id: 1,
            external_id: "a".into(),
            last_seen_at: Some(now - Duration::seconds(1)),
        }];
        let plan = plan_upsert(&[], &existing, &[], now, 0);
        assert_eq!(plan.removed_streams, [1]);
        let plan = plan_upsert(&[], &existing, &[], now, 1);
        assert!(plan.removed_streams.is_empty());
    }
}
