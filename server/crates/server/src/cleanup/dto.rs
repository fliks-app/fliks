//! `/api/cleanup/rules` body (`cleanup.md` rules 6-8): class-validator style messages, unknown keys rejected.
use crate::http::{
    AppError,
    validate::{Check, object},
};
use fliks_domain::media::kind::MediaKind;
use serde_json::{Map, Value, json};

type Res<T> = Result<T, AppError>;

/// Longest age or window a day criterion takes (100 years); Postgres date arithmetic stays in range.
const MAX_DAYS: i32 = 36_500;

pub const ACTIONS: [&str; 3] = ["delete", "delete_files_unmonitor", "none"];
/// The levels below a media: its seasons and episodes, only for kinds made of them.
const ITEM_LEVELS: [&str; 2] = ["season", "episode"];

/// Every kind names a whole-media level, then the item levels of the kinds with seasons.
pub fn levels_allowed() -> Vec<&'static str> {
    let mut all = MediaKind::NAMES.to_vec();
    all.extend(ITEM_LEVELS);
    all
}

/// Levels that name a media of a kind without seasons.
fn flat(level: &str) -> bool {
    MediaKind::parse(level).is_some_and(|k| !k.has_seasons())
}

pub fn scoped(level: &str) -> bool {
    ITEM_LEVELS.contains(&level)
}

#[derive(Debug)]
pub struct Rule {
    pub name: String,
    pub enabled: bool,
    pub levels: Vec<String>,
    pub delete_series_when_empty: bool,
    pub reminder_days: Vec<i32>,
    pub criteria: Value,
    pub action: String,
    pub grace_days: Option<i32>,
}

pub fn rule(v: Value) -> Res<Rule> {
    let o = object(v);
    let mut c = Check::new(
        &o,
        &[
            "name",
            "enabled",
            "levels",
            "criteria",
            "action",
            "graceDays",
            "deleteSeriesWhenEmpty",
            "reminderDays",
        ],
        "",
    );
    let name = match o.get("name") {
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_owned(),
        Some(Value::String(_)) => {
            c.err("name", "should not be empty");
            String::new()
        }
        _ => {
            c.err("name", "must be a string");
            String::new()
        }
    };
    let enabled = match o.get("enabled") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            c.err("enabled", "must be a boolean value");
            true
        }
    };
    let action = c
        .one_of("action", &ACTIONS, true)
        .unwrap_or_else(|| "delete".into());
    let grace_days = match o.get("graceDays") {
        None | Some(Value::Null) => None,
        Some(v) => c.int("graceDays", v, false, Some(0), Some(3650)),
    };
    let levels = levels(&mut c, &o);
    let delete_series_when_empty = match o.get("deleteSeriesWhenEmpty") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => {
            if *b && !levels.iter().any(|l| scoped(l)) {
                c.err("deleteSeriesWhenEmpty", "must be false below season level");
            }
            *b
        }
        Some(_) => {
            c.err("deleteSeriesWhenEmpty", "must be a boolean value");
            false
        }
    };
    let reminder_days = reminder_days(&mut c, &o);
    let criteria = match o.get("criteria") {
        Some(Value::Object(k)) => criteria(k, &levels, &mut c.errs),
        _ => {
            c.err("criteria", "must be an object");
            json!({})
        }
    };
    c.finish(Rule {
        name,
        enabled,
        levels,
        delete_series_when_empty,
        reminder_days,
        criteria,
        action,
        grace_days,
    })
}

/// Canonical order; null or absent is `["movie"]`; at most one seasonal level (kind, season, episode).
fn levels(c: &mut Check, o: &Map<String, Value>) -> Vec<String> {
    let default = || vec![MediaKind::Movie.to_string()];
    let allowed = levels_allowed();
    let a = match o.get("levels") {
        None | Some(Value::Null) => return default(),
        Some(Value::Array(a)) => a,
        Some(_) => {
            c.err("levels", "must be an array");
            return default();
        }
    };
    if a.is_empty() {
        c.err("levels", "should not be empty");
        return default();
    }
    let mut got: Vec<&str> = vec![];
    for v in a {
        match v.as_str().filter(|s| allowed.contains(s)) {
            Some(s) if got.contains(&s) => {
                c.errs.push("levels's elements must be unique".into());
            }
            Some(s) => got.push(s),
            None => c.errs.push(format!(
                "each value in levels must be one of the following values: {}",
                allowed.join(", ")
            )),
        }
    }
    if got.iter().filter(|l| !flat(l)).count() > 1 {
        let mut names: Vec<&str> = MediaKind::seasonal_names();
        names.extend(ITEM_LEVELS);
        let last = names.pop().unwrap_or_default();
        c.err(
            "levels",
            &format!("must hold at most one of {} and {last}", names.join(", ")),
        );
    }
    let v: Vec<String> = allowed
        .iter()
        .filter(|l| got.contains(l))
        .map(|l| (*l).to_owned())
        .collect();
    if v.is_empty() { default() } else { v }
}

