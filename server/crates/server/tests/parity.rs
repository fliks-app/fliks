//! HTTP parity runner (plan 5.3); env knobs and usage in server/parity/README.md.
use reqwest::{Client, Method, multipart};
use serde_json::{Map, Value, json};
use std::{collections::HashMap, fs, path::Path, process::Command, time::Duration};

const ACTORS: [&str; 7] = [
    "admin", "user", "readonly", "other", "manager", "noread", "settings",
];
const MEDIA_ROOT: &str = "/tmp/fliks-parity";

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.into())
}

/// Runs psql inside the container so no credentials are needed; `sql` is fed on stdin when given.
fn psql(args: &[&str], sql: Option<&[u8]>) {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = Command::new("docker")
        .args(["exec", "-i", "fliks-postgres-1", "sh", "-c"])
        .arg(r#"psql -U "$POSTGRES_USER" -v ON_ERROR_STOP=1 -q "$@""#)
        .arg("_")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("docker");
    let mut stdin = child.stdin.take().expect("stdin");
    if let Some(sql) = sql {
        stdin.write_all(sql).expect("psql stdin");
    }
    drop(stdin);
    let out = child.wait_with_output().expect("docker");
    assert!(
        out.status.success(),
        "psql {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Template DB of a scenario `seed`: `base` is the committed dump, any other name is `seed/<name>.sql` applied on top.
fn template(base_tpl: &str, seed: &str) -> String {
    if seed == "base" {
        return base_tpl.into();
    }
    format!("{base_tpl}_{}", seed.replace('-', "_"))
}

fn build_seed_template(base_tpl: &str, seed: &str) {
    let name = template(base_tpl, seed);
    let dir = std::env::var("CARGO_MANIFEST_DIR").expect("run through cargo test");
    let delta = fs::read(Path::new(&dir).join(format!("../../parity/seed/{seed}.sql")))
        .unwrap_or_else(|e| panic!("seed {seed}: {e}"));
    psql(
        &[
            "-d",
            "postgres",
            "-c",
            &format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)"),
            "-c",
            &format!("CREATE DATABASE {name} TEMPLATE {base_tpl}"),
        ],
        None,
    );
    psql(&["-d", &name], Some(&delta));
}

/// Recreates the scenario database from its seed template.
fn reset_db(db: &str, tpl: &str) {
    psql(
        &[
            "-d",
            "postgres",
            "-c",
            &format!("DROP DATABASE IF EXISTS {db} WITH (FORCE)"),
            "-c",
            &format!("CREATE DATABASE {db} TEMPLATE {tpl}"),
        ],
        None,
    );
}

// ---- tiny JSONPath: `$.a.b[0]`, `[*]`, and `$..key` (last segment only, for ignore) ----

enum Seg {
    Key(String),
    Idx(usize),
    Wild,
    Desc(String),
}

fn parse_path(p: &str) -> Vec<Seg> {
    let mut out = vec![];
    let mut s = p.strip_prefix('$').unwrap_or(p);
    while !s.is_empty() {
        if let Some(r) = s.strip_prefix("..") {
            let end = r.find(['.', '[']).unwrap_or(r.len());
            out.push(Seg::Desc(r[..end].into()));
            s = &r[end..];
        } else if let Some(r) = s.strip_prefix('.') {
            let end = r.find(['.', '[']).unwrap_or(r.len());
            out.push(Seg::Key(r[..end].into()));
            s = &r[end..];
        } else if let Some(r) = s.strip_prefix('[') {
            let end = r.find(']').expect("unclosed [");
            out.push(if &r[..end] == "*" {
                Seg::Wild
            } else {
                Seg::Idx(r[..end].parse().expect("index"))
            });
            s = &r[end + 1..];
        } else {
            panic!("bad path {p}");
        }
    }
    out
}

fn select<'a>(v: &'a Value, p: &[Seg]) -> Option<&'a Value> {
    let Some((first, rest)) = p.split_first() else {
        return Some(v);
    };
    match first {
        Seg::Key(k) => select(v.get(k)?, rest),
        Seg::Idx(i) => select(v.get(*i)?, rest),
        Seg::Wild | Seg::Desc(_) => None,
    }
}

