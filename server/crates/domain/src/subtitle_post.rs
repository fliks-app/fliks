//! Post-processing actions on subtitle text (`subtitle-post-processor.ts`); each is `&str -> String`.
use crate::js::{fre, multiline, rx, trim};
use crate::subtitle_clean::{CleanOptions, clean_subtitle};
use fancy_regex::Regex;
use std::sync::LazyLock;

pub fn remove_style_tags(content: &str) -> String {
    let no_html = rx!(i r"</?[a-zA-Z][^>]*>").replace_all(content, "");
    rx!(r"\{\\[^}]+\}").replace_all(&no_html, "").into_owned()
}

pub fn remove_emoji(content: &str) -> String {
    content
        .chars()
        .filter(|c| {
            !matches!(*c as u32,
                0x1F600..=0x1F64F | 0x1F300..=0x1F5FF | 0x1F680..=0x1F6FF | 0x1F1E0..=0x1F1FF
                | 0x2600..=0x26FF | 0x2700..=0x27BF | 0xFE00..=0xFE0F | 0x1F900..=0x1F9FF
                | 0x1FA00..=0x1FA6F | 0x1FA70..=0x1FAFF | 0x200D | 0x20E3)
        })
        .collect()
}

pub fn fix_ocr(content: &str) -> String {
    static R: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
        [
            (r"\bl\b(?=[A-Z])", "I"),
            (r"\bln\b", "In"),
            (r"\bIVIr\b", "Mr"),
            (r"\bIVIrs\b", "Mrs"),
            (r"\brn(?=[aeiou])", "m"),
            (r"\b0(?=[a-zA-Z])", "O"),
            (r"(?<=[a-zA-Z])0\b", "O"),
            (r"\|\|", "H"),
            (r"\|(?=[a-z])", "l"),
            (r"\|(?=[A-Z])", "I"),
        ]
        .map(|(p, r)| (fre(p, false), r))
        .to_vec()
    });
    R.iter().fold(content.to_owned(), |acc, (re, rep)| {
        re.replace_all(&acc, *rep).into_owned()
    })
}

pub fn common_fixes(content: &str, language: Option<&str>) -> String {
    static LINE_SPACE: LazyLock<Regex> =
        LazyLock::new(|| fre(&multiline(r"^[ \t]+(?=\r?$)"), false));
    static REPEAT: LazyLock<Regex> = LazyLock::new(|| fre(r"([.!?])\1{3,}", false));
    // French typography keeps a space before ? ! ; :
    let before = if language == Some("fr") {
        rx!(r" +([,.])")
    } else {
        rx!(r" +([,.!?;:])")
    };
    let s = rx!(r"  +").replace_all(content, " ");
    let s = s.replace(". .", "..").replace("....", "...");
    let s = before.replace_all(&s, "$1");
    let s = REPEAT.replace_all(&s, |c: &fancy_regex::Captures<str>| c[1].repeat(3));
    let s = LINE_SPACE.replace_all(&s, "");
    let s = rx!(r"\A(\r?\n)+").replace(&s, "");
    rx!(r"(\r?\n){3,}").replace_all(&s, "$1$1").into_owned()
}

fn blocks(content: &str) -> Vec<&str> {
    rx!(r"\r?\n\r?\n").split(content).collect()
}

fn lines(block: &str) -> Vec<&str> {
    rx!(r"\r?\n").split(block).collect()
}

/// Uppercases the first character, except one outside the BMP (JS `charAt(0)` is a lone surrogate).
fn capitalise(lower: &str) -> String {
    let mut it = lower.chars();
    match it.next() {
        Some(c) if c.len_utf16() == 1 => c.to_uppercase().chain(it).collect(),
        _ => lower.to_owned(),
    }
}

