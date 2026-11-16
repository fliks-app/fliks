//! The release a group is created as: the one that best fits the library's profile and pressing preferences.
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

/// What makes two releases of a group one version: the same title, track count and disambiguation.
pub fn version_key(title: &str, tracks: Option<i32>, disambiguation: Option<&str>) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}",
        title.trim().to_lowercase(),
        tracks.unwrap_or(-1),
        disambiguation.unwrap_or("").trim().to_lowercase()
    )
}

/// The versions of a group: its releases collapsed by `version_key`, the best pressing of each by the
/// preferences of `pick_target`, earliest first.
pub fn versions<'a>(
    releases: &'a [Release],
    profile: &MetadataProfile,
    prefs: &Config,
) -> Vec<&'a Release> {
    let key = |r: &Release| version_key(&r.title, r.track_count, r.disambiguation.as_deref());
    let mut keys: Vec<String> = releases.iter().map(key).collect();
    keys.sort_unstable();
    keys.dedup();
    let mut out: Vec<&Release> = keys
        .iter()
        .filter_map(|k| {
            let among: Vec<String> = releases
                .iter()
                .filter(|r| &key(r) == k)
                .map(|r| r.external_id.clone())
                .collect();
            pick_target(releases, profile, prefs, Some(&among))
        })
        .collect();
    out.sort_by(|a, b| (a.release_date, &a.external_id).cmp(&(b.release_date, &b.external_id)));
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
            disambiguation: None,
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
    fn releases_of_one_title_and_size_are_one_version() {
        let mut deluxe = rel("d", "GB", "cd", 18, 2019);
        deluxe.disambiguation = Some("Deluxe".into());
        let rs = [
            rel("a", "US", "cd", 12, 2019),
            rel("b", "GB", "cd", 12, 2020),
            deluxe,
        ];
        let v = versions(&rs, &MetadataProfile::default(), &Config::default());
        assert_eq!(
            v.iter().map(|r| r.external_id.as_str()).collect::<Vec<_>>(),
            ["a", "d"]
        );
    }
}
