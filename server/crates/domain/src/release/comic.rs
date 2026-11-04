//! The issue a comic release name says (`docs/spec/release.md` rules 68-69), on the number grammar of `comics::name`.
use crate::comics::name::parse_path;
use crate::js::rx;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComicRelease {
    pub series: String,
    /// Canonical decimal text (`"1"`, `"1.5"`, `"-1"`); `None` for a name with no single issue number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    /// `issue`, `annual` or `special`.
    pub kind: &'static str,
    /// The total of an `(of 12)`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub of: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<i32>,
    pub digital: bool,
    pub scan: bool,
    pub c2c: bool,
    /// A trade paperback, omnibus or a run of issues: never one issue.
    pub collected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

fn is_year(w: &str) -> bool {
    rx!(r"^(?:19|20)\d\d$").is_match(w)
}

/// Dots are separators in a scene name, except in a decimal number (one or two digits after it).
fn spaced(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    b.iter()
        .enumerate()
        .map(|(i, c)| {
            let after = b[(i + 1).min(b.len())..]
                .iter()
                .take_while(|c| c.is_ascii_digit())
                .count();
            let decimal = i > 0 && b[i - 1].is_ascii_digit() && (1..=2).contains(&after);
            if *c == '.' && !decimal { ' ' } else { *c }
        })
        .collect()
}

pub fn parse_comic_release(title: &str) -> ComicRelease {
    let raw = title.trim().replace(['/', '\\'], " ");
    let raw = rx!(i r"\.(?:cbz|cbr|cb7|pdf)$")
        .replace(&raw, "")
        .into_owned();
    let scene = !raw.contains(char::is_whitespace);
    let mut r = ComicRelease {
        kind: "issue",
        ..Default::default()
    };
    let mut s = raw.replace('_', " ");
    if let Some(c) = rx!(i r"(?:digital|scan|c2c|webrip|\d)\)?-([a-zA-Z]\w*)$").captures(&s) {
        r.group = Some(c[1].to_owned());
        s.truncate(c.get(1).map_or(s.len(), |m| m.start() - 1));
    }
    if scene {
        s = spaced(&s);
    }
    let mut bare = String::new();
    let mut at = 0;
    for c in rx!(r"\(([^)]*)\)|\[([^\]]*)\]").captures_iter(&s) {
        let m = c.get(0).expect("whole match");
        bare.push_str(&s[at..m.start()]);
        bare.push(' ');
        at = m.end();
        let inner = c
            .get(1)
            .or_else(|| c.get(2))
            .map_or("", |m| m.as_str())
            .trim();
        let words: Vec<String> = inner
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(str::to_owned)
            .collect();
        let tag = |w: &String| {
            matches!(
                w.as_str(),
                "digital" | "webrip" | "web" | "scan" | "scanned" | "c2c" | "cover" | "to"
            )
        };
        r.digital |= words.iter().any(|w| w == "digital" || w == "webrip");
        r.scan |= words.iter().any(|w| w == "scan" || w == "scanned");
        r.c2c |= words.iter().any(|w| w == "c2c") || inner.eq_ignore_ascii_case("cover to cover");
        let word = rx!(
            i r"^(?:tpb|trade paperback|omnibus|hardcover|hc|graphic novel|compendium|collection|collected|deluxe edition|library edition)$"
        )
        .is_match(inner);
        r.collected |= word;
        if is_year(inner) {
            r.year.get_or_insert(inner.parse().unwrap_or(0));
        } else if let Some(n) = rx!(i r"^of\s+(\d+)$").captures(inner) {
            r.of = n[1].parse().ok();
        } else if !word && !inner.is_empty() && !words.iter().all(|w| tag(w) || is_year(w)) {
            r.group = Some(inner.to_owned());
        }
    }
    bare.push_str(&s[at..]);
    let lower = bare.to_lowercase();
    r.digital |= rx!(r"\b(?:digital|webrip)\b").is_match(&lower);
    r.scan |= rx!(r"\bscan(?:ned)?\b").is_match(&lower);
    r.c2c |= rx!(r"\bc2c\b").is_match(&lower);
    let collected = rx!(
        i r"\b(?:tpb|trade paperback|omnibus|hardcover|hc|graphic novel|compendium|collection|collected|deluxe edition|library edition|complete)\b"
    );
    r.collected |= collected.is_match(&bare);
    let bare = collected.replace_all(&bare, " ");
    let bare = rx!(i r"\b(?:digital|webrip|scan(?:ned)?|c2c)\b").replace_all(&bare, " ");
    let bare = rx!(i r"\b(?:part|pt)\.?\s*\d+\b").replace_all(&bare, " ");
    let bare = rx!(i r"(^|\s)(v(?:ol(?:ume)?\.?\s?)?\d{1,3})\.(\d{1,3})(\s|$)")
        .replace_all(&bare, "$1$2 $3$4");
    let mut bare = bare.into_owned();
    if let Some(c) = rx!(r"(?:^|\s)#?(\d{1,4})\s?-\s?#?(\d{1,4})(?:\s|$)").captures(&bare)
        && !is_year(&c[2])
        && c[2].parse::<u32>().ok() > c[1].parse::<u32>().ok()
    {
        r.collected = true;
        let m = c.get(0).expect("whole match");
        bare.replace_range(m.range(), " ");
    }
    let mut words: Vec<&str> = bare.split_whitespace().collect();
    if r.year.is_none()
        && let Some(i) = words.iter().rposition(|w| is_year(w))
        && i > 0
        && i + 1 == words.len()
    {
        r.year = words[i].parse().ok();
        words.remove(i);
    }
    let bare = words.join(" ");
    if let Some(c) = rx!(r"(\d)\s+of\s+(\d{1,4})\s*$").captures(&bare) {
        r.of = c[2].parse().ok();
    }
    let n = parse_path(&format!("{bare}.cbz"));
    r.series = n.volume;
    r.number = n.sort;
    r.kind = n.kind;
    r.volume = n.volume_no;
    r.collected |= r.volume.is_some() && r.number.is_none();
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_group_after_a_number() {
        let r = parse_comic_release("Moon Tales 005-GRP");
        assert_eq!(
            (r.number.as_deref(), r.group.as_deref()),
            (Some("5"), Some("GRP"))
        );
    }
}
