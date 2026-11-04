//! The records a comic provider returns, checked where the host receives them
//! (`docs/spec/provider-plugins.md` rules 60-62).
use super::name;
use chrono::NaiveDate;
use serde_json::{Value, json};
use std::collections::HashSet;

const MAX_TITLE: usize = 500;
const MAX_LABEL: usize = 255;
const MAX_OVERVIEW: usize = 10_000;
const MAX_URL: usize = 2048;
/// The sort keys from 100000 are ingest's, for files that carry no number.
const SORT_LIMIT: f64 = 10_000.0;

/// A volume as a search hit or a work record.
#[derive(Debug, Clone, PartialEq)]
pub struct Work {
    pub external_id: String,
    pub title: String,
    pub overview: Option<String>,
    pub year: Option<i32>,
    pub poster_url: Option<String>,
    pub publisher: Option<String>,
    pub volume: Option<i32>,
    pub issue_count: Option<i32>,
    pub source_url: Option<String>,
}

/// A trimmed string of 1 to `max` characters.
fn text(v: &Value, key: &str, max: usize) -> Option<String> {
    let s = v.get(key)?.as_str()?.trim();
    (!s.is_empty() && s.chars().count() <= max).then(|| s.to_owned())
}

fn int(v: &Value, key: &str, min: i64, max: i64) -> Option<i32> {
    let n = v.get(key)?.as_i64()?;
    i32::try_from(n).ok().filter(|_| (min..=max).contains(&n))
}

fn https(v: &Value, key: &str) -> Option<String> {
    text(v, key, MAX_URL).filter(|u| u.starts_with("https://"))
}

/// The volume a record describes; `Err` when the id or the title is missing or the record is no
/// comic. An optional key out of its bounds is dropped, not the record.
pub fn work(v: &Value) -> Result<Work, &'static str> {
    if !v.is_object() {
        return Err("not an object");
    }
    if v.get("mediaType").is_some_and(|m| m != "comic") {
        return Err("mediaType is not comic");
    }
    Ok(Work {
        external_id: text(v, "externalId", 128).ok_or("externalId is missing")?,
        title: text(v, "title", MAX_TITLE).ok_or("title is missing")?,
        overview: text(v, "overview", MAX_OVERVIEW),
        year: int(v, "year", 1, 9999),
        poster_url: text(v, "posterUrl", MAX_URL),
        publisher: text(v, "publisher", 255),
        volume: int(v, "volume", 0, 9999),
        issue_count: int(v, "issueCount", 0, i64::from(i32::MAX)),
        source_url: https(v, "sourceUrl"),
    })
}

/// One issue of a volume, as `comic_issues` keeps it.
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub label: String,
    /// Rounded to 2 decimals and inside the number grammar of `name::number`, like ingest's keys.
    pub sort: f64,
    pub kind: &'static str,
    pub title: Option<String>,
    pub release_date: Option<String>,
}

impl Issue {
    /// The decimal text of the sort key (`"1"`, `"1.5"`, `"-1"`).
    pub fn sort_text(&self) -> String {
        format!("{}", self.sort)
    }

    /// `(kind, sort in hundredths)`: what makes two issues one.
    pub fn key(&self) -> (&'static str, i64) {
        (self.kind, (self.sort * 100.0).round() as i64)
    }

    /// The normalised record `issue` reads back unchanged.
    pub fn to_value(&self) -> Value {
        json!({"number": self.label, "sortNumber": self.sort, "kind": self.kind,
               "title": self.title, "releaseDate": self.release_date})
    }
}

pub fn issue(v: &Value) -> Result<Issue, &'static str> {
    let kind = match v.get("kind") {
        None | Some(Value::Null) => "issue",
        Some(Value::String(k)) if k == "issue" => "issue",
        Some(Value::String(k)) if k == "annual" => "annual",
        Some(Value::String(k)) if k == "special" => "special",
        Some(_) => return Err("unknown kind"),
    };
    let sort = v
        .get("sortNumber")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && n.abs() < SORT_LIMIT)
        .ok_or("sortNumber is missing or out of range")?;
    // `+ 0.0` turns -0 into 0.
    let sort = (sort * 100.0).round() / 100.0 + 0.0;
    name::number(&format!("{sort}")).ok_or("sortNumber is outside the number grammar")?;
    let label = text(v, "number", MAX_LABEL)
        .filter(|l| !l.chars().any(char::is_control))
        .ok_or("number is not a label")?;
    let release_date = match v.get("releaseDate") {
        None | Some(Value::Null) => None,
        Some(Value::String(d)) => Some(
            NaiveDate::parse_from_str(d.trim(), "%Y-%m-%d")
                .map_err(|_| "releaseDate is not a date")?
                .to_string(),
        ),
        Some(_) => return Err("releaseDate is not a date"),
    };
    let title = v
        .get("title")
        .and_then(Value::as_str)
        .map(|t| t.trim().chars().take(MAX_TITLE).collect::<String>())
        .filter(|t| !t.is_empty());
    Ok(Issue {
        label,
        sort,
        kind,
        title,
        release_date,
    })
}

