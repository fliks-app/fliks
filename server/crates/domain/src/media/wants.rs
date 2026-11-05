//! Wants, follows and discovery rules (`docs/spec/wants-follows.md`).
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use super::{family::Family, kind::MediaKind};
use crate::language::parse_language_code;

/// The most wants a media or a follow holds.
pub const MAX_WANTS: usize = 8;

/// One wished edition: a family and an edition language (`None` is any).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WantSpec {
    pub family: Family,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub quality_profile_id: Option<i32>,
}

/// One want per family of the kind, any language: what a new media is wished with.
pub fn default_wants(kind: MediaKind) -> Vec<WantSpec> {
    kind.families()
        .iter()
        .map(|f| WantSpec {
            family: *f,
            language: None,
            quality_profile_id: None,
        })
        .collect()
}

/// Reads a JSON array of wants for a media of `kind`: languages normalised, families of the kind only.
pub fn parse_wants(v: &Value, kind: MediaKind) -> Result<Vec<WantSpec>, String> {
    let Value::Array(list) = v else {
        return Err("wants must be an array".into());
    };
    if list.is_empty() || list.len() > MAX_WANTS {
        return Err(format!("wants must hold 1 to {MAX_WANTS} entries"));
    }
    let mut out: Vec<WantSpec> = Vec::with_capacity(list.len());
    for item in list {
        let mut w: WantSpec = serde_json::from_value(item.clone())
            .map_err(|_| "each want must be { family, language?, qualityProfileId? }".to_owned())?;
        if !kind.families().contains(&w.family) {
            return Err(format!("{kind} has no {} want", w.family));
        }
        if let Some(l) = w.language.take().filter(|l| !l.trim().is_empty()) {
            w.language =
                Some(parse_language_code(&l).ok_or_else(|| format!("{l} is not a language code"))?);
        }
        if w.family == Family::Video && w.language.is_some() {
            return Err("a video want has no language".into());
        }
        if w.quality_profile_id.is_some_and(|q| q < 1) {
            return Err("qualityProfileId must be a positive integer".into());
        }
        if out
            .iter()
            .any(|o| o.family == w.family && o.language == w.language)
        {
            return Err("wants must be distinct".into());
        }
        out.push(w);
    }
    Ok(out)
}

/// The message of a create path that gets no quality profile.
pub const PROFILE_REQUIRED: &str = "A quality profile is required";

/// `parse_wants` for the create paths: every want must carry a quality profile.
pub fn parse_wants_profiled(v: &Value, kind: MediaKind) -> Result<Vec<WantSpec>, String> {
    let w = parse_wants(v, kind)?;
    if w.iter().any(|w| w.quality_profile_id.is_none()) {
        return Err(PROFILE_REQUIRED.into());
    }
    Ok(w)
}

/// A provider's date text (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) as a day, the first of the month or year when coarser.
pub fn parse_release(text: &str) -> Option<NaiveDate> {
    let mut parts = text.trim().splitn(3, '-');
    let year: i32 = parts
        .next()?
        .parse()
        .ok()
        .filter(|y| (1..=9999).contains(y))?;
    let month = parts.next().map_or(Some(1), |m| m.parse().ok())?;
    let day = parts.next().map_or(Some(1), |d| d.get(..2)?.parse().ok())?;
    NaiveDate::from_ymd_opt(year, month, day)
}

/// The last day a provider's date text can mean: the end of the year or month when it is coarser.
pub fn parse_release_end(text: &str) -> Option<NaiveDate> {
    let first = parse_release(text)?;
    let (y, m) = (first.year(), first.month());
    match text.trim().splitn(3, '-').count() {
        1 => NaiveDate::from_ymd_opt(y, 12, 31),
        2 => {
            let next = if m == 12 {
                NaiveDate::from_ymd_opt(y + 1, 1, 1)
            } else {
                NaiveDate::from_ymd_opt(y, m + 1, 1)
            };
            next.and_then(|n| n.pred_opt())
        }
        _ => Some(first),
    }
}

