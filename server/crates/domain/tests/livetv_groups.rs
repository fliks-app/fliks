//! Golden restricted-group vectors (`fixtures/livetv-groups/cases.json`, `BLESS=1` rewrites `expected`):
//! the access operations replayed on the pure `State`, settings reads and writes included.
mod common;

use chrono::{DateTime, Duration, Utc};
use common::replay;
use fliks_domain::livetv::access::{
    EXEMPT_KEY, RESTRICTED_KEY, State, VANISHED_KEY, read_group_set, read_vanished,
    restricted_view, write_vanished,
};
use serde_json::{Value, json};

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|g| g.as_str().unwrap().to_owned())
        .collect()
}

/// The setting as the replay reports it: what the run wrote, else what it started with.
fn setting(key: &str, state: &State, input: &Value, written: Value) -> Value {
    if state.written.contains(&key) {
        return written;
    }
    match input["settings"][key].as_str() {
        None => Value::Null,
        Some(raw) => serde_json::from_str(raw).unwrap_or_else(|_| json!(raw)),
    }
}

fn grace_days(input: &Value) -> i64 {
    input["settings"]["livetv_stale_stream_days"]
        .as_str()
        .and_then(fliks_domain::js::parse_int)
        .unwrap_or(7)
}

fn scenario(i: &Value) -> Value {
    let raw = |k: &str| i["settings"][k].as_str();
    let mut st = State {
        restricted: read_group_set(raw(RESTRICTED_KEY)),
        exempt: read_group_set(raw(EXEMPT_KEY)),
        vanished: read_vanished(raw(VANISHED_KEY)),
        grants: i["grants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| {
                (
                    g[0].as_i64().unwrap() as i32,
                    g[1].as_str().unwrap().to_owned(),
                )
            })
            .collect(),
        written: vec![],
    };
    let mut now: DateTime<Utc> = DateTime::parse_from_rfc3339(i["now"].as_str().unwrap())
        .unwrap()
        .to_utc();
    let grace = grace_days(i);
    let perms = |id: i64| -> Vec<String> {
        i["users"]
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["id"] == id)
            .map_or(vec![], |u| strings(&u["permissions"]))
    };
    let mut results = vec![];
    for step in i["steps"].as_array().unwrap() {
        results.push(match step["op"].as_str().unwrap() {
            "set" => json!(st.set_restricted(&strings(&step["groups"]))),
            "adult" => json!(st.restrict_adult(&strings(&step["names"]))),
            "expire" => {
                now += Duration::days(step["advanceDays"].as_i64().unwrap());
                json!(st.expire(&strings(&step["live"]), grace, now))
            }
            "grants" => {
                let (groups, ignored) = st.set_grants(
                    step["userId"].as_i64().unwrap() as i32,
                    &strings(&step["groups"]),
                );
                json!({"groups": groups, "ignored": ignored})
            }
            "denied" => {
                let id = step["userId"].as_i64().unwrap();
                json!(st.denied(id as i32, &perms(id)))
            }
            "view" => {
                serde_json::to_value(restricted_view(&st.restricted, &st.vanished, grace)).unwrap()
            }
            op => panic!("unknown op {op}"),
        });
    }
    let vanished: serde_json::Map<String, Value> =
        serde_json::from_str(&write_vanished(&st.vanished)).unwrap();
    let mut rows = st.grants.clone();
    rows.sort();
    let grants: Vec<Value> = rows.iter().map(|(u, g)| json!([u, g])).collect();
    json!({
        "results": results,
        "final": {
            "restricted": setting(RESTRICTED_KEY, &st, i, json!(st.restricted)),
            "exempt": setting(EXEMPT_KEY, &st, i, json!(st.exempt)),
            "vanished": setting(VANISHED_KEY, &st, i, Value::Object(vanished)),
        },
        "grants": grants,
    })
}

#[test]
fn livetv_groups_reproduce_expected() {
    replay("livetv-groups", 96, scenario);
}
