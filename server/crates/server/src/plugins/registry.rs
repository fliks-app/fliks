//! The in-memory registry (`plugins.md` rules 7-11, Host design): manifests, route tables,
//! declared permissions, webhooks, release picker and player; plus the registration checks.
use fliks_domain::acl::Permissions;
use fliks_domain::net::{Class, classify};
use fliks_domain::plugins::{self as dp, route::Matcher};
use reqwest::Url;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, RwLock};

pub const WEBHOOK_EVENTS: [&str; 11] = [
    "media.imported",
    "media.monitored.changed",
    "media.season.monitored.changed",
    "media.removed",
    "media.files.imported",
    "media.acquisition.requested",
    "acquisition.grabbed",
    "request.created",
    "request.approved",
    "library.scan.completed",
    "settings.changed",
];
const METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
pub const MAX_JOBS: usize = 16;

/// A registration failure: `reason` is the `statusReason` prefix.
#[derive(Debug, Clone, PartialEq)]
pub struct Fail {
    pub reason: &'static str,
    pub detail: String,
}

pub fn fail(reason: &'static str, detail: impl Into<String>) -> Fail {
    Fail {
        reason,
        detail: detail.into(),
    }
}

/// Reasons that keep the route table and permissions: the routes answer 503, not 403.
pub fn installed_but_not_running(reason: &str) -> bool {
    matches!(
        reason,
        "disabled"
            | "tampered"
            | "db-provision-failed"
            | "db-unavailable"
            | "spawn-failed"
            | "incompatible-fliks"
            | "incompatible-api"
            | "network-not-granted"
            | "manifest-mismatch"
            | "invalid-component"
    )
}

#[derive(Debug, Clone)]
pub struct Route {
    pub method: String,
    pub path: String,
    pub policy: String,
    pub object_guard: Option<String>,
    matcher: Matcher,
}

#[derive(Debug, Clone)]
pub struct Job {
    pub name: String,
    pub cron: String,
    pub triggerable: bool,
    pub label_key: String,
}

#[derive(Debug, Clone)]
pub struct Registered {
    pub plugin_id: String,
    pub version: String,
    pub manifest: Value,
    pub signature: String,
    pub archive: Arc<Vec<u8>>,
}

impl Registered {
    pub fn is_process(&self) -> bool {
        self.manifest["kind"] == "process"
    }
}

#[derive(Default)]
struct Tables {
    registered: HashMap<String, Registered>,
    routes: HashMap<String, Arc<Vec<Route>>>,
    permissions: HashMap<String, BTreeSet<String>>,
    webhooks: HashMap<String, Vec<(String, String)>>,
    pickers: HashMap<String, Value>,
    players: HashMap<String, String>,
    jobs: HashMap<String, Vec<Job>>,
}

#[derive(Default)]
pub struct Registry(RwLock<Tables>);

/// What `ALL /api/plugins/:id/*` resolved: the route and its captured params.
pub struct Resolved {
    pub route: Route,
    pub params: Vec<(String, dp::route::ParamValue)>,
}

/// Everything rule 7 validated, ready to be installed into the tables.
pub struct Declared {
    pub routes: Vec<Route>,
    pub permissions: BTreeSet<String>,
    pub webhooks: Vec<(String, String)>,
    pub jobs: Vec<Job>,
}

