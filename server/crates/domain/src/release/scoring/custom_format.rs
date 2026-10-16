//! Custom-format matcher (`custom-formats.service.ts`): conditions of one type are alternatives, types all hold.
use crate::release::parsing::attributes::parse_release_attributes;
use crate::release::parsing::language::parse_release_language;
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFormatSpec {
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
    #[serde(default, deserialize_with = "null_false")]
    pub negate: bool,
    #[serde(default, deserialize_with = "null_false")]
    pub required: bool,
}

/// A stored `null` (the DTO's `IsOptional` lets it through) is falsy, as in the JS matcher.
fn null_false<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(Option::<bool>::deserialize(d)?.unwrap_or(false))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFormat {
    pub id: i64,
    pub name: String,
    pub score: i64,
    #[serde(default)]
    pub specs: Vec<CustomFormatSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFormatMatch {
    pub format_id: i64,
    pub format_name: String,
    pub matched: bool,
    pub score: i64,
}

/// Collapses spelling variants of one tag (`WEB-DL`, `web.dl`, `WEBDL`): ASCII letters and digits only.
fn norm(value: Option<&str>) -> String {
    value
        .unwrap_or("")
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_lowercase()
}

/// JS `parseInt(value, 10)` of a `norm`ed value: its leading digits, `None` for NaN.
fn parse_int(s: &str) -> Option<i64> {
    let digits: String = s.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// A pattern that does not compile matches nothing (so a `negate` on it holds).
fn title_regex(pattern: &str) -> Option<regress::Regex> {
    regress::Regex::with_flags(pattern, "i").ok()
}

fn eval_spec(
    title: &str,
    attrs: &crate::release::parsing::attributes::ReleaseAttributes,
    spec: &CustomFormatSpec,
    flags: &[String],
) -> bool {
    let value = norm(Some(&spec.value));
    match spec.kind.as_str() {
        "title_regex" => title_regex(&spec.value).is_some_and(|r| r.find(title).is_some()),
        "source" => norm(attrs.source) == value,
        "resolution" => {
            attrs.resolution > 0 && parse_int(&value) == Some(i64::from(attrs.resolution))
        }
        "language" => {
            let lang = parse_release_language(title);
            norm(Some(lang.iso_code)) == value
                || norm(Some(lang.name)) == value
                || lang
                    .iso639_2
                    .is_some_and(|c| c.iter().any(|c| norm(Some(c)) == value))
        }
        "release_flag" => flags.iter().any(|f| norm(Some(f)) == value),
        "release_group" => norm(attrs.release_group.as_deref()) == value,
        "edition" => norm(attrs.edition) == value,
        "video_codec" => norm(attrs.video_codec) == value,
        "audio_codec" => norm(attrs.audio_codec) == value,
        _ => false,
    }
}

/// A format with no condition matches nothing; a `required` condition must hold on its own.
pub fn matches_format(title: &str, fmt: &CustomFormat, flags: &[String]) -> bool {
    if fmt.specs.is_empty() {
        return false;
    }
    let attrs = parse_release_attributes(title);
    let mut groups: Vec<(&str, bool)> = vec![];
    for spec in &fmt.specs {
        let raw = eval_spec(title, &attrs, spec, flags);
        let result = raw != spec.negate;
        if spec.required && !result {
            return false;
        }
        match groups.iter_mut().find(|(k, _)| *k == spec.kind) {
            Some(g) => g.1 |= result,
            None => groups.push((&spec.kind, result)),
        }
    }
    groups.iter().all(|(_, any)| *any)
}

pub fn score_release_with(formats: &[CustomFormat], title: &str, flags: &[String]) -> i64 {
    formats
        .iter()
        .filter(|f| matches_format(title, f, flags))
        .map(|f| f.score)
        .sum()
}

pub fn test_release(
    formats: &[CustomFormat],
    title: &str,
    flags: &[String],
) -> Vec<CustomFormatMatch> {
    formats
        .iter()
        .map(|f| {
            let matched = matches_format(title, f, flags);
            CustomFormatMatch {
                format_id: f.id,
                format_name: f.name.clone(),
                matched,
                score: if matched { f.score } else { 0 },
            }
        })
        .collect()
}

/// `Err(value)` of the first `title_regex` that does not compile.
pub fn validate_title_regexes(specs: &[CustomFormatSpec]) -> Result<(), String> {
    match specs
        .iter()
        .find(|s| s.kind == "title_regex" && title_regex(&s.value).is_none())
    {
        Some(s) => Err(s.value.clone()),
        None => Ok(()),
    }
}
