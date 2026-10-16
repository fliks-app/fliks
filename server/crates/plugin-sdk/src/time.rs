//! Wall clock as RFC 3339 UTC with milliseconds (SDK-6).

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_rfc3339() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    rfc3339(ms)
}

pub fn rfc3339(unix_ms: i64) -> String {
    let (days, ms) = (
        unix_ms.div_euclid(86_400_000),
        unix_ms.rem_euclid(86_400_000),
    );
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let (h, mi, s, milli) = (ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

#[cfg(test)]
mod tests {
    #[test]
    fn formats() {
        assert_eq!(super::rfc3339(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            super::rfc3339(1_760_000_000_123),
            "2025-10-09T08:53:20.123Z"
        );
        assert_eq!(super::rfc3339(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
