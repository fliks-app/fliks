//! Subtitle cleaner (`subtitle-cleaner.ts`): ads, custom exclusions and hearing-impaired cues.
use crate::js::{WS_CLASS, fre, multiline, rx, trim, u16len};
use fancy_regex::{Regex, RegexBuilder};
use std::sync::LazyLock;

#[derive(Debug, Clone, Default)]
pub struct CleanOptions {
    pub remove_ads: bool,
    pub remove_hi_tags: bool,
    pub custom_exclusions: Vec<String>,
}

impl CleanOptions {
    pub fn ads() -> Self {
        Self {
            remove_ads: true,
            ..Self::default()
        }
    }
}

const BACKTRACK_LIMIT: usize = 100_000;

/// Case-insensitive exclusions; a blank or invalid pattern is skipped (the count is returned).
pub fn compile_exclusions(patterns: &[String]) -> (Vec<Regex>, usize) {
    let mut skipped = 0;
    let compiled = patterns
        .iter()
        .filter(|p| !trim(p).is_empty())
        .filter_map(|p| {
            // `(?i)` as a prefix: the builder flag does not reach a lookbehind.
            RegexBuilder::new(&format!("(?i){p}"))
                .backtrack_limit(BACKTRACK_LIMIT)
                .build()
                .map_err(|_| skipped += 1)
                .ok()
        })
        .collect();
    (compiled, skipped)
}

static AD_PATTERNS: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| {
    let ns = format!("[^{WS_CLASS}]");
    [
        "opensubtitles".to_owned(),
        "subscene".into(),
        "addic7ed".into(),
        r"sub(s|title)?\s*(by|from|ripped|downloaded)".into(),
        r"sync(ed|hronized)?\s*(by|&|and)\s".into(),
        format!(r"www\.{ns}+\.{ns}+"),
        format!(r"https?://{ns}+"),
        r"support\s+us\s+and\s+become".into(),
        r"advertise\s+your\s+product".into(),
        r"a]?]?[a-zA-Z]*sub[a-zA-Z]*\.(com|org|net|io)".into(),
        r"please\s+rate\s+this\s+subtitle".into(),
        r"captioning\s+sponsored\s+by".into(),
        r"captions\s+(by|copyright|paid)".into(),
    ]
    .iter()
    .map(|p| crate::js::re(p, true))
    .collect()
});

fn hi_spans() -> &'static [regex::Regex; 4] {
    static R: LazyLock<[regex::Regex; 4]> = LazyLock::new(|| {
        [
            r"\[(?s:.){1,300}?\]",
            r"\((?s:.){1,300}?\)",
            r"（(?s:.){1,300}?）",
            r"［(?s:.){1,300}?］",
        ]
        .map(|p| regex::Regex::new(p).expect("static"))
    });
    &R
}

fn is_hi_symbol(c: char) -> bool {
    matches!(
        c,
        '\u{266A}'
            ..='\u{266F}'
                | '¶'
                | '\u{1F3B5}'
                | '\u{1F3B6}'
                | '\u{1F4F1}'
                | '\u{260E}'
                | '\u{260F}'
                | '\u{27A1}'
                | '\u{21D2}'
    )
}

fn label_line() -> &'static Regex {
    static R: LazyLock<Regex> = LazyLock::new(|| {
        fre(
            &multiline(r"^([ \t]*)((?:[-–—][ \t]*)?)([^\n:]{1,30}):(?=[ \t]|$)"),
            false,
        )
    });
    &R
}

fn name_label() -> &'static regex::Regex {
    static R: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^\p{Lu}[\p{L}'’.\-]*(?: \p{Lu}[\p{L}'’.\-]*){0,2}$").expect("static")
    });
    &R
}