fn strip(v: &mut Value, key: &str) {
    match v {
        Value::Object(o) => {
            o.remove(key);
            o.values_mut().for_each(|c| strip(c, key));
        }
        Value::Array(a) => a.iter_mut().for_each(|c| strip(c, key)),
        _ => {}
    }
}

fn remove(v: &mut Value, p: &[Seg]) {
    match p {
        [] => {}
        [Seg::Desc(k)] => strip(v, k),
        [Seg::Key(k)] => {
            if let Some(o) = v.as_object_mut() {
                o.remove(k);
            }
        }
        [first, rest @ ..] => kids(v, first).into_iter().for_each(|c| remove(c, rest)),
    }
}

fn kids<'a>(v: &'a mut Value, s: &Seg) -> Vec<&'a mut Value> {
    match (s, v) {
        (Seg::Key(k), Value::Object(o)) => o.get_mut(k).into_iter().collect(),
        (Seg::Idx(i), Value::Array(a)) => a.get_mut(*i).into_iter().collect(),
        (Seg::Wild, Value::Array(a)) => a.iter_mut().collect(),
        (Seg::Wild, Value::Object(o)) => o.values_mut().collect(),
        _ => vec![],
    }
}

/// Sorts the arrays at `p` so list order is not compared.
fn sort_at(v: &mut Value, p: &[Seg]) {
    match (p, v) {
        ([], Value::Array(a)) => a.sort_by_key(|x| x.to_string()),
        ([first, rest @ ..], v) => kids(v, first).into_iter().for_each(|c| sort_at(c, rest)),
        _ => {}
    }
}

// ---- comparison ----

fn show(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 80 {
        format!("{}...", &s[..80])
    } else {
        s
    }
}

fn diff(ptr: &str, e: &Value, a: &Value, out: &mut Vec<String>) {
    match (e, a) {
        (Value::Number(x), Value::Number(y)) => {
            if x.as_f64() != y.as_f64() {
                out.push(format!("{ptr}: expected {x} got {y}"));
            }
        }
        (Value::Object(x), Value::Object(y)) => {
            for (k, ev) in x {
                match y.get(k) {
                    Some(av) => diff(&format!("{ptr}/{k}"), ev, av, out),
                    None => out.push(format!("{ptr}/{k}: missing")),
                }
            }
            for k in y.keys().filter(|k| !x.contains_key(*k)) {
                out.push(format!("{ptr}/{k}: unexpected"));
            }
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                out.push(format!("{ptr}: expected {} items got {}", x.len(), y.len()));
            }
            for (i, (ev, av)) in x.iter().zip(y).enumerate() {
                diff(&format!("{ptr}/{i}"), ev, av, out);
            }
        }
        _ if e == a => {}
        _ => out.push(format!("{ptr}: expected {} got {}", show(e), show(a))),
    }
}

fn is_key(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.')
}

/// Nest error envelope: `statusCode` + `error` always, `message` only for i18n keys or `strictMessage`.
fn diff_error(e: &Map<String, Value>, a: &Value, strict: bool, out: &mut Vec<String>) {
    for k in ["statusCode", "error"] {
        diff(
            &format!("/{k}"),
            e.get(k).unwrap_or(&Value::Null),
            a.get(k).unwrap_or(&Value::Null),
            out,
        );
    }
    let m = e.get("message").unwrap_or(&Value::Null);
    if strict || m.as_str().is_some_and(is_key) {
        diff("/message", m, a.get("message").unwrap_or(&Value::Null), out);
    }
}

// ---- variables ----

fn lookup(vars: &HashMap<String, Value>, k: &str) -> Option<String> {
    vars.get(k).map(|v| {
        v.as_str()
            .map(String::from)
            .unwrap_or_else(|| v.to_string())
    })
}