/// Sorted descending; null or absent is the default `[7, 1]`.
fn reminder_days(c: &mut Check, o: &Map<String, Value>) -> Vec<i32> {
    if o.get("reminderDays").is_none_or(Value::is_null) {
        return vec![7, 1];
    }
    let Some(a) = c.int_array("reminderDays", false) else {
        return vec![7, 1];
    };
    if a.len() > 5 {
        c.err("reminderDays", "must contain no more than 5 elements");
    }
    if a.iter().any(|n| *n < 1) {
        c.errs
            .push("each value in reminderDays must not be less than 1".into());
    }
    let mut v: Vec<i32> = a.iter().filter_map(|n| i32::try_from(*n).ok()).collect();
    v.sort_unstable_by(|x, y| y.cmp(x));
    if v.windows(2).any(|w| w[0] == w[1]) {
        c.errs.push("reminderDays's elements must be unique".into());
    }
    v
}

const KEYS: [&str; 21] = [
    "libraryIds",
    "excludeLibraryIds",
    "addedOlderThanDays",
    "releasedOlderThanDays",
    "lastPlayedOlderThanDays",
    "neverPlayed",
    "watchedByRequester",
    "ratingBelow",
    "minVotes",
    "sizeAboveGb",
    "genres",
    "excludeGenres",
    "seriesEnded",
    "notLiked",
    "playCountBelow",
    "playCountByUsersBelow",
    "notPlayedInLastDays",
    "likedByFewerThan",
    "notLikedByRequester",
    "keepLatestEpisodes",
    "diskFreeBelowPercent",
];

/// Valid for every selected level; the error list holds each message once.
fn criteria(k: &Map<String, Value>, levels: &[String], errs: &mut Vec<String>) -> Value {
    let mut out = Value::Null;
    let mut all: Vec<String> = vec![];
    for level in levels {
        let mut e = vec![];
        let v = criteria_at(k, level, &mut e);
        if out.is_null() {
            out = v;
        }
        for m in e {
            if !all.contains(&m) {
                all.push(m);
            }
        }
    }
    errs.extend(all);
    out
}

fn criteria_at(k: &Map<String, Value>, level: &str, errs: &mut Vec<String>) -> Value {
    let mut c = Check::new(k, &KEYS, "criteria.");
    let mut out = Map::new();
    for key in &KEYS {
        let key = *key;
        let Some(v) = k.get(key).filter(|v| !v.is_null()) else {
            continue;
        };
        let val: Option<Value> = match key {
            "libraryIds" | "excludeLibraryIds" => c.int_array(key, false).map(|a| json!(a)),
            "keepLatestEpisodes" if level != "episode" => {
                c.err(key, "is only available at episode level");
                None
            }
            "playCountBelow" | "playCountByUsersBelow" | "notPlayedInLastDays" if scoped(level) => {
                c.err(key, &format!("is not available at {level} level"));
                None
            }
            "addedOlderThanDays"
            | "releasedOlderThanDays"
            | "lastPlayedOlderThanDays"
            | "notPlayedInLastDays" => c
                .int(key, v, false, Some(0), Some(MAX_DAYS))
                .map(Value::from),
            "minVotes"
            | "likedByFewerThan"
            | "keepLatestEpisodes"
            | "playCountBelow"
            | "playCountByUsersBelow" => c.int(key, v, false, Some(1), None).map(Value::from),
            "diskFreeBelowPercent" => c.int(key, v, false, Some(1), Some(100)).map(Value::from),
            "neverPlayed"
            | "watchedByRequester"
            | "seriesEnded"
            | "notLiked"
            | "notLikedByRequester" => match v {
                Value::Bool(_) => Some(v.clone()),
                _ => {
                    c.err(key, "must be a boolean value");
                    None
                }
            },
            "ratingBelow" | "sizeAboveGb" => {
                match v.as_f64().filter(|n| v.is_number() && *n >= 0.0) {
                    Some(_) => Some(v.clone()),
                    None => {
                        c.err(key, "must be a non-negative number");
                        None
                    }
                }
            }
            _ => match v.as_array().filter(|a| a.iter().all(Value::is_string)) {
                Some(_) => Some(v.clone()),
                None => {
                    c.err(key, "must be an array of strings");
                    None
                }
            },
        };
        if let Some(val) = val {
            out.insert(key.into(), val);
        }
    }
    if out.contains_key("minVotes") && !out.contains_key("ratingBelow") {
        c.err("minVotes", "requires ratingBelow");
    }
    errs.extend(c.errs);
    Value::Object(out)
}

