//! Relevance order of scored releases (`sortReleasesByRelevance`, `release-rejection.helper.ts`).
use crate::release::parsing::quality::app_quality_by_id;
use crate::release::parsing::season_episode::Span;

pub trait Sortable {
    fn quality_id(&self) -> i64;
    fn rank(&self) -> i64;
    fn blocklisted(&self) -> bool;
    fn language_allowed(&self) -> bool;
    fn rejected(&self) -> bool;
    fn custom_format_score(&self) -> i64;
    fn seeders(&self) -> i64;
    fn leechers(&self) -> i64;
    fn freeleech(&self) -> bool;
    fn size_deviation(&self) -> Option<f64>;
    fn is_full_season(&self) -> bool;
    fn seasons(&self) -> Option<Span>;
    /// A PROPER or REPACK is 2; it wins a tie on rank and score.
    fn revision(&self) -> u32 {
        1
    }
    /// Only text releases set it; a retail one wins a tie on rank and score.
    fn retail(&self) -> bool {
        false
    }
    /// Stores the label the sort gave this row.
    fn set_label(&mut self, _label: ReleaseLabel) {}
}

/// log2 gap that counts as a real swarm difference; smaller gaps fall through.
const SWARM_EPSILON: f64 = 0.25;

fn swarm(n: i64) -> f64 {
    (n.max(0) as f64 + 1.0).log2()
}

fn flag_first(a: bool, b: bool) -> f64 {
    if a == b {
        0.0
    } else if a {
        -1.0
    } else {
        1.0
    }
}

/// The comparator: the first non-zero step decides, negative = `a` first, with the step's key.
fn decide<T: Sortable>(a: &T, b: &T, prefer_full_season: bool) -> Option<(f64, &'static str)> {
    macro_rules! step {
        ($step:expr, $key:expr) => {
            let s: f64 = $step;
            if s != 0.0 {
                return Some((s, $key));
            }
        };
    }
    step!(flag_first(!a.rejected(), !b.rejected()), "rejected");
    step!(flag_first(!a.blocklisted(), !b.blocklisted()), "blocked");
    step!(
        flag_first(a.language_allowed(), b.language_allowed()),
        "language"
    );
    step!(flag_first(a.seeders() > 0, b.seeders() > 0), "seeders");
    if prefer_full_season {
        let res = |t: &T| app_quality_by_id(t.quality_id()).map_or(0, |q| q.resolution);
        if res(a) == res(b) {
            step!(
                flag_first(a.is_full_season(), b.is_full_season()),
                "full_season"
            );
            if let (true, Some(sa), Some(sb)) = (a.is_full_season(), a.seasons(), b.seasons()) {
                step!(
                    ((sa.to - sa.from) - (sb.to - sb.from)) as f64,
                    "full_season"
                );
            }
        }
    }
    step!((b.rank() - a.rank()) as f64, "rank");
    step!(
        (b.custom_format_score() - a.custom_format_score()) as f64,
        "score"
    );
    step!(
        f64::from(b.revision()) - f64::from(a.revision()),
        "revision"
    );
    step!(flag_first(a.retail(), b.retail()), "retail");
    step!(flag_first(a.freeleech(), b.freeleech()), "freeleech");
    let (sa, sb) = (swarm(a.seeders()), swarm(b.seeders()));
    if (sa - sb).abs() > SWARM_EPSILON {
        return Some((sb - sa, "swarm"));
    }
    let (la, lb) = (swarm(a.leechers()), swarm(b.leechers()));
    if (la - lb).abs() > SWARM_EPSILON {
        return Some((lb - la, "swarm"));
    }
    if let (Some(da), Some(db)) = (a.size_deviation(), b.size_deviation())
        && (da - db).abs() > 0.05
    {
        return Some((da - db, "size"));
    }
    None
}

fn compare<T: Sortable>(a: &T, b: &T, prefer_full_season: bool) -> f64 {
    decide(a, b, prefer_full_season).map_or(0.0, |d| d.0)
}

/// What a release is in the sorted list: the best clean one, a clean one passed over (with the first
/// comparator step it lost on against the best, `order` for a tie), a rejected or a blocklisted one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReleaseLabel {
    #[default]
    Rejected,
    Blocked,
    Best,
    PassedOver(&'static str),
}

impl ReleaseLabel {
    /// The wire `label` and, for a passed-over release, `lostOn`.
    pub fn wire(self) -> (&'static str, Option<&'static str>) {
        match self {
            Self::Rejected => ("rejected", None),
            Self::Blocked => ("blocked", None),
            Self::Best => ("best", None),
            Self::PassedOver(on) => ("passed_over", Some(on)),
        }
    }
}

