//! Golden live TV vectors (`fixtures/livetv-parsing/cases.json`, `BLESS=1` rewrites `expected`).
mod common;

use chrono::{DateTime, SecondsFormat, Utc};
use common::replay;
use fliks_domain::livetv::{
    guide::{self, Candidate, Matchable},
    m3u::{self, parse_m3u},
    names,
    sync::{self, Entry, GroupPattern},
    xmltv::{self, Channel, Options, Programme, Sink},
    xtream::{self, Credentials},
};
use serde_json::{Value, json};
use std::{collections::HashMap, io::Read};

fn ms(d: DateTime<Utc>) -> Value {
    json!(d.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn opt_ms(d: Option<DateTime<Utc>>) -> Value {
    d.map_or(Value::Null, ms)
}

/// Serialises a struct and writes its date fields the way a JS `Date` prints.
fn dated(v: impl serde::Serialize, keys: &[&str]) -> Value {
    let mut v = serde_json::to_value(v).unwrap();
    fn walk(v: &mut Value, keys: &[&str]) {
        match v {
            Value::Object(o) => {
                for (k, c) in o.iter_mut() {
                    match (keys.contains(&k.as_str()), c.as_str()) {
                        (true, Some(s)) => {
                            let d = DateTime::parse_from_rfc3339(s).unwrap().to_utc();
                            *c = ms(d);
                        }
                        _ => walk(c, keys),
                    }
                }
            }
            Value::Array(a) => a.iter_mut().for_each(|c| walk(c, keys)),
            _ => {}
        }
    }
    walk(&mut v, keys);
    v
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn opt(v: &Value) -> Option<&str> {
    v.as_str()
}

#[derive(Default)]
struct Collect {
    channels: Vec<Channel>,
    programmes: Vec<Programme>,
}

impl Sink for Collect {
    fn channel(&mut self, c: Channel) {
        self.channels.push(c);
    }
    fn programme(&mut self, p: Programme) {
        self.programmes.push(p);
    }
}

/// A reader giving out the given chunk lengths in turn.
struct Cuts<'a>(&'a [u8], Vec<usize>, usize);

impl Read for Cuts<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let want = self.1[self.2 % self.1.len()];
        self.2 += 1;
        let n = self.0.len().min(want).min(buf.len());
        buf[..n].copy_from_slice(&self.0[..n]);
        self.0 = &self.0[n..];
        Ok(n)
    }
}

fn read_feed(xml: &[u8], cuts: Vec<usize>, opts: &Options) -> Value {
    let mut c = Collect::default();
    xmltv::parse_stream(Cuts(xml, cuts, 0), opts, &mut c).unwrap();
    json!({
        "channels": serde_json::to_value(&c.channels).unwrap(),
        "programmes": dated(&c.programmes, &["startsAt", "endsAt"]),
    })
}

/// Whole, cut once at every byte offset, and at three seeded random splits: one answer.
fn xmltv_case(i: &Value) -> Value {
    let xml = s(&i["xml"]).as_bytes();
    let opts = Options {
        offset_minutes: i["offsetMinutes"].as_i64().unwrap_or(0) as i32,
        language: opt(&i["language"]).map(Into::into),
        ..Options::default()
    };
    let whole = read_feed(xml, vec![usize::MAX], &opts);
    for at in 1..xml.len() {
        assert_eq!(
            read_feed(xml, vec![at, usize::MAX], &opts),
            whole,
            "cut at {at}"
        );
    }
    let mut seed = 0x2545_f491_u64;
    for _ in 0..3 {
        let cuts: Vec<usize> = (0..16)
            .map(|_| {
                seed = seed
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                1 + (seed >> 33) as usize % 17
            })
            .collect();
        assert_eq!(read_feed(xml, cuts, &opts), whole, "random cuts");
    }
    whole
}

fn creds(v: Option<Credentials>) -> Value {
    serde_json::to_value(v).unwrap()
}

fn classify(i: &Value) -> Value {
    let pattern = |k: &str| opt(&i[k]).map(|p| GroupPattern::compile(p).unwrap());
    let entries: Vec<Entry> = serde_json::from_value(i["entries"].clone()).unwrap();
    let c = sync::classify_entries(
        entries,
        pattern("include").as_ref(),
        pattern("exclude").as_ref(),
    )
    .unwrap();
    json!({
        "live": c.live.iter().map(|e| e.url.clone()).collect::<Vec<_>>(),
        "onDemandCount": c.on_demand_count,
        "groups": c.groups,
    })
}

