//! ISBN normalisation (`books-files.md` rules 1-3).
use crate::js::rx;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Isbn {
    pub isbn13: String,
    /// Only for a `978` ISBN-13, the one with an ISBN-10 form.
    pub isbn10: Option<String>,
}

fn isbn13_check(first12: &str) -> char {
    let sum: u32 = first12
        .bytes()
        .enumerate()
        .map(|(i, b)| u32::from(b - b'0') * if i % 2 == 0 { 1 } else { 3 })
        .sum();
    char::from(b'0' + ((10 - sum % 10) % 10) as u8)
}

fn isbn10_check(first9: &str) -> char {
    let sum: u32 = first9
        .bytes()
        .enumerate()
        .map(|(i, b)| u32::from(b - b'0') * (10 - i as u32))
        .sum();
    match (11 - sum % 11) % 11 {
        10 => 'X',
        d => char::from(b'0' + d as u8),
    }
}

/// An ISBN-10 or ISBN-13 with its prefix, hyphens and spaces tolerated; `None` unless the checksum holds.
pub fn parse(raw: &str) -> Option<Isbn> {
    let s = rx!(i r"^\s*(?:urn:)?(?:isbn(?:-?1[03])?)?[:\s]*").replace(raw, "");
    let s: String = s
        .chars()
        .filter(|c| !matches!(c, '-' | ' ' | '\u{a0}'))
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if rx!(r"^97[89][0-9]{10}$").is_match(&s) {
        if isbn13_check(&s[..12]) != s.chars().last()? {
            return None;
        }
        let isbn10 = s.strip_prefix("978").map(|rest| {
            let nine = &rest[..9];
            format!("{nine}{}", isbn10_check(nine))
        });
        return Some(Isbn { isbn13: s, isbn10 });
    }
    if rx!(r"^[0-9]{9}[0-9X]$").is_match(&s) {
        if isbn10_check(&s[..9]) != s.chars().last()? {
            return None;
        }
        let twelve = format!("978{}", &s[..9]);
        let isbn13 = format!("{twelve}{}", isbn13_check(&twelve));
        return Some(Isbn {
            isbn13,
            isbn10: Some(s),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_forms_normalise_to_the_same_pair() {
        let want = Isbn {
            isbn13: "9780306406157".into(),
            isbn10: Some("0306406152".into()),
        };
        for raw in [
            "9780306406157",
            "978-0-306-40615-7",
            "urn:isbn:9780306406157",
            "ISBN 0-306-40615-2",
            "isbn:0306406152",
        ] {
            assert_eq!(parse(raw), Some(want.clone()), "{raw}");
        }
    }

    #[test]
    fn bad_checksums_and_shapes_are_refused() {
        for raw in ["9780306406158", "0306406153", "12345", "", "979123", "abc"] {
            assert_eq!(parse(raw), None, "{raw}");
        }
    }

    #[test]
    fn x_check_digit_and_979_prefix() {
        assert_eq!(parse("080442957x").unwrap().isbn13, "9780804429573");
        assert_eq!(parse("979-10-90636-07-1").unwrap().isbn10, None);
    }
}
