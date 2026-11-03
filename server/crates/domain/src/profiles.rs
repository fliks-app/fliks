//! Default quality-definition sizes (`docs/spec/profiles.md` rules 25-26).
use crate::media::family::Family;
use crate::release::audio::quality::{AUDIO_QUALITIES, audio_quality_by_id};
use crate::release::parsing::quality::{APP_QUALITIES, AppQuality, app_quality_by_id};
use crate::release::text::quality::{TEXT_QUALITIES, text_quality_by_id};

/// MB per hour of content (video, audio) or MB of file (text); `0` on min or max means no limit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sizes {
    pub min: f64,
    pub preferred: f64,
    pub max: f64,
}

const fn s(min: f64, preferred: f64, max: f64) -> Sizes {
    Sizes {
        min,
        preferred,
        max,
    }
}

/// Keyed `"<resolution>-<source>"`, then `"<resolution>"`, then `"0"`.
const TABLE: [(&str, Sizes); 16] = [
    ("0", s(0.0, 700.0, 1500.0)),
    ("480", s(0.0, 800.0, 1500.0)),
    ("720-hdtv", s(150.0, 1200.0, 2500.0)),
    ("720-web", s(150.0, 1500.0, 3000.0)),
    ("720-bluray", s(250.0, 2500.0, 5000.0)),
    ("720", s(150.0, 1500.0, 3500.0)),
    ("1080-hdtv", s(250.0, 2000.0, 4000.0)),
    ("1080-web", s(250.0, 3000.0, 5000.0)),
    ("1080-bluray", s(400.0, 5000.0, 10000.0)),
    ("1080-remux", s(8000.0, 18000.0, 30000.0)),
    ("1080", s(250.0, 3000.0, 6000.0)),
    ("2160-hdtv", s(600.0, 4000.0, 8000.0)),
    ("2160-web", s(600.0, 6000.0, 12000.0)),
    ("2160-bluray", s(1000.0, 12000.0, 25000.0)),
    ("2160-remux", s(15000.0, 35000.0, 60000.0)),
    ("2160", s(600.0, 8000.0, 20000.0)),
];

fn lookup(key: &str) -> Option<Sizes> {
    TABLE.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// Audio MB per hour by `AUDIO_QUALITIES` id: unknown, then the 64k, 128k and 256k buckets of each lossy codec, then lossless.
fn audio_sizes(id: u32) -> Sizes {
    match audio_quality_by_id(i64::from(id)).map(|q| (q.resolution, q.source)) {
        Some((64, _)) => s(10.0, 30.0, 60.0),
        Some((128, _)) => s(30.0, 60.0, 120.0),
        Some((256, _)) => s(60.0, 120.0, 250.0),
        Some((16, _)) => s(150.0, 350.0, 700.0),
        Some((24, _)) => s(300.0, 700.0, 1400.0),
        _ => s(0.0, 60.0, 250.0),
    }
}

/// Text MB per file by `TEXT_QUALITIES` id.
fn text_sizes(id: u32) -> Sizes {
    match text_quality_by_id(i64::from(id)).map(|q| q.source) {
        Some("pdf") => s(0.0, 8.0, 150.0),
        Some("epub") => s(0.0, 2.0, 80.0),
        Some("cbz") => s(0.0, 50.0, 500.0),
        _ => s(0.0, 2.0, 50.0),
    }
}

/// Sizes of the quality of the family, the `"0"` defaults for an id outside its table.
pub fn default_sizes(family: Family, quality_id: i64) -> Sizes {
    let id = u32::try_from(quality_id).unwrap_or(0);
    match family {
        Family::Audio => audio_sizes(id),
        Family::Text => text_sizes(id),
        Family::Video | Family::Image => video_sizes(quality_id),
    }
}

/// Sizes of the quality, `"0"` defaults for an id outside `APP_QUALITIES`.
fn video_sizes(quality_id: i64) -> Sizes {
    let Some(q) = app_quality_by_id(quality_id) else {
        return TABLE[0].1;
    };
    lookup(&format!("{}-{}", q.resolution, q.source))
        .or_else(|| lookup(&q.resolution.to_string()))
        .unwrap_or(TABLE[0].1)
}

/// The qualities of a family; empty for a family without a quality table.
pub fn table(family: Family) -> &'static [AppQuality] {
    match family {
        Family::Video => &APP_QUALITIES,
        Family::Audio => &AUDIO_QUALITIES,
        Family::Text => &TEXT_QUALITIES,
        Family::Image => &[],
    }
}

