//! The catalog's media kinds, as stored in `media.type` and exchanged as `mediaType`.
use std::fmt;

use serde::{Deserialize, Serialize};

use super::family::Family;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Movie,
    Series,
    Book,
    Comic,
    Album,
}

impl MediaKind {
    pub const ALL: [Self; 5] = [
        Self::Movie,
        Self::Series,
        Self::Book,
        Self::Comic,
        Self::Album,
    ];
    /// Wire names, in `ALL` order.
    pub const NAMES: [&'static str; 5] = [
        Self::Movie.as_str(),
        Self::Series.as_str(),
        Self::Book.as_str(),
        Self::Comic.as_str(),
        Self::Album.as_str(),
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
            Self::Book => "book",
            Self::Comic => "comic",
            Self::Album => "album",
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
            Self::Movie | Self::Book | Self::Comic | Self::Album => false,
            Self::Series => true,
        }
    }

    /// Wire names of the kinds made of seasons and episodes, for SQL `= ANY(...)` bounds.
    pub fn seasonal_names() -> Vec<&'static str> {
        Self::ALL
            .into_iter()
            .filter(|k| k.has_seasons())
            .map(Self::as_str)
            .collect()
    }

    /// The families a media of this kind is wished in: one want each.
    pub const fn families(self) -> &'static [Family] {
        match self {
            Self::Movie | Self::Series => &[Family::Video],
            Self::Book => &[Family::Text, Family::Audio],
            Self::Comic => &[Family::Image],
            Self::Album => &[Family::Audio],
        }
    }

    /// Whether the kind is wished in the video family, the only one TMDB and TVDB describe.
    pub fn is_video(self) -> bool {
        self.families().contains(&Family::Video)
    }

    /// The key of this kind's count in `{movies, series}` payloads.
    pub const fn count_key(self) -> &'static str {
        match self {
            Self::Movie => "movies",
            Self::Series => "series",
            Self::Book => "books",
            Self::Comic => "comics",
            Self::Album => "albums",
        }
    }

    /// The key of this kind's count of completed media in a user's playback stats.
    pub const fn completed_stat_key(self) -> &'static str {
        match self {
            Self::Movie => "moviesWatched",
            Self::Series => "seriesStarted",
            Self::Book => "booksFinished",
            Self::Comic => "comicsFinished",
            Self::Album => "albumsFinished",
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
        assert_eq!(MediaKind::Movie.count_key(), "movies");
        assert_eq!(MediaKind::Series.count_key(), "series");
        assert_eq!(MediaKind::Book.count_key(), "books");
        assert_eq!(MediaKind::Comic.count_key(), "comics");
        assert_eq!(MediaKind::Comic.completed_stat_key(), "comicsFinished");
        assert_eq!(MediaKind::Album.count_key(), "albums");
        assert_eq!(MediaKind::Album.completed_stat_key(), "albumsFinished");
        assert_eq!(
            MediaKind::NAMES,
            ["movie", "series", "book", "comic", "album"]
        );
        assert_eq!(MediaKind::seasonal_names(), ["series"]);
        assert_eq!(MediaKind::Movie.completed_stat_key(), "moviesWatched");
        assert_eq!(MediaKind::Series.completed_stat_key(), "seriesStarted");
        assert_eq!(MediaKind::Book.completed_stat_key(), "booksFinished");
        assert_eq!(MediaKind::parse("Movie"), None);
        assert!(MediaKind::Series.has_seasons());
        assert!(
            !MediaKind::Movie.has_seasons()
                && !MediaKind::Book.has_seasons()
                && !MediaKind::Comic.has_seasons()
                && !MediaKind::Album.has_seasons()
        );
        assert_eq!(MediaKind::from_tv(true), MediaKind::Series);
        assert_eq!(
            MediaKind::one_of_message(),
            "must be one of the following values: movie, series, book, comic, album"
        );
    }
}