/// The labels of an already sorted list.
pub fn label_releases<T: Sortable>(sorted: &[T], prefer_full_season: bool) -> Vec<ReleaseLabel> {
    let best = sorted
        .iter()
        .position(|r| !r.rejected() && !r.blocklisted());
    sorted
        .iter()
        .enumerate()
        .map(|(i, r)| match best {
            _ if r.blocklisted() => ReleaseLabel::Blocked,
            _ if r.rejected() => ReleaseLabel::Rejected,
            Some(b) if b == i => ReleaseLabel::Best,
            Some(b) => ReleaseLabel::PassedOver(
                decide(&sorted[b], r, prefer_full_season).map_or("order", |d| d.1),
            ),
            None => ReleaseLabel::Rejected,
        })
        .collect()
}

/// Stable merge sort that tolerates a non-total comparator (`slice::sort_by` may panic on one).
fn merge_sort<T>(mut rows: Vec<T>, cmp: &impl Fn(&T, &T) -> f64) -> Vec<T> {
    if rows.len() < 2 {
        return rows;
    }
    let right = merge_sort(rows.split_off(rows.len() / 2), cmp);
    let left = merge_sort(rows, cmp);
    let (mut out, mut l, mut r) = (
        Vec::with_capacity(left.len() + right.len()),
        left.into_iter().peekable(),
        right.into_iter().peekable(),
    );
    while let (Some(a), Some(b)) = (l.peek(), r.peek()) {
        out.push(if cmp(a, b) > 0.0 { r.next() } else { l.next() }.expect("peeked"));
    }
    out.extend(l);
    out.extend(r);
    out
}

pub fn sort_releases_by_relevance<T: Sortable>(rows: Vec<T>, prefer_full_season: bool) -> Vec<T> {
    let mut rows = merge_sort(rows, &|a, b| compare(a, b, prefer_full_season));
    let labels = label_releases(&rows, prefer_full_season);
    for (r, l) in rows.iter_mut().zip(labels) {
        r.set_label(l);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct Row {
        rank: i64,
        score: i64,
        seeders: i64,
        rejected: bool,
        blocked: bool,
        label: ReleaseLabel,
    }

    fn row(rank: i64, score: i64, seeders: i64) -> Row {
        Row {
            rank,
            score,
            seeders,
            rejected: false,
            blocked: false,
            label: ReleaseLabel::default(),
        }
    }

    impl Sortable for Row {
        fn quality_id(&self) -> i64 {
            0
        }
        fn rank(&self) -> i64 {
            self.rank
        }
        fn blocklisted(&self) -> bool {
            self.blocked
        }
        fn language_allowed(&self) -> bool {
            true
        }
        fn rejected(&self) -> bool {
            self.rejected
        }
        fn custom_format_score(&self) -> i64 {
            self.score
        }
        fn seeders(&self) -> i64 {
            self.seeders
        }
        fn leechers(&self) -> i64 {
            0
        }
        fn freeleech(&self) -> bool {
            false
        }
        fn size_deviation(&self) -> Option<f64> {
            None
        }
        fn is_full_season(&self) -> bool {
            false
        }
        fn seasons(&self) -> Option<Span> {
            None
        }
        fn set_label(&mut self, label: ReleaseLabel) {
            self.label = label;
        }
    }

    #[test]
    fn a_passed_over_release_names_the_first_step_it_lost_on() {
        let mut rejected = row(9, 0, 5);
        rejected.rejected = true;
        let mut blocked = row(9, 0, 5);
        blocked.blocked = true;
        let rows = vec![
            row(5, 0, 5),
            row(4, 0, 5),
            row(5, 10, 5),
            row(5, 0, 0),
            row(5, 0, 5),
            rejected,
            blocked,
        ];
        let sorted = sort_releases_by_relevance(rows, false);
        let labels: Vec<_> = sorted.iter().map(|r| r.label.wire()).collect();
        assert_eq!(
            labels,
            [
                ("best", None),
                ("passed_over", Some("score")),
                ("passed_over", Some("score")),
                ("passed_over", Some("rank")),
                ("passed_over", Some("seeders")),
                ("blocked", None),
                ("rejected", None),
            ]
        );
    }

    #[test]
    fn a_tie_is_lost_on_order() {
        let sorted = sort_releases_by_relevance(vec![row(5, 0, 5), row(5, 0, 5)], false);
        assert_eq!(sorted[1].label.wire(), ("passed_over", Some("order")));
    }

    #[test]
    fn a_list_with_no_clean_release_has_no_best() {
        let mut r = row(1, 0, 1);
        r.rejected = true;
        let sorted = sort_releases_by_relevance(vec![r], false);
        assert_eq!(sorted[0].label, ReleaseLabel::Rejected);
    }
}