impl Registry {
    fn r(&self) -> std::sync::RwLockReadGuard<'_, Tables> {
        self.0.read().unwrap_or_else(|e| e.into_inner())
    }
    fn w(&self) -> std::sync::RwLockWriteGuard<'_, Tables> {
        self.0.write().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(&self, id: &str) -> Option<Registered> {
        self.r().registered.get(id).cloned()
    }

    pub fn list(&self) -> Vec<Registered> {
        let mut v: Vec<_> = self.r().registered.values().cloned().collect();
        v.sort_by(|a, b| a.plugin_id.cmp(&b.plugin_id));
        v
    }

    /// Route table, permissions, picker and player: kept while installed but not running.
    pub fn install_declarations(&self, id: &str, manifest: &Value, d: &Declared) {
        let mut t = self.w();
        set_or_remove(
            &mut t.routes,
            id,
            (!d.routes.is_empty()).then(|| Arc::new(d.routes.clone())),
        );
        set_or_remove(
            &mut t.permissions,
            id,
            (!d.permissions.is_empty()).then(|| d.permissions.clone()),
        );
        set_or_remove(
            &mut t.pickers,
            id,
            manifest["ui"].get("releasePicker").cloned(),
        );
        set_or_remove(
            &mut t.players,
            id,
            manifest["ui"]["player"]["preRollRoute"]
                .as_str()
                .map(str::to_owned),
        );
    }

    pub fn activate(&self, reg: Registered, webhooks: Vec<(String, String)>) {
        let mut t = self.w();
        let id = reg.plugin_id.clone();
        set_or_remove(
            &mut t.webhooks,
            &id,
            (!webhooks.is_empty()).then_some(webhooks),
        );
        if !reg.is_process() {
            t.routes.remove(&id);
            t.permissions.remove(&id);
            t.jobs.remove(&id);
        }
        t.registered.insert(id, reg);
    }

    pub fn set_jobs(&self, id: &str, jobs: Vec<Job>) {
        set_or_remove(&mut self.w().jobs, id, (!jobs.is_empty()).then_some(jobs));
    }

    /// The funnel of every failure (and of `unregister`): live state goes, declarations stay
    /// only for the installed-but-not-running reasons.
    pub fn withdraw(&self, id: &str, keep_declarations: bool) {
        let mut t = self.w();
        t.registered.remove(id);
        t.webhooks.remove(id);
        t.jobs.remove(id);
        if !keep_declarations {
            t.routes.remove(id);
            t.permissions.remove(id);
            t.pickers.remove(id);
            t.players.remove(id);
        }
    }

    pub fn resolve(&self, id: &str, method: &str, path: &str) -> Option<Resolved> {
        let routes = self.r().routes.get(id)?.clone();
        let m = method.to_ascii_uppercase();
        routes.iter().filter(|r| r.method == m).find_map(|r| {
            Some(Resolved {
                params: r.matcher.matches(path)?,
                route: r.clone(),
            })
        })
    }

    pub fn permissions_of(&self, id: &str) -> BTreeSet<String> {
        self.r().permissions.get(id).cloned().unwrap_or_default()
    }

    /// The policy check of a resolved route (fail closed).
    pub fn allows(&self, id: &str, policy: &str, perms: &Permissions) -> bool {
        dp::parse_policy(policy, &self.permissions_of(id)).is_some_and(|(a, s)| perms.can(a, &s))
    }

    fn winner(map: &HashMap<String, impl Sized>) -> Option<String> {
        map.keys().min().cloned()
    }

    pub fn release_picker_for(&self, id: &str) -> Option<Value> {
        let t = self.r();
        (Self::winner(&t.pickers).as_deref() == Some(id)).then(|| t.pickers.get(id).cloned())?
    }

    pub fn release_picker_winner(&self) -> Option<String> {
        Self::winner(&self.r().pickers)
    }

    pub fn pre_roll(&self) -> Option<(String, String)> {
        let t = self.r();
        let id = Self::winner(&t.players)?;
        Some((id.clone(), t.players.get(&id)?.clone()))
    }

    pub fn pre_roll_winner(&self) -> Option<String> {
        Self::winner(&self.r().players)
    }

    pub fn webhooks_for_event(&self, event: &str) -> Vec<(String, String)> {
        let t = self.r();
        let mut out = vec![];
        for (id, list) in &t.webhooks {
            out.extend(
                list.iter()
                    .filter(|(e, _)| e == event)
                    .map(|(_, w)| (id.clone(), w.clone())),
            );
        }
        out
    }

    pub fn webhooks_of(&self, id: &str) -> Vec<(String, String)> {
        self.r().webhooks.get(id).cloned().unwrap_or_default()
    }

    pub fn jobs(&self) -> Vec<(String, Job)> {
        let t = self.r();
        let mut out: Vec<(String, Job)> = t
            .jobs
            .iter()
            .flat_map(|(id, js)| js.iter().map(|j| (id.clone(), j.clone())))
            .collect();
        out.sort_by(|a, b| (&a.0, &a.1.name).cmp(&(&b.0, &b.1.name)));
        out
    }

    pub fn job(&self, name: &str) -> Option<(String, Job)> {
        self.jobs().into_iter().find(|(_, j)| j.name == name)
    }

    fn other_job_names(&self, id: &str) -> BTreeSet<String> {
        let t = self.r();
        t.jobs
            .iter()
            .filter(|(o, _)| o.as_str() != id)
            .flat_map(|(_, js)| js.iter().map(|j| j.name.clone()))
            .collect()
    }

    /// Step (7): the first loaded plugin keeps an i18n root.
    pub fn check_i18n(&self, id: &str, manifest: &Value) -> Result<(), Fail> {
        let Some(root) = super::manifest::i18n_root(manifest) else {
            return Ok(());
        };
        for (other, r) in &self.r().registered {
            if other != id && super::manifest::i18n_root(&r.manifest).as_deref() == Some(&root) {
                return Err(fail(
                    "i18n-namespace-conflict",
                    format!(
                        "i18n keys under \"{root}.\" are already claimed by plugin \"{other}\""
                    ),
                ));
            }
        }
        Ok(())
    }

    /// Steps (4)-(6) and (8): every declaration a manifest makes, checked in rule 7's order.
    pub fn validate(&self, id: &str, m: &Value) -> Result<Declared, Fail> {
        let process = m["kind"] == "process";
        let webhooks = validate_webhooks(m)?;
        let routes_json = if process {
            m["routes"].as_array().cloned().unwrap_or_default()
        } else {
            vec![]
        };
        validate_release_picker(m, &routes_json)?;
        validate_player(m, &routes_json)?;
        validate_view_targets(id, m)?;
        self.check_i18n(id, m)?;
        if !process {
            return Ok(Declared {
                routes: vec![],
                permissions: BTreeSet::new(),
                webhooks,
                jobs: vec![],
            });
        }
        let permissions = validate_permissions(id, &m["permissions"])?;
        let jobs = validate_jobs(&m["jobs"], &self.other_job_names(id))?;
        let routes = validate_routes(&routes_json, &permissions)?;
        Ok(Declared {
            routes,
            permissions,
            webhooks: vec![],
            jobs,
        })
    }
}

