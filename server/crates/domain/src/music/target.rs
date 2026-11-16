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
/// closeness to the usual track count (over the whole pool), then the earliest date; the id breaks a tie.
/// `among` limits the choice to those release ids; a profile-allowed one wins, else any of them.
pub fn pick_target<'a>(
    releases: &'a [Release],
    profile: &MetadataProfile,
    prefs: &Config,
    among: Option<&[String]>,
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
    let listed = |r: &&Release| among.is_none_or(|a| a.contains(&r.external_id));
    let mut candidates: Vec<&Release> = pool.into_iter().filter(listed).collect();
    if candidates.is_empty() {
        candidates = releases.iter().filter(listed).collect();
    }
    candidates.into_iter().min_by_key(|r| {
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

/// The fewest releases that hold every recording: `holders[i]` are the release ids holding recording `i`
/// (none empty). Each round takes the release holding most of the rest, ties by `pick_target` preference;
/// the result pairs a release with the indices it takes.
pub fn cover<'a>(
    releases: &'a [Release],
    profile: &MetadataProfile,
    prefs: &Config,
    holders: &[Vec<String>],
) -> Vec<(&'a Release, Vec<usize>)> {
    let mut rest: Vec<usize> = (0..holders.len()).collect();
    let mut out = vec![];
    while !rest.is_empty() {
        let count = |id: &String| rest.iter().filter(|i| holders[**i].contains(id)).count();
        let best = releases
            .iter()
            .map(|r| count(&r.external_id))
            .max()
            .unwrap_or(0);
        if best == 0 {
            break;
        }
        let among: Vec<String> = releases
            .iter()
            .filter(|r| count(&r.external_id) == best)
            .map(|r| r.external_id.clone())
            .collect();
        let Some(chosen) = pick_target(releases, profile, prefs, Some(&among)) else {
            break;
        };
        let (took, left) = rest
            .into_iter()
            .partition(|i| holders[*i].contains(&chosen.external_id));
        rest = left;
        out.push((chosen, took));
    }
    out
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
        let p = pick_target(&rs, &MetadataProfile::default(), &Config::default(), None);
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
            pick_target(&rs, &MetadataProfile::default(), &cfg, None)
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
            pick_target(&both, &p, &Config::default(), None)
                .unwrap()
                .external_id,
            "o"
        );
        assert_eq!(
            pick_target(&[bootleg], &p, &Config::default(), None)
                .unwrap()
                .external_id,
            "b"
        );
        assert!(pick_target(&[], &p, &Config::default(), None).is_none());
    }

    #[test]
    fn a_listed_holder_wins_whatever_the_standard_edition() {
        let rs = [
            rel("std-a", "GB", "cd", 13, 2019),
            rel("std-b", "GB", "cd", 13, 2020),
            rel("bonus", "XW", "digital", 15, 2021),
        ];
        let among = ["bonus".to_owned()];
        let p = pick_target(
            &rs,
            &MetadataProfile::default(),
            &Config::default(),
            Some(&among),
        );
        assert_eq!(p.unwrap().external_id, "bonus");
        assert!(
            pick_target(
                &rs,
                &MetadataProfile::default(),
                &Config::default(),
                Some(&[])
            )
            .is_none()
        );
    }

    #[test]
    fn among_holders_the_closest_to_the_usual_count_wins() {
        let rs = [
            rel("std-a", "GB", "cd", 13, 2019),
            rel("std-b", "GB", "cd", 13, 2019),
            rel("std-c", "GB", "cd", 13, 2019),
            rel("deluxe", "GB", "cd", 25, 2019),
            rel("plus", "GB", "cd", 15, 2020),
        ];
        let among = ["deluxe".to_owned(), "plus".to_owned()];
        let p = pick_target(
            &rs,
            &MetadataProfile::default(),
            &Config::default(),
            Some(&among),
        );
        assert_eq!(p.unwrap().external_id, "plus");
    }

    #[test]
    fn two_recordings_on_one_release_take_one_release() {
        let rs = [
            rel("a", "GB", "cd", 13, 2019),
            rel("b", "GB", "cd", 15, 2019),
            rel("c", "GB", "cd", 15, 2020),
        ];
        let ids = |l: &[&str]| l.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        let (p, c) = (MetadataProfile::default(), Config::default());
        let one = cover(&rs, &p, &c, &[ids(&["b", "c"]), ids(&["b"])]);
        assert_eq!(one.len(), 1);
        assert_eq!(
            (one[0].0.external_id.as_str(), one[0].1.clone()),
            ("b", vec![0, 1])
        );
        let two = cover(&rs, &p, &c, &[ids(&["a"]), ids(&["c"])]);
        assert_eq!(two.len(), 2);
    }
}
