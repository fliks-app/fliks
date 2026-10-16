//! Library file and folder naming (`naming.service.ts`); no IO, the caller joins and confines.
use crate::js::{rx, trim};
use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamingFormats {
    pub movie: String,
    pub movie_folder: String,
    pub series: String,
    pub series_folder: String,
    pub season_folder: String,
}

pub fn default_formats() -> NamingFormats {
    NamingFormats {
        movie: "{Movie Title} ({Release Year}) {Quality Full}".into(),
        movie_folder: "{Movie Title} ({Release Year})".into(),
        series: "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}"
            .into(),
        series_folder: "{Series Title}".into(),
        season_folder: "Season {season:00}".into(),
    }
}

/// `app_settings` rows (`key`, nullable `value`): a stored value, even empty, else the default.
pub fn formats_from_rows(rows: &[(String, Option<String>)]) -> NamingFormats {
    let get = |key: &str, default: String| {
        rows.iter()
            .rev()
            .find(|(k, _)| k == key)
            .and_then(|(_, v)| v.clone())
            .unwrap_or(default)
    };
    let d = default_formats();
    NamingFormats {
        movie: get("naming_movie_format", d.movie),
        movie_folder: get("naming_movie_folder_format", d.movie_folder),
        series: get("naming_series_format", d.series),
        series_folder: get("naming_series_folder_format", d.series_folder),
        season_folder: get("naming_season_folder_format", d.season_folder),
    }
}

/// `null` and absent both read as the empty string.
fn nullable<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

