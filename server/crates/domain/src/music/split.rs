//! Multi-valued tags written as one string, cut on the separators the admin configures.
use std::collections::HashSet;

/// The separators of a list of artists: `AC/DC` and `Simon & Garfunkel` stay whole.
pub const ARTIST_SEPARATORS: [&str; 2] = [";", " / "];
pub const GENRE_SEPARATORS: [&str; 3] = [";", ",", " / "];

/// Each value cut on every separator, trimmed; an empty part and a repeat (case-insensitive) is dropped.
pub fn split(values: &[String], separators: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = vec![];
    for v in values {
        let mut parts = vec![v.as_str()];
        for sep in separators.iter().filter(|s| !s.is_empty()) {
            parts = parts
                .into_iter()
                .flat_map(|p| p.split(sep.as_str()))
                .collect();
        }
        for p in parts {
            let p = p.trim();
            if !p.is_empty() && seen.insert(p.to_lowercase()) {
                out.push(p.to_owned());
            }
        }
    }
    out
}

/// A setting holding a JSON array of strings; anything else is `default`.
pub fn separators(setting: Option<&str>, default: &[&str]) -> Vec<String> {
    setting
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .unwrap_or_else(|| default.iter().map(|s| (*s).to_owned()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn values_are_cut_trimmed_and_deduplicated() {
        let seps = separators(None, &ARTIST_SEPARATORS);
        assert_eq!(
            split(&v(&["Ana; Bo / ana", "Cy"]), &seps),
            ["Ana", "Bo", "Cy"]
        );
        assert_eq!(split(&v(&["AC/DC", "Simon & Garfunkel"]), &seps).len(), 2);
    }

    #[test]
    fn a_bad_setting_falls_back_to_the_default() {
        assert_eq!(separators(Some("[\" & \"]"), &[";"]), [" & "]);
        assert_eq!(separators(Some("nope"), &[";"]), [";"]);
        assert!(split(&v(&["A & B"]), &separators(Some("[]"), &[";"])).len() == 1);
    }
}
