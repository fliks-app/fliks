//! The catalog's media kinds, as stored in `media.type` and exchanged as `mediaType`.
use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Movie,
    Series,
}

impl MediaKind {
    pub const ALL: [Self; 2] = [Self::Movie, Self::Series];
    /// Wire names, in `ALL` order.
    pub const NAMES: [&'static str; 2] = [Self::Movie.as_str(), Self::Series.as_str()];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }

    /// The kind a provider's `tv` flag stands for.
    pub const fn from_tv(tv: bool) -> Self {
        if tv { Self::Series } else { Self::Movie }
    }

    /// Whether the title is made of seasons and episodes.
    pub const fn has_seasons(self) -> bool {
        match self {
            Self::Movie => false,
            Self::Series => true,
        }
    }

    /// The `"must be one of the following values"` text of every input naming a kind.
    pub fn one_of_message() -> String {
        format!(
            "must be one of the following values: {}",
            Self::NAMES.join(", ")
        )
    }
}

impl fmt::Display for MediaKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The text that is not a media kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownKind(pub String);

impl fmt::Display for UnknownKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown media kind {:?}", self.0)
    }
}

impl std::error::Error for UnknownKind {}

impl TryFrom<String> for MediaKind {
    type Error = UnknownKind;

    fn try_from(s: String) -> Result<Self, UnknownKind> {
        Self::parse(&s).ok_or(UnknownKind(s))
    }
}

#[cfg(test)]
mod tests {
    use super::MediaKind;

    #[test]
    fn wire_names_round_trip() {
        for k in MediaKind::ALL {
            assert_eq!(MediaKind::parse(k.as_str()), Some(k));
            assert_eq!(serde_json::to_string(&k).unwrap(), format!("\"{k}\""));
        }
        assert_eq!(MediaKind::NAMES, ["movie", "series"]);
        assert_eq!(MediaKind::parse("Movie"), None);
        assert!(MediaKind::Series.has_seasons() && !MediaKind::Movie.has_seasons());
        assert_eq!(MediaKind::from_tv(true), MediaKind::Series);
        assert_eq!(
            MediaKind::one_of_message(),
            "must be one of the following values: movie, series"
        );
    }
}
