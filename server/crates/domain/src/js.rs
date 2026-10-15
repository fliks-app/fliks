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
