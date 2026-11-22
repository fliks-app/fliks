//! The checks of the health job: each is a pure function of what the job read, so it is testable alone.
use crate::plugins::runtime::State;
use serde_json::{Value, json};

const GIB: i64 = 1 << 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Warn,
    Error,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

/// One broken thing: `key` identifies it across runs, `code` and `params` are what the client words.
#[derive(Clone, Debug, PartialEq)]
pub struct Check {
    pub key: String,
    pub level: Level,
    pub code: &'static str,
    pub params: Value,
    pub link: Option<String>,
}

const SYSTEM: &str = "/admin/system";

fn check(key: String, level: Level, code: &'static str, params: Value, link: &str) -> Check {
    Check {
        key,
        level,
        code,
        params,
        link: Some(link.to_owned()),
    }
}

/// A plugin whose registration failed or whose breaker tripped is an error; one that is down or
/// answering late is a warning (the miss ladder already debounces, so there is no second one here).
pub fn plugin(
    id: &str,
    name: &str,
    registration_failed: bool,
    live: Option<State>,
) -> Option<Check> {
    let (level, code) = match live {
        _ if registration_failed => (Level::Error, "plugin_failed"),
        Some(State::Failed) => (Level::Error, "plugin_failed"),
        Some(State::Degraded | State::Backoff | State::Crashed) => (Level::Warn, "plugin_degraded"),
        _ => return None,
    };
    Some(check(
        format!("plugin:{id}"),
        level,
        code,
        json!({ "plugin": name }),
        &format!("/admin/settings/plugins/{id}"),
    ))
}

/// A folder that cannot be read, or is empty while it holds files, is an unmounted share (error);
/// `reach` is `(writable, empty)`, `None` when unreadable; one that is not writable only blocks imports and optimizations (warn: a read-only share can still stream).
pub fn folder(
    library_id: i32,
    folder_id: i32,
    library: &str,
    path: &str,
    reach: Option<(bool, bool)>,
    had_files: bool,
) -> Option<Check> {
    let link = format!("/admin/settings/libraries/{library_id}");
    let params = json!({ "library": library, "folder": path });
    let key = format!("folder:{folder_id}");
    match reach {
        None => Some(check(key, Level::Error, "library_unmounted", params, &link)),
        Some((_, true)) if had_files => {
            Some(check(key, Level::Error, "library_unmounted", params, &link))
        }
        Some((false, _)) => Some(check(key, Level::Warn, "library_read_only", params, &link)),
        Some(_) => None,
    }
}

/// Free space for the user below the floor of the queue settings; a floor of 0 turns the check off.
pub fn space(key: &str, label: &str, avail: i64, floor_gb: u32, link: &str) -> Option<Check> {
    let floor = i64::from(floor_gb) * GIB;
    (floor > 0 && avail < floor).then(|| {
        check(
            format!("space:{key}"),
            Level::Error,
            "space_low",
            json!({ "label": label, "freeGb": avail.max(0) / GIB, "floorGb": floor_gb }),
            link,
        )
    })
}

/// A secret or artwork directory that fell back to the temp dir is lost at the next container recreate.
pub fn storage(conf_persistent: bool, data_persistent: bool) -> Vec<Check> {
    let mut out = vec![];
    if !conf_persistent {
        out.push(check(
            "storage:conf".into(),
            Level::Error,
            "conf_volatile",
            json!({}),
            SYSTEM,
        ));
    }
    if !data_persistent {
        out.push(check(
            "storage:data".into(),
            Level::Warn,
            "data_volatile",
            json!({}),
            SYSTEM,
        ));
    }
    out
}

/// The newest run of a core job ended `failed`.
pub fn job(name: &str) -> Check {
    check(
        format!("job:{name}"),
        Level::Warn,
        "job_failed",
        json!({ "job": name }),
        SYSTEM,
    )
}

/// The sentence a notification channel carries, in English like every notification text.
pub fn text(code: &str, p: &Value) -> String {
    let s = |k: &str| p[k].as_str().unwrap_or_default().to_owned();
    match code {
        "plugin_failed" => format!("Plugin {} failed", s("plugin")),
        "plugin_degraded" => format!("Plugin {} is not responding", s("plugin")),
        "library_unmounted" => format!("Library {}: a folder is not reachable", s("library")),
        "library_read_only" => format!("Library {}: a folder is read-only", s("library")),
        "space_low" => format!(
            "{} has {} GB free, below the {} GB floor",
            s("label"),
            p["freeGb"],
            p["floorGb"]
        ),
        "conf_volatile" => "The configuration directory is not persistent".into(),
        "data_volatile" => "The data directory is not persistent".into(),
        "job_failed" => format!("Scheduled job {} failed", s("job")),
        other => other.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_states_map_to_levels() {
        let lvl = |failed, s| plugin("p", "P", failed, s).map(|c| c.level);
        assert_eq!(lvl(false, Some(State::Failed)), Some(Level::Error));
        assert_eq!(lvl(true, None), Some(Level::Error));
        assert_eq!(lvl(false, Some(State::Degraded)), Some(Level::Warn));
        assert_eq!(lvl(false, Some(State::Backoff)), Some(Level::Warn));
        assert_eq!(lvl(false, Some(State::Ready)), None);
        assert_eq!(lvl(false, None), None);
    }

    #[test]
    fn a_folder_is_unmounted_unreadable_or_empty_with_files() {
        let f = |reach, files| folder(1, 2, "L", "/m", reach, files).map(|c| (c.level, c.code));
        assert_eq!(f(None, false), Some((Level::Error, "library_unmounted")));
        assert_eq!(
            f(Some((true, true)), true),
            Some((Level::Error, "library_unmounted"))
        );
        assert_eq!(f(Some((true, true)), false), None);
        assert_eq!(
            f(Some((false, true)), true),
            Some((Level::Error, "library_unmounted"))
        );
        assert_eq!(
            f(Some((false, false)), true),
            Some((Level::Warn, "library_read_only"))
        );
        assert_eq!(f(Some((true, false)), true), None);
    }

    #[test]
    fn space_uses_one_floor_and_zero_disables_it() {
        assert!(space("a", "A", 5 * GIB, 20, SYSTEM).is_some());
        assert!(space("a", "A", 20 * GIB, 20, SYSTEM).is_none());
        assert!(space("a", "A", 0, 0, SYSTEM).is_none());
    }
}
