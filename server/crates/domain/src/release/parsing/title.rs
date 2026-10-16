//! Title and year of a raw release or file name (`title.extractor.ts`, `decode-html-entities.ts`).
use crate::js::rx;
use crate::media::VIDEO_EXTS;
use crate::release::parsing::season_episode::parse_season_episode;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedRelease {
    pub search_key: String,
    pub title: String,
    pub year: Option<u32>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub is_full_season: bool,
    pub kind: &'static str,
}

const NAMED: [(&str, char); 102] = [
    ("amp", '&'),
    ("lt", '<'),
    ("gt", '>'),
    ("apos", '\''),
    ("quot", '"'),
    ("nbsp", ' '),
    ("iexcl", '¡'),
    ("cent", '¢'),
    ("pound", '£'),
    ("yen", '¥'),
    ("sect", '§'),
    ("copy", '©'),
    ("reg", '®'),
    ("deg", '°'),
    ("plusmn", '±'),
    ("sup2", '²'),
    ("sup3", '³'),
    ("micro", 'µ'),
    ("para", '¶'),
    ("middot", '·'),
    ("sup1", '¹'),
    ("frac14", '¼'),
    ("frac12", '½'),
    ("frac34", '¾'),
    ("iquest", '¿'),
    ("Agrave", 'À'),
    ("Aacute", 'Á'),
    ("Acirc", 'Â'),
    ("Atilde", 'Ã'),
    ("Auml", 'Ä'),
    ("Aring", 'Å'),
    ("AElig", 'Æ'),
    ("Ccedil", 'Ç'),
    ("Egrave", 'È'),
    ("Eacute", 'É'),
    ("Ecirc", 'Ê'),
    ("Euml", 'Ë'),
    ("Igrave", 'Ì'),
    ("Iacute", 'Í'),
    ("Icirc", 'Î'),
    ("Iuml", 'Ï'),
    ("ETH", 'Ð'),
    ("Ntilde", 'Ñ'),
    ("Ograve", 'Ò'),
    ("Oacute", 'Ó'),
    ("Ocirc", 'Ô'),
    ("Otilde", 'Õ'),
    ("Ouml", 'Ö'),
    ("Oslash", 'Ø'),
    ("Ugrave", 'Ù'),
    ("Uacute", 'Ú'),
    ("Ucirc", 'Û'),
    ("Uuml", 'Ü'),
    ("Yacute", 'Ý'),
    ("THORN", 'Þ'),
    ("szlig", 'ß'),
    ("agrave", 'à'),
    ("aacute", 'á'),
    ("acirc", 'â'),
    ("atilde", 'ã'),
    ("auml", 'ä'),
    ("aring", 'å'),
    ("aelig", 'æ'),
    ("ccedil", 'ç'),
    ("egrave", 'è'),
    ("eacute", 'é'),
    ("ecirc", 'ê'),
    ("euml", 'ë'),
    ("igrave", 'ì'),
    ("iacute", 'í'),
    ("icirc", 'î'),
    ("iuml", 'ï'),
    ("eth", 'ð'),
    ("ntilde", 'ñ'),
    ("ograve", 'ò'),
    ("oacute", 'ó'),
    ("ocirc", 'ô'),
    ("otilde", 'õ'),
    ("ouml", 'ö'),
    ("oslash", 'ø'),
    ("ugrave", 'ù'),
    ("uacute", 'ú'),
    ("ucirc", 'û'),
    ("uuml", 'ü'),
    ("yacute", 'ý'),
    ("thorn", 'þ'),
    ("yuml", 'ÿ'),
    ("OElig", 'Œ'),
    ("oelig", 'œ'),
    ("Scaron", 'Š'),
    ("scaron", 'š'),
    ("Yuml", 'Ÿ'),
    ("ldquo", '“'),
    ("rdquo", '”'),
    ("lsquo", '‘'),
    ("rsquo", '’'),
    ("bdquo", '„'),
    ("hellip", '…'),
    ("ndash", '–'),
    ("mdash", '—'),
    ("trade", '™'),
    ("euro", '€'),
];