fn subst_str(s: &str, vars: &HashMap<String, Value>) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i..].find('}') else { break };
        let name = &rest[i + 1..i + j];
        match lookup(vars, name) {
            Some(v) => out.push_str(&v),
            None => return Err(format!("unresolved {{{name}}}")),
        }
        rest = &rest[i + j + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn subst(v: &mut Value, vars: &HashMap<String, Value>) -> Result<(), String> {
    match v {
        Value::String(s) => {
            if let Some(name) = s.strip_prefix('{').and_then(|r| r.strip_suffix('}'))
                && let Some(val) = vars.get(name)
            {
                *v = val.clone();
                return Ok(());
            }
            *s = subst_str(s, vars)?;
        }
        Value::Array(a) => a.iter_mut().try_for_each(|c| subst(c, vars))?,
        Value::Object(o) => o.values_mut().try_for_each(|c| subst(c, vars))?,
        _ => {}
    }
    Ok(())
}

// ---- requests ----

struct Resp {
    status: u16,
    headers: Map<String, Value>,
    body: Value,
}

struct Ctx {
    http: Client,
    target: String,
    tokens: HashMap<String, String>,
}

fn parse_sse(block: &str) -> Option<Value> {
    let (mut ev, mut data) = (String::new(), vec![]);
    for l in block.lines() {
        if let Some(v) = l.strip_prefix("event:") {
            ev = v.trim().into();
        } else if let Some(v) = l.strip_prefix("data:") {
            data.push(v.strip_prefix(' ').unwrap_or(v));
        }
    }
    if ev.is_empty() && data.is_empty() {
        return None;
    }
    let d = data.join("\n");
    Some(json!({ "event": ev, "data": serde_json::from_str(&d).unwrap_or(Value::String(d)) }))
}

async fn send(ctx: &Ctx, step: &Value, vars: &HashMap<String, Value>) -> Result<Resp, String> {
    let mut step = step.clone();
    step.as_object_mut().map(|o| o.remove("expect"));
    subst(&mut step, vars)?;
    if let Some(ms) = step["sleepMs"].as_u64() {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        return Ok(Resp {
            status: 200,
            headers: Map::new(),
            body: Value::Null,
        });
    }
    let mut path = step["path"]
        .as_str()
        .ok_or("step without path")?
        .to_string();
    let actor = step["as"].as_str().unwrap_or("anon");
    let mut headers: Vec<(String, String)> = vec![];
    if let Some(h) = step["headers"].as_object() {
        headers.extend(
            h.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())),
        );
    }
    let token = match actor {
        "anon" => None,
        "engine" => Some(env("PARITY_HOST_TOKEN", "")),
        a => Some(
            ctx.tokens
                .get(a)
                .ok_or(format!("unknown actor {a}"))?
                .clone(),
        ),
    };
    if let Some(t) = token {
        match step["auth"].as_str().unwrap_or("cookie") {
            "bearer" => headers.push(("authorization".into(), format!("Bearer {t}"))),
            "query" => path.push_str(&format!(
                "{}token={t}",
                if path.contains('?') { '&' } else { '?' }
            )),
            _ if actor == "engine" => headers.push(("authorization".into(), format!("Bearer {t}"))),
            _ => headers.push(("cookie".into(), format!("fliks_access={t}"))),
        }
    }
    let method = Method::from_bytes(step["method"].as_str().unwrap_or("GET").as_bytes())
        .map_err(|e| e.to_string())?;
    // `"stub": true` talks to the external-API stub (PARITY_STUB, parity/external/stub.py) instead of the app.
    let base = if step["stub"].as_bool() == Some(true) {
        env("PARITY_STUB", "http://127.0.0.1:4890")
    } else {
        ctx.target.clone()
    };
    let mut req = ctx.http.request(method, format!("{base}{path}"));
    for (k, v) in headers {
        req = req.header(k, v);
    }
    if let Some(m) = step.get("multipart") {
        let bytes = match m["file"].as_str() {
            Some(f) => fs::read(Path::new(MEDIA_ROOT).join(f)).map_err(|e| format!("{f}: {e}"))?,
            None => m["content"]
                .as_str()
                .unwrap_or_default()
                .as_bytes()
                .to_vec(),
        };
        let part = multipart::Part::bytes(bytes)
            .file_name(m["filename"].as_str().unwrap_or("file").to_string())
            .mime_str(
                m["contentType"]
                    .as_str()
                    .unwrap_or("application/octet-stream"),
            )
            .map_err(|e| e.to_string())?;
        req = req.multipart(
            multipart::Form::new().part(m["field"].as_str().unwrap_or("file").to_string(), part),
        );
    } else if let Some(b) = step.get("body") {
        req = req.json(b);
    }
    let sse = step.get("sse");
    if sse.is_none() {
        req = req.timeout(Duration::from_secs(30));
    }
    let mut r = req.send().await.map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    let headers: Map<String, Value> = r
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.as_str().to_string(),
                Value::String(v.to_str().unwrap_or_default().into()),
            )
        })
        .collect();
    let body = match sse {
        Some(cfg) if status == 200 => {
            let want = cfg["events"].as_u64().unwrap_or(1) as usize;
            let within = Duration::from_millis(cfg["timeoutMs"].as_u64().unwrap_or(3000));
            let mut events: Vec<Value> = vec![];
            let mut buf = String::new();
            let mut after = cfg["after"].as_array().cloned();
            let _ = tokio::time::timeout(within, async {
                while let Ok(Some(chunk)) = r.chunk().await {
                    buf.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
                    while let Some(i) = buf.find("\n\n") {
                        let block: String = buf.drain(..i + 2).collect();
                        events.extend(parse_sse(&block));
                        // sub-steps run once the stream is open, so the events they cause are observed
                        if let Some(steps) = after.take() {
                            for s in steps {
                                let _ = Box::pin(send(ctx, &s, vars)).await;
                            }
                        }
                        if events.len() >= want {
                            return;
                        }
                    }
                }
            })
            .await;
            Value::Array(events)
        }
        _ => {
            // the app serves the stub's image host under `FLIKS_TMDB_IMAGE_URL`; Nest answered the real one
            let text = r.text().await.map_err(|e| e.to_string())?.replace(
                &format!("{}/img/t/p", env("PARITY_STUB", "http://127.0.0.1:4890")),
                "https://image.tmdb.org/t/p",
            );
            if text.is_empty() {
                Value::Null
            } else {
                serde_json::from_str(&text).unwrap_or(Value::String(text))
            }
        }
    };
    Ok(Resp {
        status,
        headers,
        body,
    })
}

