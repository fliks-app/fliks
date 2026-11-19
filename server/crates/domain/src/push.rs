//! Push notification vocabulary, English fallback text and plaintext sizing (`docs/spec/push.md`).
use serde_json::{Map, Value};

pub const CATEGORIES: [&str; 5] = ["requests", "parties", "social", "episodes", "account"];
pub const PLUGIN_PREFIX: &str = "plugin.";
/// The relay refuses a payload above 2700 bytes; the RFC 8291 record adds 103.
pub const PLAINTEXT_MAX: usize = 2500;
pub const LOCALES: [&str; 6] = ["en", "fr", "de", "es", "it", "pt"];

pub fn is_category(c: &str) -> bool {
    CATEGORIES.contains(&c)
        || c.strip_prefix(PLUGIN_PREFIX)
            .is_some_and(|id| !id.is_empty())
}

/// The supported language of a tag (`fr-CA` gives `fr`), English otherwise.
pub fn locale(tag: &str) -> &'static str {
    let base = tag.split(['-', '_']).next().unwrap_or_default();
    LOCALES
        .into_iter()
        .find(|l| l.eq_ignore_ascii_case(base))
        .unwrap_or("en")
}

/// English text of a `push.<path>`; `None` for an unknown path.
pub fn english(path: &str) -> Option<&'static str> {
    Some(match path {
        "request_approved.title" => "Request approved",
        "request_approved.body" => "{{title}} was approved",
        "request_declined.title" => "Request declined",
        "request_declined.body" => "{{title}} was declined",
        "request_available.title" => "Now available",
        "request_available.body" => "{{title}} is ready to watch",
        "request_created.title" => "New request",
        "request_created.body" => "{{user}} requested {{title}}",
        "party_invited.title" => "Watch party invitation",
        "party_invited.body" => "{{host}} invited you to {{party}}",
        "party_starting.title" => "Watch party starting",
        "party_starting.body" => "{{party}} is starting",
        "follow_request.title" => "Follow request",
        "follow_request.body" => "{{user}} wants to follow you",
        "follow_accepted.title" => "Follow request accepted",
        "follow_accepted.body" => "{{user}} accepted your request",
        "content_recommended.title" => "New recommendation",
        "content_recommended.body" => "{{user}} recommends {{title}}",
        "episode_one.title" => "New episode",
        "episode_one.body" => "{{title}} {{episode}}",
        "episodes_many.title" => "New episodes",
        "episodes_many.body" => "{{title}} {{season}}: {{count}} new episodes",
        "episodes_series.title" => "New episodes",
        "episodes_series.body" => "{{title}}: {{count}} new episodes",
        "pairing_requested.title" => "Sign-in request",
        "pairing_requested.body" => "{{device}} wants to sign in to your account",
        "test.title" => "Test notification",
        "test.body" => "Notifications work on this device",
        "action.approve" => "Approve",
        "action.decline" => "Decline",
        "action.join" => "Join",
        "action.accept" => "Accept",
        "action.open" => "Open",
        _ => return None,
    })
}

/// ngx-translate interpolation: `{{name}}`, spaces inside the braces allowed; an unknown name stays as written.
pub fn interpolate(template: &str, params: &Map<String, Value>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let name = after[..end].trim();
        match params.get(name) {
            Some(Value::String(s)) => out.push_str(s),
            Some(Value::Null) | None => out.push_str(&rest[start..start + 2 + end + 2]),
            Some(v) => out.push_str(&v.to_string()),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

/// Cuts `s` to at most `max` bytes on a character boundary, with an ellipsis when it was cut.
pub fn truncate(s: &mut String, max: usize) {
    if s.len() <= max {
        return;
    }
    let keep = max.saturating_sub('\u{2026}'.len_utf8());
    let mut end = keep;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push('\u{2026}');
}

/// Shortens `body`, then `title`, until `size(title, body)` fits `max`.
pub fn fit(title: &mut String, body: &mut String, max: usize, size: impl Fn(&str, &str) -> usize) {
    let total = size(title, body);
    if total <= max {
        return;
    }
    let over = total - max;
    let target = body.len().saturating_sub(over);
    truncate(body, target.max(1));
    let total = size(title, body);
    if total > max {
        let target = title.len().saturating_sub(total - max);
        truncate(title, target.max(1));
    }
}

/// `S02E03`.
pub fn episode_code(season: i64, episode: i64) -> String {
    format!("S{season:02}E{episode:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn params(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn locale_takes_the_base_language() {
        assert_eq!(locale("fr-CA"), "fr");
        assert_eq!(locale("PT_br"), "pt");
        assert_eq!(locale("ja"), "en");
        assert_eq!(locale(""), "en");
    }

    #[test]
    fn interpolates_known_names_only() {
        let p = params(json!({"title": "A", "n": 3}));
        assert_eq!(
            interpolate("{{ title }} x{{n}} {{gone}}", &p),
            "A x3 {{gone}}"
        );
        assert_eq!(interpolate("open {{", &p), "open {{");
    }

    #[test]
    fn every_catalogue_key_has_both_texts() {
        for k in [
            "request_approved",
            "request_declined",
            "request_available",
            "request_created",
            "party_invited",
            "party_starting",
            "follow_request",
            "follow_accepted",
            "content_recommended",
            "episode_one",
            "episodes_many",
            "episodes_series",
            "pairing_requested",
            "test",
        ] {
            assert!(english(&format!("{k}.title")).is_some(), "{k}");
            assert!(english(&format!("{k}.body")).is_some(), "{k}");
        }
    }

    #[test]
    fn fit_cuts_the_body_first_on_a_char_boundary() {
        let mut t = "Title".to_owned();
        let mut b = "\u{00e9}".repeat(400);
        fit(&mut t, &mut b, 300, |t, b| t.len() + b.len());
        assert_eq!(t, "Title");
        assert!(t.len() + b.len() <= 300);
        assert!(b.ends_with('\u{2026}'));
    }

    #[test]
    fn fit_cuts_the_title_when_the_body_is_not_enough() {
        let mut t = "T".repeat(200);
        let mut b = "b".to_owned();
        fit(&mut t, &mut b, 50, |t, b| t.len() + b.len());
        assert!(t.len() + b.len() <= 50);
    }
}