/// `parseInt(digits, radix)`: the leading valid digits, saturated past the code point range.
fn parse_code(digits: &str, radix: u32) -> Option<u32> {
    let mut code: Option<u32> = None;
    for d in digits.chars().map_while(|c| c.to_digit(radix)) {
        let v = code.unwrap_or(0).saturating_mul(radix).saturating_add(d);
        code = Some(v.min(0x11_0000));
    }
    code
}

pub fn decode_html_entities(s: &str) -> String {
    rx!(r"&(?:#(x?)([0-9a-fA-F]+)|([a-zA-Z]+));")
        .replace_all(s, |m: &regex::Captures| {
            let raw = m[0].to_owned();
            if let Some(digits) = m.get(2) {
                let radix = if m[1].is_empty() { 10 } else { 16 };
                return match parse_code(digits.as_str(), radix) {
                    Some(c @ 1..=0x10_FFFF) => char::from_u32(c).unwrap_or('\u{FFFD}').to_string(),
                    _ => raw,
                };
            }
            NAMED
                .iter()
                .find(|(n, _)| *n == &m[3])
                .map_or(raw, |(_, c)| c.to_string())
        })
        .into_owned()
}

fn prettify(raw: &str) -> String {
    let s = rx!(r"[._]+").replace_all(raw, " ");
    let s = rx!(r"\s*\(?\b(?:19|20)\d{2}\)?\s*$").replace(&s, "");
    let s = rx!(r"[()\[\]{}]").replace_all(&s, " ");
    let s = rx!(r"\s+").replace_all(&s, " ");
    let s = rx!(r"^[\s\-:]+|[\s\-:]+$").replace_all(&s, "");
    crate::js::trim(&s).to_owned()
}

fn years(s: &str) -> impl Iterator<Item = u32> {
    rx!(r"\b((?:19|20)\d{2})\b")
        .captures_iter(s)
        .map(|m| m[1].parse().expect("4 digits"))
}

pub fn extract_media_title(raw_name: &str) -> ExtractedRelease {
    let decoded = decode_html_entities(raw_name);
    let mut decoded = rx!(i r"\.torrent$").replace(&decoded, "").into_owned();
    if let Some(dot) = decoded.rfind('.')
        && dot > 0
        && VIDEO_EXTS.contains(&decoded[dot..].to_lowercase().as_str())
    {
        decoded.truncate(dot);
    }
    let se = parse_season_episode(&decoded);

    let cut = rx!(i r"\b(?:S\d{1,2}(?:E\d{1,3})?|Season[\s._-]?\d{1,2}|\d{1,2}x\d{1,3}|Complete[\s._-]?(?:Series|S\d{1,2}))\b")
        .find(&decoded)
        .map(|m| m.start());
    let year = match cut {
        Some(c) => years(&decoded[..c]).next(),
        None => years(&decoded).next(),
    };
    let slot = match (cut, year) {
        (Some(c), _) => &decoded[..c],
        (None, Some(y)) => {
            let at = regex::Regex::new(&format!(r"(?-u:\b){y}(?-u:\b)")).expect("year pattern");
            at.find(&decoded)
                .map_or(decoded.as_str(), |m| &decoded[..m.start()])
        }
        (None, None) => {
            let meta = rx!(i r"\b(?:2160p|1080p|720p|480p|4K|UHD|BluRay|BDRip|WEB-?DL|WEB-?Rip|HDTV|DVDRip|REMUX|x264|x265|HEVC|H[\s._]?264|H[\s._]?265|AV1|VP9|DTS|AC3|AAC|TrueHD|HDR|DV|HDR10|Atmos|MA|5\.1|7\.1)\b");
            meta.find(&decoded)
                .map_or(decoded.as_str(), |m| &decoded[..m.start()])
        }
    };

    let title = prettify(slot);
    let search_key = title
        .to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    let kind = if se.season.is_some() {
        "series"
    } else if year.is_some() && cut.is_none() {
        "movie"
    } else {
        "unknown"
    };
    ExtractedRelease {
        search_key,
        title,
        year,
        season: se.season,
        episode: se.episode,
        is_full_season: se.is_full_season,
        kind,
    }
}
