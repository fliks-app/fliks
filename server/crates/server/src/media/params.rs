//! Query-string DTOs of the media routes (`media-query.md` rules 4-9): JS-style number coercion, a 400 for what Postgres rejects.
use crate::http::AppError;
use fliks_domain::media::query::{is_iso8601, js_number};

pub type Pairs = [(String, String)];

pub const STATUSES: [&str; 6] = [
    "tba",
    "announced",
    "released",
    "ended",
    "continuing",
    "deleted",
];
pub const MODES: [&str; 3] = ["media", "file", "both"];

/// The values of every key, in order; a repeated key is an array.
struct Reader<'a> {
    pairs: &'a Pairs,
    errors: Vec<String>,
}

const NUMBER_MSG: &str = "must be a number conforming to the specified constraints";

impl<'a> Reader<'a> {
    fn new(pairs: &'a Pairs, known: &[&str]) -> Self {
        let mut errors = vec![];
        for (k, _) in pairs {
            if !known.contains(&k.as_str())
                && !errors
                    .iter()
                    .any(|e: &String| e.contains(&format!("property {k} ")))
            {
                errors.push(format!("property {k} should not exist"));
            }
        }
        Self { pairs, errors }
    }

    fn all(&self, key: &str) -> Vec<&'a str> {
        self.pairs
            .iter()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
            .collect()
    }

    fn string(&mut self, key: &str) -> Option<String> {
        match self.all(key).as_slice() {
            [] => None,
            [v] => Some((*v).to_owned()),
            _ => {
                self.errors.push(format!("{key} must be a string"));
                None
            }
        }
    }

    fn one_of(&mut self, key: &str, allowed: &[&str]) -> Option<String> {
        let v = self.all(key);
        if v.is_empty() {
            return None;
        }
        match v.as_slice() {
            [x] if allowed.contains(x) => Some((*x).to_owned()),
            _ => {
                self.errors.push(format!(
                    "{key} must be one of the following values: {}",
                    allowed.join(", ")
                ));
                None
            }
        }
    }

    /// `@Type(() => Number)` + `IsNumber`: an array, NaN or an infinity is a 400.
    fn number(&mut self, key: &str) -> Option<f64> {
        match self.all(key).as_slice() {
            [] => None,
            [v] => match js_number(v).filter(|n| n.is_finite()) {
                Some(n) => Some(n),
                None => {
                    self.errors.push(format!("{key} {NUMBER_MSG}"));
                    None
                }
            },
            _ => {
                self.errors.push(format!("{key} {NUMBER_MSG}"));
                None
            }
        }
    }

    /// A number bound to an int4 column: anything else is a 400.
    fn int(&mut self, key: &str) -> Option<i32> {
        let n = self.number(key)?;
        if n.fract() == 0.0 && (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&n) {
            Some(n as i32)
        } else {
            self.errors.push(format!("{key} must be an integer number"));
            None
        }
    }

    /// Only the exact string `true` is true; an array is false.
    fn flag(&self, key: &str) -> Option<bool> {
        let v = self.all(key);
        (!v.is_empty()).then(|| v == ["true"])
    }

    fn finish(self) -> Result<(), AppError> {
        if self.errors.is_empty() {
            Ok(())
        } else {
            Err(AppError::bad_request(self.errors))
        }
    }
}

#[derive(Debug, Default)]
pub struct Search {
    pub q: Option<String>,
    pub media_type: Option<String>,
    pub status: Option<String>,
    pub monitored: Option<bool>,
    pub year: Option<i32>,
    pub genre: Option<String>,
    pub genres: Vec<String>,
    pub year_min: Option<i32>,
    pub year_max: Option<i32>,
    pub vote_min: Option<f64>,
    pub collection_id: Option<i32>,
    pub quality_profile_id: Option<i32>,
    pub language_profile_id: Option<i32>,
    pub sort_by: Option<String>,
    pub sort_order: Option<String>,
    pub page: Option<f64>,
    pub limit: Option<f64>,
    pub library_id: Option<i32>,
    pub missing: Option<bool>,
    pub cutoff_unmet: bool,
    pub unidentified: bool,
    pub letter: Option<String>,
    pub exclude_watched: bool,
    pub only_watched: bool,
    pub requested_by_me: bool,
}

