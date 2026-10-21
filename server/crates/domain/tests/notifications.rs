//! Golden notification vectors (`fixtures/notifications/cases.json`, `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::notifications::*;
use serde_json::{Map, Value, json};

fn obj(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn run(i: &Value) -> Value {
    let payload = obj(&i["payload"]);
    match i["fn"].as_str().unwrap() {
        "format" => json!({"message": format_message(i["event"].as_str().unwrap(), &payload)}),
        "send" => {
            let typ = i["type"].as_str().unwrap();
            match build_request(
                typ,
                &obj(&i["settings"]),
                i["event"].as_str().unwrap(),
                &payload,
            ) {
                Err(error) => json!({"error": error}),
                Ok(None) => json!({"sent": false}),
                Ok(Some(r)) => {
                    let headers: Map<String, Value> = r
                        .headers
                        .into_iter()
                        .map(|(k, v)| (k.into(), v.into()))
                        .collect();
                    let mut body = match r.body {
                        Body::Json(v) => v,
                        Body::Text(t) => t.into(),
                    };
                    // No mention injection, unlike the 4.x body.
                    if typ == "discord" {
                        body.as_object_mut().unwrap().remove("allowed_mentions");
                    }
                    json!({"url": r.url, "headers": headers, "body": body})
                }
            }
        }
        "normalize" => {
            let existing = i.get("existing").map(obj);
            match normalize_settings(
                i["type"].as_str().unwrap(),
                &obj(&i["settings"]),
                existing.as_ref(),
            ) {
                Ok(s) => json!({"settings": s}),
                Err(error) => json!({"error": error}),
            }
        }
        "validate" => json!({"errors": validate(&i["body"], None)}),
        "redact" => json!({"settings": redact(i["type"].as_str().unwrap(), &obj(&i["settings"]))}),
        "subscribable" => json!({"events": subscribable().collect::<Vec<_>>()}),
        f => panic!("unknown fn {f}"),
    }
}

#[test]
fn notification_vectors() {
    replay("notifications", 413, run);
}

fn settings(v: Value) -> Map<String, Value> {
    obj(&v)
}

#[test]
fn discord_blocks_mentions() {
    let s = settings(json!({"webhookUrl": "https://d.test/h"}));
    let r = build_request(
        "discord",
        &s,
        "request.created",
        &obj(&json!({"title": "@everyone"})),
    )
    .unwrap()
    .unwrap();
    let Body::Json(b) = r.body else { panic!() };
    assert_eq!(b["allowed_mentions"], json!({"parse": []}));
}

#[test]
fn webhook_url_is_a_secret_for_discord_and_slack() {
    for t in ["discord", "slack"] {
        let s = settings(json!({"webhookUrl": "https://d.test/h", "token": "t", "username": "u"}));
        assert_eq!(
            redact(t, &s),
            settings(json!({"username": "u", "secretsSet": ["token", "webhookUrl"]}))
        );
        assert_eq!(
            redact(t, &settings(json!({}))),
            settings(json!({"secretsSet": []}))
        );
        let stored = settings(json!({"webhookUrl": "https://old.test/h"}));
        let keep =
            |incoming: Value| normalize_settings(t, &settings(incoming), Some(&stored)).unwrap();
        assert_eq!(keep(json!({})), stored);
        assert_eq!(keep(json!({"webhookUrl": "  "})), stored);
        assert_eq!(
            keep(json!({"webhookUrl": " https://new.test/h ", "secretsSet": []})),
            settings(json!({"webhookUrl": "https://new.test/h"}))
        );
        assert_eq!(keep(json!({"webhookUrl": null})), settings(json!({})));
        // a type switch carries no stored endpoint
        assert_eq!(
            normalize_settings(t, &settings(json!({})), None).unwrap(),
            settings(json!({}))
        );
    }
}

#[test]
fn update_validates_the_effective_endpoint() {
    let stored = settings(json!({"webhookUrl": "https://old.test/h"}));
    let body = |s: Value| json!({"name": "n", "type": "discord", "settings": s});
    assert!(validate(&body(json!({})), Some(&stored)).is_empty());
    assert!(validate(&body(json!({"webhookUrl": ""})), Some(&stored)).is_empty());
    assert_eq!(
        validate(&body(json!({"webhookUrl": null})), Some(&stored)).len(),
        1
    );
    assert_eq!(
        validate(&body(json!({"webhookUrl": "x"})), Some(&stored)).len(),
        1
    );
    assert_eq!(validate(&body(json!({})), None).len(), 1);
}

#[test]
fn vocabulary() {
    assert_eq!(EVENTS.len(), 20);
    assert_eq!(subscribable().count(), 19);
    assert!(is_event("health.issue") && !is_event("request"));
}

#[test]
fn numbers_print_like_js() {
    let t = |v: Value| format_message("grab.started", &obj(&json!({"title": v})));
    assert_eq!(t(json!(i64::MIN)), "Grabbing: -9223372036854776000");
    assert_eq!(t(json!(1u64 << 60)), "Grabbing: 1152921504606847000");
    assert_eq!(t(json!(1.5)), "Grabbing: 1.5");
}
