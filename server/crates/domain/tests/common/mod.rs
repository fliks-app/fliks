//! Fixture replay helpers: JSON comparison and the `BLESS=1` rewrite of `expected` (same as the engine's).
#![allow(dead_code)] // each suite uses a subset
use serde::Serialize;
use serde_json::Value;
use serde_json::ser::{PrettyFormatter, Serializer};
use std::path::{Path, PathBuf};

/// `BLESS=1 cargo test` rewrites `expected` from the current output instead of failing.
pub fn blessing() -> bool {
    std::env::var("BLESS").is_ok_and(|v| v == "1")
}

/// A fixture file whose `expected` (or that of one of its `cases`) can be blessed and saved.
pub struct Fixture {
    path: PathBuf,
    text: String,
    pub root: Value,
    changed: Vec<usize>,
    whole: bool,
}

impl Fixture {
    pub fn load(path: &Path) -> Self {
        let text = std::fs::read_to_string(path).unwrap();
        let root = serde_json::from_str(&text).unwrap();
        Self {
            path: path.into(),
            text,
            root,
            changed: vec![],
            whole: false,
        }
    }

    /// Replace `expected` of the file, or of case `idx` of its `cases`.
    pub fn bless(&mut self, idx: Option<usize>, got: Value) {
        match idx {
            Some(i) => {
                self.root["cases"][i]["expected"] = got;
                self.changed.push(i);
            }
            None => {
                self.root["expected"] = got;
                self.whole = true;
            }
        }
    }

    /// Writes the file back in its own layout (one case per line, or pretty with its indent).
    pub fn save(self) {
        if !self.whole && self.changed.is_empty() {
            return;
        }
        let mut lines: Vec<String> = self.text.split('\n').map(String::from).collect();
        let out = if self
            .text
            .lines()
            .next()
            .is_some_and(|l| l.ends_with("\"cases\":["))
        {
            let last = self.root["cases"].as_array().unwrap().len() - 1;
            for i in self.changed {
                let comma = if i == last { "" } else { "," };
                lines[i + 1] = format!("{}{comma}", self.root["cases"][i]);
            }
            lines.join("\n")
        } else {
            let indent = lines.get(1).map_or(2, |l| l.len() - l.trim_start().len());
            let pad = " ".repeat(indent);
            let mut buf = vec![];
            let mut ser =
                Serializer::with_formatter(&mut buf, PrettyFormatter::with_indent(pad.as_bytes()));
            self.root.serialize(&mut ser).unwrap();
            format!("{}\n", String::from_utf8(buf).unwrap())
        };
        std::fs::write(&self.path, out).unwrap();
    }
}

/// Paths where `a` and `b` differ, as `path: got != expected`, compact.
pub fn diff(path: &str, a: &Value, b: &Value, out: &mut Vec<String>) {
    if a == b {
        return;
    }
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for k in x.keys().chain(y.keys().filter(|k| !x.contains_key(*k))) {
                let (p, null) = (format!("{path}.{k}"), Value::Null);
                match (x.get(k), y.get(k)) {
                    (Some(p1), Some(p2)) => diff(&p, p1, p2, out),
                    (Some(p1), None) => out.push(format!("{p}: got {p1}, expected absent")),
                    (None, p2) => {
                        out.push(format!("{p}: got absent, expected {}", p2.unwrap_or(&null)))
                    }
                }
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                diff(&format!("{path}[{i}]"), p, q, out);
            }
        }
        _ => out.push(format!("{path}: got {a}, expected {b}")),
    }
}

/// JSON as JS prints it: a whole float is an integer (`6.0` -> `6`), `-0` -> `0`.
pub fn norm(v: Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 9e15 => Value::from(f as i64),
            _ => Value::Number(n),
        },
        Value::Array(a) => Value::Array(a.into_iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, norm(v))).collect()),
        v => v,
    }
}

/// Replays every case of `fixtures/<set>/cases.json` through `run(input)` (blessing under `BLESS=1`).
pub fn replay(set: &str, count: usize, run: impl Fn(&Value) -> Value) {
    // Read at run time: a target dir shared across worktrees reuses binaries built in another one.
    let dir = std::env::var("CARGO_MANIFEST_DIR").expect("run through cargo test");
    let path = PathBuf::from(dir).join(format!("../../fixtures/{set}/cases.json"));
    let mut fx = Fixture::load(&path);
    let cases = fx.root["cases"].as_array().unwrap().clone();
    assert_eq!(cases.len(), count);
    let mut failed = vec![];
    for (idx, c) in cases.iter().enumerate() {
        let got = norm(run(&c["input"]));
        let mut d = vec![];
        diff("", &got, &norm(c["expected"].clone()), &mut d);
        if d.is_empty() {
            continue;
        }
        if blessing() {
            fx.bless(Some(idx), got);
        } else {
            failed.push(format!("#{idx} {}\n  {}", c["input"], d.join("\n  ")));
        }
    }
    fx.save();
    for f in failed.iter().take(20) {
        eprintln!("FAIL {}", f.chars().take(1500).collect::<String>());
    }
    assert!(
        failed.is_empty(),
        "{set}: {} of {count} cases fail",
        failed.len()
    );
}