macro_rules! data {
    ($(#[$m:meta])* $name:ident { $($(#[$a:meta])* $f:ident: $t:ty),* $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Default, Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        pub struct $name { $($(#[$a])* pub $f: $t),* }
    };
}

data!(MovieFile {
    #[serde(deserialize_with = "nullable")] title: String,
    original_title: Option<String>,
    year: Option<i64>,
    #[serde(deserialize_with = "nullable")] quality: String,
    release_group: Option<String>,
    tmdb_id: Option<i64>,
});
data!(SeriesFile {
    #[serde(deserialize_with = "nullable")] series_title: String,
    season: i64,
    episode: i64,
    episode_title: Option<String>,
    #[serde(deserialize_with = "nullable")] quality: String,
    release_group: Option<String>,
    air_date: Option<String>,
});
data!(MovieFolder {
    #[serde(deserialize_with = "nullable")] title: String,
    original_title: Option<String>,
    year: Option<i64>,
    tmdb_id: Option<i64>,
});
data!(SeriesFolder {
    #[serde(deserialize_with = "nullable")] series_title: String,
    original_title: Option<String>,
    year: Option<i64>,
    tmdb_id: Option<i64>,
});

/// Successive literal replacements in order: a value that carries a later token is expanded by it.
fn fill(format: &str, subs: &[(&str, String)]) -> String {
    let name = subs.iter().fold(format.to_owned(), |name, (token, value)| {
        name.replace(token, value)
    });
    sanitize(&name)
}

/// A year or id as text; `0` and absent are empty.
fn opt_num(n: Option<i64>) -> String {
    n.filter(|n| *n != 0)
        .map_or(String::new(), |n| n.to_string())
}

fn pad2(n: i64) -> String {
    let s = n.to_string();
    if s.len() < 2 { format!("0{s}") } else { s }
}

/// `originalTitle || fallback`.
fn original(o: &Option<String>, fallback: &str) -> String {
    o.clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

pub fn apply_movie_format(format: &str, d: &MovieFile) -> String {
    fill(
        format,
        &[
            ("{Movie Title}", d.title.clone()),
            ("{Original Title}", original(&d.original_title, &d.title)),
            ("{Release Year}", opt_num(d.year)),
            ("{Quality Full}", d.quality.clone()),
            ("{Quality Title}", d.quality.clone()),
            (
                "{Release Group}",
                d.release_group.clone().unwrap_or_default(),
            ),
            ("{TMDB Id}", opt_num(d.tmdb_id)),
            ("{MediaInfo AudioCodec}", String::new()),
            ("{MediaInfo VideoCodec}", String::new()),
        ],
    )
}

pub fn apply_series_format(format: &str, d: &SeriesFile) -> String {
    fill(
        format,
        &[
            ("{Series Title}", d.series_title.clone()),
            ("{season:00}", pad2(d.season)),
            ("{episode:00}", pad2(d.episode)),
            (
                "{Episode Title}",
                d.episode_title.clone().unwrap_or_default(),
            ),
            ("{Quality Full}", d.quality.clone()),
            ("{Quality Title}", d.quality.clone()),
            (
                "{Release Group}",
                d.release_group.clone().unwrap_or_default(),
            ),
            ("{Air Date}", d.air_date.clone().unwrap_or_default()),
            ("{MediaInfo AudioCodec}", String::new()),
            ("{MediaInfo VideoCodec}", String::new()),
        ],
    )
}

/// Not validated: the caller passes the result through [`validate_folder_name`] (`.`, `..`, `''` are kept as is).
pub fn apply_movie_folder_format(format: &str, d: &MovieFolder) -> String {
    fill(
        format,
        &[
            ("{Movie Title}", d.title.clone()),
            ("{Original Title}", original(&d.original_title, &d.title)),
            ("{Release Year}", opt_num(d.year)),
            ("{TMDB Id}", opt_num(d.tmdb_id)),
        ],
    )
}

pub fn apply_series_folder_format(format: &str, d: &SeriesFolder) -> String {
    fill(
        format,
        &[
            ("{Series Title}", d.series_title.clone()),
            (
                "{Original Title}",
                original(&d.original_title, &d.series_title),
            ),
            ("{Release Year}", opt_num(d.year)),
            ("{TMDB Id}", opt_num(d.tmdb_id)),
        ],
    )
}

pub fn apply_season_folder_format(format: &str, season: i64) -> String {
    fill(
        format,
        &[
            ("{season:00}", pad2(season)),
            ("{season}", season.to_string()),
        ],
    )
}

/// Why a folder name cannot be a single path component under the library root.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderNameError {
    Empty,
    Dot,
    DotDot,
    Separator,
    Nul,
}

/// The one validator of every `folderName` writer: one real component, never the root or its parent.
pub fn validate_folder_name(name: &str) -> Result<&str, FolderNameError> {
    match name {
        "" => Err(FolderNameError::Empty),
        "." => Err(FolderNameError::Dot),
        ".." => Err(FolderNameError::DotDot),
        _ if name.contains(['/', '\\']) => Err(FolderNameError::Separator),
        _ if name.contains('\0') => Err(FolderNameError::Nul),
        _ => Ok(name),
    }
}

/// Drops leftover tokens, `undefined`, path-hostile characters and empty brackets.
fn sanitize(name: &str) -> String {
    let s = rx!(r"\{[^}]*\}").replace_all(name, "");
    let s = s.replace("undefined", "");
    let s: String = s
        .chars()
        .filter(|c| !"<>:\"/\\|?*".contains(*c) && *c >= '\u{20}')
        .collect();
    let s = rx!(r"\s{2,}").replace_all(&s, " ");
    let s = rx!(r"\(\s*\)").replace_all(&s, "");
    let s = rx!(r"\[\s*\]").replace_all(&s, "");
    let s = rx!(r"\s{2,}").replace_all(&s, " ");
    trim(&s).to_owned()
}

/// The `-GROUP` before an optional extension; empty when there is none.
pub fn extract_release_group(source_title: &str) -> String {
    rx!(r"-([A-Za-z0-9]+)(?:\.[A-Za-z0-9]{2,4})?$")
        .captures(source_title)
        .map_or(String::new(), |m| m[1].to_owned())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeNumbers {
    pub season: i64,
    pub episode: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode_end: Option<i64>,
}

fn numbered_special() -> &'static fancy_regex::Regex {
    rx!(fancy i r"(?:^|[^a-zA-Z0-9])(?:specials?|ova|oav|ovd|sp|ncop|nced)[ ._-]*(\d{1,2})(?![0-9])")
}

/// A `Specials` / `Season 00` folder, a marker, a `.5` interstitial or `SxxE00` numbering.
pub fn is_special_file(path_or_name: &str) -> bool {
    let fm = |r: &fancy_regex::Regex| r.is_match(path_or_name).unwrap_or(false);
    rx!(i r"(?:^|[\\/])(?:specials?|(?:season|saison)[ ._-]*0+)(?:[\\/])").is_match(path_or_name)
        || rx!(i r"(?:^|[^a-zA-Z0-9])(?:specials?|ova|oav|ovd|ncop|nced)(?:[^a-zA-Z0-9]|$)")
            .is_match(path_or_name)
        || fm(numbered_special())
        || rx!(r"(?:^|[^0-9])\d{1,3}\.5(?:[^0-9]|$)").is_match(path_or_name)
        || fm(rx!(fancy r"(?:[Ss](\d{1,2})[ ._-]*[Ee]|(\d{1,2})[xX])0+(?![0-9])"))
}

/// One cascade entry: pattern, season group (`None` = season 1), episode group, range-end group.
struct Pattern {
    re: &'static Regex,
    season: Option<usize>,
    episode: usize,
    end: Option<usize>,
    explicit: bool,
}

fn cascade() -> &'static [Pattern; 9] {
    static P: std::sync::LazyLock<[Pattern; 9]> = std::sync::LazyLock::new(|| {
        let p = |re, season, episode, end, explicit| Pattern {
            re,
            season,
            episode,
            end,
            explicit,
        };
        [
            p(
                rx!(r"[Ss](\d{1,2})[Ee](\d{1,3})(?:[_\-Ee]+(\d{1,3}))*"),
                Some(1),
                2,
                Some(3),
                true,
            ),
            p(
                rx!(r"[Ss](\d{1,2})\s*[Ee](\d{1,3})"),
                Some(1),
                2,
                None,
                true,
            ),
            p(
                rx!(r"[Ss](\d{1,2})\s*[.\- _][Ee](\d{1,3})"),
                Some(1),
                2,
                None,
                true,
            ),
            p(rx!(r"(\d{1,2})[xX](\d{2,3})"), Some(1), 2, None, true),
            p(
                rx!(r"(?:^|[\s.])(\d)(\d{2})(?:[\s.]|$)"),
                Some(1),
                2,
                None,
                false,
            ),
            p(
                rx!(i r"(?:Part|Pt)\s*\.?\s*(\d{1,3})"),
                None,
                1,
                None,
                false,
            ),
            p(
                rx!(i r"(?:Episode|Ep)\s*\.?\s*(\d{1,3})"),
                None,
                1,
                None,
                false,
            ),
            p(
                rx!(r"(?:^|[\s.])- (\d{2,4})(?:[\s.]|$)"),
                None,
                1,
                None,
                false,
            ),
            p(rx!(r"[Ee](\d{2,3})(?:[^a-zA-Z\d]|$)"), None, 1, None, false),
        ]
    });
    &P
}

