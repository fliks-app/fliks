//! `log` import plus `info!`-style macros (SDK-10): one line per call, credentials scrubbed.

pub use crate::bindings::fliks::plugin::log::Level;

pub fn log(level: Level, message: &str) {
    let line = scrub(message);
    #[cfg(target_arch = "wasm32")]
    crate::bindings::fliks::plugin::log::log(level, &line);
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{level:?} {line}");
}

/// Every `scheme://user:pass@` becomes `scheme://***:***@`, and line breaks become spaces.
pub fn scrub(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail
            .find(|c: char| c.is_whitespace() || c == '/' || c == '@')
            .unwrap_or(tail.len());
        let user = &tail[..end];
        let credentials = user
            .char_indices()
            .any(|(j, c)| c == ':' && j > 0 && j < end - 1);
        if credentials && tail[end..].starts_with('@') {
            out.push_str("***:***@");
            rest = &tail[end + 1..];
        } else {
            rest = tail;
        }
    }
    out.push_str(rest);
    out.replace(['\r', '\n'], " ")
}

/// `url` without its userinfo, query and fragment, for logs and stored errors.
pub fn redact_url(url: &str) -> String {
    let url = &url[..url.find(['?', '#']).unwrap_or(url.len())];
    let Some(i) = url.find("://") else {
        return url.to_owned();
    };
    let (scheme, rest) = url.split_at(i + 3);
    let authority = &rest[..rest.find('/').unwrap_or(rest.len())];
    match authority.rfind('@') {
        Some(at) => format!("{scheme}{}", &rest[at + 1..]),
        None => url.to_owned(),
    }
}

#[macro_export]
macro_rules! debug {
    ($($t:tt)*) => { $crate::log::log($crate::log::Level::Debug, &format!($($t)*)) };
}
#[macro_export]
macro_rules! info {
    ($($t:tt)*) => { $crate::log::log($crate::log::Level::Info, &format!($($t)*)) };
}
#[macro_export]
macro_rules! warn {
    ($($t:tt)*) => { $crate::log::log($crate::log::Level::Warn, &format!($($t)*)) };
}
#[macro_export]
macro_rules! error {
    ($($t:tt)*) => { $crate::log::log($crate::log::Level::Error, &format!($($t)*)) };
}

#[cfg(test)]
mod tests {
    use super::{redact_url, scrub};

    #[test]
    fn scrubs_credentials() {
        assert_eq!(
            scrub("pg://fp_1:secret@db/x\nnext\r\nhttp://a:b@h and https://u:p@q"),
            "pg://***:***@db/x next  http://***:***@h and https://***:***@q"
        );
        for kept in [
            "http://host:8080/a@b",
            "http://:p@h",
            "http://u:@h",
            "a://b",
            "x://",
        ] {
            assert_eq!(scrub(kept), kept);
        }
        assert_eq!(scrub("é://ü:ß@h"), "é://***:***@h");
    }

    #[test]
    fn redacts_urls() {
        assert_eq!(
            redact_url("https://u:p@idx.lan:9117/api?apikey=s#f"),
            "https://idx.lan:9117/api"
        );
        assert_eq!(redact_url("http://h/p@x?q"), "http://h/p@x");
        assert_eq!(redact_url("http://tok@h"), "http://h");
        assert_eq!(redact_url("not a url?k=v"), "not a url");
    }
}
