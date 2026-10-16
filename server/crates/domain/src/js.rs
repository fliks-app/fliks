//! JavaScript semantics the ported code depends on.
use serde::Deserialize;

/// `String.prototype.trim` / `\s` whitespace.
pub(crate) fn is_ws(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(is_ws)
}

/// `Math.round`: halves toward +infinity.
pub(crate) fn round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// For `Option<Option<T>>` fields: absent is `None`, an explicit null is `Some(None)`.
pub(crate) fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// The JS `\s` set as regex class contents.
const WS_CLASS: &str =
    r"\x09-\x0D \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// ASCII `\b` for `fancy_regex`, which has no `(?-u:\b)`.
const FANCY_BOUNDARY: &str =
    r"(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))";

/// Rewrites a JS (non-`u`) pattern into Rust syntax: ASCII `\d` and `\b`, the JS `\s` set,
/// and with `icase` every ASCII letter outside a class as `[xX]` (no `K`/`ſ` folding).
pub(crate) fn translate(p: &str, icase: bool, fancy: bool) -> String {
    let mut out = String::with_capacity(p.len() * 2);
    let (mut chars, mut in_class) = (p.chars(), false);
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('d') if in_class => out.push_str("0-9"),
                Some('d') => out.push_str("[0-9]"),
                Some('s') if in_class => out.push_str(WS_CLASS),
                Some('s') => out.push_str(&format!("[{WS_CLASS}]")),
                Some('b') if fancy => out.push_str(FANCY_BOUNDARY),
                Some('b') => out.push_str(r"(?-u:\b)"),
                Some(n) => {
                    out.push('\\');
                    out.push(n);
                }
                None => out.push('\\'),
            },
            '[' if !in_class => {
                in_class = true;
                out.push(c);
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            c if icase && !in_class && c.is_ascii_alphabetic() => {
                out.push_str(&format!(
                    "[{}{}]",
                    c.to_ascii_lowercase(),
                    c.to_ascii_uppercase()
                ));
            }
            c => out.push(c),
        }
    }
    out
}

pub(crate) fn re(p: &str, icase: bool) -> regex::Regex {
    regex::Regex::new(&translate(p, icase, false)).expect("static pattern")
}

pub(crate) fn fre(p: &str, icase: bool) -> fancy_regex::Regex {
    fancy_regex::Regex::new(&translate(p, icase, true)).expect("static pattern")
}

/// A lazily compiled JS pattern: `rx!(p)`, `rx!(i p)`, `rx!(fancy p)`, `rx!(fancy i p)`.
macro_rules! rx {
    (fancy i $p:expr) => {{
        static R: std::sync::LazyLock<fancy_regex::Regex> =
            std::sync::LazyLock::new(|| $crate::js::fre($p, true));
        &*R
    }};
    (fancy $p:expr) => {{
        static R: std::sync::LazyLock<fancy_regex::Regex> =
            std::sync::LazyLock::new(|| $crate::js::fre($p, false));
        &*R
    }};
    (i $p:expr) => {{
        static R: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| $crate::js::re($p, true));
        &*R
    }};
    ($p:expr) => {{
        static R: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| $crate::js::re($p, false));
        &*R
    }};
}
pub(crate) use rx;
