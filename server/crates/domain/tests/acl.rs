//! Golden ACL vectors (`fixtures/acl/cases.json`, `BLESS=1` rewrites `expected`).
mod common;

use common::{Fixture, blessing, diff};
use fliks_domain::acl::{Action, Permissions, Subject};
use serde_json::{Value, json};
use std::path::PathBuf;

const PLUGINS: [&str; 2] = [
    "plugin:fliks.myplugin:download",
    "plugin:fliks.otherplugin:download",
];

/// CASL 6.8 denies every instance check once a non-`all` ability also holds a string-subject rule
/// (`Settings`, `plugin:*`); Nest only checks classes, so `Permissions` keeps the intended semantics.
fn casl_denies_instances(p: &Permissions) -> bool {
    let has = |s: &Subject| ALL_ACTIONS.iter().any(|a| p.can(*a, s));
    !p.can(Action::Manage, &Subject::All)
        && (has(&Subject::Settings) || PLUGINS.iter().any(|s| has(&s.parse().unwrap())))
}

const ALL_ACTIONS: [Action; 9] = [
    Action::Manage,
    Action::Create,
    Action::Read,
    Action::Update,
    Action::Delete,
    Action::Approve,
    Action::Decline,
    Action::Grab,
    Action::Track,
];

/// Instance subjects are `<Type>.<name>`; their conditions come from the case's `instances`.
fn check(p: &Permissions, user_id: i64, inst: &[Value], action: Action, subject: &str) -> bool {
    let Some(i) = inst.iter().find(|i| i["name"] == subject) else {
        return p.can(action, &subject.parse::<Subject>().expect(subject));
    };
    if casl_denies_instances(p) {
        return false;
    }
    let v = &i["value"];
    match i["type"].as_str().unwrap() {
        "User" => p.can_user(action, v["id"].as_i64() == Some(user_id)),
        "FliksRequest" => p.can_request(
            action,
            v["userId"].as_i64() == Some(user_id),
            v["status"] == "pending",
        ),
        t => panic!("instance type {t}"),
    }
}

#[test]
fn acl_reproduces_expected() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/acl/cases.json");
    let mut fx = Fixture::load(&path);
    let cases = fx.root["cases"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 35);
    let (mut checks, mut failed) = (0, vec![]);
    for (idx, c) in cases.iter().enumerate() {
        let input = &c["input"];
        let perms: Vec<String> = serde_json::from_value(input["rolePermissions"].clone()).unwrap();
        let p = Permissions::from(&perms, input["isAdmin"].as_bool().unwrap());
        let inst = input["instances"].as_array().unwrap();
        let user_id = input["userId"].as_i64().unwrap();
        let got: Vec<Value> = c["expected"]["checks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| {
                let (a, s) = (
                    k["action"].as_str().unwrap(),
                    k["subject"].as_str().unwrap(),
                );
                let allowed = check(&p, user_id, inst, a.parse().expect(a), s);
                json!({"action": a, "subject": s, "allowed": allowed})
            })
            .collect();
        checks += got.len();
        let got = json!({ "checks": got });
        let mut d = vec![];
        diff("", &got, &c["expected"], &mut d);
        if d.is_empty() {
            continue;
        }
        if blessing() {
            fx.bless(Some(idx), got);
        } else {
            failed.push(format!("{}\n  {}", input["label"], d.join("\n  ")));
        }
    }
    fx.save();
    assert!(checks > 1000, "only {checks} checks replayed");
    for f in failed.iter().take(20) {
        eprintln!("FAIL {f}");
    }
    assert!(failed.is_empty(), "acl: {} of 35 cases fail", failed.len());
}
