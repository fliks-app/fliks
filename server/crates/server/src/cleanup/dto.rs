//! `/api/cleanup/rules` body (`cleanup.md` rules 6-8): class-validator style messages, unknown keys rejected.
use crate::{
    http::AppError,
    requests::dto::{Check, MEDIA_TYPES, Res, object},
};
use serde_json::{Map, Value, json};

pub const ACTIONS: [&str; 3] = ["delete", "delete_files_unmonitor", "none"];
pub const LEVELS: [&str; 4] = ["movie", "series", "season", "episode"];

pub fn scoped(level: &str) -> bool {
    level == "season" || level == "episode"
}

#[derive(Debug)]
pub struct Rule {
    pub name: String,
    pub enabled: bool,
    pub level: String,
    pub delete_series_when_empty: bool,
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
            "level",
            "criteria",
            "action",
            "graceDays",
            "deleteSeriesWhenEmpty",
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
    let typed_series = o
        .get("criteria")
        .and_then(|k| k.get("mediaType"))
        .and_then(Value::as_str)
        == Some("series");
    let level = c
        .one_of("level", &LEVELS, true)
        .unwrap_or_else(|| if typed_series { "series" } else { "movie" }.into());
    let delete_series_when_empty = match o.get("deleteSeriesWhenEmpty") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => {
            if *b && !scoped(&level) {
                c.err("deleteSeriesWhenEmpty", "must be false below season level");
            }
            *b
        }
        Some(_) => {
            c.err("deleteSeriesWhenEmpty", "must be a boolean value");
            false
        }
    };
    let criteria = match o.get("criteria") {
        Some(Value::Object(k)) => criteria(k, &level, &mut c.errs),
        _ => {
            c.err("criteria", "must be an object");
            json!({})
        }
    };
    c.finish(Rule {
        name,
        enabled,
        level,
        delete_series_when_empty,
        criteria,
        action,
        grace_days,
    })
}

const KEYS: [&str; 18] = [
    "libraryIds",
    "mediaType",
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
    "likedByFewerThan",
    "notLikedByRequester",
    "keepLatestEpisodes",
    "diskFreeBelowPercent",
];

fn criteria(k: &Map<String, Value>, level: &str, errs: &mut Vec<String>) -> Value {
    let mut c = Check::new(k, &KEYS, "criteria.");
    let mut out = Map::new();
    for key in &KEYS {
        let key = *key;
        let Some(v) = k.get(key).filter(|v| !v.is_null()) else {
            continue;
        };
        let val: Option<Value> = match key {
            "libraryIds" => c.int_array(key, false).map(|a| json!(a)),
            "mediaType" if scoped(level) => {
                c.err(key, &format!("is not available at {level} level"));
                None
            }
            "mediaType" => c
                .one_of(key, &MEDIA_TYPES, true)
                .map(Value::from)
                .filter(|t| {
                    let ok = *t == level;
                    if !ok {
                        c.err(key, &format!("must be {level}"));
                    }
                    ok
                }),
            "keepLatestEpisodes" if level != "episode" => {
                c.err(key, "is only available at episode level");
                None
            }
            "addedOlderThanDays" | "releasedOlderThanDays" | "lastPlayedOlderThanDays" => {
                c.int(key, v, false, Some(0), None).map(Value::from)
            }
            "minVotes" | "likedByFewerThan" | "keepLatestEpisodes" => {
                c.int(key, v, false, Some(1), None).map(Value::from)
            }
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