fn caps_cue() -> &'static regex::Regex {
    rx!(
        r"\b(LAUGH|CHUCKL|GIGGL|APPLAU|CLAP|CHEER|MUSIC|SONG|SINGING|PLAYING|THEME|SIGH|GASP|GRUNT|GROAN|MOAN|PANT|SCREAM|SHOUT|YELL|WHISPER|MUMBL|MUTTER|SOB|SNIFF|COUGH|SNORE|KNOCK|DOOR|BELL|PHONE|RING|BEEP|BUZZ|SIREN|ALARM|GUNSHOT|GUNFIRE|EXPLOSION|CRASH|BANG|THUD|CLANG|FOOTSTEP|ENGINE|TIRES|HORN|WIND|RAIN|THUNDER|BIRD|DOG|BARK|CLICK|CLATTER|RUSTL|SQUEAK|CREAK|SPLASH|STATIC|INDISTINCT|INAUDIBLE|CHATTER|SPEAKING|CONTINUES|NARRATOR|ANNOUNCER|VOICE|OVER|ON TV|ON RADIO)"
    )
}

fn has_letter(s: &str) -> bool {
    rx!(r"\p{L}").is_match(s)
}

fn has_lower(s: &str) -> bool {
    rx_lower().is_match(s)
}

fn rx_lower() -> &'static regex::Regex {
    static R: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\p{Ll}").expect("static"));
    &R
}

fn is_sound_span(span: &str) -> bool {
    let units: Vec<u16> = span.encode_utf16().collect();
    let inner = String::from_utf16_lossy(&units[1..units.len() - 1]);
    let inner = trim(&inner);
    u16len(inner) >= 2 && rx!(r"[\p{L}\p{N}]").is_match(inner)
}

fn strip_spans_and_symbols(text: &str) -> String {
    let mut out = text.to_owned();
    for re in hi_spans() {
        out = re
            .replace_all(&out, |c: &regex::Captures| {
                if is_sound_span(&c[0]) {
                    String::new()
                } else {
                    c[0].to_owned()
                }
            })
            .into_owned();
    }
    out.chars().filter(|c| !is_hi_symbol(*c)).collect()
}

fn is_caps_label(label: &str) -> bool {
    let upper = rx!(r"[^\p{Lu}]").replace_all(label, "");
    u16len(&upper) >= 2 && !has_lower(label)
}

/// A mixed-case label is only a speaker name when it comes back at least twice.
fn recurring_name_labels(cues: &[String]) -> std::collections::HashSet<String> {
    let mut counts: std::collections::HashMap<String, usize> = Default::default();
    for cue in cues {
        for m in label_line().captures_iter(cue).flatten() {
            let label = trim(&m[3]).to_owned();
            if name_label().is_match(&label) {
                *counts.entry(label).or_default() += 1;
            }
        }
    }
    counts
        .into_iter()
        .filter(|(_, n)| *n >= 2)
        .map(|(l, _)| l)
        .collect()
}

fn strip_labels(text: &str, recurring: &std::collections::HashSet<String>) -> String {
    let mut out = String::new();
    let mut last = 0;
    for m in label_line().captures_iter(text).flatten() {
        let whole = m.get(0).expect("group 0");
        out.push_str(&text[last..whole.start()]);
        let label = trim(&m[3]);
        if is_caps_label(label) || recurring.contains(label) {
            out.push_str(&m[1]);
            out.push_str(&m[2]);
        } else {
            out.push_str(whole.as_str());
        }
        last = whole.end();
    }
    out.push_str(&text[last..]);
    out
}

fn uppercase_ratio(cues: &[String]) -> f64 {
    let (mut total, mut caps) = (0u32, 0u32);
    for line in cues.iter().flat_map(|c| c.split('\n')) {
        if !has_letter(line) {
            continue;
        }
        total += 1;
        if !has_lower(line) {
            caps += 1;
        }
    }
    if total == 0 {
        0.0
    } else {
        f64::from(caps) / f64::from(total)
    }
}

fn is_caps_sound_line(line: &str) -> bool {
    let letters = rx!(r"[^\p{L}]").replace_all(line, "");
    if u16len(&letters) < 4 || has_lower(line) || line.contains(['!', '?']) {
        return false;
    }
    caps_cue().is_match(line)
}

