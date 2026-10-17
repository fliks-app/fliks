//! Restricted groups (`livetv-access.md` rules 5-8, 21-28): the pure decisions around the three settings.
use super::names::fold_group_key;
use crate::js;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use fancy_regex::Regex;
use serde::Serialize;
use std::{collections::HashSet, sync::LazyLock};

pub const RESTRICTED_KEY: &str = "livetv_restricted_groups";
pub const EXEMPT_KEY: &str = "livetv_restricted_groups_exempt";
pub const VANISHED_KEY: &str = "livetv_restricted_groups_vanished";

/// Either permission means the account administers Live TV itself.
pub const ADMIN_PERMISSIONS: [&str; 2] = ["manage:all", "settings.access"];

/// ASCII word semantics, as JS without the `u` flag: `\b` and `\w` by hand.
static ADULT: LazyLock<Regex> = LazyLock::new(|| {
    const W: &str = "[A-Za-z0-9_]";
    let b = format!("(?:(?<={W})(?!{W})|(?<!{W})(?={W}))");
    let ws = format!("[{}]", js::WS_CLASS);
    let p = format!(
        "(?i){b}(?:xxx|sex[eo]?|porn{W}*|erot(?:ic|iqu|ik){W}*|x[- ]?rated|adult(?!{ws}*swim{b}){W}*){b}\
         |(?<![A-Za-z0-9])(?:\\+18|18\\+)(?![A-Za-z0-9])"
    );
    Regex::new(&p).expect("adult pattern")
});

/// Groups a provider ships that must never be visible by default; heuristic, excludes "Adult Swim".
pub fn is_adult_group(name: &str) -> bool {
    ADULT.is_match(name).unwrap_or(false)
}

/// A stored group set: anything but an array of strings reads as empty, non-strings are dropped.
pub fn read_group_set(raw: Option<&str>) -> Vec<String> {
    let Some(serde_json::Value::Array(a)) = raw.and_then(|r| serde_json::from_str(r).ok()) else {
        return vec![];
    };
    a.into_iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

/// A stored vanished map, in stored order: anything but an object reads as empty, non-strings are dropped.
pub fn read_vanished(raw: Option<&str>) -> Vec<(String, String)> {
    let Some(serde_json::Value::Object(o)) = raw.and_then(|r| serde_json::from_str(r).ok()) else {
        return vec![];
    };
    o.into_iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_owned())))
        .collect()
}

pub fn write_vanished(map: &[(String, String)]) -> String {
    let o: serde_json::Map<String, serde_json::Value> = map
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
        .collect();
    serde_json::Value::Object(o).to_string()
}

/// Trims, drops empties, deduplicates by fold key (first spelling wins) and sorts by code point.
pub fn normalize_group_set<S: AsRef<str>>(groups: &[S]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out: Vec<String> = groups
        .iter()
        .map(|g| js::trim(g.as_ref()))
        .filter(|g| !g.is_empty() && seen.insert(fold_group_key(g)))
        .map(str::to_owned)
        .collect();
    out.sort();
    out
}

/// The restricted groups a user was not granted; nothing for an account that administers live TV.
pub fn denied_groups(
    restricted: &[String],
    granted: &[String],
    permissions: &[String],
) -> Vec<String> {
    if restricted.is_empty()
        || ADMIN_PERMISSIONS
            .iter()
            .any(|p| permissions.iter().any(|q| q == p))
    {
        return vec![];
    }
    let granted: HashSet<_> = granted.iter().map(|g| fold_group_key(g)).collect();
    restricted
        .iter()
        .filter(|g| !granted.contains(&fold_group_key(g)))
        .cloned()
        .collect()
}

/// Adult-looking groups neither restricted nor exempted yet (a repeated name repeats).
pub fn adult_additions(names: &[String], restricted: &[String], exempt: &[String]) -> Vec<String> {
    let known: HashSet<_> = restricted
        .iter()
        .chain(exempt)
        .map(|g| fold_group_key(g))
        .collect();
    names
        .iter()
        .filter(|n| is_adult_group(n) && !known.contains(&fold_group_key(n)))
        .cloned()
        .collect()
}

/// What `setRestrictedGroups` derives from the previous and the new set.
#[derive(Debug, PartialEq)]
pub struct SetOutcome {
    pub unique: Vec<String>,
    /// Previous groups whose fold key left the set: their grants go first.
    pub dropped: Vec<String>,
    /// The exempt set after the change, `None` when it stays as stored.
    pub exempt: Option<Vec<String>>,
}

