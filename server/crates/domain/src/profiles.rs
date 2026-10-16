//! Default quality-definition sizes (`docs/spec/profiles.md` rules 25-26).
use crate::release::parsing::quality::{APP_QUALITIES, app_quality_by_id};

/// MB per hour of content; `0` on min or max means no limit.
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

/// Sizes of the quality, `"0"` defaults for an id outside `APP_QUALITIES`.
pub fn default_sizes(quality_id: i64) -> Sizes {
    let Some(q) = app_quality_by_id(quality_id) else {
        return TABLE[0].1;
    };
    lookup(&format!("{}-{}", q.resolution, q.source))
        .or_else(|| lookup(&q.resolution.to_string()))
        .unwrap_or(TABLE[0].1)
}

/// The rows `ensureDefaults` inserts: `(qualityId, title, sizes)` per `APP_QUALITIES` entry.
pub fn seed_rows() -> impl Iterator<Item = (i32, &'static str, Sizes)> {
    APP_QUALITIES
        .iter()
        .map(|q| (q.id as i32, q.name, default_sizes(i64::from(q.id))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_consequences() {
        assert_eq!(default_sizes(1), s(0.0, 700.0, 1500.0));
        assert_eq!(default_sizes(999), s(0.0, 700.0, 1500.0));
        assert_eq!(default_sizes(-1), s(0.0, 700.0, 1500.0));
        for id in 5..=10 {
            assert_eq!(default_sizes(id), s(0.0, 800.0, 1500.0), "{id}");
        }
        assert_eq!(default_sizes(11), s(150.0, 1200.0, 2500.0));
        assert_eq!(default_sizes(13), s(150.0, 1500.0, 3000.0));
        assert_eq!(default_sizes(14), s(250.0, 2500.0, 5000.0));
        assert_eq!(default_sizes(19), s(8000.0, 18000.0, 30000.0));
        assert_eq!(default_sizes(24), s(15000.0, 35000.0, 60000.0));
    }

    #[test]
    fn seeds_one_row_per_quality() {
        let rows: Vec<_> = seed_rows().collect();
        assert_eq!(rows.len(), 24);
        assert_eq!(rows[17].1, "Bluray-1080p");
    }
}
