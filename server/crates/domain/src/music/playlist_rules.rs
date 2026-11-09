//! Smart playlist rules and their validation (`docs/spec/playlists.md` rules 50-51).
use serde::{Deserialize, Serialize};

pub const MAX_CRITERIA: usize = 50;
pub const MAX_LIMIT: u32 = 5000;
const MAX_TEXT: usize = 255;
const PRIMARY_TYPES: [&str; 5] = ["album", "single", "ep", "broadcast", "other"];
const SECONDARY_TYPES: [&str; 12] = [
    "compilation",
    "soundtrack",
    "spokenword",
    "interview",
    "audiobook",
    "audio drama",
    "live",
    "remix",
    "dj-mix",
    "mixtape/street",
    "demo",
    "field recording",
];
/// Audio codecs of `streamInfo` that keep every sample; `pcm_*` is lossless too.
pub const LOSSLESS_CODECS: [&str; 6] = ["flac", "alac", "ape", "wavpack", "tta", "mlp"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Match {
    All,
    Any,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortBy {
    Artist,
    Album,
    Title,
    Year,
    PlayCount,
    LastPlayed,
    AddedAt,
    Duration,
    Popularity,
    Random,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sort {
    pub by: SortBy,
    pub descending: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Criterion {
    Artist {
        name: String,
    },
    AlbumArtist {
        name: String,
    },
    Composer {
        name: String,
    },
    Work {
        title: String,
    },
    Genre {
        name: String,
    },
    Year {
        min: Option<i32>,
        max: Option<i32>,
    },
    OriginalYear {
        min: Option<i32>,
        max: Option<i32>,
    },
    ReleaseType {
        types: Vec<String>,
    },
    Compilation {
        value: bool,
    },
    Favourite {
        value: bool,
    },
    PlayCount {
        min: Option<i64>,
        max: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    LastPlayed {
        within_days: Option<i32>,
        older_than_days: Option<i32>,
    },
    #[serde(rename_all = "camelCase")]
    AddedAt {
        within_days: Option<i32>,
        older_than_days: Option<i32>,
    },
    #[serde(rename_all = "camelCase")]
    Duration {
        min_seconds: Option<f64>,
        max_seconds: Option<f64>,
    },
    Lossless {
        value: bool,
    },
    Codec {
        codecs: Vec<String>,
    },
    Popularity {
        min: Option<f64>,
        max: Option<f64>,
    },
    Library {
        ids: Vec<i32>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SmartRules {
    #[serde(rename = "match")]
    pub match_: Match,
    pub criteria: Vec<Criterion>,
    pub sort: Sort,
    pub limit: Option<u32>,
}

fn text(s: &str) -> bool {
    !s.trim().is_empty() && s.chars().count() <= MAX_TEXT
}

fn bounds<T: PartialOrd + Copy>(min: Option<T>, max: Option<T>, lo: T) -> bool {
    (min.is_some() || max.is_some())
        && min.is_none_or(|m| m >= lo)
        && max.is_none_or(|m| m >= lo)
        && min.zip(max).is_none_or(|(a, b)| a <= b)
}

fn days(within: Option<i32>, older: Option<i32>) -> bool {
    (within.is_some() || older.is_some())
        && within.is_none_or(|d| d > 0)
        && older.is_none_or(|d| d > 0)
}

fn valid(c: &Criterion) -> bool {
    match c {
        Criterion::Artist { name }
        | Criterion::AlbumArtist { name }
        | Criterion::Composer { name } => text(name),
        Criterion::Genre { name } => text(name),
        Criterion::Work { title } => text(title),
        Criterion::Year { min, max } | Criterion::OriginalYear { min, max } => {
            bounds(*min, *max, 0)
        }
        Criterion::ReleaseType { types } => {
            !types.is_empty()
                && types.iter().all(|t| {
                    PRIMARY_TYPES.contains(&t.as_str()) || SECONDARY_TYPES.contains(&t.as_str())
                })
        }
        Criterion::PlayCount { min, max } => bounds(*min, *max, 0),
        Criterion::LastPlayed {
            within_days,
            older_than_days,
        }
        | Criterion::AddedAt {
            within_days,
            older_than_days,
        } => days(*within_days, *older_than_days),
        Criterion::Duration {
            min_seconds,
            max_seconds,
        } => bounds(*min_seconds, *max_seconds, 0.0),
        Criterion::Popularity { min, max } => bounds(*min, *max, 0.0),
        Criterion::Codec { codecs } => !codecs.is_empty() && codecs.iter().all(|c| text(c)),
        Criterion::Library { ids } => !ids.is_empty(),
        Criterion::Compilation { .. }
        | Criterion::Favourite { .. }
        | Criterion::Lossless { .. } => true,
    }
}

impl SmartRules {
    /// `Err` when the criteria count, the limit or a criterion value is out of range.
    pub fn validate(&self) -> Result<(), &'static str> {
        let ok = (1..=MAX_CRITERIA).contains(&self.criteria.len())
            && self.limit.is_none_or(|l| (1..=MAX_LIMIT).contains(&l))
            && self.criteria.iter().all(valid);
        ok.then_some(()).ok_or("errors.playlist_rules_invalid")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules(criteria: serde_json::Value) -> Result<SmartRules, serde_json::Error> {
        serde_json::from_value(json!({
            "match": "all", "criteria": criteria,
            "sort": {"by": "playCount", "descending": true}, "limit": null
        }))
    }

    #[test]
    fn parses_the_wire_and_round_trips() {
        let r = rules(json!([
            {"type": "lastPlayed", "olderThanDays": 30},
            {"type": "duration", "minSeconds": 60.5},
            {"type": "genre", "name": "Jazz"}
        ]))
        .unwrap();
        assert!(r.validate().is_ok());
        assert_eq!(r.sort.by, SortBy::PlayCount);
        let back: SmartRules = serde_json::from_value(serde_json::to_value(&r).unwrap()).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn unknown_keys_and_types_do_not_parse() {
        assert!(rules(json!([{"type": "genre", "name": "x", "extra": 1}])).is_err());
        assert!(rules(json!([{"type": "mood"}])).is_err());
        assert!(rules(json!([{"type": "rating", "min": 1}])).is_err());
    }

    #[test]
    fn rejects_out_of_range_values() {
        for bad in [
            json!([]),
            json!([{"type": "artist", "name": "  "}]),
            json!([{"type": "year"}]),
            json!([{"type": "year", "min": 2000, "max": 1990}]),
            json!([{"type": "lastPlayed", "withinDays": 0}]),
            json!([{"type": "releaseType", "types": ["nope"]}]),
            json!([{"type": "library", "ids": []}]),
            json!([{"type": "popularity", "min": -1.0}]),
        ] {
            assert!(rules(bad.clone()).unwrap().validate().is_err(), "{bad}");
        }
        let mut r = rules(json!([{"type": "favourite", "value": true}])).unwrap();
        r.limit = Some(5001);
        assert!(r.validate().is_err());
        r.limit = Some(5000);
        assert!(r.validate().is_ok());
    }
}