pub fn plan_set_restricted(
    previous: &[String],
    requested: &[String],
    exempt: &[String],
) -> SetOutcome {
    let unique = normalize_group_set(requested);
    let keys: HashSet<_> = unique.iter().map(|g| fold_group_key(g)).collect();
    let dropped: Vec<String> = previous
        .iter()
        .filter(|g| !keys.contains(&fold_group_key(g)))
        .cloned()
        .collect();
    let removed: Vec<&String> = dropped.iter().filter(|g| is_adult_group(g)).collect();
    let readded: Vec<&String> = unique.iter().filter(|g| is_adult_group(g)).collect();
    let exempt = (!removed.is_empty() || !readded.is_empty()).then(|| {
        let mut map: Vec<(String, String)> = vec![];
        let mut put = |g: &String| match map.iter_mut().find(|(k, _)| *k == fold_group_key(g)) {
            Some(e) => e.1 = g.clone(),
            None => map.push((fold_group_key(g), g.clone())),
        };
        exempt.iter().for_each(&mut put);
        removed.iter().for_each(|g| put(g));
        for g in readded {
            map.retain(|(k, _)| *k != fold_group_key(g));
        }
        normalize_group_set(&map.into_iter().map(|(_, v)| v).collect::<Vec<_>>())
    });
    SetOutcome {
        unique,
        dropped,
        exempt,
    }
}

/// The grants `setGrants` stores (under the restricted list's own spelling) and the names it ignored.
pub fn plan_grants(requested: &[String], restricted: &[String]) -> (Vec<String>, Vec<String>) {
    let mut seen = HashSet::new();
    let requested: Vec<&str> = requested
        .iter()
        .map(|g| js::trim(g))
        .filter(|g| !g.is_empty() && seen.insert(*g))
        .collect();
    let mut matched: Vec<(String, String)> = vec![];
    let mut ignored = vec![];
    for g in requested {
        let key = fold_group_key(g);
        // The last restricted spelling of a key wins, as a Map built from the list does.
        match restricted.iter().rfind(|r| fold_group_key(r) == key) {
            Some(r) if !matched.iter().any(|(k, _)| *k == key) => matched.push((key, r.clone())),
            Some(_) => {}
            None => ignored.push(g.to_owned()),
        }
    }
    (matched.into_iter().map(|(_, v)| v).collect(), ignored)
}

#[derive(Debug, PartialEq)]
pub struct Expiry {
    pub vanished: Vec<(String, String)>,
    pub changed: bool,
    pub expired: Vec<String>,
}

pub fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `expireVanishedGroups` without its writes: marks candidates missing from the live set, clears
/// the ones back, and expires restricted groups absent for `grace_days` (not in the pass that marked them).
pub fn plan_expiry(
    live: &[String],
    restricted: &[String],
    exempt: &[String],
    mut vanished: Vec<(String, String)>,
    grace_days: i64,
    now: DateTime<Utc>,
) -> Expiry {
    let live_keys: HashSet<_> = live.iter().map(|g| fold_group_key(g)).collect();
    let mut candidates: Vec<&String> = vec![];
    for g in restricted.iter().chain(exempt) {
        if !candidates.contains(&g) {
            candidates.push(g);
        }
    }
    let previously: HashSet<String> = vanished.iter().map(|(k, _)| k.clone()).collect();
    let mut changed = false;
    for name in &candidates {
        let at = vanished.iter().position(|(k, _)| k == *name);
        if live_keys.contains(&fold_group_key(name)) {
            if let Some(i) = at {
                vanished.remove(i);
                changed = true;
            }
        } else if at.is_none() {
            vanished.push(((*name).clone(), iso(now)));
            changed = true;
        }
    }
    let before = vanished.len();
    vanished.retain(|(k, _)| candidates.contains(&k));
    changed |= vanished.len() != before;
    let restricted_keys: HashSet<_> = restricted.iter().map(|g| fold_group_key(g)).collect();
    let cutoff = now - Duration::days(grace_days);
    let expired: Vec<String> = vanished
        .iter()
        .filter(|(name, since)| {
            previously.contains(name)
                && restricted_keys.contains(&fold_group_key(name))
                && DateTime::parse_from_rfc3339(since).is_ok_and(|s| s <= cutoff)
        })
        .map(|(k, _)| k.clone())
        .collect();
    if !expired.is_empty() {
        vanished.retain(|(k, _)| !expired.contains(k));
        changed = true;
    }
    Expiry {
        vanished,
        changed,
        expired,
    }
}

