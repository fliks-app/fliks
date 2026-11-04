//! When a heartbeat completes an item, by the family of its edition (`docs/spec/item-delivery.md` rule 22).
use super::family::Family;

const VIDEO_TAIL_S: f64 = 30.0;
const VIDEO_SHARE: f64 = 0.9;
const AUDIO_SHARE: f64 = 0.98;
/// The last Readium position has a `totalProgression` just under 1.
pub const TEXT_SHARE: f64 = 0.99;

/// Where the viewer stands in an item, in the units its family measures.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Standing {
    pub position: f64,
    pub duration: f64,
    pub progression: Option<f64>,
    /// Start of the last chapter, only for an item with at least two.
    pub last_chapter_start: Option<f64>,
}

/// The video rule alone: also the zone in which every beat is written.
pub fn video(position: f64, duration: f64) -> bool {
    duration > 0.0 && (position >= duration - VIDEO_TAIL_S || position >= duration * VIDEO_SHARE)
}

pub fn finished(family: Family, s: &Standing) -> bool {
    match family {
        Family::Video => video(s.position, s.duration),
        Family::Audio => {
            (s.duration > 0.0 && s.position >= s.duration * AUDIO_SHARE)
                || s.last_chapter_start
                    .is_some_and(|c| c > 0.0 && s.position >= c)
        }
        Family::Text | Family::Image => s.progression.is_some_and(|p| p >= TEXT_SHARE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(position: f64, duration: f64) -> Standing {
        Standing {
            position,
            duration,
            ..Standing::default()
        }
    }

    #[test]
    fn video_completes_in_the_last_30_s_or_at_90_percent() {
        assert!(!finished(Family::Video, &at(3000.0, 3600.0)));
        assert!(finished(Family::Video, &at(3240.0, 3600.0)));
        assert!(finished(Family::Video, &at(95.0, 120.0)));
        assert!(!finished(Family::Video, &at(50.0, 0.0)));
    }

    #[test]
    fn audio_completes_at_98_percent_or_in_the_last_chapter() {
        assert!(!finished(Family::Audio, &at(36_000.0, 40_000.0)), "90 %");
        assert!(finished(Family::Audio, &at(39_300.0, 40_000.0)));
        let chaptered = Standing {
            last_chapter_start: Some(38_000.0),
            ..at(38_000.0, 40_000.0)
        };
        assert!(finished(Family::Audio, &chaptered));
        assert!(
            !finished(Family::Audio, &at(38_000.0, 40_000.0)),
            "no chapters"
        );
        let from_start = Standing {
            last_chapter_start: Some(0.0),
            ..at(5.0, 40_000.0)
        };
        assert!(!finished(Family::Audio, &from_start));
        let unknown_duration = Standing {
            last_chapter_start: Some(100.0),
            ..at(120.0, 0.0)
        };
        assert!(finished(Family::Audio, &unknown_duration));
    }

    #[test]
    fn text_completes_on_its_progression_alone() {
        let read = |p| Standing {
            progression: Some(p),
            ..at(3600.0, 3600.0)
        };
        assert!(!finished(Family::Text, &read(0.98)));
        assert!(finished(Family::Text, &read(0.99)));
        assert!(!finished(Family::Text, &at(3600.0, 3600.0)));
        assert!(finished(Family::Image, &read(1.0)));
        assert!(!finished(Family::Image, &read(0.5)));
    }
}
