//! JavaScript semantics the ported code depends on.
use serde::Deserialize;
use serde_json::{Number, Value};

/// `String.prototype.trim` / `\s` whitespace.
pub fn is_ws(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_ws)
}

/// `Date.prototype.toISOString`: millisecond precision, `Z`.
pub fn iso(t: chrono::DateTime<chrono::Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `Date.now()`.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `Number.prototype.toString` of a JSON number: shortest round-trip digits, never `1.0`.
pub fn number_string(n: &Number) -> String {
    const SAFE: u64 = 1 << 53;
    if let Some(i) = n.as_i64().filter(|i| i.unsigned_abs() <= SAFE) {
        return i.to_string();
    }
    let f = n.as_f64().unwrap_or_default();
    let a = f.abs();
    if f == 0.0 {
        "0".into()
    } else if !(1e-6..1e21).contains(&a) {
        format!("{f:e}").replace('e', "e+").replace("e+-", "e-")
    } else if a < SAFE as f64 {
        f.to_string()
    } else {
        // Past 2^53 JS pads the shortest digits with zeros where Rust prints the exact value.
        let e = format!("{a:e}");
        let (m, exp) = e.split_once('e').unwrap_or((&e, "0"));
        let digits: String = m.chars().filter(|c| *c != '.').collect();
        let len = exp.parse::<usize>().unwrap_or(0) + 1;
        format!("{}{digits:0<len$}", if f < 0.0 { "-" } else { "" })
    }
}

/// `String(v)` of a JSON value.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_string(n),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
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
pub(crate) const WS_CLASS: &str =
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

/// JS `parseInt(raw, 10)`: the leading integer after JS whitespace, `None` for NaN; huge values saturate.
pub fn parse_int(raw: &str) -> Option<i64> {
    let t = trim_start(raw);
    let (neg, digits) = match t.as_bytes().first()? {
        b'-' => (true, &t[1..]),
        b'+' => (false, &t[1..]),
        _ => (false, t),
    };
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    let n: i64 = digits[..end]
        .parse()
        .ok()
        .or((end > 0).then_some(i64::MAX))?;
    Some(if neg { -n } else { n })
}

/// JS `parseFloat`: the longest decimal prefix after JS whitespace (`Infinity` included), `None` for NaN.
pub fn parse_float(raw: &str) -> Option<f64> {
    let t = trim_start(raw);
    let m = rx!(r"^[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)").find(t)?;
    let s = m.as_str();
    match s.trim_start_matches(['+', '-']) {
        "Infinity" if s.starts_with('-') => Some(f64::NEG_INFINITY),
        "Infinity" => Some(f64::INFINITY),
        _ => s.parse().ok(),
    }
}

fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_ws)
}

/// JS `encodeURIComponent`: everything but `A-Za-z0-9-_.!~*'()` is percent-encoded as UTF-8.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `String.prototype.length`: UTF-16 code units.
pub(crate) fn u16len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `^`/`$` under the `m` flag break on `\n`, `\r`, U+2028 and U+2029 (fancy-regex only).
pub(crate) fn multiline(p: &str) -> String {
    const LT: &str = r"[^\n\r\x{2028}\x{2029}]";
    let (mut out, mut in_class, mut chars) = (String::new(), false, p.chars().peekable());
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                out.push(c);
                out.extend(chars.next());
            }
            '[' if !in_class => {
                in_class = true;
                out.push(c);
                if chars.peek() == Some(&'^') {
                    out.extend(chars.next());
                }
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            '^' if !in_class => out.push_str(&format!("(?<!{LT})")),
            '$' if !in_class => out.push_str(&format!("(?!{LT})")),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_number_to_string() {
        let n = |s: &str| number_string(&serde_json::from_str(s).unwrap());
        assert_eq!(n("1.0"), "1");
        assert_eq!(n("0.1"), "0.1");
        assert_eq!(n("1e-6"), "0.000001");
        assert_eq!(n("1.5e-7"), "1.5e-7");
        assert_eq!(n("1e21"), "1e+21");
        assert_eq!(n("9007199254740993"), "9007199254740992");
        assert_eq!(n("1152921504606846976"), "1152921504606847000");
        assert_eq!(n("-1152921504606846976"), "-1152921504606847000");
    }
}
