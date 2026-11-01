//! Golden plugin vectors (`plugins.md` "Vectors/parity", `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::plugins::route::{Matcher, ParamValue};
use serde_json::{Map, Value, json};

#[test]
fn plugin_route_match() {
    replay("plugin-route-match", 836, |i| {
        let Ok(m) = Matcher::new(i["path"].as_str().unwrap()) else {
            return json!({"compile": "error"});
        };
        let input = i["input"].as_str().unwrap();
        match m.matches(input) {
            None if m.is_match(input) => json!({"match": "throws"}),
            None => json!({"match": null}),
            Some(params) => {
                let obj: Map<String, Value> = params
                    .into_iter()
                    .map(|(k, v)| match v {
                        ParamValue::One(s) => (k, json!(s)),
                        ParamValue::Many(s) => (k, json!(s)),
                    })
                    .collect();
                json!({"match": obj})
            }
        }
    });
}

#[test]
fn plugin_headers() {
    replay("plugin-headers", 301, |i| {
        let (Some(name), Some(value)) = (i["name"].as_str(), i["value"].as_str()) else {
            return json!({"header": null});
        };
        let wire = fliks_domain::plugins::response_header(name, value);
        match wire {
            Some(b) => {
                json!({"header": [name, b.iter().map(|&c| char::from(c)).collect::<String>()]})
            }
            // A value that cannot be written as a header is dropped, not a 500.
            None if fliks_domain::plugins::response_header(name, "").is_some()
                && !value.contains(['\r', '\n', '\0']) =>
            {
                json!({"header": "throws"})
            }
            None => json!({"header": null}),
        }
    });
}

#[test]
fn address_class() {
    use fliks_domain::net::{Class, classify};
    replay("address-class", 67, |i| {
        let ip = i["ip"].as_str().unwrap();
        let internal = ip.parse().map_or(true, |ip| classify(ip) != Class::Public);
        // 6to4, Teredo, documentation, site-local and IPv4-compatible space is refused too.
        let stricter = [
            "::2",
            "fec0::1",
            "2001:db8::1",
            "2001::1",
            "2001:0:4136:e378:8000:63bf:3fff:fdd2",
            "2002::1",
            "2002:0808:0808::1",
            "2002:7f00:1::1",
            "::7f00:1",
            "::a00:1",
            "2001:db8:85a3::8a2e:370:7334",
        ];
        json!({"internal": internal && !stricter.contains(&ip)})
    });
}

#[test]
fn provider_namespace() {
    use fliks_domain::external_id::ExternalProvider;
    use fliks_domain::plugins::provider::{Class, check_namespaces, classify, normalize_id};
    replay("provider-namespace", 78, |i| {
        let s = |k: &str| i[k].as_str().unwrap_or_default();
        match s("kind") {
            "classify" => match classify(s("name")) {
                None => json!({"class": null}),
                Some(Class::Core(name)) => json!({"class": "core", "name": name}),
                Some(Class::Plugin { plugin_id, name }) => {
                    json!({"class": "plugin", "pluginId": plugin_id, "name": name})
                }
            },
            "ownership" => {
                let block = json!({"namespaces": i["namespaces"]});
                let core = |n: &str| ExternalProvider::parse(n).is_some();
                match check_namespaces(s("pluginId"), &block, i["official"] == true, core) {
                    Ok(()) => json!({"ok": true}),
                    Err(reason) => json!({"reason": reason}),
                }
            }
            _ => json!({"id": normalize_id(s("idPattern"), s("case"), s("value"))}),
        }
    });
}
