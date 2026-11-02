//! The families of content a media can be wished in, as stored in `editions.family` and `wants.family`.
use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    Video,
    Audio,
    Text,
    Image,
}

impl Family {
    pub const ALL: [Self; 4] = [Self::Video, Self::Audio, Self::Text, Self::Image];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Video => "video",
            Self::Audio => "audio",
            Self::Text => "text",
            Self::Image => "image",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.as_str() == s)
    }
}

impl fmt::Display for Family {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::Family;
    use crate::media::kind::MediaKind;

    #[test]
    fn wire_names_round_trip() {
        for f in Family::ALL {
            assert_eq!(Family::parse(f.as_str()), Some(f));
            assert_eq!(serde_json::to_string(&f).unwrap(), format!("\"{f}\""));
        }
        assert_eq!(Family::parse("Video"), None);
    }

    #[test]
    fn video_kinds_are_wished_in_video_and_a_book_in_text_and_audio() {
        for k in [MediaKind::Movie, MediaKind::Series] {
            assert_eq!(k.families(), [Family::Video]);
        }
        assert_eq!(MediaKind::Book.families(), [Family::Text, Family::Audio]);
    }
}