/// `clearVanished`: drops the entries whose fold key matches one of `names`.
pub fn clear_vanished(vanished: &mut Vec<(String, String)>, names: &[String]) -> bool {
    let keys: HashSet<_> = names.iter().map(|g| fold_group_key(g)).collect();
    let before = vanished.len();
    vanished.retain(|(k, _)| !keys.contains(&fold_group_key(k)));
    vanished.len() != before
}

/// The three settings and the grants table as one value: every access operation is a method here, so the
/// server only loads it, calls one and writes back `written` keys and the grants.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct State {
    pub restricted: Vec<String>,
    pub exempt: Vec<String>,
    pub vanished: Vec<(String, String)>,
    /// `(user id, group name)` rows of `livetv_group_access`.
    pub grants: Vec<(i32, String)>,
    /// Settings keys written, in order (a write that changed nothing still counts).
    pub written: Vec<&'static str>,
}

impl State {
    fn write_restricted(&mut self, groups: Vec<String>) {
        self.restricted = normalize_group_set(&groups);
        self.written.push(RESTRICTED_KEY);
    }

    fn write_vanished(&mut self) {
        self.written.push(VANISHED_KEY);
    }

    /// Every grant whose fold key matches one of `names`, whatever spelling it is stored under.
    fn delete_grants_for(&mut self, names: &[String]) {
        let keys: HashSet<_> = names.iter().map(|g| fold_group_key(g)).collect();
        self.grants
            .retain(|(_, g)| !keys.contains(&fold_group_key(g)));
    }

    fn clear_vanished_for(&mut self, names: &[String]) {
        if clear_vanished(&mut self.vanished, names) {
            self.write_vanished();
        }
    }

    /// `setRestrictedGroups`: grants of a dropped group go before the set is written.
    pub fn set_restricted(&mut self, groups: &[String]) -> Vec<String> {
        let plan = plan_set_restricted(&self.restricted, groups, &self.exempt);
        self.delete_grants_for(&plan.dropped);
        self.write_restricted(plan.unique.clone());
        if let Some(exempt) = plan.exempt {
            self.exempt = exempt;
            self.written.push(EXEMPT_KEY);
        }
        self.clear_vanished_for(&plan.unique);
        plan.unique
    }

    /// `restrictAdultGroups`: the resulting restricted set.
    pub fn restrict_adult(&mut self, names: &[String]) -> Vec<String> {
        let additions = adult_additions(names, &self.restricted, &self.exempt);
        if additions.is_empty() {
            return self.restricted.clone();
        }
        let all: Vec<String> = self.restricted.iter().cloned().chain(additions).collect();
        self.set_restricted(&all)
    }

    /// `expireVanishedGroups`: the groups whose restriction and grants lapsed.
    pub fn expire(&mut self, live: &[String], grace_days: i64, now: DateTime<Utc>) -> Vec<String> {
        let out = plan_expiry(
            live,
            &self.restricted,
            &self.exempt,
            std::mem::take(&mut self.vanished),
            grace_days,
            now,
        );
        self.vanished = out.vanished;
        if !out.expired.is_empty() {
            self.delete_grants_for(&out.expired);
            let kept: Vec<String> = self
                .restricted
                .iter()
                .filter(|g| !out.expired.contains(g))
                .cloned()
                .collect();
            self.write_restricted(kept);
        }
        if out.changed {
            self.write_vanished();
        }
        out.expired
    }

    /// `setGrants`: the stored groups and the ignored names.
    pub fn set_grants(&mut self, user: i32, requested: &[String]) -> (Vec<String>, Vec<String>) {
        let (groups, ignored) = plan_grants(requested, &self.restricted);
        self.grants.retain(|(u, _)| *u != user);
        self.grants.extend(groups.iter().map(|g| (user, g.clone())));
        self.clear_vanished_for(&groups);
        (groups, ignored)
    }

