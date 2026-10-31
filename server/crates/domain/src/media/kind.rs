//! The catalog's media kinds, as stored in `media.type` and exchanged as `mediaType`.
use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Movie,
    Series,
}

impl MediaKind {
    pub const ALL: [Self; 2] = [Self::Movie, Self::Series];
    /// Wire names, in `ALL` order: the allow-list of every `type` / `mediaType` input.
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

    pub const fn from_series(is_series: bool) -> Self {
        if is_series { Self::Series } else { Self::Movie }
    }

    pub const fn is_series(self) -> bool {
        match self {
            Self::Movie => false,
            Self::Series => true,
        }
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

impl FromStr for MediaKind {
    type Err = UnknownKind;

    fn from_str(s: &str) -> Result<Self, UnknownKind> {
        Self::parse(s).ok_or_else(|| UnknownKind(s.to_owned()))
    }
}

impl TryFrom<String> for MediaKind {
    type Error = UnknownKind;

    fn try_from(s: String) -> Result<Self, UnknownKind> {
        s.parse()
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
        assert!(MediaKind::Series.is_series() && !MediaKind::Movie.is_series());
    }
}