impl Search {
    pub fn parse(pairs: &Pairs) -> Result<Self, AppError> {
        const KEYS: [&str; 25] = [
            "q",
            "type",
            "status",
            "monitored",
            "year",
            "genre",
            "genres",
            "yearMin",
            "yearMax",
            "voteMin",
            "collectionId",
            "qualityProfileId",
            "languageProfileId",
            "sortBy",
            "sortOrder",
            "page",
            "limit",
            "libraryId",
            "missing",
            "cutoffUnmet",
            "unidentified",
            "letter",
            "excludeWatched",
            "onlyWatched",
            "requestedByMe",
        ];
        let mut r = Reader::new(pairs, &KEYS);
        let genres = match r.all("genres").as_slice() {
            [one] => one
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            many => many
                .iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        };
        let s = Self {
            q: r.string("q"),
            media_type: r.one_of("type", &["movie", "series"]),
            status: r.one_of("status", &STATUSES),
            monitored: r.flag("monitored"),
            year: r.int("year"),
            genre: r.string("genre"),
            genres,
            year_min: r.int("yearMin"),
            year_max: r.int("yearMax"),
            vote_min: r.number("voteMin"),
            collection_id: r.int("collectionId"),
            quality_profile_id: r.int("qualityProfileId"),
            language_profile_id: r.int("languageProfileId"),
            sort_by: r.string("sortBy"),
            sort_order: r.string("sortOrder"),
            page: r.number("page"),
            limit: r.number("limit"),
            library_id: r.int("libraryId"),
            missing: r.flag("missing"),
            cutoff_unmet: r.flag("cutoffUnmet") == Some(true),
            unidentified: r.flag("unidentified") == Some(true),
            letter: r.string("letter"),
            exclude_watched: r.flag("excludeWatched") == Some(true),
            only_watched: r.flag("onlyWatched") == Some(true),
            requested_by_me: r.flag("requestedByMe") == Some(true),
        };
        r.finish()?;
        s.paging()?;
        Ok(s)
    }

    /// `(limit, offset)` when paginated (`limit > 0`), literals rounded like Postgres reads them.
    pub fn paging(&self) -> Result<Option<(i64, i64)>, AppError> {
        let (page, limit) = (self.page.unwrap_or(1.0), self.limit.unwrap_or(25.0));
        if limit <= 0.0 {
            return Ok(None);
        }
        let offset = (page - 1.0) * limit;
        let (l, o) = (limit.round(), offset.round());
        if o < 0.0 {
            return Err(AppError::bad_request(vec![
                "page must not be less than 1".to_owned(),
            ]));
        }
        for (k, v) in [("limit", l), ("page", o)] {
            if v >= 9.2e18 {
                return Err(AppError::bad_request(vec![format!(
                    "{k} must not be greater than 9.2e18"
                )]));
            }
        }
        Ok(Some((l as i64, o as i64)))
    }
}

#[derive(Debug)]
pub struct Recent {
    pub library_id: Option<i32>,
    pub limit: i64,
    pub mode: String,
    pub exclude_watched: bool,
    pub requested_by_me: bool,
}

impl Recent {
    pub fn parse(pairs: &Pairs) -> Result<Self, AppError> {
        let mut r = Reader::new(
            pairs,
            &[
                "libraryId",
                "limit",
                "mode",
                "excludeWatched",
                "requestedByMe",
            ],
        );
        let library_id = r.int("libraryId");
        let limit = r.number("limit").unwrap_or(20.0);
        let mode = r.one_of("mode", &MODES);
        let s = Self {
            library_id,
            limit: 0,
            mode: mode.unwrap_or_else(|| "file".into()),
            exclude_watched: r.flag("excludeWatched") == Some(true),
            requested_by_me: r.flag("requestedByMe") == Some(true),
        };
        let rounded = limit.round();
        if rounded < 0.0 {
            r.errors.push("limit must not be less than 0".into());
        } else if rounded >= 9.2e18 {
            r.errors
                .push("limit must not be greater than 9.2e18".into());
        }
        r.finish()?;
        Ok(Self {
            limit: rounded as i64,
            ..s
        })
    }
}

#[derive(Debug)]
pub struct Calendar {
    pub start: Option<String>,
    pub end: Option<String>,
    pub media_type: Option<String>,
    pub monitored_only: bool,
    pub requested_by_me: bool,
}

impl Calendar {
    pub fn parse(pairs: &Pairs) -> Result<Self, AppError> {
        let mut r = Reader::new(
            pairs,
            &["start", "end", "type", "monitoredOnly", "requestedByMe"],
        );
        let date = |r: &mut Reader, key: &str| -> Option<String> {
            let v = r.all(key);
            match v.as_slice() {
                [] => None,
                [d] if is_iso8601(d) => Some((*d).to_owned()),
                _ => {
                    r.errors
                        .push(format!("{key} must be a valid ISO 8601 date string"));
                    None
                }
            }
        };
        let (start, end) = (date(&mut r, "start"), date(&mut r, "end"));
        let s = Self {
            start,
            end,
            media_type: r.one_of("type", &["movie", "series"]),
            monitored_only: r.flag("monitoredOnly") == Some(true),
            requested_by_me: r.flag("requestedByMe") == Some(true),
        };
        r.finish()?;
        Ok(s)
    }
}

/// A bare string query (`@Query('libraryId')`): a repeated key reaches the handler joined with `,`.
pub fn bare(pairs: &Pairs, key: &str) -> Option<String> {
    let v: Vec<&str> = pairs
        .iter()
        .filter(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .collect();
    (!v.is_empty()).then(|| v.join(","))
}
