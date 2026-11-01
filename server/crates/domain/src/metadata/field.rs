//! The closed set of fields a provider record fills (`metadata-orchestrator.md` rules 23-24).
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Field {
    Title,
    OriginalTitle,
    Overview,
    Year,
    PosterUrl,
    FanartUrl,
    LogoUrl,
    Rating,
    Genres,
    Runtime,
    Status,
    AlternativeTitles,
    ReleaseDates,
    Collection,
    Credits,
    Details,
    Ids,
}

impl Field {
    pub const ALL: [Self; 17] = [
        Self::Title,
        Self::OriginalTitle,
        Self::Overview,
        Self::Year,
        Self::PosterUrl,
        Self::FanartUrl,
        Self::LogoUrl,
        Self::Rating,
        Self::Genres,
        Self::Runtime,
        Self::Status,
        Self::AlternativeTitles,
        Self::ReleaseDates,
        Self::Collection,
        Self::Credits,
        Self::Details,
        Self::Ids,
    ];

    /// The name `media_field_sources.field` stores.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::OriginalTitle => "originalTitle",
            Self::Overview => "overview",
            Self::Year => "year",
            Self::PosterUrl => "posterUrl",
            Self::FanartUrl => "fanartUrl",
            Self::LogoUrl => "logoUrl",
            Self::Rating => "rating",
            Self::Genres => "genres",
            Self::Runtime => "runtime",
            Self::Status => "status",
            Self::AlternativeTitles => "alternativeTitles",
            Self::ReleaseDates => "releaseDates",
            Self::Collection => "collection",
            Self::Credits => "credits",
            Self::Details => "details",
            Self::Ids => "ids",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.as_str() == s)
    }

    /// The record keys the field owns.
    pub const fn keys(self) -> &'static [&'static str] {
        match self {
            Self::Title => &["title"],
            Self::OriginalTitle => &["originalTitle"],
            Self::Overview => &["overview"],
            Self::Year => &["year"],
            Self::PosterUrl => &["posterUrl"],
            Self::FanartUrl => &["fanartUrl", "additionalFanartUrls"],
            Self::LogoUrl => &["logoUrl"],
            Self::Rating => &["rating"],
            Self::Genres => &["genres"],
            Self::Runtime => &["runtime"],
            Self::Status => &["status"],
            Self::AlternativeTitles => &["alternativeTitles"],
            Self::ReleaseDates => &[
                "releaseDate",
                "inCinemas",
                "digitalRelease",
                "physicalRelease",
            ],
            Self::Collection => &["tmdbCollectionId", "tmdbCollectionName"],
            Self::Credits => &["cast", "crew"],
            Self::Details => &[
                "budget",
                "revenue",
                "tagline",
                "popularity",
                "voteCount",
                "originalLanguage",
                "productionCountries",
                "productionCompanies",
                "videos",
                "keywords",
            ],
            Self::Ids => &["tmdbId", "tvdbId", "imdbId"],
        }
    }

    /// The field owning `key`, `None` for a key no field owns.
    pub fn of_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.keys().contains(&key))
    }

    /// `null`, `""` and `[]` are empty; under `ids` so is `0`.
    pub fn is_empty(self, v: &Value) -> bool {
        blank(v) || (self == Self::Ids && v.as_i64() == Some(0))
    }
}

pub(super) fn blank(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_round_trip_and_keys_belong_to_one_field() {
        let mut seen = std::collections::HashSet::new();
        for f in Field::ALL {
            assert_eq!(Field::parse(f.as_str()), Some(f));
            for k in f.keys() {
                assert!(seen.insert(*k), "{k} owned twice");
                assert_eq!(Field::of_key(k), Some(f));
            }
        }
        assert_eq!(Field::of_key("provider"), None);
        assert_eq!(Field::parse("seasons"), None);
    }

    #[test]
    fn empty_values() {
        for v in [json!(null), json!(""), json!([])] {
            assert!(Field::Overview.is_empty(&v));
        }
        for v in [json!(0), json!(false), json!("a"), json!([1]), json!({})] {
            assert!(!Field::Rating.is_empty(&v));
        }
        assert!(Field::Ids.is_empty(&json!(0)));
        assert!(!Field::Ids.is_empty(&json!(5)));
    }
}
