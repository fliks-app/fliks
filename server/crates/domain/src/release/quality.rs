//! `APP_QUALITIES` and `parseReleaseQuality` (`common/constants/app-qualities.ts`, `release-parsing/quality.parser.ts`).
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AppQuality {
    pub id: u32,
    pub name: &'static str,
    pub resolution: u32,
    pub source: &'static str,
    /// Higher = better.
    pub rank: u32,
}

const fn q(
    id: u32,
    name: &'static str,
    resolution: u32,
    source: &'static str,
    rank: u32,
) -> AppQuality {
    AppQuality {
        id,
        name,
        resolution,
        source,
        rank,
    }
}

pub static APP_QUALITIES: [AppQuality; 24] = [
    q(1, "WORKPRINT", 0, "workprint", 5),
    q(2, "CAM", 0, "cam", 8),
    q(3, "TELESYNC", 0, "telesync", 10),
    q(4, "TELECINE", 0, "telecine", 12),
    q(5, "DVD", 480, "dvd", 18),
    q(6, "DVD-R", 480, "dvd", 20),
    q(7, "SDTV", 480, "sdtv", 22),
    q(8, "WEBDL-480p", 480, "web", 28),
    q(9, "WEBRip-480p", 480, "web", 28),
    q(10, "Bluray-480p", 480, "bluray", 30),
    q(11, "HDTV-720p", 720, "hdtv", 40),
    q(12, "WEBDL-720p", 720, "web", 45),
    q(13, "WEBRip-720p", 720, "web", 45),
    q(14, "Bluray-720p", 720, "bluray", 50),
    q(15, "HDTV-1080p", 1080, "hdtv", 55),
    q(16, "WEBDL-1080p", 1080, "web", 62),
    q(17, "WEBRip-1080p", 1080, "web", 60),
    q(18, "Bluray-1080p", 1080, "bluray", 68),
    q(19, "Remux-1080p", 1080, "remux", 72),
    q(20, "HDTV-2160p", 2160, "hdtv", 75),
    q(21, "WEBDL-2160p", 2160, "web", 82),
    q(22, "WEBRip-2160p", 2160, "web", 80),
    q(23, "Bluray-2160p", 2160, "bluray", 88),
    q(24, "Remux-2160p", 2160, "remux", 95),
];

pub fn app_quality_by_id(id: i64) -> Option<&'static AppQuality> {
    APP_QUALITIES.iter().find(|q| i64::from(q.id) == id)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParsedReleaseQuality {
    pub quality: &'static AppQuality,
    pub label: String,
}

/// JS `\b` (ASCII word characters) on the lower-cased, dot-free title.
fn re(pattern: &str) -> Regex {
    Regex::new(&pattern.replace(r"\b", r"(?-u:\b)")).expect("static pattern")
}

macro_rules! rx {
    ($p:expr) => {{
        static R: LazyLock<Regex> = LazyLock::new(|| re($p));
        &*R
    }};
}

fn by_id(id: i64) -> &'static AppQuality {
    app_quality_by_id(id).expect("table id")
}

fn named(id: i64) -> ParsedReleaseQuality {
    let quality = by_id(id);
    ParsedReleaseQuality {
        quality,
        label: quality.name.to_owned(),
    }
}

