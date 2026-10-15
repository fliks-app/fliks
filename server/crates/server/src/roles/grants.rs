//! Grantable permission strings (`roles.md` rules 12-13).
use serde_json::Value;
use std::collections::BTreeSet;

pub const PERMISSIONS: [&str; 12] = [
    "media.read",
    "media.create",
    "media.edit",
    "media.delete",
    "media.grab",
    "livetv.read",
    "requests.create",
    "requests.manage",
    "subtitles.manage",
    "settings.access",
    "users.manage",
    "roles.manage",
];

/// Same pattern as Nest's `PLUGIN_PERMISSION_NAME_PATTERN`: `^[a-z][a-z0-9_-]{0,63}$`.
fn legal_name(n: &str) -> bool {
    let mut c = n.chars();
    n.len() <= 64
        && c.next().is_some_and(|f| f.is_ascii_lowercase())
        && c.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// `plugin:<id>:<name>` per declared name; `None` when a name is illegal or repeated (registration fails).
fn subjects(plugin_id: &str, manifest: &Value) -> Option<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    for n in manifest["permissions"].as_array().into_iter().flatten() {
        let n = n.as_str().unwrap_or_default();
        if !legal_name(n) || !out.insert(format!("plugin:{plugin_id}:{n}")) {
            return None;
        }
    }
    Some(out)
}

/// Sorted union over active `process` plugins: each route policy naming a declared subject, then the uncovered subjects.
pub fn plugin_grants(rows: &[(String, Value)]) -> Vec<String> {
    let mut grants = BTreeSet::new();
    for (id, manifest) in rows {
        if manifest["kind"] != "process" {
            continue;
        }
        let Some(subjects) = subjects(id, manifest) else {
            continue;
        };
        let mut covered = BTreeSet::new();
        for policy in manifest["routes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| r["policy"].as_str())
        {
            let subject = policy.split_once(':').map_or(policy, |(_, s)| s);
            if subjects.contains(subject) {
                grants.insert(policy.to_owned());
                covered.insert(subject.to_owned());
            }
        }
        grants.extend(subjects.into_iter().filter(|s| !covered.contains(s)));
    }
    grants.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: &str, perms: &[&str], routes: &[&str]) -> (String, Value) {
        let routes: Vec<_> = routes.iter().map(|p| json!({"policy": p})).collect();
        (
            id.into(),
            json!({"kind": "process", "permissions": perms, "routes": routes}),
        )
    }

    #[test]
    fn route_policies_keep_actions_separate_and_sorted() {
        let r = row(
            "fliks.a",
            &["queue", "indexers"],
            &[
                "read:plugin:fliks.a:queue",
                "read:plugin:fliks.a:indexers",
                "manage:plugin:fliks.a:indexers",
            ],
        );
        assert_eq!(
            plugin_grants(&[r]),
            [
                "manage:plugin:fliks.a:indexers",
                "read:plugin:fliks.a:indexers",
                "read:plugin:fliks.a:queue"
            ]
        );
    }

    #[test]
    fn uncovered_subject_is_granted_bare() {
        let r = row("fliks.a", &["reports"], &["read:plugin:fliks.a:other"]);
        assert_eq!(plugin_grants(&[r]), ["plugin:fliks.a:reports"]);
    }

    #[test]
    fn nothing_without_declared_permissions() {
        assert!(plugin_grants(&[row("fliks.a", &[], &["read:plugin:fliks.a:x"])]).is_empty());
    }

    #[test]
    fn bad_or_duplicate_names_and_data_plugins_contribute_nothing() {
        let data = ("d".into(), json!({"kind": "data", "permissions": ["x"]}));
        let rows = [
            row("a", &["Bad"], &[]),
            row("b", &["x", "x"], &[]),
            row("c", &["x.y"], &[]),
            data,
        ];
        assert!(plugin_grants(&rows).is_empty());
    }
}
