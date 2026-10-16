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

/// The Nest comparator: first non-zero step decides, negative = `a` first.
fn compare<T: Sortable>(a: &T, b: &T, prefer_full_season: bool) -> f64 {
    let step = flag_first(!a.rejected(), !b.rejected());
    if step != 0.0 {
        return step;
    }
    let step = flag_first(!a.blocklisted(), !b.blocklisted());
    if step != 0.0 {
        return step;
    }
    let step = flag_first(a.language_allowed(), b.language_allowed());
    if step != 0.0 {
        return step;
    }
    let step = flag_first(a.seeders() > 0, b.seeders() > 0);
    if step != 0.0 {
        return step;
    }
    if prefer_full_season {
        let res = |t: &T| app_quality_by_id(t.quality_id()).map_or(0, |q| q.resolution);
        if res(a) == res(b) {
            let step = flag_first(a.is_full_season(), b.is_full_season());
            if step != 0.0 {
                return step;
            }
            if let (true, Some(sa), Some(sb)) = (a.is_full_season(), a.seasons(), b.seasons()) {
                let gap = (sa.to - sa.from) - (sb.to - sb.from);
                if gap != 0 {
                    return gap as f64;
                }
            }
        }
    }
    if a.rank() != b.rank() {
        return (b.rank() - a.rank()) as f64;
    }
    if a.custom_format_score() != b.custom_format_score() {
        return (b.custom_format_score() - a.custom_format_score()) as f64;
    }
    let step = flag_first(a.freeleech(), b.freeleech());
    if step != 0.0 {
        return step;
    }
    let (sa, sb) = (swarm(a.seeders()), swarm(b.seeders()));
    if (sa - sb).abs() > SWARM_EPSILON {
        return sb - sa;
    }
    let (la, lb) = (swarm(a.leechers()), swarm(b.leechers()));
    if (la - lb).abs() > SWARM_EPSILON {
        return lb - la;
    }
    if let (Some(da), Some(db)) = (a.size_deviation(), b.size_deviation())
        && (da - db).abs() > 0.05
    {
        return da - db;
    }
    0.0
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
    merge_sort(rows, &|a, b| compare(a, b, prefer_full_season))
}
