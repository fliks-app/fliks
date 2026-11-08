//! The target edition of an album: the release that best fits the library's profile and pressing preferences.
use super::{matcher::Config, profile::MetadataProfile, provider::Release};

fn rank(list: &[String], v: Option<&str>) -> usize {
    v.and_then(|v| list.iter().position(|p| p.eq_ignore_ascii_case(v)))
        .unwrap_or(list.len())
}

/// The track count most releases of the group share (the lower of two middles): the standard edition.
fn usual_tracks(releases: &[&Release]) -> Option<i32> {
    let mut n: Vec<i32> = releases.iter().filter_map(|r| r.track_count).collect();
    n.sort_unstable();
    n.get(n.len().checked_sub(1)? / 2).copied()
}

/// A release the profile allows (every release when it allows none), the best by status, country, medium,
/// closeness to the usual track count, then the earliest date; the id breaks a tie.
pub fn pick_target<'a>(
    releases: &'a [Release],
    profile: &MetadataProfile,
    prefs: &Config,
) -> Option<&'a Release> {
    let allowed: Vec<&Release> = releases
        .iter()
        .filter(|r| profile.allows_status(r.status))
        .collect();
    let pool = if allowed.is_empty() {
        releases.iter().collect()
    } else {
        allowed
    };
    let usual = usual_tracks(&pool);
    pool.into_iter().min_by_key(|r| {
        (
            rank(&profile.statuses, r.status.or(Some("unknown"))),
            rank(&prefs.countries, r.country.as_deref()),
            rank(&prefs.media, r.media),
            r.track_count
                .zip(usual)
                .map_or(i32::MAX, |(c, u)| (c - u).abs()),
            r.release_date,
            r.external_id.clone(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn rel(id: &str, country: &str, media: &'static str, tracks: i32, year: i32) -> Release {
        Release {
            external_id: id.into(),
            title: "T".into(),
            country: Some(country.into()),
            status: Some("official"),
            media: Some(media),
            release_date: NaiveDate::from_ymd_opt(year, 1, 1),
            barcode: None,
            catalog_number: None,
            label: None,
            track_count: Some(tracks),
            disc_count: None,
        }
    }

    #[test]
    fn the_standard_edition_wins_over_a_deluxe_one() {
        let rs = [
            rel("deluxe", "US", "cd", 18, 2019),
            rel("std-a", "GB", "cd", 12, 2019),
            rel("std-b", "GB", "digital", 12, 2020),
        ];
        let p = pick_target(&rs, &MetadataProfile::default(), &Config::default());
        assert_eq!(p.unwrap().external_id, "std-a");
    }

    #[test]
    fn preferences_come_before_the_track_count() {
        let rs = [
            rel("us", "US", "cd", 12, 2019),
            rel("fr", "FR", "cd", 13, 2020),
        ];
        let cfg = Config::from_percent(90.0, 80.0, vec!["fr".into()], vec![]);
        assert_eq!(
            pick_target(&rs, &MetadataProfile::default(), &cfg)
                .unwrap()
                .external_id,
            "fr"
        );
    }

    #[test]
    fn a_release_the_profile_refuses_is_kept_only_when_it_is_the_only_one() {
        let mut bootleg = rel("b", "US", "cd", 10, 2019);
        bootleg.status = Some("bootleg");
        let official = rel("o", "US", "cd", 14, 2020);
        let both = [bootleg.clone(), official];
        let p = MetadataProfile::default();
        assert_eq!(
            pick_target(&both, &p, &Config::default())
                .unwrap()
                .external_id,
            "o"
        );
        assert_eq!(
            pick_target(&[bootleg], &p, &Config::default())
                .unwrap()
                .external_id,
            "b"
        );
        assert!(pick_target(&[], &p, &Config::default()).is_none());
    }
}
