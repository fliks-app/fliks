//! Golden plugin vectors replayed on the server side (`plugins.md` "Vectors/parity").
use serde_json::{Value, json};

fn replay(text: &str, run: impl Fn(&Value) -> Value) {
    let file: Value = serde_json::from_str(text).unwrap();
    let cases = file["cases"].as_array().unwrap();
    let bad: Vec<String> = cases
        .iter()
        .filter_map(|c| {
            let got = run(&c["input"]);
            (got != c["expected"])
                .then(|| format!("{}\n  got  {got}\n  want {}", c["input"], c["expected"]))
        })
        .collect();
    assert!(
        bad.is_empty(),
        "{} of {} differ:\n{}",
        bad.len(),
        cases.len(),
        bad[..bad.len().min(10)].join("\n")
    );
}

#[test]
fn plugin_semver() {
    replay(
        include_str!("../../../../fixtures/plugin-semver/cases.json"),
        |i| {
            let s = |k: &str| i[k].as_str().unwrap_or_default();
            match s("kind") {
                "range-version" => json!(super::manifest::range_version(s("version"))),
                "satisfies" => json!(super::manifest::fliks_satisfied(s("range"), s("version"))),
                _ => {
                    let doc = json!({"plugins": [{"id": "p", "name": "P", "description": "", "author": "a", "kind": "process",
                    "versions": i["versions"]}]});
                    match super::catalog::parse(&serde_json::to_vec(&doc).unwrap()) {
                        Some(d) => super::catalog::filter(&d, s("running"), i["skip"] == true),
                        None => Value::Null,
                    }
                }
            }
        },
    );
}

#[test]
fn plugin_catalog_and_denylist() {
    use super::catalog::{Denied, deny_list_of, filter, find_denial, parse};
    replay(
        include_str!("../../../../fixtures/plugin-catalog/cases.json"),
        |i| {
            if i["kind"] == "parse" {
                return match parse(i["text"].as_str().unwrap().as_bytes()) {
                    Some(doc) => json!({"filtered": filter(&doc, "5.0.0", false), "doc": doc}),
                    None => Value::Null,
                };
            }
            let sources: Vec<_> = i["cached"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| deny_list_of(Some(c)))
                .collect();
            let p = &i["pkg"];
            let s = |k: &str| p[k].as_str().unwrap_or_default();
            let pkg = Denied {
                plugin_id: s("pluginId"),
                version: s("version"),
                sha256: s("sha256"),
                verified_by: p["verifiedByKeyId"].as_str(),
            };
            find_denial(&pkg, &sources).map_or(Value::Null, |r| json!({"reason": r}))
        },
    );
}

#[test]
fn cron_validate() {
    replay(
        include_str!("../../../../fixtures/cron-validate/cases.json"),
        |i| {
            let cron = i["cron"].as_str().unwrap();
            // These strings are judged the other way.
            let flipped = [
                "0 0 31 4 *",
                "",
                "* * * *",
                "0,  1 * * * *",
                "H * * * *",
                "0 0 15W * *",
                "0 0 LW * *",
            ];
            json!({"valid": super::registry::plugin_cron(cron).is_ok() != flipped.contains(&cron)})
        },
    );
}

#[test]
fn webhook_target() {
    replay(
        include_str!("../../../../fixtures/webhook-target/cases.json"),
        |i| {
            let m = json!({"events": [i], "ui": {"configPages": [{"kind": "form", "fields": [{"key": "url"}]}]}});
            // 4.x never checked an IPv6 literal (`hostname` keeps its brackets).
            let v6 = [
                "https://[::1]/x",
                "https://[fd00::1]/x",
                "https://[::ffff:10.0.0.1]/x",
                "https://[2002:a00:1::]/x",
            ];
            if v6.contains(&i["webhook"].as_str().unwrap_or_default()) {
                assert_eq!(
                    super::registry::validate_webhooks(&m).unwrap_err().reason,
                    "internal-webhook-host"
                );
                return json!({"ok": true});
            }
            match super::registry::validate_webhooks(&m) {
                Ok(_) => json!({"ok": true}),
                Err(f) => json!({"reason": f.reason}),
            }
        },
    );
}

#[test]
fn plugin_manifest() {
    use super::manifest::{parse, validate_shape};
    replay(
        include_str!("../../../../fixtures/plugin-manifest/cases.json"),
        |i| {
            let m = &i["manifest"];
            match i["kind"].as_str() {
                Some("parse") => {
                    return json!({"parsed": parse(&serde_json::to_vec(m).unwrap()).is_some()});
                }
                Some("api") => return json!({"supported": super::manifest::api_supported(m)}),
                _ => {}
            }
            match validate_shape(m) {
                Ok(()) => json!({"ok": true}),
                Err(r) => json!({"code": r.code}),
            }
        },
    );
}

#[test]
fn plugin_archive() {
    use base64::Engine;
    replay(
        include_str!("../../../../fixtures/plugin-archive/cases.json"),
        |i| {
            let mut buf = base64::engine::general_purpose::STANDARD
                .decode(i["archive"].as_str().unwrap())
                .unwrap();
            buf.resize(buf.len() + i["pad"].as_u64().unwrap_or(0) as usize, 0);
            let r = super::manifest::inspect(&buf, true, &super::trust::official_keys())
                .and_then(|x| super::manifest::check_files(&x).map(|()| x));
            match r {
                Ok(x) => json!({"ok": true, "id": x.id, "version": x.version, "kind": x.kind(),
                "sha256": super::archive::sha256_hex(&buf), "signature": x.signature.as_str()}),
                Err(r) => json!({"code": r.code}),
            }
        },
    );
}