pub fn not_candidate(id: i32) -> AppError {
    AppError::not_found(format!("Media #{id} is not a cleanup candidate"))
}

const BULK_MAX: usize = 200;

#[derive(Debug)]
pub struct BulkItem {
    pub media_id: i32,
    pub season_id: Option<i32>,
    pub episode_id: Option<i32>,
}

#[derive(Debug)]
pub struct Bulk {
    pub delete_now: bool,
    pub items: Vec<BulkItem>,
}

pub fn bulk(v: Value) -> Res<Bulk> {
    let o = object(v);
    let mut c = Check::new(&o, &["action", "items"], "");
    let action = c.one_of("action", &["keep", "delete-now"], false);
    let mut items = vec![];
    match o.get("items").and_then(Value::as_array) {
        Some(a) if (1..=BULK_MAX).contains(&a.len()) => {
            for (i, it) in a.iter().enumerate() {
                let it = object(it.clone());
                let prefix = format!("items.{i}.");
                let mut ic = Check::new(&it, &["mediaId", "seasonId", "episodeId"], &prefix);
                let id =
                    |ic: &mut Check, k: &str, req: bool| match it.get(k).filter(|v| !v.is_null()) {
                        None if !req => None,
                        Some(v) => ic.int(k, v, false, Some(1), None),
                        None => {
                            ic.err(k, "must be an integer number");
                            None
                        }
                    };
                let media_id = id(&mut ic, "mediaId", true);
                let season_id = id(&mut ic, "seasonId", false);
                let episode_id = id(&mut ic, "episodeId", false);
                c.errs.append(&mut ic.errs);
                if let Some(media_id) = media_id {
                    items.push(BulkItem {
                        media_id,
                        season_id,
                        episode_id,
                    });
                }
            }
        }
        _ => c.err("items", "must contain between 1 and 200 items"),
    }
    c.finish(Bulk {
        delete_now: action.as_deref() == Some("delete-now"),
        items,
    })
}

/// Version 1 file (`cleanup.md` rule 31): `level`, or the legacy `criteria.mediaType`, becomes `levels`.
fn v1_level(o: &mut Map<String, Value>, errs: &mut Vec<String>) {
    if o.contains_key("levels") {
        errs.push("property levels should not exist".into());
    }
    let legacy = match o.get_mut("criteria") {
        Some(Value::Object(k)) => k.remove("mediaType"),
        _ => None,
    };
    let level = o.remove("level").filter(|l| !l.is_null());
    let picked = match (legacy, level) {
        (Some(t), Some(l)) if t != l => {
            errs.push(format!(
                "criteria.mediaType contradicts level {}",
                l.as_str().unwrap_or_default()
            ));
            return;
        }
        (t, l) => l.or(t),
    };
    if let Some(l) = picked {
        o.insert("levels".into(), json!([l]));
    }
}

/// Portable rule (`cleanup.md` rule 30) to a rule body: library names to ids, always disabled.
pub fn import(v: Value, libraries: &[(i32, String)]) -> Res<Rule> {
    let mut o = object(v);
    let mut errs = vec![];
    let version = o.remove("fliksCleanupRule");
    if version != Some(json!(1)) && version != Some(json!(2)) {
        errs.push("fliksCleanupRule must be 1 or 2".to_owned());
    }
    if version == Some(json!(1)) {
        v1_level(&mut o, &mut errs);
    }
    if let Some(Value::Object(k)) = o.get_mut("criteria") {
        for key in ["libraryIds", "excludeLibraryIds"] {
            let Some(Value::Array(names)) = k.get(key).cloned() else {
                continue;
            };
            let mut ids = vec![];
            for n in &names {
                match n.as_str().and_then(|n| libraries.iter().find(|l| l.1 == n)) {
                    Some(l) => ids.push(json!(l.0)),
                    None => errs.push(format!(
                        "criteria.{key} unknown library {}",
                        n.as_str().map_or_else(|| n.to_string(), str::to_owned)
                    )),
                }
            }
            k.insert(key.into(), Value::Array(ids));
        }
    }
    if !errs.is_empty() {
        return Err(AppError::bad_request(errs));
    }
    o.insert("enabled".into(), json!(false));
    rule(Value::Object(o))
}