/// A title is new for a follow when its release is known and not before the day the follow began.
pub fn is_new(release: Option<NaiveDate>, since: NaiveDate) -> bool {
    release.is_some_and(|r| r >= since)
}

/// A name reduced to lower-case letters and digits, accents dropped, for comparing two spellings.
pub fn fold_name(s: &str) -> String {
    s.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric())
        .collect()
}

pub fn same_name(a: &str, b: &str) -> bool {
    let (a, b) = (fold_name(a), fold_name(b));
    !a.is_empty() && a == b
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn a_book_is_wished_in_text_and_audio_by_default() {
        let w = default_wants(MediaKind::Book);
        assert_eq!(w.len(), 2);
        assert_eq!(default_wants(MediaKind::Movie).len(), 1);
    }

    #[test]
    fn wants_are_normalised_and_checked() {
        let ok = parse_wants(
            &json!([{"family": "text", "language": "fre"}, {"family": "audio", "language": "EN"}]),
            MediaKind::Book,
        )
        .unwrap();
        assert_eq!(ok[0].language.as_deref(), Some("fr"));
        assert_eq!(ok[1].language.as_deref(), Some("en"));
        for bad in [
            json!([]),
            json!({}),
            json!([{"family": "video"}]),
            json!([{"family": "text", "extra": 1}]),
            json!([{"family": "text"}, {"family": "text", "language": null}]),
            json!([{"family": "text", "language": "und"}]),
            json!([{"family": "text", "qualityProfileId": 0}]),
        ] {
            assert!(parse_wants(&bad, MediaKind::Book).is_err(), "{bad}");
        }
        assert!(
            parse_wants(
                &json!([{"family": "video", "language": "fr"}]),
                MediaKind::Movie
            )
            .is_err()
        );
        assert!(parse_wants(&json!([{"family": "video"}]), MediaKind::Movie).is_ok());
        assert_eq!(
            parse_wants_profiled(&json!([{"family": "video"}]), MediaKind::Movie),
            Err(PROFILE_REQUIRED.into())
        );
        assert!(
            parse_wants_profiled(
                &json!([{"family": "video", "qualityProfileId": 3}]),
                MediaKind::Movie
            )
            .is_ok()
        );
    }

    #[test]
    fn release_text_is_read_at_any_precision() {
        assert_eq!(parse_release("2027"), Some(d(2027, 1, 1)));
        assert_eq!(parse_release("2027-03"), Some(d(2027, 3, 1)));
        assert_eq!(parse_release("2027-03-09"), Some(d(2027, 3, 9)));
        assert_eq!(parse_release("2027-03-09T10:00:00Z"), Some(d(2027, 3, 9)));
        assert_eq!(parse_release("2027-13"), None);
        assert_eq!(parse_release("soon"), None);
    }

    #[test]
    fn a_coarse_release_ends_with_its_period() {
        assert_eq!(parse_release_end("2026"), Some(d(2026, 12, 31)));
        assert_eq!(parse_release_end("2026-02"), Some(d(2026, 2, 28)));
        assert_eq!(parse_release_end("2026-12"), Some(d(2026, 12, 31)));
        assert_eq!(parse_release_end("2026-02-03"), Some(d(2026, 2, 3)));
        assert_eq!(parse_release_end("x"), None);
    }

    #[test]
    fn only_a_dated_release_from_the_follow_day_is_new() {
        let since = d(2026, 11, 2);
        assert!(is_new(Some(d(2026, 11, 2)), since));
        assert!(is_new(Some(d(2027, 1, 1)), since));
        assert!(!is_new(Some(d(2026, 11, 1)), since));
        assert!(!is_new(None, since));
    }

    #[test]
    fn names_compare_without_case_accents_or_punctuation() {
        assert!(same_name("Ursula K. Le Guin", "ursula k le guin"));
        assert!(same_name("Éric-Emmanuel Schmitt", "Eric Emmanuel Schmitt"));
        assert!(!same_name("", ""));
        assert!(!same_name("Ann Leckie", "Ann Lecky"));
    }
}