/// Dots and underscores become spaces, except a dot before a four-digit year.
fn normalize_separators(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(c) = rest.chars().next() {
        rest = &rest[c.len_utf8()..];
        let year_follows = rest.len() >= 4 && rest.as_bytes()[..4].iter().all(u8::is_ascii_digit);
        out.push(if c == '_' || (c == '.' && !year_follows) {
            ' '
        } else {
            c
        });
    }
    out
}

/// Season and episode of a file or release name; a season-only pack and an unnumbered special are `None`.
pub fn parse_episode_numbers(
    source_title: &str,
    file_path: Option<&str>,
) -> Option<EpisodeNumbers> {
    if let Ok(Some(m)) = numbered_special().captures(source_title) {
        let episode: i64 = m[1].parse().expect("1-2 digits");
        if episode >= 1 {
            return Some(EpisodeNumbers {
                season: 0,
                episode,
                episode_end: None,
            });
        }
    }
    let special = is_special_file(file_path.unwrap_or(source_title));
    let normalized = normalize_separators(source_title);
    for p in cascade() {
        let Some(m) =
            p.re.captures(&normalized)
                .or_else(|| p.re.captures(source_title))
        else {
            continue;
        };
        let episode: i64 = m[p.episode].parse().expect("1-4 digits");
        if p.explicit && episode == 0 {
            return None;
        }
        if episode < 1 {
            continue;
        }
        if special && !p.explicit {
            return None;
        }
        let episode_end = p
            .end
            .and_then(|i| m.get(i))
            .and_then(|g| g.as_str().parse::<i64>().ok())
            .filter(|end| *end > episode);
        let season = p.season.map_or(1, |i| m[i].parse().expect("1-2 digits"));
        return Some(EpisodeNumbers {
            season,
            episode,
            episode_end,
        });
    }
    None
}