pub fn fix_uppercase(content: &str) -> String {
    let fixed: Vec<String> = blocks(content)
        .into_iter()
        .map(|block| {
            let ls = lines(block);
            if ls.len() < 3 {
                return block.to_owned();
            }
            let text = &ls[2..];
            let fixed: Vec<String> = text
                .iter()
                .enumerate()
                .map(|(i, line)| {
                    let letters: String = line.chars().filter(char::is_ascii_alphabetic).collect();
                    if letters.len() > 1 && !letters.bytes().any(|b| b.is_ascii_lowercase()) {
                        let lower = line.to_lowercase();
                        let starts = i == 0 || rx!(r"[.!?…]\s*$").is_match(text[i - 1]);
                        if starts { capitalise(&lower) } else { lower }
                    } else {
                        (*line).to_owned()
                    }
                })
                .collect();
            [
                &ls[..2],
                &fixed.iter().map(String::as_str).collect::<Vec<_>>()[..],
            ]
            .concat()
            .join("\n")
        })
        .collect();
    fixed.join("\n\n")
}

pub fn reverse_rtl(content: &str) -> String {
    let fixed: Vec<String> = blocks(content)
        .into_iter()
        .map(|block| {
            let ls = lines(block);
            if ls.len() < 3 {
                return block.to_owned();
            }
            let text: Vec<String> = ls[2..]
                .iter()
                .map(|l| {
                    if l.chars().any(|c| matches!(c as u32, 0x590..=0x74F)) {
                        l.chars().rev().collect()
                    } else {
                        (*l).to_owned()
                    }
                })
                .collect();
            let mut out: Vec<&str> = ls[..2].to_vec();
            out.extend(text.iter().map(String::as_str));
            out.join("\n")
        })
        .collect();
    fixed.join("\n\n")
}

fn render(mut ms: i64) -> String {
    let h = ms.div_euclid(3_600_000);
    ms %= 3_600_000;
    let (m, s) = (ms / 60_000, ms % 60_000 / 1000);
    format!("{h:02}:{m:02}:{s:02},{:03}", ms % 1000)
}

fn map_times(content: &str, f: impl Fn(i64) -> i64) -> String {
    rx!(r"([0-9]{2}):([0-9]{2}):([0-9]{2}),([0-9]{3})")
        .replace_all(content, |c: &regex::Captures| {
            let n = |i: usize| c[i].parse::<i64>().unwrap_or(0);
            render(f(n(1) * 3_600_000 + n(2) * 60_000 + n(3) * 1000 + n(4)))
        })
        .into_owned()
}

pub fn adjust_times(content: &str, offset_ms: f64) -> String {
    let offset = crate::js::round(offset_ms) as i64;
    map_times(content, |ms| (ms + offset).max(0))
}

pub fn change_frame_rate(content: &str, from_fps: f64, to_fps: f64) -> String {
    if from_fps <= 0.0 || to_fps <= 0.0 || from_fps == to_fps {
        return content.to_owned();
    }
    let ratio = from_fps / to_fps;
    map_times(content, |ms| crate::js::round(ms as f64 * ratio) as i64)
}

fn ass_time(t: &str) -> String {
    match rx!(r"^([0-9]+):([0-9]{2}):([0-9]{2})\.([0-9]{2})$").captures(t) {
        Some(m) => format!("{:0>2}:{}:{},{}0", &m[1], &m[2], &m[3], &m[4]),
        None => t.to_owned(),
    }
}

/// SRT from the `Dialogue:` lines of an ASS/SSA file; the input unchanged when none is usable.
pub fn ass_to_srt(content: &str) -> String {
    let mut out: Vec<String> = vec![];
    for line in content.split('\n').filter(|l| l.starts_with("Dialogue:")) {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 10 {
            continue;
        }
        let text = parts[9..].join(",").replace("\\N", "\n");
        let text = rx!(r"\{\\[^}]*\}").replace_all(&text, "");
        let text = trim(&text);
        if text.is_empty() {
            continue;
        }
        out.push(format!(
            "{}\n{} --> {}\n{text}",
            out.len() + 1,
            ass_time(trim(parts[1])),
            ass_time(trim(parts[2]))
        ));
    }
    if out.is_empty() {
        content.to_owned()
    } else {
        out.join("\n\n") + "\n"
    }
}

/// `removeHiTags` of the post-processor: the cleaner with HI removal only.
pub fn remove_hi_tags(content: &str) -> String {
    clean_subtitle(
        content,
        &CleanOptions {
            remove_ads: false,
            remove_hi_tags: true,
            custom_exclusions: vec![],
        },
    )
}
