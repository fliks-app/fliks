//! Golden QoE vectors (`fixtures/qoe/cases.json`, `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::qoe::*;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn de<T: DeserializeOwned>(v: &Value) -> T {
    serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{e}: {v}"))
}

fn ser<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap()
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap()
}

fn aggregate(steps: &Value) -> Value {
    let mut agg = QoeAggregator::new();
    let mut results = vec![];
    for s in steps.as_array().unwrap() {
        let mut r = Value::Null;
        match s["op"].as_str().unwrap() {
            "sample" => agg.add_sample(&de(&s["s"]), num(&s["now"]), s["playing"] != false),
            "event" => {
                let load: Option<ServerLoad> = de(&s["opts"]["load"]);
                let live = s["opts"]["live"] == true;
                r = ser(agg.add_event(&de(&s["e"]), num(&s["now"]), live, load.as_ref()));
            }
            "segment" => {
                let m = &s["m"];
                agg.add_segment(
                    num(&m["segmentDurationS"]),
                    m["waitedMs"].as_f64(),
                    num(&s["now"]),
                );
            }
            "cmcd" => {
                let c = &s["c"];
                let snap = CmcdSnapshot {
                    bl: c["bl"].as_f64(),
                    mtp: c["mtp"].as_f64(),
                    br: c["br"].as_f64(),
                    ot: c["ot"].as_str().map(String::from),
                };
                agg.add_cmcd(&snap, num(&s["now"]));
            }
            "pipeline" => agg.set_pipeline(de(&s["p"])),
            op => panic!("op {op}"),
        }
        results.push(r);
    }
    json!({
        "results": results,
        "summary": ser(agg.summary()),
        "lastStall": ser(agg.last_stall()),
        "pipeline": ser(agg.pipeline()),
    })
}

/// `req.headers` values joined by commas, as the server does for repeated headers.
fn read_cmcd_req(req: &Value) -> Value {
    let query = req["query"]["CMCD"].as_str();
    let headers: Vec<(String, String)> = req["headers"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| {
            let joined = match v {
                Value::Array(a) => a
                    .iter()
                    .map(|x| x.as_str().unwrap())
                    .collect::<Vec<_>>()
                    .join(","),
                v => v.as_str().unwrap().to_owned(),
            };
            (k.clone(), joined)
        })
        .collect();
    let h: Vec<(&str, &str)> = headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    ser(read_cmcd(query, &h))
}

#[test]
fn qoe_reproduces_expected() {
    replay("qoe", 359, |i| match i["fn"].as_str().unwrap() {
        "classifyStall" => ser(classify_stall(&de(&i["stall"]), &de(&i["ctx"]))),
        "diagnose" => ser(diagnose(&de(&i["summary"]), i["live"] == true)),
        "aggregate" => aggregate(&i["steps"]),
        "merge" => ser(merge_summaries(&de::<Vec<QoeSessionSummary>>(&i["parts"]))),
        "parseEvents" => ser(parse_events(
            &i["raw"],
            num(&i["now"]),
            i["sentAt"].as_f64(),
        )),
        "parsePlaybackId" => ser(parse_playback_id(&i["raw"])),
        "parseSample" => ser(parse_sample(&i["raw"])),
        "readCmcd" => read_cmcd_req(&i["req"]),
        "readCmcdRaw" => ser(read_cmcd_raw(i["raw"].as_str().unwrap())),
        f => panic!("fn {f}"),
    });
}

#[test]
fn cmcd_dictionary_follows_rfc_8941_like_the_library() {
    let snap = |raw: &str| common::norm(ser(read_cmcd_raw(raw)));
    for (raw, want) in [
        ("bl=1.5", json!({"bl": 1.5})),
        ("bl=100;x=1", Value::Null),
        ("BL=1", Value::Null),
        ("ot=\"v\"", json!({"ot": "v"})),
        ("ot=v", json!({"ot": "v"})),
        ("bl=1 , mtp=2", json!({"bl": 1, "mtp": 2})),
        ("bl=1\t,\tmtp=2", json!({"bl": 1, "mtp": 2})),
        ("  bl=1  ", json!({"bl": 1})),
        ("", Value::Null),
        ("  ", Value::Null),
        ("bl=1,", Value::Null),
        ("bl=1,,mtp=2", Value::Null),
        ("bl=1;", Value::Null),
        ("mtp=1e3", Value::Null),
        ("bl=0x10", Value::Null),
        ("bl=1.1234", Value::Null),
        ("bl=1.123", json!({"bl": 1.123})),
        ("bl=1,bl=2", json!({"bl": 2})),
        ("bl=2,bl=\"x\"", Value::Null),
        ("bl=?1", Value::Null),
        ("bl=-0", json!({"bl": 0})),
        ("bl=-5", Value::Null),
        ("bl=999999999999999", json!({"bl": 999999999999999_i64})),
        ("bl=1000000000000000", Value::Null),
        ("bl=(1 2)", Value::Null),
        ("bl=:AQID:", Value::Null),
        ("bl=:AQ==:,mtp=1", json!({"mtp": 1})),
        ("bl=:A:,mtp=1", Value::Null),
        ("bl=1,mtp=(1 2;a=1);b", json!({"bl": 1})),
        ("bl=1,mtp=(1 2", Value::Null),
        ("bl=1;a=?0,br=2", json!({"br": 2})),
        ("ot=av;a", Value::Null),
        ("bl=123456789012.5", json!({"bl": 123456789012.5})),
        ("bl=1234567890123.5", Value::Null),
    ] {
        assert_eq!(snap(raw), want, "{raw:?}");
    }
}