    /// The groups a user may not see: their grants are the rows of `user`.
    pub fn denied(&self, user: i32, permissions: &[String]) -> Vec<String> {
        let granted: Vec<String> = self
            .grants
            .iter()
            .filter(|(u, _)| *u == user)
            .map(|(_, g)| g.clone())
            .collect();
        denied_groups(&self.restricted, &granted, permissions)
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    pub name: String,
    pub automatic: bool,
    pub vanished_since: Option<String>,
    pub cleanup_at: Option<String>,
}

pub fn restricted_view(
    restricted: &[String],
    vanished: &[(String, String)],
    grace_days: i64,
) -> Vec<GroupView> {
    restricted
        .iter()
        .map(|name| {
            let since = vanished
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone());
            let cleanup_at = since
                .as_deref()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|s| iso(s.to_utc() + Duration::days(grace_days)));
            GroupView {
                name: name.clone(),
                automatic: is_adult_group(name),
                vanished_since: since,
                cleanup_at,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_adult_pattern_has_ascii_word_boundaries() {
        for yes in [
            "ADULTES",
            "Adulte",
            "Adultes FR",
            "FOR ADULTS",
            "PORNO",
            "Eroticos",
            "Erotik",
            "SEX",
            "X-RATED",
            "+18",
            "18+",
            "éxxx",
        ] {
            assert!(is_adult_group(yes), "{yes}");
        }
        for no in [
            "HOT",
            "HOT TV Israel",
            "Hot Hits",
            "Adult Swim",
            "News",
            "FR | SPORT",
            "Sussex",
            "Essex",
            "xxxl",
            "18+Movies",
            "+18Movies",
        ] {
            assert!(!is_adult_group(no), "{no}");
        }
    }

    #[test]
    fn group_sets_dedupe_by_fold_key_and_sort() {
        assert_eq!(normalize_group_set(&["b", " A ", "a", "", "B"]), ["A", "b"]);
        assert_eq!(read_group_set(Some(r#"["x", 1, "y"]"#)), ["x", "y"]);
        assert!(read_group_set(Some("{}")).is_empty() && read_group_set(Some("nope")).is_empty());
        assert!(read_vanished(Some("[]")).is_empty());
    }

    #[test]
    fn denied_groups_skip_admins_and_follow_grants_by_fold_key() {
        let restricted = v(&["XXX", "Kids"]);
        assert_eq!(denied_groups(&restricted, &v(&["xxx "]), &[]), ["Kids"]);
        assert!(denied_groups(&restricted, &[], &v(&["settings.access"])).is_empty());
        assert!(denied_groups(&[], &[], &[]).is_empty());
    }

    #[test]
    fn restricting_again_retires_an_exemption_and_dropping_one_adds_it() {
        let o = plan_set_restricted(&v(&["XXX"]), &[], &[]);
        assert_eq!(
            (o.dropped.clone(), o.exempt.clone()),
            (v(&["XXX"]), Some(v(&["XXX"])))
        );
        let o = plan_set_restricted(&[], &v(&["xxx"]), &v(&["XXX"]));
        assert_eq!(o.exempt, Some(vec![]));
        let o = plan_set_restricted(&v(&["Kids"]), &v(&["kids"]), &[]);
        assert!(o.dropped.is_empty() && o.exempt.is_none());
    }

    #[test]
    fn grants_follow_the_restricted_spelling() {
        let (m, i) = plan_grants(&v(&["xxx", " nope ", "XXX"]), &v(&["XXX"]));
        assert_eq!((m, i), (v(&["XXX"]), v(&["nope"])));
    }

    #[test]
    fn expiry_waits_for_a_second_pass_and_the_grace() {
        let t0 = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let first = plan_expiry(&[], &v(&["XXX"]), &[], vec![], 0, t0);
        assert!(first.expired.is_empty() && first.changed);
        let second = plan_expiry(&[], &v(&["XXX"]), &[], first.vanished, 0, t0);
        assert_eq!(second.expired, ["XXX"]);
        assert!(second.vanished.is_empty());
        let back = plan_expiry(
            &v(&["xxx"]),
            &v(&["XXX"]),
            &[],
            vec![("XXX".into(), iso(t0))],
            7,
            t0,
        );
        assert!(back.vanished.is_empty() && back.changed);
        let exempt_only = plan_expiry(
            &[],
            &[],
            &v(&["XXX"]),
            vec![("XXX".into(), iso(t0 - Duration::days(30)))],
            7,
            t0,
        );
        assert!(exempt_only.expired.is_empty());
        let stale = plan_expiry(&[], &[], &[], vec![("Old".into(), iso(t0))], 7, t0);
        assert!(stale.vanished.is_empty() && stale.changed);
    }

    #[test]
    fn the_view_adds_the_cleanup_date() {
        let t0 = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let view = restricted_view(&v(&["Sex"]), &[("Sex".into(), iso(t0))], 7);
        assert_eq!(
            view[0].cleanup_at.as_deref(),
            Some("2026-01-08T00:00:00.000Z")
        );
        assert!(view[0].automatic);
    }
}