// ---- scenarios ----

fn collect(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let mut es: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    es.sort();
    for p in es {
        if p.is_dir() {
            collect(&p, out);
        } else if p.extension().is_some_and(|e| e == "json") {
            out.push(p);
        }
    }
}

/// Scenario `fs`: rebuilds `s5-ingest/work` under the media root (`{path, from}` copies a generated
/// file, `{path, text}` writes one, `{dir}` makes a directory, `{link, to}` a symlink).
fn fs_setup(sc: &Value) {
    let Some(items) = sc["fs"].as_array() else {
        return;
    };
    let root = Path::new(MEDIA_ROOT);
    let work = root.join("s5-ingest/work");
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).expect("work dir");
    let under = |p: &str| {
        assert!(
            p.starts_with("s5-ingest/work/"),
            "fs path outside the work dir: {p}"
        );
        root.join(p)
    };
    for it in items {
        if let Some(d) = it["dir"].as_str() {
            fs::create_dir_all(under(d)).expect("fs dir");
            continue;
        }
        if let (Some(l), Some(to)) = (it["link"].as_str(), it["to"].as_str()) {
            let l = under(l);
            fs::create_dir_all(l.parent().expect("parent")).expect("fs parent");
            std::os::unix::fs::symlink(to, l).expect("fs link");
            continue;
        }
        let p = under(it["path"].as_str().expect("fs path"));
        fs::create_dir_all(p.parent().expect("parent")).expect("fs parent");
        match (it["from"].as_str(), it["text"].as_str()) {
            (Some(f), _) => fs::copy(root.join(f), &p).map(drop),
            (_, Some(t)) => fs::write(&p, t),
            _ => fs::write(&p, b""),
        }
        .expect("fs file");
    }
}

