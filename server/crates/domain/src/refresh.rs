//! Which media the metadata jobs refresh (`scheduler.md` rules 23-25).
use crate::media::kind::MediaKind;
use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};

const DAY: i64 = 24 * 3600;

/// The columns the due tests read.
pub struct Row<'a> {
    pub kind: MediaKind,
    pub status: &'a str,
    pub release_date: Option<NaiveDate>,
    pub year: Option<i32>,
    pub refreshed_at: Option<DateTime<Utc>>,
}

/// True when at least one provider id is set (`hasProviderId`).
pub fn identified(tmdb: Option<i32>, tvdb: Option<i32>, imdb: Option<&str>) -> bool {
    tmdb.is_some() || tvdb.is_some() || imdb.is_some_and(|s| !s.is_empty())
}

/// A movie out for over a year, or an ended series, is settled: refreshed weekly instead of every night.
pub fn is_due<Z: TimeZone>(m: &Row, now: DateTime<Utc>, tz: &Z) -> bool {
    let released = || {
        let start = match (m.release_date, m.year.filter(|y| *y != 0)) {
            (Some(d), _) => d.and_hms_opt(0, 0, 0).map(|d| d.and_utc()),
            (None, Some(y)) => NaiveDate::from_ymd_opt(y, 1, 1)
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .and_then(|d| tz.from_local_datetime(&d).earliest())
                .map(|d| d.with_timezone(&Utc)),
            (None, None) => None,
        };
        start.is_some_and(|s| (now - s).num_seconds() > 365 * DAY)
    };
    let settled = match m.kind {
        MediaKind::Series => m.status == "ended",
        MediaKind::Movie => released(),
    };
    !settled
        || m.refreshed_at
            .is_none_or(|t| (now - t).num_seconds() >= 7 * DAY)
}

/// `METADATA_STALE_AFTER_MONTHS`: `max(1, parseInt(raw, 10) || 3)`.
pub fn stale_months(raw: Option<&str>) -> u32 {
    let t = raw.unwrap_or("3").trim_start();
    let (sign, digits) = match t.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, t.strip_prefix('+').unwrap_or(t)),
    };
    let n: i64 = digits
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap_or(0);
    match sign * n {
        0 => 3,
        n => n.clamp(1, 1200) as u32,
    }
}

/// `now` minus `months` like JS `setMonth` in the local zone: an overflowing day rolls into the next month.
pub fn stale_before<Z: TimeZone>(now: DateTime<Utc>, months: u32, tz: &Z) -> DateTime<Utc> {
    let local = now.with_timezone(tz).naive_local();
    let idx = local.year() * 12 + local.month0() as i32 - months as i32;
    let (y, m0) = (idx.div_euclid(12), idx.rem_euclid(12) as u32);
    let first = NaiveDate::from_ymd_opt(y, m0 + 1, 1).expect("year in range");
    let at: NaiveDateTime =
        (first + Duration::days(i64::from(local.day()) - 1)).and_time(local.time());
    tz.from_local_datetime(&at)
        .earliest()
        .map_or(now, |d| d.with_timezone(&Utc))
}