/// Accents, case and punctuation gone, on both sides of a title comparison.
fn normalize_title(s: &str) -> String {
    let stripped = rx!(r"\p{Diacritic}")
        .replace_all(&s.nfd().collect::<String>(), "")
        .into_owned();
    let lower = stripped.to_lowercase();
    trim(&rx!(r"[^a-z0-9]+").replace_all(&lower, " ")).to_owned()
}

/// Node `path.extname` (POSIX), on bytes: every separator and dot is ASCII.
fn extname(path: &str, sep: impl Fn(u8) -> bool) -> &str {
    let b = path.as_bytes();
    let (mut start_dot, mut start_part, mut end, mut matched_slash, mut pre_dot) =
        (None, 0, None, true, 0i8);
    for i in (0..b.len()).rev() {
        if sep(b[i]) {
            if !matched_slash {
                start_part = i + 1;
                break;
            }
            continue;
        }
        if end.is_none() {
            matched_slash = false;
            end = Some(i + 1);
        }
        if b[i] == b'.' {
            if start_dot.is_none() {
                start_dot = Some(i);
            } else if pre_dot != 1 {
                pre_dot = 1;
            }
        } else if start_dot.is_some() {
            pre_dot = -1;
        }
    }
    match (start_dot, end) {
        (Some(d), Some(e))
            if pre_dot != 0 && !(pre_dot == 1 && d == e - 1 && d == start_part + 1) =>
        {
            &path[d..e]
        }
        _ => "",
    }
}

/// `path.basename(p, path.extname(p))`; `\` also separates on Windows.
fn stem(filename: &str, win32: bool) -> &str {
    let sep = |c: u8| c == b'/' || (win32 && c == b'\\');
    let ext = extname(filename, sep);
    let trimmed = filename.trim_end_matches(|c: char| c.is_ascii() && sep(c as u8));
    let seg = trimmed
        .rsplit(|c: char| c.is_ascii() && sep(c as u8))
        .next()
        .unwrap_or("");
    if seg.len() > ext.len() {
        seg.strip_suffix(ext).unwrap_or(seg)
    } else {
        seg
    }
}

pub trait HasTitle {
    fn title(&self) -> Option<&str>;
}

/// Index of the special whose title the filename contains: earliest position, then longest title.
pub fn match_special_by_title<T: HasTitle>(filename: &str, specials: &[T]) -> Option<usize> {
    let haystack = normalize_title(stem(filename, cfg!(windows)));
    let mut best: Option<(usize, usize, usize)> = None;
    for (i, s) in specials.iter().enumerate() {
        let needle = normalize_title(s.title().unwrap_or(""));
        // A short title would match half the release names on disk.
        if needle.len() < 4 {
            continue;
        }
        let Some(pos) = haystack.find(&needle) else {
            continue;
        };
        if best.is_none_or(|(bp, bl, _)| pos < bp || (pos == bp && needle.len() > bl)) {
            best = Some((pos, needle.len(), i));
        }
    }
    best.map(|(_, _, i)| i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win32_stem_splits_on_backslash() {
        assert_eq!(stem("dir\\a.mkv", true), "a");
        assert_eq!(stem("dir\\a.mkv", false), "dir\\a");
        assert_eq!(stem("a.mkv/", false), "a");
        assert_eq!(stem(".mkv", false), ".mkv");
        assert_eq!(stem("a.", false), "a");
        assert_eq!(stem("..", false), "..");
    }
}