/// Scenario `fsAfter`: `{exists: [...], absent: [...]}`, waited for up to 3 s (detached deletes).
async fn fs_check(sc: &Value) -> Vec<String> {
    let root = Path::new(MEDIA_ROOT);
    let want = |k: &str| -> Vec<String> {
        sc["fsAfter"][k]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect()
    };
    let (exists, absent) = (want("exists"), want("absent"));
    if !exists.is_empty() {
        // a detached delete must have had time to (wrongly) remove what should stay
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let mut errs = vec![];
    for _ in 0..30 {
        errs.clear();
        for p in &exists {
            if fs::symlink_metadata(root.join(p)).is_err() {
                errs.push(format!("fs: {p} should exist"));
            }
        }
        for p in &absent {
            if fs::symlink_metadata(root.join(p)).is_ok() {
                errs.push(format!("fs: {p} should be absent"));
            }
        }
        if errs.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    errs
}

/// Runs one scenario; in record mode fills each step's `expect` from the live response.
async fn run(ctx: &Ctx, sc: &mut Value, record: bool) -> Vec<String> {
    fs_setup(sc);
    let ignore: Vec<Vec<Seg>> = sc["ignore"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_str())
                .map(parse_path)
                .collect()
        })
        .unwrap_or_default();
    let unordered: Vec<Vec<Seg>> = sc["unordered"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_str())
                .map(parse_path)
                .collect()
        })
        .unwrap_or_default();
    let strict = sc["strictMessage"].as_bool().unwrap_or(false);
    let record = record && sc["deviation"].is_null();
    let captures: Vec<(String, Vec<Seg>)> = sc["capture"]
        .as_object()
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), parse_path(v.as_str().unwrap_or_default())))
                .collect()
        })
        .unwrap_or_default();
    let mut vars = HashMap::new();
    let mut results = json!({ "steps": [] });
    let mut errs = vec![];
    let n = sc["steps"].as_array().map_or(0, |s| s.len());
    for i in 0..n {
        let step = sc["steps"][i].clone();
        let resp = match send(ctx, &step, &vars).await {
            Ok(r) => r,
            Err(e) => {
                errs.push(format!("step {i}: {e}"));
                break;
            }
        };
        let mut body = resp.body.clone();
        ignore.iter().for_each(|p| remove(&mut body, p));
        if step["ignoreBody"].as_bool() == Some(true) {
            body = Value::Null;
        }
        results["steps"].as_array_mut().unwrap().push(json!({
            "status": resp.status, "headers": resp.headers, "body": resp.body }));
        for (k, p) in &captures {
            if let Some(v) = select(&results, p) {
                vars.insert(k.clone(), v.clone());
            }
        }
        if record {
            let mut ex = Map::new();
            ex.insert("status".into(), resp.status.into());
            if !body.is_null() {
                ex.insert("body".into(), body);
            }
            if let Some(h) = step["expect"]["headers"].as_object() {
                let live: Map<String, Value> = h
                    .keys()
                    .map(|k| {
                        (
                            k.clone(),
                            resp.headers.get(k).cloned().unwrap_or(Value::Null),
                        )
                    })
                    .collect();
                ex.insert("headers".into(), live.into());
            }
            sc["steps"][i]["expect"] = ex.into();
            continue;
        }
        let ex = &step["expect"];
        let mut d = vec![];
        if ex["status"].as_u64() != Some(resp.status as u64) {
            d.push(format!(
                "status: expected {} got {}",
                ex["status"], resp.status
            ));
        }
        match (&ex["body"], ex["status"].as_u64().unwrap_or(0) >= 400) {
            (Value::Object(e), true) if e.contains_key("statusCode") => {
                diff_error(e, &body, strict, &mut d)
            }
            (Value::Null, _) => {
                if !body.is_null() {
                    d.push(format!("/: expected empty body got {}", show(&body)));
                }
            }
            (e, _) => {
                let (mut e, mut b) = (e.clone(), body.clone());
                ignore.iter().for_each(|p| remove(&mut e, p));
                unordered.iter().for_each(|p| {
                    sort_at(&mut e, p);
                    sort_at(&mut b, p);
                });
                diff("", &e, &b, &mut d)
            }
        }
        for (k, ev) in ex["headers"].as_object().into_iter().flatten() {
            let got = resp.headers.get(k).unwrap_or(&Value::Null);
            if ev != got {
                d.push(format!("header {k}: expected {ev} got {got}"));
            }
        }
        errs.extend(d.into_iter().map(|m| format!("step {i}: {m}")));
    }
    errs.extend(fs_check(sc).await);
    errs
}