fn tidy(text: &str, shrunk: bool) -> String {
    static EMPTY_TAG: LazyLock<Regex> = LazyLock::new(|| fre(r"<(\w+)[^>]*>\s*</\1>", false));
    let text = EMPTY_TAG.replace_all(text, "");
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|l| trim(&rx!(r"[ \t]{2,}").replace_all(l, " ")).to_owned())
        .filter(|l| !l.is_empty() && !rx!(r"^[～〜~.…\-–—•\s]*$").is_match(l))
        .collect();
    if shrunk && lines.len() == 1 {
        lines[0] = rx!(r"^[-–—][ \t]*").replace(&lines[0], "").into_owned();
    }
    lines.retain(|l| !l.is_empty());
    lines.join("\n")
}

struct Block {
    header: Vec<String>,
    text: String,
    raw: bool,
}

/// Cleans an SRT document (already decoded); ends with one newline.
pub fn clean_subtitle(content: &str, opts: &CleanOptions) -> String {
    let (custom, _) = compile_exclusions(&opts.custom_exclusions);
    let line_break = rx!(r"\r?\n");
    let mut kept: Vec<Block> = vec![];
    for block in rx!(r"\r?\n\r?\n").split(content) {
        let lines: Vec<&str> = line_break.split(block).collect();
        if lines.len() < 2 {
            if !trim(block).is_empty() {
                kept.push(Block {
                    header: vec![],
                    text: block.to_owned(),
                    raw: true,
                });
            }
            continue;
        }
        let text_lines = &lines[2..];
        let joined = text_lines.join(" ");
        let ad = opts.remove_ads && AD_PATTERNS.iter().any(|p| p.is_match(&joined));
        let excluded = !ad && custom.iter().any(|p| p.is_match(&joined).unwrap_or(false));
        if ad || excluded {
            continue;
        }
        kept.push(Block {
            header: lines[..2].iter().map(|s| (*s).to_owned()).collect(),
            text: text_lines.join("\n"),
            raw: false,
        });
    }
    if opts.remove_hi_tags {
        let stripped: Vec<String> = kept
            .iter()
            .map(|b| {
                if b.raw {
                    b.text.clone()
                } else {
                    strip_spans_and_symbols(&b.text)
                }
            })
            .collect();
        let recurring = recurring_name_labels(&stripped);
        let drop_caps = uppercase_ratio(&stripped) < 0.7;
        for (b, s) in kept.iter_mut().zip(&stripped) {
            if b.raw {
                continue;
            }
            let mut text = strip_labels(s, &recurring);
            if drop_caps {
                text = text
                    .split('\n')
                    .filter(|l| !is_caps_sound_line(l))
                    .collect::<Vec<_>>()
                    .join("\n");
            }
            let shrunk = u16len(&text) != u16len(&b.text);
            b.text = tidy(&text, shrunk);
        }
    }
    let mut index = 1;
    let out: Vec<String> = kept
        .into_iter()
        .filter(|b| !trim(&b.text).is_empty())
        .map(|b| {
            if b.raw {
                return b.text;
            }
            let mut header = b.header;
            if rx!(r"^[0-9]+$").is_match(trim(&header[0])) {
                header[0] = index.to_string();
                index += 1;
            }
            header.push(b.text);
            header.join("\n")
        })
        .collect();
    out.join("\n\n") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    // An invalid or backtracking-bound exclusion is skipped, never run unbounded.
    #[test]
    fn a_bad_or_overrunning_exclusion_is_skipped_and_counted() {
        let pats = ["(".to_owned(), "(a+)+$".into(), "good".into()];
        let (compiled, skipped) = compile_exclusions(&pats);
        assert_eq!((compiled.len(), skipped), (2, 1));
        let opts = CleanOptions {
            custom_exclusions: vec!["(a+)+$".into(), "good".into()],
            ..CleanOptions::default()
        };
        let doc = format!(
            "1\n00:00:01,000 --> 00:00:02,000\n{}!\n\n2\n00:00:03,000 --> 00:00:04,000\ngood day\n",
            "a".repeat(40)
        );
        let out = clean_subtitle(&doc, &opts);
        assert!(
            out.contains(&"a".repeat(40)) && !out.contains("good day"),
            "{out}"
        );
    }
}
