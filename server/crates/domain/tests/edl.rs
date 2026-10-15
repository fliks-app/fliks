//! Golden EDL vectors (`fixtures/edl/cases.json`, `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::edl::*;
use serde_json::{Value, json};
use std::collections::HashMap;

fn ranges(r: &[EdlRange]) -> Value {
    serde_json::to_value(r).unwrap()
}

/// The fixture's virtual directory: `name -> (text | {dir:true} | {fill, size}, mtime)`, persistent across steps.
#[derive(Default)]
struct Dir(HashMap<String, (Value, f64)>);

impl Dir {
    fn write(&mut self, files: &Value, mtime: f64) {
        for (name, v) in files.as_object().unwrap() {
            self.0.insert(name.clone(), (v.clone(), mtime));
        }
    }

    /// Reads `a.mkv`'s sidecar like the server's reader does: case-insensitive lookup, size cap, cache.
    fn read(&self, cache: &mut EdlCache, fps: Option<f64>) -> Value {
        let exact = edl_path_for("a.mkv");
        let names: Vec<String> = self.0.keys().cloned().collect();
        let path = match self.0.contains_key(&exact) {
            true => exact.clone(),
            false => find_case_insensitive(&exact, &names).map_or(exact, String::from),
        };
        let Some((file, mtime)) = self.0.get(&path) else {
            return Value::Null;
        };
        let text = match file {
            Value::String(s) => s.clone(),
            f if f["dir"] == true => return Value::Null,
            f => f["fill"]
                .as_str()
                .unwrap()
                .repeat(f["size"].as_u64().unwrap() as usize),
        };
        let size = text.len() as u64;
        if size > MAX_EDL_BYTES {
            return Value::Null;
        }
        if let Some(hit) = cache.get(&path, fps, *mtime, size) {
            return ranges(hit);
        }
        let parsed = parse_edl(&text, fps).ranges;
        let out = ranges(&parsed);
        cache.put(&path, fps, *mtime, size, parsed);
        out
    }
}

#[test]
fn edl_reproduces_expected() {
    replay("edl", 158, |i| match i["fn"].as_str().unwrap() {
        "parseEdl" => {
            serde_json::to_value(parse_edl(i["text"].as_str().unwrap(), i["fps"].as_f64())).unwrap()
        }
        "edlPathFor" => json!(edl_path_for(i["video"].as_str().unwrap())),
        "shiftRanges" => {
            let r: Vec<EdlRange> = serde_json::from_value(i["ranges"].clone()).unwrap();
            ranges(&shift_ranges(&r, i["shift"].as_f64().unwrap()))
        }
        "readEdlSidecar" => {
            let mut dir = Dir::default();
            dir.write(&i["files"], 0.0);
            dir.read(&mut EdlCache::default(), i["fps"].as_f64())
        }
        "readEdlSidecarSteps" => {
            let (mut dir, mut cache) = (Dir::default(), EdlCache::default());
            let steps = i["steps"].as_array().unwrap().iter().enumerate();
            let out = steps.map(|(n, s)| {
                dir.write(
                    &s["files"],
                    s["mtime"].as_f64().unwrap_or(1000.0 + n as f64),
                );
                dir.read(&mut cache, s["fps"].as_f64())
            });
            Value::Array(out.collect())
        }
        f => panic!("fn {f}"),
    });
}

#[test]
fn edl_cache_is_keyed_by_path_and_fps() {
    let mut c = EdlCache::default();
    let r = parse_edl("1 2 0", None).ranges;
    c.put("a.edl", Some(25.0), 1.0, 5, r);
    assert!(c.get("a.edl", Some(25.0), 1.0, 5).is_some());
    assert!(c.get("a.edl", None, 1.0, 5).is_none());
    assert!(c.get("a.edl", Some(25.0), 2.0, 5).is_none());
}
