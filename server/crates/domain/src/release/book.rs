//! Language and author/title/narrator of an audio or text release name (`docs/spec/release.md` rules 60-61).
use crate::books::filename::{BookNameGuess, parse_path};
use crate::js::rx;
use crate::language::{AppLanguage, app_language_by_iso};
use crate::release::parsing::language::parse_language_with;

pub fn parse_book_language(title: &str) -> Vec<&'static AppLanguage> {
    let t = title.replace(['.', '_', '-'], " ").to_lowercase();
    let mut langs = parse_language_with(title, tag_region_start);
    if rx!(r"\b(fr|francais|français)\b").is_match(&t)
        && let Some(fr) = app_language_by_iso("fr")
        && !langs.contains(&fr)
    {
        langs.insert(0, fr);
    }
    langs
}

fn is_lang(w: &str) -> bool {
    rx!(i r"^(?:fr|french|francais|français|german|deutsch|spanish|italian|english|multi)$")
        .is_match(w)
}

/// Where the tags of a name with no video marker begin: its first bracket group or tag word, else its end.
fn tag_region_start(decoded: &str) -> usize {
    let bracket = decoded.find(['[', '(', '{']);
    let word = rx!(r"[^\s.\-_\[\](){},;+&]+")
        .find_iter(decoded)
        .find(|m| is_tag(m.as_str(), false))
        .map(|m| m.start());
    bracket
        .into_iter()
        .chain(word)
        .min()
        .unwrap_or(decoded.len())
}

/// `digits_unit` is whether a bitrate or bit-depth unit follows, which makes a bare number a tag.
fn is_tag(w: &str, digits_unit: bool) -> bool {
    is_lang(w)
        || rx!(
            i r"^(?:epub|azw3?|kf8|mobi|pdf|fb2|djvu|cbz|ebook|retail|non-?retail|non|audiobook|unabridged|abridged|m4b|m4a|mp3|flac|alac|wav|ogg|vorbis|opus|aac|kbps|kbit|bit|v[0-2]|\d+k(?:bps|bit)?|\d+-?bit)$"
        )
        .is_match(w)
        || (digits_unit && w.bytes().all(|b| b.is_ascii_digit()))
}

fn is_unit(w: &str) -> bool {
    matches!(w.to_lowercase().as_str(), "kbps" | "kbit" | "bit")
}

/// Drops bracketed groups made only of tags, then the trailing run of tags; a run of languages alone stays.
fn strip_tags(s: &str) -> String {
    let split = |g: &str| -> Vec<String> {
        g.split(|c: char| c.is_whitespace() || ",;+&".contains(c))
            .filter(|w| !w.is_empty())
            .map(str::to_owned)
            .collect()
    };
    let tags_only = |ws: &[String]| {
        !ws.is_empty()
            && ws
                .iter()
                .enumerate()
                .all(|(i, w)| is_tag(w, ws.get(i + 1).is_some_and(|n| is_unit(n))))
    };
    let s = rx!(r"[\[\(\{]([^\]\)\}]*)[\]\)\}]").replace_all(s, |c: &regex::Captures| {
        if tags_only(&split(&c[1])) {
            " ".to_owned()
        } else {
            c[0].to_owned()
        }
    });
    let words: Vec<&str> = s.split_whitespace().collect();
    let mut end = words.len();
    while end > 0 && is_tag(words[end - 1], words.get(end).is_some_and(|n| is_unit(n))) {
        end -= 1;
    }
    let all_lang = words[end..].iter().all(|w| is_lang(w));
    words[..if all_lang { words.len() } else { end }].join(" ")
}

/// Best effort: a scene name (`Author.-.Title.2019.EPUB-GRP`) is cut at its first tag and read as a file name.
pub fn parse_book_release_name(title: &str) -> BookNameGuess {
    let title = title
        .trim()
        .replace("kb/s", "kbps")
        .replace("kbit/s", "kbps")
        .replace(['/', '\\'], " ");
    if title.contains(char::is_whitespace) {
        return parse_path(&strip_tags(&title));
    }
    let spaced = title.replace(['.', '_'], " ");
    let tag = rx!(
        i r"^(?:epub|azw3?|kf8|mobi|pdf|ebook|retail|audiobook|m4b|m4a|mp3|flac|ogg|opus|aac|fr|french|francais|\d+k(?:bps)?|(?:19|20)\d\d)(?:-\w+)?$"
    );
    let words: Vec<&str> = spaced.split_whitespace().collect();
    let end = words
        .iter()
        .position(|w| tag.is_match(w))
        .unwrap_or(words.len());
    let year = words[end..]
        .iter()
        .find(|w| rx!(r"^(?:19|20)\d\d(?:-\w+)?$").is_match(w));
    let name = words[..end].join(" ");
    parse_path(&match year {
        Some(y) => format!("{name} ({})", &y[..4]),
        None => name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_code_in_the_work_title_is_not_a_language() {
        for t in [
            "Dan Simmons - Hyperion [EPUB]",
            "Ken Bruen - No Exit [M4B]",
            "La Fin des temps [EPUB]",
        ] {
            let ids: Vec<_> = parse_book_language(t).iter().map(|l| l.id).collect();
            assert_eq!(ids, [crate::language::ENGLISH_LANGUAGE.id], "{t}");
        }
        let tagged = parse_book_language("Some Title [EPUB] [fin]");
        assert_eq!(tagged[0].id, app_language_by_iso("fi").unwrap().id);
    }
}