fn set_or_remove<T>(map: &mut HashMap<String, T>, id: &str, v: Option<T>) {
    match v {
        Some(v) => {
            map.insert(id.to_owned(), v);
        }
        None => {
            map.remove(id);
        }
    }
}

/// Keys declared on `form` pages (a group's fields included): the targets of `setting:<key>`.
pub fn form_field_keys(m: &Value) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    for page in m["ui"]["configPages"].as_array().into_iter().flatten() {
        if page.get("kind").is_some_and(|k| k != "form") {
            continue;
        }
        for item in page["fields"].as_array().into_iter().flatten() {
            match item["kind"].as_str() {
                Some("group") => keys.extend(
                    item["fields"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|f| f["key"].as_str().map(str::to_owned)),
                ),
                Some("caption") | Some("status") => {}
                _ => keys.extend(item["key"].as_str().map(str::to_owned)),
            }
        }
    }
    keys
}

pub(crate) fn validate_webhooks(m: &Value) -> Result<Vec<(String, String)>, Fail> {
    let settings = form_field_keys(m);
    let mut out = vec![];
    for e in m["events"].as_array().into_iter().flatten() {
        let event = e["event"].as_str().unwrap_or_default();
        let webhook = e["webhook"].as_str().unwrap_or_default();
        if !WEBHOOK_EVENTS.contains(&event) {
            return Err(fail(
                "invalid-webhook-event",
                format!("event \"{event}\" is not a recognised domain event"),
            ));
        }
        if let Some(key) = webhook.strip_prefix("setting:") {
            if !settings.contains(key) {
                return Err(fail(
                    "unknown-webhook-setting",
                    format!("webhook \"{webhook}\" names no field declared on a form page"),
                ));
            }
            out.push((event.to_owned(), webhook.to_owned()));
            continue;
        }
        let url = Url::parse(webhook).map_err(|_| {
            fail(
                "invalid-webhook-url",
                format!("webhook \"{webhook}\" is not a valid URL"),
            )
        })?;
        if url.scheme() != "https" {
            return Err(fail(
                "insecure-webhook-scheme",
                format!(
                    "webhook \"{webhook}\" must use https, got \"{}:\"",
                    url.scheme()
                ),
            ));
        }
        let literal = match url.host() {
            Some(url::Host::Ipv4(a)) => Some(std::net::IpAddr::V4(a)),
            Some(url::Host::Ipv6(a)) => Some(std::net::IpAddr::V6(a)),
            _ => None,
        };
        if let Some(ip) = literal
            && classify(ip) != Class::Public
        {
            return Err(fail(
                "internal-webhook-host",
                format!(
                    "webhook host \"{}\" is an internal address",
                    url.host_str().unwrap_or_default()
                ),
            ));
        }
        out.push((event.to_owned(), webhook.to_owned()));
    }
    Ok(out)
}

