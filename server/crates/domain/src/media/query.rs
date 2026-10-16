//! JavaScript input semantics of the media query strings (`media-query.md` rules 5, 8, 38).
use crate::js;
use fancy_regex::Regex;
use std::sync::LazyLock;

/// `Number(s)`; `None` is NaN.
pub fn js_number(s: &str) -> Option<f64> {
    let t = js::trim(s);
    if t.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return u128::from_str_radix(digits, radix).ok().map(|n| n as f64);
        }
    }
    match t {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    if !t.chars().all(|c| c.is_ascii_digit() || ".eE+-".contains(c)) {
        return None;
    }
    t.parse().ok()
}

/// `parseInt(s, 10)`; `None` is NaN.
pub fn js_parse_int(s: &str) -> Option<i64> {
    let s = js::trim(s);
    let (neg, digits) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    let n: i64 = digits[..end].parse().ok()?;
    Some(if neg { -n } else { n })
}

/// A numeric SQL literal as Postgres reads it: halves round away from zero.
pub fn round_half_away(x: f64) -> f64 {
    x.round()
}

// validator.js `isISO8601` (non-strict), as class-validator's `IsDateString` uses it.
static ISO8601: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^([\+-]?\d{4}(?!\d{2}\b))((-?)((0[1-9]|1[0-2])(\3([12]\d|0[1-9]|3[01]))?|W([0-4]\d|5[0-3])(-?[1-7])?|(00[1-9]|0[1-9]\d|[12]\d{2}|3([0-5]\d|6[1-6])))",
        r"([T\s]((([01]\d|2[0-3])((:?)[0-5]\d)?|24:?00)([\.,]\d+(?!:))?)?(\17[0-5]\d([\.,]\d+)?)?([zZ]|([\+-])([01]\d|2[0-3]):?([0-5]\d)?)?)?)?$"
    ))
    .expect("static")
});

pub fn is_iso8601(s: &str) -> bool {
    ISO8601.is_match(s).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_follows_js() {
        assert_eq!(js_number(""), Some(0.0));
        assert_eq!(js_number(" 7 "), Some(7.0));
        assert_eq!(js_number("1e3"), Some(1000.0));
        assert_eq!(js_number("0x10"), Some(16.0));
        assert_eq!(js_number("abc"), None);
        assert_eq!(js_number("inf"), None);
        assert_eq!(js_number("5e"), None);
        assert_eq!(js_number(".5"), Some(0.5));
    }

    #[test]
    fn parse_int_and_dates() {
        assert_eq!(js_parse_int("12abc"), Some(12));
        assert_eq!(js_parse_int("abc"), None);
        for ok in [
            "2026-03-01",
            "20260301",
            "2026-03-01T10:00:00Z",
            "2026-W10",
            "2026-060",
            "2026-03",
            "2026",
        ] {
            assert!(is_iso8601(ok), "{ok}");
        }
        for bad in ["", "abc", "2026-13-01", "2026-3-1", "20263"] {
            assert!(!is_iso8601(bad), "{bad}");
        }
    }
}
