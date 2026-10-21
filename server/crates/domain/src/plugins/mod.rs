//! Pure plugin-host rules (`docs/spec/plugins.md`): route matching, policy vocabulary, guards.
pub use fliks_plugin_route as route;

use crate::acl::{Action, Subject};
use std::collections::BTreeSet;

/// Rule 8: `<action>:<Subject>` split at the first `:`; plugin subjects only when declared.
pub fn parse_policy(policy: &str, declared: &BTreeSet<String>) -> Option<(Action, Subject)> {
    let (action, subject) = policy.split_once(':')?;
    let action: Action = action.parse().ok()?;
    let core = match subject {
        "User" => Some(Subject::User),
        "Media" => Some(Subject::Media),
        "FliksRequest" => Some(Subject::FliksRequest),
        "QualityProfile" => Some(Subject::QualityProfile),
        "LanguageProfile" => Some(Subject::LanguageProfile),
        "SubtitleProvider" => Some(Subject::SubtitleProvider),
        "SubtitleFile" => Some(Subject::SubtitleFile),
        "TranslationProvider" => Some(Subject::TranslationProvider),
        "Library" => Some(Subject::Library),
        "Playlist" => Some(Subject::Playlist),
        "Settings" => Some(Subject::Settings),
        _ => None,
    };
    match core {
        Some(s) => Some((action, s)),
        None if declared.contains(subject) => Some((action, Subject::Plugin(subject.to_owned()))),
        None => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectGuard {
    MediaAccessible,
    LibraryAccessible,
}

/// `<guard>:<param>` with exactly one `:`.
pub fn parse_object_guard(spec: &str) -> Option<(ObjectGuard, &str)> {
    let mut parts = spec.split(':');
    let (g, p) = (parts.next()?, parts.next()?);
    if parts.next().is_some() || p.is_empty() {
        return None;
    }
    let g = match g {
        "mediaAccessible" => ObjectGuard::MediaAccessible,
        "libraryAccessible" => ObjectGuard::LibraryAccessible,
        _ => return None,
    };
    Some((g, p))
}

/// `^[1-9][0-9]*$` within `Number.MAX_SAFE_INTEGER`.
pub fn positive_int(raw: &str) -> Option<i64> {
    let ok = raw.starts_with(|c: char| ('1'..='9').contains(&c))
        && raw.bytes().all(|b| b.is_ascii_digit());
    let n: i64 = if ok { raw.parse().ok()? } else { return None };
    (n <= 9_007_199_254_740_991).then_some(n)
}

/// `^[a-z][a-z0-9_-]{0,63}$`.
pub fn legal_permission_name(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_lowercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// `^[a-z][a-z0-9]*(\.[a-z0-9]+)*$`, at most 51 chars.
pub fn legal_plugin_id(id: &str) -> bool {
    id.len() <= 51
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id.split('.').all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

/// Rule 38: the proxy's response header allowlist and name/value filters.
pub fn response_header(name: &str, value: &str) -> Option<Vec<u8>> {
    const ALLOWED: [&str; 5] = [
        "content-type",
        "content-disposition",
        "cache-control",
        "etag",
        "last-modified",
    ];
    let token = !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b));
    if !token || !ALLOWED.contains(&name.to_ascii_lowercase().as_str()) {
        return None;
    }
    // A header value is written as Latin-1; controls and characters above U+00FF are refused.
    value
        .chars()
        .map(|c| match u32::from(c) {
            0x09 | 0x20..=0x7e | 0x80..=0xff => Some(c as u8),
            _ => None,
        })
        .collect()
}

/// Rule 8: a literal path a core `/api/plugins/:id/...` route shadows.
pub fn shadowed_by_core(method: &str, path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    let p = p.strip_suffix('/').unwrap_or(&p);
    match method.to_ascii_uppercase().as_str() {
        "GET" => matches!(p, "/logo" | "/export"),
        "POST" => matches!(
            p,
            "/import" | "/enable" | "/disable" | "/restart" | "/events/test"
        ),
        _ => false,
    }
}

/// Rule 24: the installed id owning `plugin.<id>.<key>` is the longest matching id.
pub fn setting_owner<'a>(key: &str, ids: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let rest = key.strip_prefix("plugin.")?;
    ids.into_iter()
        .filter(|id| rest.strip_prefix(id).is_some_and(|r| r.starts_with('.')))
        .max_by_key(|id| id.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positive_ints() {
        for ok in ["1", "42"] {
            assert!(positive_int(ok).is_some());
        }
        for bad in [
            "0", "-1", "1.5", "1e3", "01", "0x1", " 1 ", "", "1abc", "NaN",
        ] {
            assert!(positive_int(bad).is_none(), "{bad}");
        }
        assert!(positive_int(&"1".repeat(40)).is_none());
        assert!(positive_int("9007199254740992").is_none());
    }

    #[test]
    fn guards_and_policies() {
        assert_eq!(
            parse_object_guard("mediaAccessible:id"),
            Some((ObjectGuard::MediaAccessible, "id"))
        );
        for bad in [
            "deleteEverything:id",
            "mediaAccessible",
            "mediaAccessible:",
            "mediaAccessible:id:x",
            "",
        ] {
            assert!(parse_object_guard(bad).is_none());
        }
        let d: BTreeSet<String> = ["plugin:a:queue".to_owned()].into();
        assert!(parse_policy("read:plugin:a:queue", &d).is_some());
        assert!(parse_policy("read:plugin:b:queue", &d).is_none());
        assert!(parse_policy("read:Settings", &d).is_some());
        assert!(parse_policy("read:LiveTvChannel", &d).is_none());
        assert!(parse_policy("frob:Settings", &d).is_none());
    }

    #[test]
    fn owner_and_shadow() {
        let ids = ["fliks", "fliks.download"];
        assert_eq!(
            setting_owner("plugin.fliks.download.k", ids),
            Some("fliks.download")
        );
        assert_eq!(setting_owner("plugin.fliks.k", ids), Some("fliks"));
        assert_eq!(setting_owner("plugin.fliksx.k", ids), None);
        assert!(shadowed_by_core("get", "/LOGO/") && shadowed_by_core("POST", "/events/test"));
        assert!(!shadowed_by_core("GET", "/:page") && !shadowed_by_core("POST", "/logo"));
        assert!(
            legal_plugin_id("fliks.download")
                && !legal_plugin_id("a..b")
                && !legal_plugin_id(&"a".repeat(52))
        );
    }
}