fn route_keys(routes: &[Value]) -> BTreeSet<String> {
    routes
        .iter()
        .map(|r| {
            format!(
                "{} {}",
                r["method"]
                    .as_str()
                    .unwrap_or_default()
                    .to_ascii_uppercase(),
                r["path"].as_str().unwrap_or_default()
            )
        })
        .collect()
}

fn validate_release_picker(m: &Value, routes: &[Value]) -> Result<(), Fail> {
    let Some(rp) = m["ui"].get("releasePicker") else {
        return Ok(());
    };
    let keys = route_keys(routes);
    for ctx in ["movie", "season", "episode"] {
        for (key, method) in [("search", "GET"), ("grab", "POST")] {
            let path = rp[ctx][key].as_str().unwrap_or_default();
            if !keys.contains(&format!("{method} {path}")) {
                return Err(fail(
                    "invalid-release-picker",
                    format!(
                        "releasePicker.{ctx}.{key} \"{path}\" is not declared as a {method} route in routes[]"
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn validate_player(m: &Value, routes: &[Value]) -> Result<(), Fail> {
    let Some(player) = m["ui"].get("player") else {
        return Ok(());
    };
    let route = player["preRollRoute"].as_str().unwrap_or("undefined");
    if !route_keys(routes).contains(&format!("POST {route}")) {
        return Err(fail(
            "invalid-player",
            format!(
                "ui.player.preRollRoute \"{route}\" is not declared as a POST route in routes[]"
            ),
        ));
    }
    Ok(())
}

fn validate_view_targets(id: &str, m: &Value) -> Result<(), Fail> {
    let pages: BTreeSet<&str> = m["ui"]["configPages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["id"].as_str())
        .collect();
    let mut pending: Vec<&Value> = m["ui"]["contributions"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    while let Some(c) = pending.pop() {
        pending.extend(c["children"].as_array().into_iter().flatten());
        let Some(path) = c["action"]["path"]
            .as_str()
            .filter(|_| c["action"]["kind"] == "route")
        else {
            continue;
        };
        let Some(prefix) = ["/admin/settings/plugins/", "/plugins/"]
            .into_iter()
            .find(|p| path.starts_with(p))
        else {
            continue;
        };
        let segs: Vec<&str> = path[prefix.len()..].split('/').collect();
        if segs.len() != 2 || segs[0] != id || !pages.contains(segs[1]) {
            return Err(fail(
                "invalid-ui-contribution",
                format!(
                    "contribution \"{}\" routes to \"{path}\", which is not one of this plugin's ui.configPages",
                    c["id"].as_str().unwrap_or_default()
                ),
            ));
        }
    }
    Ok(())
}

fn validate_permissions(id: &str, raw: &Value) -> Result<BTreeSet<String>, Fail> {
    let (mut seen, mut out) = (BTreeSet::new(), BTreeSet::new());
    for e in raw.as_array().into_iter().flatten() {
        let name = e.as_str().unwrap_or_default();
        if !dp::legal_permission_name(name) {
            return Err(fail(
                "invalid-permission",
                format!(
                    "permission {} is not a legal permission name",
                    Value::String(name.into())
                ),
            ));
        }
        if !seen.insert(name.to_owned()) {
            return Err(fail(
                "invalid-permission",
                format!("duplicate permission \"{name}\""),
            ));
        }
        out.insert(format!("plugin:{id}:{name}"));
    }
    Ok(out)
}

fn validate_jobs(raw: &Value, taken: &BTreeSet<String>) -> Result<Vec<Job>, Fail> {
    let list = raw.as_array().cloned().unwrap_or_default();
    if list.len() > MAX_JOBS {
        return Err(fail(
            "invalid-job-name",
            format!("at most {MAX_JOBS} jobs may be declared"),
        ));
    }
    let (mut seen, mut out) = (BTreeSet::new(), vec![]);
    for j in &list {
        let name = j["name"].as_str().unwrap_or_default().to_owned();
        let cron = j["cron"].as_str().unwrap_or_default().to_owned();
        let label = j["labelKey"].as_str().unwrap_or_default().to_owned();
        if name.is_empty() {
            return Err(fail("invalid-job-name", "job name must not be empty"));
        }
        if !seen.insert(name.clone()) {
            return Err(fail(
                "invalid-job-name",
                format!("duplicate job name \"{name}\""),
            ));
        }
        if crate::jobs::is_core(&name) {
            return Err(fail(
                "job-name-conflict",
                format!("job \"{name}\" collides with a core scheduler job"),
            ));
        }
        if taken.contains(&name) {
            return Err(fail(
                "job-name-conflict",
                format!(
                    "job \"{name}\" collides with a job already registered by another plugin or bundle"
                ),
            ));
        }
        if let Err(e) = plugin_cron(&cron) {
            return Err(fail(
                "invalid-job-cron",
                format!("job \"{name}\" has an invalid cron expression \"{cron}\": {e}"),
            ));
        }
        let Some(triggerable) = j["triggerable"].as_bool() else {
            return Err(fail(
                "invalid-job-triggerable",
                format!("job \"{name}\" has a non-boolean \"triggerable\""),
            ));
        };
        if label.is_empty() {
            return Err(fail(
                "invalid-job-label",
                format!("job \"{name}\" has an empty \"labelKey\""),
            ));
        }
        out.push(Job {
            name,
            cron,
            triggerable,
            label_key: label,
        });
    }
    Ok(out)
}

fn validate_routes(routes: &[Value], declared: &BTreeSet<String>) -> Result<Vec<Route>, Fail> {
    let (mut seen, mut out) = (BTreeSet::new(), vec![]);
    for r in routes {
        let raw_method = r["method"].as_str().unwrap_or_default();
        let method = raw_method.to_ascii_uppercase();
        let path = r["path"].as_str().unwrap_or_default();
        let policy = r["policy"].as_str().unwrap_or_default();
        if !METHODS.contains(&method.as_str()) {
            return Err(fail(
                "invalid-route-method",
                format!("route method \"{raw_method}\" is not a known HTTP verb"),
            ));
        }
        if !path.starts_with('/') {
            return Err(fail(
                "invalid-route-path",
                format!("route path \"{path}\" must start with \"/\""),
            ));
        }
        let matcher = Matcher::new(path).map_err(|e| {
            fail(
                "invalid-route-path",
                format!("route path \"{path}\" is invalid: {e}"),
            )
        })?;
        if dp::shadowed_by_core(&method, path) {
            return Err(fail(
                "invalid-route-path",
                format!("route \"{method} {path}\" is shadowed by a core /api/plugins route"),
            ));
        }
        if dp::parse_policy(policy, declared).is_none() {
            return Err(fail(
                "invalid-route-policy",
                format!("route policy \"{policy}\" is not a recognised action:subject pair"),
            ));
        }
        let guard = r["objectGuard"].as_str().map(str::to_owned);
        if let Some(g) = &guard {
            let ok = dp::parse_object_guard(g)
                .is_some_and(|(_, p)| matcher.param_names().any(|n| n == p));
            if !ok {
                return Err(fail(
                    "invalid-route-object-guard",
                    format!(
                        "route objectGuard \"{g}\" on path \"{path}\" does not resolve to a known guard and param"
                    ),
                ));
            }
        }
        let key = format!("{method} {path}");
        if !seen.insert(key.clone()) {
            return Err(fail(
                "duplicate-route",
                format!("duplicate route \"{key}\""),
            ));
        }
        out.push(Route {
            method,
            path: path.to_owned(),
            policy: policy.to_owned(),
            object_guard: guard,
            matcher,
        });
    }
    Ok(out)
}

/// Rule 9: `croner` with 5 fields, 6 with seconds, or a nickname such as `@daily` (C150).
pub fn plugin_cron(cron: &str) -> Result<(), String> {
    if !cron.starts_with('@') && !(5..=6).contains(&cron.split_whitespace().count()) {
        return Err("expected 5 or 6 fields".into());
    }
    crate::jobs::parse_cron(cron)
        .map(drop)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn process(routes: Value) -> Value {
        json!({"kind":"process","routes":routes,"permissions":["queue"],"jobs":[]})
    }

    #[test]
    fn routes_and_shadowing() {
        let reg = Registry::default();
        let ok = process(
            json!([{"method":"get","path":"/queue/:id","policy":"read:plugin:p:queue","objectGuard":"mediaAccessible:id"}]),
        );
        assert!(reg.validate("p", &ok).is_ok());
        for (routes, reason) in [
            (
                json!([{"method":"FROB","path":"/a","policy":"read:Settings"}]),
                "invalid-route-method",
            ),
            (
                json!([{"method":"GET","path":"a","policy":"read:Settings"}]),
                "invalid-route-path",
            ),
            (
                json!([{"method":"GET","path":"/logo","policy":"read:Settings"}]),
                "invalid-route-path",
            ),
            (
                json!([{"method":"GET","path":"/a","policy":"read:plugin:q:queue"}]),
                "invalid-route-policy",
            ),
            (
                json!([{"method":"GET","path":"/a","policy":"read:Settings","objectGuard":"mediaAccessible:id"}]),
                "invalid-route-object-guard",
            ),
            (
                json!([{"method":"GET","path":"/a","policy":"read:Settings"},{"method":"get","path":"/a","policy":"read:Settings"}]),
                "duplicate-route",
            ),
        ] {
            assert_eq!(
                reg.validate("p", &process(routes)).err().unwrap().reason,
                reason
            );
        }
        assert!(
            reg.validate(
                "p",
                &process(json!([{"method":"GET","path":"/:page","policy":"read:Settings"}]))
            )
            .is_ok()
        );
    }

    #[test]
    fn jobs_and_webhooks() {
        let taken = BTreeSet::from(["Other".to_owned()]);
        let job = |name: &str, cron: &str| json!([{"name":name,"cron":cron,"triggerable":true,"labelKey":"k"}]);
        assert!(validate_jobs(&job("Sync", "*/5 * * * *"), &taken).is_ok());
        assert_eq!(
            validate_jobs(&job("Backup", "* * * * *"), &taken)
                .unwrap_err()
                .reason,
            "job-name-conflict"
        );
        assert_eq!(
            validate_jobs(&job("Other", "* * * * *"), &taken)
                .unwrap_err()
                .reason,
            "job-name-conflict"
        );
        assert_eq!(
            validate_jobs(&job("Sync", "nope"), &taken)
                .unwrap_err()
                .reason,
            "invalid-job-cron"
        );
        let many: Vec<Value> = (0..17).map(|i| json!({"name":format!("J{i}"),"cron":"* * * * *","triggerable":true,"labelKey":"k"})).collect();
        assert!(validate_jobs(&Value::Array(many), &taken).is_err());
        let hook =
            |w: &str| json!({"kind":"data","events":[{"event":"media.imported","webhook":w}]});
        assert!(validate_webhooks(&hook("https://example.com/h")).is_ok());
        assert_eq!(
            validate_webhooks(&hook("http://example.com"))
                .unwrap_err()
                .reason,
            "insecure-webhook-scheme"
        );
        assert_eq!(
            validate_webhooks(&hook("https://10.0.0.1/"))
                .unwrap_err()
                .reason,
            "internal-webhook-host"
        );
        assert_eq!(
            validate_webhooks(&hook("setting:url")).unwrap_err().reason,
            "unknown-webhook-setting"
        );
        assert_eq!(
            validate_webhooks(&hook("::")).unwrap_err().reason,
            "invalid-webhook-url"
        );
    }
}
