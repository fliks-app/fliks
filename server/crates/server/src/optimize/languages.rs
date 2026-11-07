//! Language tokens of a profile (`original`, `media_profile`, ISO 639 codes) resolved for one media.
use fliks_domain::language::{normalize_language_code, parse_language_code};

pub const ORIGINAL: &str = "original";
pub const MEDIA_PROFILE: &str = "media_profile";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Audio,
    Subtitle,
}

/// What the tokens resolve against: the media's metadata and its language profile.
#[derive(Debug, Clone, Default)]
pub struct Languages {
    pub original: Option<String>,
    pub profile_audio: Vec<String>,
    pub profile_subtitles: Vec<String>,
}

pub fn is_token(t: &str) -> bool {
    t == ORIGINAL || t == MEDIA_PROFILE || parse_language_code(t).is_some_and(|c| c.len() <= 3)
}

/// The canonical code of a track's language, none when it is unknown (`und`, empty).
pub fn known(lang: &str) -> Option<String> {
    parse_language_code(lang)
}

impl Languages {
    /// Canonical codes in the profile's order of preference, without duplicates.
    pub fn resolve(&self, tokens: &[String], kind: Kind) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for t in tokens {
            let codes: Vec<String> = match t.as_str() {
                ORIGINAL => self.original.iter().cloned().collect(),
                MEDIA_PROFILE => match kind {
                    Kind::Audio => self.profile_audio.clone(),
                    Kind::Subtitle => self.profile_subtitles.clone(),
                },
                code => vec![normalize_language_code(Some(code))],
            };
            for c in codes {
                let c = normalize_language_code(Some(&c));
                if c != "und" && !out.contains(&c) {
                    out.push(c);
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_resolve_in_order_without_duplicates() {
        let l = Languages {
            original: Some("ja".into()),
            profile_audio: vec!["fra".into(), "ja".into()],
            profile_subtitles: vec!["fr".into()],
        };
        let t = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            l.resolve(&t(&["original", "media_profile", "en"]), Kind::Audio),
            ["ja", "fr", "en"]
        );
        assert_eq!(l.resolve(&t(&["media_profile"]), Kind::Subtitle), ["fr"]);
        assert!(
            Languages::default()
                .resolve(&t(&["original"]), Kind::Audio)
                .is_empty()
        );
    }

    #[test]
    fn token_validation() {
        assert!(is_token("original") && is_token("fra") && is_token("pt-BR"));
        assert!(!is_token("und") && !is_token("everyone") && !is_token(""));
    }
}