/// The quality ids a want of `family` without a profile allows: every quality but the unknown one.
pub fn default_allowed(family: Family) -> Vec<u32> {
    table(family)
        .iter()
        .filter(|q| q.source != "unknown")
        .map(|q| q.id)
        .collect()
}

/// The rows `ensureDefaults` inserts: `(qualityId, title, sizes)` per quality of the family.
pub fn seed_rows(family: Family) -> impl Iterator<Item = (i32, &'static str, Sizes)> {
    table(family)
        .iter()
        .map(move |q| (q.id as i32, q.name, default_sizes(family, i64::from(q.id))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_consequences() {
        assert_eq!(default_sizes(Family::Video, 1), s(0.0, 700.0, 1500.0));
        assert_eq!(default_sizes(Family::Video, 999), s(0.0, 700.0, 1500.0));
        assert_eq!(default_sizes(Family::Video, -1), s(0.0, 700.0, 1500.0));
        for id in 5..=10 {
            assert_eq!(
                default_sizes(Family::Video, id),
                s(0.0, 800.0, 1500.0),
                "{id}"
            );
        }
        assert_eq!(default_sizes(Family::Video, 11), s(150.0, 1200.0, 2500.0));
        assert_eq!(default_sizes(Family::Video, 13), s(150.0, 1500.0, 3000.0));
        assert_eq!(default_sizes(Family::Video, 14), s(250.0, 2500.0, 5000.0));
        assert_eq!(
            default_sizes(Family::Video, 19),
            s(8000.0, 18000.0, 30000.0)
        );
        assert_eq!(
            default_sizes(Family::Video, 24),
            s(15000.0, 35000.0, 60000.0)
        );
    }

    #[test]
    fn a_want_without_a_profile_allows_every_known_quality() {
        assert_eq!(
            default_allowed(Family::Text),
            [202, 203, 204, 205, 206, 207]
        );
        assert_eq!(default_allowed(Family::Audio).len(), 14);
        assert!(!default_allowed(Family::Audio).contains(&101));
        assert!(default_allowed(Family::Image).is_empty());
    }

    #[test]
    fn seeds_one_row_per_quality() {
        assert_eq!(seed_rows(Family::Audio).count(), 15);
        assert_eq!(seed_rows(Family::Text).count(), 7);
        assert_eq!(seed_rows(Family::Image).count(), 0);
        let rows: Vec<_> = seed_rows(Family::Video).collect();
        assert_eq!(rows.len(), 24);
        assert_eq!(rows[17].1, "Bluray-1080p");
    }

    #[test]
    fn family_defaults() {
        assert_eq!(default_sizes(Family::Audio, 103), s(30.0, 60.0, 120.0));
        assert_eq!(default_sizes(Family::Audio, 115), s(300.0, 700.0, 1400.0));
        assert_eq!(default_sizes(Family::Audio, 101), s(0.0, 60.0, 250.0));
        assert_eq!(default_sizes(Family::Text, 202), s(0.0, 8.0, 150.0));
        assert_eq!(default_sizes(Family::Text, 205), s(0.0, 2.0, 80.0));
        assert_eq!(default_sizes(Family::Text, 999), s(0.0, 2.0, 50.0));
    }

    #[test]
    fn quality_ids_are_unique_across_families() {
        let ids: std::collections::BTreeSet<u32> = Family::ALL
            .into_iter()
            .flat_map(|f| table(f).iter().map(|q| q.id))
            .collect();
        assert_eq!(ids.len(), 24 + 15 + 7);
    }
}
