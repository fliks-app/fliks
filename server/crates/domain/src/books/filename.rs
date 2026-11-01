//! Book file and folder name guesses (`books-files.md` rules 29-39), for files without usable metadata.
use crate::js::rx;
use regex::Captures;
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartGuess {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disc: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Absent values are omitted. `confidence` is 0..=95: how much structure backed the guess.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookNameGuess {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub authors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_position: Option<f64>,
    pub narrators: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    /// Set when the file is one part of an audiobook; the rest then describes the book.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<PartGuess>,
    pub confidence: u8,
}

const PARTICLES: [&str; 14] = [
    "de", "du", "des", "del", "della", "di", "da", "la", "le", "les", "van", "von", "der", "den",
];

fn is_particle(w: &str) -> bool {
    PARTICLES.contains(&w.to_lowercase().as_str())
}

/// NFC, typographic apostrophes folded to `'`, whitespace collapsed.
fn tidy(s: &str) -> String {
    let s: String = s
        .nfc()
        .map(|c| {
            if matches!(c, '\u{2019}' | '\u{2018}' | '\u{2bc}' | '\u{b4}' | '`') {
                '\''
            } else {
                c
            }
        })
        .collect();
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn trim_edges(s: &str) -> String {
    s.trim_matches(|c: char| {
        c.is_whitespace()
            || matches!(
                c,
                '-' | '_' | '.' | ',' | ';' | ':' | '\u{2013}' | '\u{2014}'
            )
    })
    .to_owned()
}

fn position(s: &str) -> Option<f64> {
    s.replace(',', ".").parse::<f64>().ok()
}

fn title_case_token(w: &str, first: bool) -> String {
    let mut out = String::new();
    let mut up = true;
    for c in w.chars() {
        if up {
            out.extend(c.to_uppercase());
        } else {
            out.extend(c.to_lowercase());
        }
        up = matches!(c, '-' | '\'');
    }
    if is_particle(&out) && !first {
        return out.to_lowercase();
    }
    if !first && (out.starts_with("D'") || out.starts_with("L'")) {
        out.replace_range(..1, &out[..1].to_lowercase());
    }
    out
}

fn all_upper(w: &str) -> bool {
    let letters: Vec<char> = w.chars().filter(|c| c.is_alphabetic()).collect();
    !letters.is_empty() && letters.iter().all(|c| c.is_uppercase())
}

/// One person: `Last, First` and `LAST First` become `First Last`, an all-caps name is title-cased.
fn clean_author(raw: &str) -> String {
    let s = trim_edges(&tidy(raw));
    let s = match s.split(',').collect::<Vec<_>>()[..] {
        [last, first] if !last.trim().is_empty() && !first.trim().is_empty() => {
            format!("{} {}", first.trim(), last.trim())
        }
        _ => s,
    };
    let mut toks: Vec<String> = s.split_whitespace().map(String::from).collect();
    let caps = |t: &String| all_upper(t) && t.chars().count() >= 2 && !t.contains('.');
    let run = toks.iter().take_while(|t| caps(t)).count();
    let surname = toks.iter().take(run).any(|t| t.chars().count() >= 3);
    if surname && run < toks.len() && toks[run..].iter().any(|t| !all_upper(t)) {
        toks.rotate_left(run);
    }
    toks.iter()
        .enumerate()
        .map(|(i, t)| {
            let long = t.chars().filter(|c| c.is_alphabetic()).count() >= 3 || is_particle(t);
            if all_upper(t) && long && !t.contains('.') {
                title_case_token(t, i == 0)
            } else {
                t.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn split_authors(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for piece in rx!(i r"\s*(?:;|&|\+|\s+et\s+|\s+and\s+|\s+und\s+)\s*").split(&tidy(raw)) {
        let commas: Vec<&str> = piece.split(',').map(str::trim).collect();
        let names = match commas[..] {
            [last, first]
                if !last.contains(' ')
                    || (last.split(' ').any(is_particle) && first.split(' ').count() <= 2) =>
            {
                vec![piece.to_owned()]
            }
            _ => commas.iter().map(|s| (*s).to_owned()).collect(),
        };
        for n in names {
            let n = clean_author(&n);
            if !n.is_empty() && !out.contains(&n) {
                out.push(n);
            }
        }
    }
    out
}

/// Capitalised words (particles and `d'`/`l'` forms allowed inside), no digit, not an article-led title.
fn looks_like_name(s: &str, min_words: usize) -> bool {
    let connector = |w: &str| matches!(w.to_lowercase().as_str(), "&" | "+" | "et" | "and" | "und");
    let words: Vec<&str> = s
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|w| !w.is_empty() && !connector(w))
        .collect();
    let upper = |w: &str| w.chars().next().is_some_and(char::is_uppercase);
    let lead_particle = |w: &str| {
        matches!(
            w,
            "de" | "du" | "del" | "della" | "di" | "da" | "van" | "von" | "der" | "den"
        )
    };
    let elided = |w: &str| {
        let mut c = w.chars();
        matches!(c.next(), Some('d' | 'D' | 'l' | 'L'))
            && c.next() == Some('\'')
            && c.next().is_some()
    };
    let article = |w: &str| {
        matches!(
            w.to_lowercase().as_str(),
            "les" | "un" | "une" | "the" | "an" | "a" | "des" | "mon" | "ma" | "mes"
        )
    };
    (min_words..=6).contains(&words.len())
        && !s.chars().any(|c| c.is_ascii_digit())
        && !words.first().is_some_and(|w| article(w))
        && words.iter().enumerate().all(|(i, w)| {
            upper(w) || (i == 0 && lead_particle(w)) || (i > 0 && (is_particle(w) || elided(w)))
        })
}

fn fold(s: &str) -> Vec<String> {
    let mut v: Vec<String> = s
        .nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect();
    v.sort();
    v
}

fn same_name(a: &str, b: &str) -> bool {
    fold(a) == fold(b)
}

/// `(series, position)` from `Series #3`, `Tome 3`, `Series, Vol. 3`; the series is `None` when only a number.
fn strict_series(s: &str) -> Option<(Option<String>, f64)> {
    let spaced = rx!(r"(\S)#").replace_all(s, "$1 #");
    let c = rx!(i r"^(?:(.*?)\s*,?\s+)?(?:#|(?:tome|vol(?:ume)?|book|livre|t|n°|no\.|n\.)\.?\s*#?)\s*0*(\d+(?:[.,]\d+)?)$")
        .captures(&spaced)?;
    let name = c
        .get(1)
        .map(|m| trim_edges(m.as_str()))
        .filter(|n| !n.is_empty());
    Some((name, position(&c[2])?))
}

fn loose_series(s: &str) -> Option<(String, f64)> {
    if let Some((Some(n), p)) = strict_series(s) {
        return Some((n, p));
    }
    let c = rx!(r"^(.+?)\s+0*(\d{1,3}(?:[.,]\d+)?)$").captures(s)?;
    Some((trim_edges(&c[1]), position(&c[2])?))
}

fn bare_number(s: &str) -> Option<f64> {
    position(
        rx!(r"^0*(\d{1,3}(?:[.,]\d+)?)\.?$")
            .captures(s)?
            .get(1)?
            .as_str(),
    )
}

#[derive(Default)]
struct Parsed {
    title: Option<String>,
    authors: Vec<String>,
    series: Option<String>,
    position: Option<f64>,
    narrators: Vec<String>,
    year: Option<i32>,
    /// `Author - Title` read from two segments, which `Title - Subtitle` and `Title - Author` also are.
    pair: Option<(String, String)>,
}

fn split_names(s: &str) -> Vec<String> {
    rx!(i r"\s*(?:,|&|\s+et\s+|\s+and\s+)\s*")
        .split(s)
        .map(clean_author)
        .filter(|n| !n.is_empty())
        .collect()
}

/// Brackets that carry a narrator, a year or file-format noise leave the name and are returned.
fn strip_markers(s: &str, p: &mut Parsed) -> String {
    let mut s = s.to_owned();
    let narr = rx!(i r"[\[\(\{]\s*(?:narr(?:ator|ated by|\.)?|read by|lu par|narr[éeÉE] par|narrateur|voix)\s*[:.]?\s*([^\]\)\}]+?)\s*[\]\)\}]");
    for c in narr.captures_iter(&s.clone()) {
        p.narrators.extend(split_names(&c[1]));
    }
    s = narr.replace_all(&s, " ").into_owned();
    let braces = rx!(r"\{\s*([^{}]+?)\s*\}");
    for c in braces.captures_iter(&s.clone()) {
        p.narrators.extend(split_names(&c[1]));
    }
    s = braces.replace_all(&s, " ").into_owned();
    let year = rx!(r"[\[\(]\s*((?:1[5-9]|20)\d\d)\s*[\]\)]");
    p.year = year.captures(&s).and_then(|c| c[1].parse().ok());
    s = year.replace_all(&s, " ").into_owned();
    s = rx!(i r"[\[\(]\s*(?:z-?lib(?:rary)?(?:\.\w+)?|libgen[^\]\)]*|epub|mobi|azw3?|pdf|m4b|mp3|ebook|retail|audiobook|livre audio|unabridged|abridged|fr|french|fran[cçCÇ]ais|vf|\d+\s*kbps|b0[0-9A-Za-z]{8}|[^\]\)]*[eéEÉ]dition[^\]\)]*)\s*[\]\)]")
        .replace_all(&s, " ")
        .into_owned();
    p.narrators.dedup();
    tidy(&s)
}

fn parse_name(raw: &str) -> Parsed {
    let mut p = Parsed::default();
    let mut s = tidy(raw);
    if !s.contains(' ') {
        s = s.replace('_', " ");
    }
    let mut s = trim_edges(&strip_markers(&s, &mut p));

    if let Some(c) = rx!(r"^(.*\S)\s*\(([^()]+)\)$").captures(&s.clone()) {
        let inner = c[2].trim();
        let series = strict_series(inner).or_else(|| {
            let m = rx!(r"^(.+?)[,\s]+#?0*(\d{1,3})$").captures(inner)?;
            Some((Some(trim_edges(&m[1])), position(&m[2])?))
        });
        if let Some((name, pos)) = series {
            p.series = name;
            p.position = Some(pos);
            s = trim_edges(&c[1]);
        } else if looks_like_name(inner, 2) {
            p.authors = split_authors(inner);
            s = trim_edges(&c[1]);
        }
    }

    let segs: Vec<String> = rx!(r"\s+[-\x{2013}\x{2014}]\s+")
        .split(&s)
        .map(trim_edges)
        .filter(|t| !t.is_empty())
        .collect();
    match &segs[..] {
        [] => {}
        [one] => {
            if let Some(c) = rx!(r"^0*(\d{1,3})\.\s+(.+)$").captures(one) {
                p.position = position(&c[1]);
                p.title = Some(c[2].to_owned());
            } else {
                p.title = Some(one.clone());
            }
        }
        [a, b] => {
            if let Some(n) = bare_number(a) {
                p.position = Some(n);
                p.title = Some(b.clone());
            } else if let Some((name, n)) = strict_series(a) {
                p.series = p.series.take().or(name);
                p.position = Some(n);
                p.title = Some(b.clone());
            } else if let Some((name, n)) = loose_series(a) {
                p.series = p.series.take().or(Some(name));
                p.position = Some(n);
                p.title = Some(b.clone());
            } else if p.authors.is_empty() && looks_like_name(a, 1) {
                p.authors = split_authors(a);
                p.title = Some(b.clone());
                p.pair = Some((a.clone(), b.clone()));
            } else {
                p.title = Some(format!("{a} - {b}"));
            }
        }
        [a, rest @ ..] => {
            let named = looks_like_name(a, 1) && p.authors.is_empty();
            let joined = |from: usize| rest[from..].join(" - ");
            if let (Some(n), true) = (bare_number(&rest[0]), rest.len() >= 2) {
                p.series = Some(a.clone());
                p.position = Some(n);
                p.title = Some(joined(1));
            } else if named {
                p.authors = split_authors(a);
                let series = loose_series(&rest[0])
                    .filter(|_| rest.len() >= 2)
                    .map(|(s, n)| (s, n, 1));
                let series = series.or_else(|| {
                    let n = bare_number(rest.get(1)?).filter(|_| rest.len() >= 3)?;
                    Some((rest[0].clone(), n, 2))
                });
                if let Some((name, n, from)) = series {
                    p.series = Some(name);
                    p.position = Some(n);
                    p.title = Some(joined(from));
                } else {
                    p.title = Some(joined(0));
                }
            } else {
                p.title = Some(segs.join(" - "));
            }
        }
    }
    p
}

/// A part of an audiobook: `Part 1`, `Track 01`, `01 - Chapter`; plain numbers only for formats made of parts.
fn part_of(stem: &str, multi_part_ext: bool) -> Option<PartGuess> {
    let s = tidy(stem).replace('_', " ");
    let part = |c: Captures, n: usize, t: usize| {
        let title = c
            .get(t)
            .map(|m| trim_edges(m.as_str()))
            .filter(|t| !t.is_empty());
        let title = title.filter(|t| {
            !rx!(i r"^(?:chapter|chapitre|chap\.?|track|piste|part|partie)\s*\d*$").is_match(t)
        });
        Some(PartGuess {
            disc: None,
            number: c[n].parse().ok(),
            title,
        })
    };
    if let Some(c) = rx!(i r"^(?:part|partie|pt|chapter|chapitre|chap|track|piste|disc|disque|cd)\s*\.?\s*0*(\d+)\s*(?:[-\x{2013}:._]\s*(.+))?$").captures(&s) {
        return part(c, 1, 2);
    }
    let c = rx!(r"^0*(\d{1,4})(?:\s*[-\x{2013}._]\s*|\s+)(.+)$").captures(&s);
    if let Some(c) = c {
        let generic =
            rx!(i r"^(?:chapter|chapitre|chap\.?|track|piste|part|partie)\b").is_match(&c[2]);
        return (multi_part_ext || generic).then(|| part(c, 1, 2))?;
    }
    if multi_part_ext {
        let c = rx!(r"^0*(\d{1,4})$").captures(&s)?;
        return part(c, 1, 2);
    }
    None
}

/// A guess from a library-relative path, `/`-separated: the file (or the audiobook folder), then
/// up to two folders above it as `Author` and `Author/Series`.
pub fn parse_path(path: &str) -> BookNameGuess {
    let mut comps: Vec<String> = path
        .replace('\\', "/")
        .split('/')
        .map(tidy)
        .filter(|c| !c.is_empty())
        .collect();
    let Some(last) = comps.pop() else {
        return BookNameGuess::default();
    };
    let ext = rx!(i r"\.(epub|azw3?|mobi|kfx|fb2|pdf|djvu|txt|cbz|cbr|cb7|m4b|m4a|mp3|flac|ogg|oga|opus|wma|aac|wav)$").captures(&last);
    let (stem, ext) = match &ext {
        Some(c) => (
            last[..c.get(0).unwrap().start()].to_owned(),
            c[1].to_lowercase(),
        ),
        None => (last.clone(), String::new()),
    };
    let audio = matches!(
        ext.as_str(),
        "m4b" | "m4a" | "mp3" | "flac" | "ogg" | "oga" | "opus" | "wma" | "aac" | "wav"
    );
    let part = if audio {
        part_of(&stem, ext != "m4b")
    } else {
        None
    };

    let mut guess = BookNameGuess::default();
    let work = if let Some(mut part) = part {
        let disc = rx!(i r"^(?:cd|disc|disk|disque)\s*0*(\d+)$");
        while let Some(c) = comps.last().and_then(|f| disc.captures(f)) {
            part.disc = part.disc.or(c[1].parse().ok());
            comps.pop();
        }
        guess.part = Some(part);
        comps.pop()
    } else {
        Some(stem)
    };
    let parsed = work.as_deref().map(parse_name).unwrap_or_default();
    let ctx: Vec<&String> = comps.iter().rev().take(2).collect();

    let Parsed {
        mut title,
        mut authors,
        mut series,
        position,
        narrators,
        year,
        pair,
    } = parsed;
    let from_name = !authors.is_empty();
    let numbered = position.is_some() && series.is_none();
    let (author_folder, series_folder) = match ctx.as_slice() {
        [] => (None, None),
        [f] if numbered => (None, Some(*f)),
        [f] => (Some(*f), None),
        [inner, outer] => (Some(*outer), Some(*inner)),
        _ => unreachable!(),
    };
    let mut agreed = false;
    if let Some(f) = author_folder {
        let repeats_series =
            series_folder.is_none() && series.as_deref().is_some_and(|s| same_name(s, f));
        let fa = if repeats_series {
            vec![]
        } else {
            split_authors(f)
        };
        let overlap =
            |a: &[String], b: &[String]| a.iter().any(|x| b.iter().any(|y| same_name(x, y)));
        if !fa.is_empty() && from_name && overlap(&fa, &authors) {
            agreed = true;
        } else if let (false, Some((a, b))) = (fa.is_empty(), &pair) {
            if overlap(&fa, &split_authors(b)) {
                title = Some(a.clone());
                agreed = true;
            } else {
                title = Some(format!("{a} - {b}"));
            }
            authors = fa;
        } else if !from_name {
            authors = fa;
        }
    }
    if let (Some(f), true) = (series_folder, series.is_none()) {
        let bare = rx!(r"\s*\(\d+\)$").replace(f, "");
        let own = title.as_deref().is_some_and(|t| same_name(&bare, t))
            || authors.iter().any(|a| same_name(&bare, a));
        if numbered || !own {
            series = Some(f.clone());
        }
    }

    let mut confidence = 0u8;
    if title.is_some() {
        confidence += 40;
    }
    if !authors.is_empty() {
        confidence += if agreed { 45 } else { 30 };
    }
    if series.is_some() && position.is_some() {
        confidence += 10;
    }
    guess.title = title;
    guess.authors = authors;
    guess.series = series;
    guess.series_position = position;
    guess.narrators = narrators;
    guess.year = year;
    guess.confidence = confidence.min(95);
    guess
}