fn state(i: &Value) -> Value {
    let at = opt(&i["expiresAt"]).map(|t| DateTime::parse_from_rfc3339(t).unwrap().to_utc());
    let now = DateTime::parse_from_rfc3339(s(&i["now"])).unwrap().to_utc();
    serde_json::to_value(sync::account_state(at, opt(&i["status"]), now)).unwrap()
}

fn guide_case(i: &Value) -> Value {
    let channels: Vec<Matchable> = serde_json::from_value(i["channels"].clone()).unwrap();
    let candidates: Vec<Candidate> = serde_json::from_value(i["candidates"].clone()).unwrap();
    serde_json::to_value(guide::match_guide_channels(&channels, &candidates)).unwrap()
}

fn priority(i: &Value) -> Value {
    let rows = i["rows"].as_array().unwrap();
    let prio: HashMap<i32, i32> = i["priorities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p[0].as_i64().unwrap() as i32, p[1].as_i64().unwrap() as i32))
        .collect();
    let keyed: Vec<(String, i32, usize)> = rows
        .iter()
        .enumerate()
        .map(|(n, r)| {
            (
                r["guideChannelId"].as_str().unwrap().to_owned(),
                r["guideSourceId"].as_i64().unwrap() as i32,
                n,
            )
        })
        .collect();
    let kept = guide::pick_highest_priority(&keyed, |r| (r.0.as_str(), r.1), &prio);
    Value::Array(kept.iter().map(|r| rows[r.2].clone()).collect())
}

#[test]
fn livetv_parsing_reproduces_expected() {
    replay("livetv-parsing", 567, |i| match s(&i["fn"]) {
        "parseM3u" => {
            let p = parse_m3u(s(&i["text"]));
            let mut v = serde_json::to_value(&p).unwrap();
            v["expiresAt"] = opt_ms(p.expires_at);
            v
        }
        "deriveExternalId" => json!(m3u::derive_external_id(s(&i["url"]), s(&i["name"]))),
        "isOnDemandUrl" => json!(m3u::is_on_demand_url(s(&i["url"]))),
        "normalizeGroupName" => json!(names::normalize_group_name(opt(&i["raw"]))),
        "foldGroupKey" => json!(names::fold_group_key(s(&i["raw"]))),
        "normalizeChannelName" => json!(names::normalize_channel_name(s(&i["raw"]))),
        "nameSimilarity" => json!(names::name_similarity(s(&i["a"]), s(&i["b"]))),
        "classifyEntries" => classify(i),
        "liveTvAccountStateOf" => state(i),
        "detectXtreamFromUrl" => creds(xtream::detect_from_url(s(&i["raw"]))),
        "detectXtreamFromStreamUrl" => creds(xtream::detect_from_stream_url(s(&i["raw"]))),
        "xtreamPlaylistUrl" => {
            let c: Credentials = serde_json::from_value(i["creds"].clone()).unwrap();
            json!(xtream::playlist_url(&c))
        }
        "pickOutputFormat" => {
            let allowed: Vec<String> = serde_json::from_value(i["allowed"].clone()).unwrap();
            json!(xtream::pick_output_format(&allowed))
        }
        "xtreamAccount" => match xtream::account(&i["data"]) {
            Ok(a) => dated(&a, &["expiresAt"]),
            Err(e) if e.starts_with("authentication") => json!({"error": "auth"}),
            Err(_) => json!({"error": "other"}),
        },
        "xtreamLiveStreams" => match xtream::live_streams(&i["categories"], &i["streams"]) {
            Ok(v) => serde_json::to_value(v).unwrap(),
            Err(_) => json!({"error": "list"}),
        },
        "parseXmltvStream" => xmltv_case(i),
        "parseXmltvDate" => {
            let off = i["offset"].as_i64().unwrap() as i32;
            opt_ms(xmltv::parse_xmltv_date(opt(&i["raw"]), off))
        }
        "decodeXmlText" => json!(xmltv::decode_xml_text(s(&i["raw"]))),
        "matchGuideChannels" => guide_case(i),
        "pickHighestPriorityRows" => priority(i),
        other => panic!("unknown fn {other}"),
    });
}