/// Rule 25: incomplete or stale metadata.
pub fn needs_refresh(
    poster: Option<&str>,
    overview: Option<&str>,
    series_without_seasons: bool,
    refreshed_at: Option<DateTime<Utc>>,
    stale_before: DateTime<Utc>,
) -> bool {
    poster.is_none_or(str::is_empty)
        || overview.is_none_or(str::is_empty)
        || series_without_seasons
        || refreshed_at.is_none_or(|t| t < stale_before)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn movie(release: Option<&str>, year: Option<i32>, refreshed: Option<&str>) -> Row<'static> {
        Row {
            kind: MediaKind::Movie,
            status: "released",
            release_date: release.map(|d| d.parse().unwrap()),
            year,
            refreshed_at: refreshed.map(at),
        }
    }

    #[test]
    fn due_boundaries() {
        let now = at("2026-10-16T12:00:00Z");
        let utc = Utc;
        // 365 days after 2025-10-16 UTC midnight is 2026-10-16T00:00: past it, the movie is settled.
        let old = movie(Some("2025-10-16"), None, Some("2026-10-14T12:00:00Z"));
        assert!(!is_due(&old, now, &utc));
        let young = movie(Some("2025-10-17"), None, Some("2026-10-14T12:00:00Z"));
        assert!(is_due(&young, now, &utc));
        let stale = movie(Some("2020-01-01"), None, Some("2026-10-09T12:00:00Z"));
        assert!(is_due(&stale, now, &utc));
        let fresh = movie(Some("2020-01-01"), None, Some("2026-10-09T12:00:01Z"));
        assert!(!is_due(&fresh, now, &utc));
        assert!(is_due(&movie(Some("2020-01-01"), None, None), now, &utc));
        let series = |status, r| Row {
            kind: MediaKind::Series,
            status,
            release_date: None,
            year: None,
            refreshed_at: r,
        };
        assert!(is_due(&series("continuing", Some(now)), now, &utc));
        assert!(!is_due(&series("ended", Some(now)), now, &utc));
        assert!(is_due(&series("ended", None), now, &utc));
    }

    #[test]
    fn year_fallback_uses_local_new_year() {
        let paris = FixedOffset::east_opt(3600).unwrap();
        let row = movie(None, Some(2025), Some("2026-10-15T00:00:00Z"));
        // 2025-01-01 00:00 +01:00 is 2024-12-31T23:00Z: 365 days later is 2025-12-31T23:00Z.
        assert!(!is_due(&row, at("2026-01-01T00:00:00Z"), &paris));
        assert!(is_due(&row, at("2025-12-31T22:59:59Z"), &paris));
        assert!(is_due(
            &movie(None, Some(0), None),
            at("2030-01-01T00:00:00Z"),
            &Utc
        ));
        assert!(is_due(
            &movie(None, None, Some("2030-01-01T00:00:00Z")),
            at("2030-01-02T00:00:00Z"),
            &Utc
        ));
    }

    #[test]
    fn stale_months_parses_like_parse_int() {
        for (raw, want) in [
            (None, 3),
            (Some("6"), 6),
            (Some(" 12abc"), 12),
            (Some("0"), 3),
            (Some("-5"), 1),
            (Some("abc"), 3),
            (Some(""), 3),
        ] {
            assert_eq!(stale_months(raw), want, "{raw:?}");
        }
    }

    #[test]
    fn stale_before_rolls_like_set_month() {
        assert_eq!(
            stale_before(at("2026-10-16T12:00:00Z"), 3, &Utc),
            at("2026-07-16T12:00:00Z")
        );
        assert_eq!(
            stale_before(at("2026-01-31T12:00:00Z"), 1, &Utc),
            at("2025-12-31T12:00:00Z")
        );
        // 31 March minus one month is "31 February" = 3 March.
        assert_eq!(
            stale_before(at("2026-03-31T12:00:00Z"), 1, &Utc),
            at("2026-03-03T12:00:00Z")
        );
        assert_eq!(
            stale_before(at("2026-02-15T00:00:00Z"), 14, &Utc),
            at("2024-12-15T00:00:00Z")
        );
    }

    #[test]
    fn needs_refresh_matrix() {
        let before = at("2026-07-16T00:00:00Z");
        let fresh = Some(at("2026-09-01T00:00:00Z"));
        let ok = |p, o, s, r| needs_refresh(p, o, s, r, before);
        assert!(!ok(Some("p"), Some("o"), false, fresh));
        assert!(ok(None, Some("o"), false, fresh));
        assert!(ok(Some(""), Some("o"), false, fresh));
        assert!(ok(Some("p"), Some(""), false, fresh));
        assert!(ok(Some("p"), Some("o"), true, fresh));
        assert!(ok(Some("p"), Some("o"), false, None));
        assert!(ok(
            Some("p"),
            Some("o"),
            false,
            Some(at("2026-07-15T23:59:59Z"))
        ));
        assert!(!ok(Some("p"), Some("o"), false, Some(before)));
    }

    #[test]
    fn identified_needs_a_provider_id() {
        assert!(identified(Some(1), None, None));
        assert!(identified(None, Some(1), None));
        assert!(identified(None, None, Some("tt1")));
        assert!(!identified(None, None, Some("")));
        assert!(!identified(None, None, None));
    }
}