#[tokio::test]
#[ignore]
async fn parity() {
    let target = env("PARITY_TARGET", "http://127.0.0.1:4849");
    let record = env("PARITY_RECORD", "") == "1";
    let filter = env("PARITY_FILTER", "");
    let http = Client::new();
    let (db, base_tpl) = (
        env("PARITY_DB", "fliks_parity"),
        env("PARITY_TPL", "fliks_parity_tpl"),
    );
    let engine = env("PARITY_ENGINE", "up");
    // Library scenarios create directories under libs/ and list it; a leftover from a previous run breaks the listing.
    let _ = fs::remove_dir_all(Path::new(MEDIA_ROOT).join("libs"));
    let (mut ok, mut failed, mut skipped, mut dev) = (0, 0, 0, vec![]);
    let mut files = vec![];
    collect(
        &Path::new(&std::env::var("CARGO_MANIFEST_DIR").expect("run through cargo test"))
            .join("../../parity/scenarios"),
        &mut files,
    );
    let mut seeds: Vec<String> = vec!["base".into()];
    let selected: Vec<_> = files
        .iter()
        .filter(|f| f.to_string_lossy().contains(&filter))
        .collect();
    for f in &selected {
        let sc: Value = serde_json::from_str(&fs::read_to_string(f).unwrap()).unwrap_or_default();
        let seed = sc["seed"].as_str().unwrap_or("base").to_string();
        if !seeds.contains(&seed) {
            build_seed_template(&base_tpl, &seed);
            seeds.push(seed);
        }
    }
    reset_db(&db, &template(&base_tpl, seeds.last().expect("seed")));
    let mut tokens = HashMap::new();
    for a in ACTORS {
        let r = http
            .post(format!("{target}/api/auth/login"))
            .json(&json!({ "username": a, "password": format!("{a}-pass") }))
            .send()
            .await
            .unwrap_or_else(|e| panic!("login {a}: {e}"));
        let v: Value = r.json().await.unwrap_or_default();
        // seeds beyond `base` add actors (noread, settings); a missing one only matters to the scenarios that use it
        match v["accessToken"].as_str() {
            Some(t) => tokens.insert(a.to_string(), t.to_string()),
            None if a == "noread" || a == "settings" => None,
            None => panic!("login {a}: {v}"),
        };
    }
    let ctx = Ctx {
        http,
        target,
        tokens,
    };

    for f in selected {
        let mut sc: Value = serde_json::from_str(&fs::read_to_string(f).unwrap())
            .unwrap_or_else(|e| panic!("{f:?}: {e}"));
        let name = sc["name"].as_str().unwrap_or("?").to_string();
        if sc["engine"].as_str().is_some_and(|e| e != engine) {
            skipped += 1;
            continue;
        }
        reset_db(
            &db,
            &template(&base_tpl, sc["seed"].as_str().unwrap_or("base")),
        );
        // untagged scenarios are recorded with the engine up only
        let rec = record && (sc["engine"].is_string() || engine == "up");
        let errs = run(&ctx, &mut sc, rec).await;
        if rec && sc["deviation"].is_null() {
            fs::write(f, serde_json::to_string_pretty(&sc).unwrap() + "\n").unwrap();
        }
        let line = |tag: &str| {
            format!(
                "{tag} {name}: {}",
                errs.iter().take(6).cloned().collect::<Vec<_>>().join("; ")
            )
        };
        if !sc["deviation"].is_null() {
            dev.push(if errs.is_empty() {
                format!("DEVIATION {name} ({}): matches", sc["deviation"])
            } else {
                line("DEVIATION-DIFF")
            });
        } else if errs.is_empty() {
            ok += 1;
        } else {
            failed += 1;
            println!("{}", line("FAIL"));
        }
    }
    dev.iter().for_each(|l| println!("{l}"));
    println!(
        "parity: {ok} passed, {failed} failed, {skipped} skipped (engine {engine}), {} deviation",
        dev.len()
    );
    assert_eq!(failed, 0);
}
