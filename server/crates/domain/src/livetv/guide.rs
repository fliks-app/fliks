//! Guide matching and source priority (`livetv-guide.md` rules 34 and 44).
use super::names::{name_tokens, normalize_channel_name, token_similarity};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Below this a name pair is a coincidence, not the same channel.
const FUZZY_THRESHOLD: f64 = 0.75;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub display_names: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Matchable {
    pub id: i32,
    pub name: String,
    pub guide_channel_id: Option<String>,
    pub guide_match_kind: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Id,
    Name,
    Fuzzy,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Id => "id",
            Self::Name => "name",
            Self::Fuzzy => "fuzzy",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub channel_id: i32,
    pub guide_channel_id: String,
    pub kind: Kind,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub assignments: Vec<Assignment>,
    pub unmatched_channel_ids: Vec<i32>,
    pub by_kind: ByKind,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct ByKind {
    pub id: usize,
    pub name: usize,
    pub fuzzy: usize,
}

struct FuzzyEntry<'a> {
    id: &'a str,
    tokens: Vec<String>,
}

/// Three passes, weakest last: the guide id, the name, a token overlap. A manual assignment is never revisited.
pub fn match_guide_channels(channels: &[Matchable], candidates: &[Candidate]) -> Report {
    let mut by_id: HashMap<String, &str> = HashMap::new();
    let mut by_name: HashMap<String, &str> = HashMap::new();
    let mut fuzzy: Vec<FuzzyEntry> = vec![];
    let mut by_token: HashMap<String, Vec<usize>> = HashMap::new();
    for c in candidates {
        by_id.insert(c.id.to_lowercase(), &c.id);
        for name in std::iter::once(&c.id).chain(&c.display_names) {
            let key = normalize_channel_name(name);
            if !key.is_empty() {
                by_name.entry(key).or_insert(&c.id);
            }
        }
        for name in &c.display_names {
            let tokens = name_tokens(name);
            if tokens.is_empty() {
                continue;
            }
            for t in &tokens {
                by_token.entry(t.clone()).or_default().push(fuzzy.len());
            }
            fuzzy.push(FuzzyEntry { id: &c.id, tokens });
        }
    }
    let mut report = Report::default();
    for ch in channels {
        if ch.guide_match_kind.as_deref() == Some("manual") {
            continue;
        }
        let mut assign = |guide: &str, kind: Kind| {
            report.assignments.push(Assignment {
                channel_id: ch.id,
                guide_channel_id: guide.to_owned(),
                kind,
            });
            match kind {
                Kind::Id => report.by_kind.id += 1,
                Kind::Name => report.by_kind.name += 1,
                Kind::Fuzzy => report.by_kind.fuzzy += 1,
            }
        };
        if let Some(id) = ch
            .guide_channel_id
            .as_ref()
            .filter(|g| !g.is_empty())
            .and_then(|g| by_id.get(&g.to_lowercase()))
        {
            assign(id, Kind::Id);
            continue;
        }
        if let Some(id) = by_name.get(&normalize_channel_name(&ch.name)) {
            assign(id, Kind::Name);
            continue;
        }
        let tokens = name_tokens(&ch.name);
        let mut best: Option<(&str, f64)> = None;
        let mut scored: Vec<usize> = vec![];
        for t in &tokens {
            for &i in by_token.get(t).into_iter().flatten() {
                if scored.contains(&i) {
                    continue;
                }
                scored.push(i);
                let score = token_similarity(&tokens, &fuzzy[i].tokens);
                if score > best.map_or(0.0, |b| b.1) {
                    best = Some((fuzzy[i].id, score));
                }
            }
        }
        match best.filter(|b| b.1 >= FUZZY_THRESHOLD) {
            Some((id, _)) => assign(id, Kind::Fuzzy),
            None => report.unmatched_channel_ids.push(ch.id),
        }
    }
    report
}

/// Per guide channel id the rows of the highest-priority guide source (ties to the lower source id),
/// original order kept. `priority` of a source missing from the map is 0.
pub fn pick_highest_priority<'a, T>(
    rows: &'a [T],
    key: impl Fn(&'a T) -> (&'a str, i32),
    priority: &HashMap<i32, i32>,
) -> Vec<&'a T> {
    let mut winner: HashMap<&str, (i32, i32)> = HashMap::new();
    for r in rows {
        let (channel, source) = key(r);
        let p = priority.get(&source).copied().unwrap_or(0);
        match winner.get(channel) {
            Some(&(cur_source, cur_p)) if !(p > cur_p || (p == cur_p && source < cur_source)) => {}
            _ => {
                winner.insert(channel, (source, p));
            }
        }
    }
    rows.iter()
        .filter(|r| {
            let (channel, source) = key(r);
            winner.get(channel).is_some_and(|w| w.0 == source)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(id: i32, name: &str, guide: Option<&str>, kind: Option<&str>) -> Matchable {
        Matchable {
            id,
            name: name.into(),
            guide_channel_id: guide.map(Into::into),
            guide_match_kind: kind.map(Into::into),
        }
    }

    fn cand(id: &str, names: &[&str]) -> Candidate {
        Candidate {
            id: id.into(),
            display_names: names.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn passes_run_id_name_fuzzy_and_skip_manual() {
        let candidates = [
            cand("One.fr", &["One"]),
            cand("sport", &["Sport Extra Max"]),
            cand("dup", &["Dup"]),
            cand("DUP", &["Other"]),
        ];
        let channels = [
            ch(1, "Whatever", Some("one.FR"), None),
            ch(2, "one hd", None, None),
            ch(3, "Sport Extra Max Live", None, None),
            ch(4, "Zzz", None, Some("id")),
            ch(5, "Locked", Some("one.fr"), Some("manual")),
            ch(6, "dup", None, None),
        ];
        let r = match_guide_channels(&channels, &candidates);
        let got: Vec<_> = r
            .assignments
            .iter()
            .map(|a| (a.channel_id, a.guide_channel_id.as_str(), a.kind))
            .collect();
        assert_eq!(
            got,
            [
                (1, "One.fr", Kind::Id),
                (2, "One.fr", Kind::Name),
                (3, "sport", Kind::Fuzzy),
                (6, "dup", Kind::Name)
            ]
        );
        assert_eq!(r.unmatched_channel_ids, [4]);
        assert_eq!((r.by_kind.id, r.by_kind.name, r.by_kind.fuzzy), (1, 2, 1));
    }

    #[test]
    fn a_tie_goes_to_the_first_visited_candidate() {
        let candidates = [
            cand("a", &["red green blue yellow"]),
            cand("b", &["red green blue purple"]),
        ];
        let r = match_guide_channels(&[ch(1, "red green blue", None, None)], &candidates);
        assert_eq!(r.assignments[0].guide_channel_id, "a");
        assert_eq!(r.assignments[0].kind, Kind::Fuzzy);
    }

    #[test]
    fn priority_keeps_one_source_per_channel() {
        let rows = [("c", 1), ("c", 2), ("d", 2), ("c", 1)];
        let p: HashMap<i32, i32> = [(1, 0), (2, 5)].into();
        let kept = pick_highest_priority(&rows, |r| (r.0, r.1), &p);
        assert_eq!(kept, [&("c", 2), &("d", 2)]);
        let tie: HashMap<i32, i32> = HashMap::new();
        let kept = pick_highest_priority(&rows, |r| (r.0, r.1), &tie);
        assert_eq!(kept, [&("c", 1), &("d", 2), &("c", 1)]);
    }
}
