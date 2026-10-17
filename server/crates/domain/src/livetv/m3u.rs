//! Extended M3U parsing (`livetv-sources.md` rules 22-26 and 29).
use super::names::{normalize_channel_name, normalize_group_name};
use crate::js::{self, rx};
use chrono::{DateTime, TimeZone, Utc};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct M3uEntry {
    pub external_id: String,
    pub name: String,
    pub url: String,
    pub logo: Option<String>,
    pub group_name: String,
    pub tvg_id: Option<String>,
    pub number: Option<i32>,
    pub shift_minutes: i32,
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    pub attrs: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct M3uPlaylist {
    pub guide_url: Option<String>,
    pub guide_urls: Vec<String>,
    pub max_connections: Option<i32>,
    pub expires_at: Option<DateTime<Utc>>,
    pub entries: Vec<M3uEntry>,
}

/// Provider text never carries U+0000: Postgres rejects it (C128).
fn clean(s: &str) -> String {
    s.replace('\0', "")
}

fn parse_attrs(line: &str) -> BTreeMap<String, String> {
    rx!(r#"([A-Za-z0-9_-]+)="([^"]*)""#)
        .captures_iter(line)
        .map(|c| (c[1].to_lowercase(), c[2].to_owned()))
        .collect()
}

/// `parseInt` of a non-empty attribute; a value outside int32 is no value.
fn int_or_null(raw: Option<&str>) -> Option<i32> {
    let raw = raw.filter(|r| !r.is_empty())?;
    js::parse_int(raw).and_then(|n| i32::try_from(n).ok())
}

fn shift_minutes(raw: Option<&str>) -> i32 {
    let hours = raw
        .filter(|r| !r.is_empty())
        .and_then(js::parse_float)
        .filter(|h| h.is_finite());
    hours.map_or(0, |h| js::round(h * 60.0) as i32)
}

fn split_guide_urls(raw: Option<&str>) -> Vec<String> {
    raw.filter(|r| !r.is_empty())
        .map(|r| {
            r.split(',')
                .map(|u| js::trim(u).to_owned())
                .filter(|u| !u.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// `billed-till`: an epoch in seconds, or an ISO date (`Date.parse` subset: ISO 8601 forms, UTC when no offset).
pub fn parse_date_attr(raw: Option<&str>) -> Option<DateTime<Utc>> {
    let raw = raw.filter(|r| !r.is_empty())?;
    if raw.bytes().all(|b| b.is_ascii_digit()) {
        let secs: f64 = raw.parse().ok()?;
        return (secs > 1_000_000_000.0)
            .then(|| Utc.timestamp_millis_opt((secs * 1000.0) as i64).single())
            .flatten();
    }
    parse_iso_date(raw)
}

/// ISO 8601 date or date-time as `Date.parse` reads them; no offset means UTC.
pub fn parse_iso_date(raw: &str) -> Option<DateTime<Utc>> {
    let t = js::trim(raw);
    let m = rx!(r"^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$")
        .captures(t)?;
    let num = |i: usize, d: u32| m.get(i).map_or(Some(d), |g| g.as_str().parse::<u32>().ok());
    let year: i32 = m[1].parse().ok()?;
    let (mo, day) = (num(2, 1)?, num(3, 1)?);
    let (h, mi, s) = (num(4, 0)?, num(5, 0)?, num(6, 0)?);
    if h > 24 || mi > 59 || s > 59 || (h == 24 && (mi, s) != (0, 0)) {
        return None;
    }
    let ms = m.get(7).map_or(0, |g| {
        let f = format!("{:0<3}", &g.as_str()[..g.as_str().len().min(3)]);
        f.parse::<i64>().unwrap_or(0)
    });
    let base = chrono::NaiveDate::from_ymd_opt(year, mo, day)?
        .and_hms_opt(0, 0, 0)?
        .and_utc()
        + chrono::Duration::milliseconds(
            i64::from(h) * 3_600_000 + i64::from(mi) * 60_000 + i64::from(s) * 1000 + ms,
        );
    let offset = m.get(8).map_or(0, |g| {
        let g = g.as_str();
        if g == "Z" {
            return 0;
        }
        let sign = if g.starts_with('-') { -1 } else { 1 };
        let h: i64 = g[1..3].parse().unwrap_or(0);
        let m: i64 = g[4..6].parse().unwrap_or(0);
        sign * (h * 60 + m)
    });
    Some(base - chrono::Duration::minutes(offset))
}

/// `decodeURIComponent`, which throws on any malformed escape: the raw text is kept then.
fn safe_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let well_formed = bytes.iter().enumerate().all(|(i, b)| {
        *b != b'%'
            || bytes
                .get(i + 1..i + 3)
                .is_some_and(|h| h.iter().all(u8::is_ascii_hexdigit))
    });
    if !well_formed {
        return raw.to_owned();
    }
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map_or_else(|_| raw.to_owned(), |c| c.into_owned())
}

/// `inputstream.adaptive.stream_headers`: a query-string-shaped blob with percent-encoded values.
fn parse_stream_headers(raw: &str) -> (Option<String>, Option<String>) {
    let (mut ua, mut referer) = (None, None);
    for part in raw.split('&') {
        let Some(eq) = part.find('=').filter(|e| *e > 0) else {
            continue;
        };
        let key = js::trim(&part[..eq]).to_lowercase();
        let value = safe_decode(js::trim(&part[eq + 1..]));
        if value.is_empty() {
            continue;
        }
        match key.as_str() {
            "user-agent" => ua = Some(value),
            "referer" | "referrer" => referer = Some(value),
            _ => {}
        }
    }
    (ua, referer)
}

const GENERIC_SEGMENTS: [&str; 10] = [
    "index",
    "master",
    "playlist",
    "live",
    "stream",
    "chunklist",
    "variant",
    "manifest",
    "tracks-v1a1",
    "video",
];

fn before_query(url: &str) -> &str {
    url.split('?').next().unwrap_or_default()
}

/// A provider's own path convention for films and episodes, never a channel.
pub fn is_on_demand_url(url: &str) -> bool {
    rx!(i r"/(movie|series)/").is_match(before_query(url))
}

/// Identity of one entry within a source: the panel's stream id, else the url, else the name. Never `tvg-id`.
pub fn derive_external_id(url: &str, name: &str) -> String {
    let path = before_query(url);
    let last = path.rsplit('/').next().unwrap_or_default();
    let last = rx!(i r"\.[a-z0-9]+$").replace(last, "");
    let usable = !last.is_empty()
        && !GENERIC_SEGMENTS.contains(&last.to_lowercase().as_str())
        && rx!(r"^[A-Za-z0-9_.-]+$").is_match(&last);
    if usable {
        last.into_owned()
    } else if !url.is_empty() {
        url.to_owned()
    } else {
        normalize_channel_name(name)
    }
}

struct Pending {
    attrs: BTreeMap<String, String>,
    name: String,
    user_agent: Option<String>,
    referer: Option<String>,
}

/// Unknown directives are skipped: one player-specific line must not cost a whole lineup.
pub fn parse_m3u(text: &str) -> M3uPlaylist {
    let mut entries = vec![];
    let (mut guide_urls, mut max_connections, mut expires_at) = (vec![], None, None);
    let mut pending: Option<Pending> = None;
    let mut pending_group: Option<String> = None;
    let mut seen: HashSet<String> = HashSet::new();
    for raw in text.split('\n') {
        let line = js::trim(raw);
        if line.is_empty() {
            continue;
        }
        if line.starts_with("#EXTM3U") {
            let a = parse_attrs(line);
            let guide = a
                .get("x-tvg-url")
                .filter(|v| !v.is_empty())
                .or(a.get("url-tvg"));
            guide_urls = split_guide_urls(guide.map(String::as_str));
            max_connections = int_or_null(a.get("max-conn").map(String::as_str));
            expires_at = parse_date_attr(a.get("billed-till").map(String::as_str));
        } else if line.starts_with("#EXTINF") {
            pending = Some(Pending {
                attrs: parse_attrs(line),
                name: line
                    .find(',')
                    .map_or(String::new(), |c| js::trim(&line[c + 1..]).to_owned()),
                user_agent: None,
                referer: None,
            });
            pending_group = None;
        } else if line.starts_with("#EXTGRP") {
            let rest = line.find(':').map_or(line, |c| &line[c + 1..]);
            pending_group = Some(js::trim(rest).to_owned()).filter(|g| !g.is_empty());
        } else if let (Some(rest), Some(p)) = (line.strip_prefix("#EXTVLCOPT:"), pending.as_mut()) {
            if let Some(eq) = rest.find('=').filter(|e| *e > 0) {
                let key = js::trim(&rest[..eq]).to_lowercase();
                let value = js::trim(&rest[eq + 1..]);
                if !value.is_empty() {
                    match key.as_str() {
                        "http-user-agent" => p.user_agent = Some(value.to_owned()),
                        "http-referrer" | "http-referer" => p.referer = Some(value.to_owned()),
                        _ => {}
                    }
                }
            }
        } else if let (Some(rest), Some(p)) = (line.strip_prefix("#KODIPROP:"), pending.as_mut()) {
            if let Some(eq) = rest.find('=').filter(|e| *e > 0)
                && js::trim(&rest[..eq]).to_lowercase() == "inputstream.adaptive.stream_headers"
            {
                let (ua, referer) = parse_stream_headers(js::trim(&rest[eq + 1..]));
                p.user_agent = ua.or(p.user_agent.take());
                p.referer = referer.or(p.referer.take());
            }
        } else if line.starts_with('#') {
        } else if let Some(p) = pending.take() {
            let name = if p.name.is_empty() {
                p.attrs.get("tvg-name").cloned().unwrap_or_default()
            } else {
                p.name
            };
            if name.is_empty() {
                continue;
            }
            let external_id = clean(&derive_external_id(line, &name));
            if !seen.insert(external_id.clone()) {
                continue;
            }
            let attr = |k: &str| p.attrs.get(k).filter(|v| !v.is_empty());
            let group = attr("group-title").cloned().or(pending_group.clone());
            let number_raw = p.attrs.get("tvg-chno").or(p.attrs.get("channel-number"));
            entries.push(M3uEntry {
                external_id,
                name: clean(&name),
                url: clean(line),
                logo: attr("tvg-logo").map(|v| clean(v)),
                group_name: clean(&normalize_group_name(group.as_deref())),
                tvg_id: attr("tvg-id").map(|v| clean(v)),
                number: int_or_null(number_raw.map(String::as_str)),
                shift_minutes: shift_minutes(p.attrs.get("tvg-shift").map(String::as_str)),
                user_agent: p.user_agent.map(|v| clean(&v)),
                referer: p.referer.map(|v| clean(&v)),
                attrs: p.attrs,
            });
            pending_group = None;
        }
    }
    M3uPlaylist {
        guide_url: guide_urls.first().cloned(),
        guide_urls,
        max_connections,
        expires_at,
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(lines: &[&str]) -> M3uPlaylist {
        parse_m3u(&lines.join("\n"))
    }

    #[test]
    fn reads_the_header_and_the_usual_attributes() {
        let p = parse(&[
            r#"#EXTM3U x-tvg-url="http://provider/xmltv.php?u=a""#,
            r#"#EXTINF:-1 tvg-id="C1.fr" tvg-name="One" tvg-logo="http://logo/1.png" tvg-chno="7" group-title="News",One FHD"#,
            "http://provider/live/u/p/101.ts",
        ]);
        assert_eq!(
            p.guide_url.as_deref(),
            Some("http://provider/xmltv.php?u=a")
        );
        let e = &p.entries[0];
        assert_eq!(
            (
                e.external_id.as_str(),
                e.name.as_str(),
                e.group_name.as_str()
            ),
            ("101", "One FHD", "News")
        );
        assert_eq!((e.number, e.tvg_id.as_deref()), (Some(7), Some("C1.fr")));
    }

    #[test]
    fn groups_come_from_extgrp_then_the_sentinel() {
        let p = parse(&["#EXTINF:-1,Two", "#EXTGRP:Sport", "http://p/2.ts"]);
        assert_eq!(p.entries[0].group_name, "Sport");
        let p = parse(&["#EXTINF:-1,One", "http://p/1.ts"]);
        assert_eq!(p.entries[0].group_name, "__livetv_ungrouped__");
        let p = parse(&["#EXTGRP:Late", "#EXTINF:-1,One", "http://p/1.ts"]);
        assert_eq!(p.entries[0].group_name, "__livetv_ungrouped__");
    }

    #[test]
    fn shift_is_fractional_hours_in_minutes() {
        let p = parse(&[r#"#EXTINF:-1 tvg-shift="-0.5",Three"#, "http://p/3.ts"]);
        assert_eq!(p.entries[0].shift_minutes, -30);
    }

    #[test]
    fn variants_share_a_tvg_id_but_a_repeated_stream_is_dropped() {
        let p = parse(&[
            r#"#EXTINF:-1 tvg-id="one.fr",One HD"#,
            "http://p/live/u/p/101.ts",
            r#"#EXTINF:-1 tvg-id="one.fr",One FHD"#,
            "http://p/live/u/p/102.ts",
            "#EXTINF:-1,Again",
            "http://p/live/u/p/101.ts",
        ]);
        let ids: Vec<_> = p.entries.iter().map(|e| e.external_id.as_str()).collect();
        assert_eq!(ids, ["101", "102"]);
    }

    #[test]
    fn directives_set_the_entry_headers_and_reset() {
        let p = parse(&[
            "#EXTINF:-1,A",
            "#EXTVLCOPT:http-user-agent=Custom/1.0",
            "#EXTVLCOPT:http-referrer=http://portal.example/",
            "http://p/1.ts",
            "#EXTINF:-1,B",
            "#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=Kodi%2F20&Referer=http%3A%2F%2Fp.example%2F",
            "http://p/2.ts",
            "#EXTINF:-1,C",
            "http://p/3.ts",
        ]);
        let h: Vec<_> = p
            .entries
            .iter()
            .map(|e| (e.user_agent.as_deref(), e.referer.as_deref()))
            .collect();
        assert_eq!(
            h,
            [
                (Some("Custom/1.0"), Some("http://portal.example/")),
                (Some("Kodi/20"), Some("http://p.example/")),
                (None, None)
            ]
        );
    }

    #[test]
    fn account_attributes_of_the_header() {
        for (attrs, conn, exp) in [
            (
                r#"max-conn="2" billed-till="1893456000""#,
                Some(2),
                Some(1_893_456_000),
            ),
            (r#"max-conn="0""#, Some(0), None),
            (r#"billed-till="2029-12-31""#, None, Some(1_893_369_600)),
            (r#"billed-till="not-a-date""#, None, None),
            (r#"billed-till="30""#, None, None),
            ("", None, None),
        ] {
            let p = parse_m3u(&format!("#EXTM3U {attrs}\n#EXTINF:-1,A\nhttp://p/1.ts\n"));
            assert_eq!(p.max_connections, conn, "{attrs}");
            assert_eq!(p.expires_at.map(|d| d.timestamp()), exp, "{attrs}");
        }
    }

    #[test]
    fn external_ids() {
        assert_eq!(derive_external_id("http://h/9.ts", "X"), "9");
        assert_eq!(
            derive_external_id("http://h:8080/live/u/p/4321.m3u8?x=1", "X"),
            "4321"
        );
        assert_eq!(derive_external_id("http://h/", "Canal + HD"), "http://h/");
        assert_eq!(
            derive_external_id("http://a/live/index.m3u8", "One"),
            "http://a/live/index.m3u8"
        );
    }

    #[test]
    fn on_demand_paths() {
        for (url, want) in [
            ("http://h/movie/u/p/1.mp4", true),
            ("http://h/MOVIE/u/p/1.mp4", true),
            ("http://h/live/u/p/1.ts", false),
            ("http://h/movies-catalog/1.ts", false),
        ] {
            assert_eq!(is_on_demand_url(url), want, "{url}");
        }
    }

    #[test]
    fn nul_bytes_never_reach_the_rows() {
        let p = parse(&["#EXTINF:-1,A\0B", "http://p/\u{0}1.ts"]);
        assert_eq!(
            (p.entries[0].name.as_str(), p.entries[0].url.as_str()),
            ("AB", "http://p/1.ts")
        );
    }
}
