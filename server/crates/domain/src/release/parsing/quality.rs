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

/// A lone `web` tag counts as WEB-DL only after the SxxEyy, year or resolution token (before it, it is
/// the title) and when no other source tag is present.
pub(super) fn is_bare_web(t: &str) -> bool {
    let tags = rx!(r"\bs\d{1,3}e\d{1,4}\b|\b(19|20)\d{2}\b|\b(\d{3,4}p|4k|8k|uhd)\b")
        .find(t)
        .map_or(t, |m| &t[m.end()..]);
    rx!(r"\bweb\b").is_match(tags)
        && !rx!(r"\b(hdtv|sdtv|dvd|dvdrip|dvd-?r|bluray|blu-?ray|bdrip|brrip|bdr)\b").is_match(t)
}

/// App quality of a release name (torrent title).
pub fn parse_release_quality(title: &str) -> ParsedReleaseQuality {
    let t = title.replace('.', " ").to_lowercase();

    let is_remux = rx!(r"\bremux\b").is_match(&t);
    let is_bluray = rx!(r"\b(bluray|blu-?ray|bdrip|brrip|bdr)\b").is_match(&t);
    let is_web_rip = rx!(r"\bweb[ -]?rip\b").is_match(&t);
    let is_web_dl = rx!(r"\bweb[ -]?dl\b").is_match(&t) || (is_bare_web(&t) && !is_web_rip);
    let is_hdtv = rx!(r"\bhdtv\b").is_match(&t);
    let is_dvd = rx!(r"\b(dvd|dvdrip|dvd-?r)\b").is_match(&t);
    let is_dvdr = rx!(r"\bdvd-?r\b").is_match(&t);
    let is_sdtv = rx!(r"\bsdtv\b").is_match(&t);

    let resolution: u32 = if rx!(r"\b(4320p?|8k|2160p?|4k|uhd)\b").is_match(&t) {
        2160
    } else if rx!(r"\b1080[ip]?\b").is_match(&t) {
        1080
    } else if rx!(r"\b720[ip]?\b").is_match(&t) {
        720
    } else {
        480
    };

    if rx!(r"\b(hd-?cam|cam)\b").is_match(&t) {
        return named(2);
    }
    if rx!(r"\b(hd-?ts|ts|telesync)\b").is_match(&t) {
        return named(3);
    }
    if rx!(r"\btc\b|telecine").is_match(&t) {
        return named(4);
    }

    let mut source = if is_remux {
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

    if resolution == 480 && source == "hdtv" {
        source = "sdtv";
    }

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
            } else if is_dvdr {
                Some(last)
            } else {
                Some(first)
            };
            return pick(wanted.copied().unwrap_or(*first));
        }
        [] => {}
    }

    let fallback = APP_QUALITIES
        .iter()
        .rfind(|q| q.resolution == resolution)
        .unwrap_or(&APP_QUALITIES[0]);
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
    fn resolutions_bucket_to_table_rows() {
        let name = |t| parse_release_quality(t).quality.name;
        assert_eq!(name("Show.S01E01.4320p.WEB-DL.x265"), "WEBDL-2160p");
        assert_eq!(name("Show.576p.HDTV"), "SDTV");
        assert_eq!(name("Movie.2019.360p.WEB-DL"), "WEBDL-480p");
    }

    #[test]
    fn web_tags_and_cam_variants() {
        let name = |t| parse_release_quality(t).quality.name;
        assert_eq!(name("Show.S01E01.1080p.WEB.h264-GRP"), "WEBDL-1080p");
        assert_eq!(name("Show.S02E03.WEB.DL.1080p.AAC"), "WEBDL-1080p");
        assert_eq!(name("Show.S02E03.WEB.Rip.1080p"), "WEBRip-1080p");
        assert_eq!(name("Web.Therapy.S01E01.720p.HDTV"), "HDTV-720p");
        assert_eq!(name("Web.Therapy.S01E01.1080p.WEB.h264"), "WEBDL-1080p");
        assert_eq!(name("Web.Therapy.S01E01.720p.x264-GRP"), "HDTV-720p");
        assert_eq!(name("Web.Therapy.2011.1080p.x264-GRP"), "HDTV-1080p");
        assert_eq!(name("Movie.2019.HDCAM.XviD"), "CAM");
        assert_eq!(name("Movie.2019.HDTS.XviD"), "TELESYNC");
    }

    #[test]
    fn empty_quality_parses_to_sdtv_but_ranks_zero() {
        assert_eq!(rank_from_quality_string(Some("")), 0);
        assert_eq!(parse_release_quality("").quality.name, "SDTV");
    }
}