/// The issues of an answer that passed the checks, and what was dropped.
#[derive(Debug, Default)]
pub struct Issues {
    pub kept: Vec<Issue>,
    pub invalid: usize,
    pub first_reason: Option<&'static str>,
    /// Children whose `(kind, sort)` an earlier one already held.
    pub repeats: usize,
}

pub fn issues(list: &[Value]) -> Issues {
    let mut out = Issues::default();
    let mut seen = HashSet::new();
    for v in list {
        match issue(v) {
            Err(why) => {
                out.invalid += 1;
                out.first_reason.get_or_insert(why);
            }
            Ok(i) if seen.insert(i.key()) => out.kept.push(i),
            Ok(_) => out.repeats += 1,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn child(n: &str, s: Value, kind: &str) -> Value {
        json!({"number": n, "sortNumber": s, "kind": kind, "releaseDate": "2016-06-01"})
    }

    #[test]
    fn a_work_needs_an_id_and_a_title_and_drops_what_is_out_of_range() {
        let w = work(
            &json!({"externalId": "42", "title": " Alpha ", "mediaType": "comic",
            "year": 0, "volume": 3, "issueCount": -1, "publisher": "P", "sourceUrl": "http://x"}),
        )
        .unwrap();
        assert_eq!(
            (w.title.as_str(), w.year, w.volume, w.issue_count),
            ("Alpha", None, Some(3), None)
        );
        assert_eq!((w.publisher.as_deref(), w.source_url), (Some("P"), None));
        assert!(work(&json!({"externalId": "42"})).is_err());
        assert!(work(&json!({"title": "A"})).is_err());
        assert!(work(&json!({"externalId": "1", "title": "A", "mediaType": "book"})).is_err());
        assert!(work(&json!([])).is_err());
    }

    #[test]
    fn children_are_checked_one_by_one() {
        let bad = [
            child("1", json!(1), "weird"),
            child("1", json!("1"), "issue"),
            child("1", json!(10000), "issue"),
            child("1", json!(-10000.5), "issue"),
            child("", json!(1), "issue"),
            child(&"x".repeat(256), json!(1), "issue"),
            child("a\u{7}", json!(1), "issue"),
            json!({"number": "1", "sortNumber": 1, "releaseDate": "2016-02-30"}),
            json!({"number": "1", "sortNumber": 1, "releaseDate": 2016}),
        ];
        for b in &bad {
            assert!(issue(b).is_err(), "{b}");
        }
        let i =
            issue(&json!({"number": " 1.10 ", "sortNumber": 1.100_000_1, "title": "  "})).unwrap();
        assert_eq!(
            (i.kind, i.sort_text().as_str(), i.title),
            ("issue", "1.1", None)
        );
        assert_eq!(
            issue(&json!({"number": "0", "sortNumber": -0.0}))
                .unwrap()
                .sort_text(),
            "0"
        );
    }

    #[test]
    fn a_batch_keeps_the_first_of_equal_sorts_and_counts_the_rest() {
        let got = issues(&[
            child("1.10", json!(1.1), "issue"),
            child("1.1", json!(1.1), "issue"),
            child("1.1", json!(1.1), "annual"),
            child("?", json!(null), "issue"),
        ]);
        let labels: Vec<_> = got.kept.iter().map(|i| i.label.as_str()).collect();
        assert_eq!(labels, ["1.10", "1.1"]);
        assert_eq!((got.invalid, got.repeats), (1, 1));
        assert_eq!(
            got.first_reason,
            Some("sortNumber is missing or out of range")
        );
        // the normalised form reads back as itself
        let again = issues(&got.kept.iter().map(Issue::to_value).collect::<Vec<_>>());
        assert_eq!(again.kept, got.kept);
    }
}