/// App quality of a release name (torrent title).
pub fn parse_release_quality(title: &str) -> ParsedReleaseQuality {
    let t = title.replace('.', " ").to_lowercase();

    let is_remux = rx!(r"\bremux\b").is_match(&t);
    let is_bluray = rx!(r"\b(bluray|blu-?ray|bdrip|brrip|bdr)\b").is_match(&t);
    let is_web_dl = rx!(r"\bweb-?dl\b").is_match(&t);
    let is_web_rip = rx!(r"\bweb-?rip\b").is_match(&t);
    let is_hdtv = rx!(r"\bhdtv\b").is_match(&t);
    let is_dvd = rx!(r"\b(dvd|dvdrip|dvd-?r)\b").is_match(&t);
    let is_sdtv = rx!(r"\bsdtv\b").is_match(&t);

    let low_res = rx!(r"\b(576|480|360)p?\b");
    let resolution: u32 = if rx!(r"\b(4320p?|8k)\b").is_match(&t) {
        4320
    } else if rx!(r"\b(2160p?|4k|uhd)\b").is_match(&t) {
        2160
    } else if rx!(r"\b1080[ip]?\b").is_match(&t) {
        1080
    } else if rx!(r"\b720[ip]?\b").is_match(&t) {
        720
    } else if let Some(m) = low_res.captures(&t) {
        m[1].parse().unwrap_or(480)
    } else {
        0
    };

    if rx!(r"\bcam\b").is_match(&t) {
        return named(2);
    }
    if rx!(r"\b(ts|telesync)\b").is_match(&t) {
        return named(3);
    }
    if rx!(r"\btc\b|telecine").is_match(&t) {
        return named(4);
    }

    let source = if is_remux {
        "remux"
    } else if is_bluray {
        "bluray"
    } else if is_web_dl || is_web_rip {
        "web"
    } else if is_hdtv {
        "hdtv"
    } else if is_dvd {
        "dvd"
    } else if is_sdtv {
        "sdtv"
    } else if resolution >= 2160 {
        "web"
    } else {
        "hdtv"
    };

    let candidates: Vec<&'static AppQuality> = APP_QUALITIES
        .iter()
        .filter(|q| q.resolution == resolution && q.source == source)
        .collect();
    let pick = |c: &'static AppQuality| ParsedReleaseQuality {
        quality: c,
        label: c.name.to_owned(),
    };
    match candidates.as_slice() {
        [one] => return pick(one),
        [first, .., last] => {
            let wanted = if is_web_dl {
                candidates.iter().find(|c| c.name.contains("WEBDL"))
            } else if is_web_rip {
                candidates.iter().find(|c| c.name.contains("WEBRip"))
            } else {
                return pick(last);
            };
            return pick(wanted.copied().unwrap_or(*first));
        }
        [] => {}
    }

    let fuzzy: Vec<&'static AppQuality> = APP_QUALITIES
        .iter()
        .filter(|q| {
            !(resolution > 0 && q.resolution != resolution || resolution == 0 && q.resolution > 480)
        })
        .collect();
    let fallback = fuzzy
        .iter()
        .find(|q| q.source == source)
        .or(fuzzy.last())
        .copied()
        .unwrap_or(&APP_QUALITIES[0]);
    if resolution > 0 && fuzzy.is_empty() {
        let nearest = APP_QUALITIES.iter().fold(&APP_QUALITIES[0], |best, q| {
            if q.resolution > best.resolution && q.resolution <= resolution {
                q
            } else {
                best
            }
        });
        return ParsedReleaseQuality {
            quality: fallback,
            label: format!("{resolution}p ({})", nearest.name),
        };
    }
    pick(fallback)
}

/// Rank of a stored `media_files.quality`; 0 for null or empty.
pub fn rank_from_quality_string(quality: Option<&str>) -> u32 {
    match quality {
        None | Some("") => 0,
        Some(q) => parse_release_quality(q).quality.rank,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eight_k_keeps_a_label_but_not_a_bucket() {
        let p = parse_release_quality("Show.S01E01.4320p.WEB-DL.x265");
        assert_eq!(p.quality.id, 1);
        assert_eq!(p.label, "4320p (HDTV-2160p)");
        assert_eq!(
            parse_release_quality("Show.576p.DVDRip").label,
            "576p (DVD)"
        );
    }

    #[test]
    fn empty_quality_parses_to_480_bluray_but_ranks_zero() {
        assert_eq!(rank_from_quality_string(Some("")), 0);
        assert_eq!(parse_release_quality("").quality.name, "Bluray-480p");
    }
}
