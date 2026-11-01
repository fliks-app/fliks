//! The kinds of release date a media can carry, as stored in `media_release_dates.kind`.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReleaseKind {
    Release,
    Cinema,
    Digital,
    Physical,
}

impl ReleaseKind {
    /// Calendar order: the specific dates first, the fallback last.
    pub const ALL: [Self; 4] = [Self::Cinema, Self::Digital, Self::Physical, Self::Release];

    /// The value stored in `media_release_dates.kind`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Release => "release",
            Self::Cinema => "cinema",
            Self::Digital => "digital",
            Self::Physical => "physical",
        }
    }

    /// The key a media payload carries it under.
    pub const fn wire_key(self) -> &'static str {
        match self {
            Self::Release => "releaseDate",
            Self::Cinema => "inCinemas",
            Self::Digital => "digitalRelease",
            Self::Physical => "physicalRelease",
        }
    }

    /// The calendar event of an entry.
    pub const fn event(self) -> &'static str {
        self.as_str()
    }

    /// Whether the date only counts when no other kind falls in the window.
    pub const fn is_fallback(self) -> bool {
        matches!(self, Self::Release)
    }
}

#[cfg(test)]
mod tests {
    use super::ReleaseKind;

    #[test]
    fn registry_is_closed_and_ordered() {
        let keys = ReleaseKind::ALL.map(ReleaseKind::wire_key);
        assert_eq!(
            keys,
            [
                "inCinemas",
                "digitalRelease",
                "physicalRelease",
                "releaseDate"
            ]
        );
        let fallbacks: Vec<_> = ReleaseKind::ALL
            .into_iter()
            .filter(|k| k.is_fallback())
            .collect();
        assert_eq!(fallbacks, [ReleaseKind::Release]);
        assert_eq!(ReleaseKind::Release.as_str(), "release");
    }
}
