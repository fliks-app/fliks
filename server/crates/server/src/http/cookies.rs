//! `fliks_access` cookie: raw `Cookie` parsing like `request-cookie.util.ts`, attributes like `cookie-opts.util.ts`.
use axum::http::{HeaderMap, header};
use std::time::{SystemTime, UNIX_EPOCH};

pub const ACCESS_COOKIE: &str = "fliks_access";

const NATIVE_ORIGINS: [&str; 3] = [
    "https://localhost",
    "capacitor://localhost",
    "http://localhost",
];

/// First `name=` segment over every `Cookie` header (joined with `; `): `None` when absent, `Some("")`
/// when present and empty. The value is percent-decoded, or kept raw when it is not valid.
pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    headers
        .get_all(header::COOKIE)
        .iter()
        // Lossy, not to_str: one non-ASCII cookie from another app must not hide ours (Node reads latin1).
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .find_map(|h| {
            h.split(';')
                .find_map(|seg| seg.trim().strip_prefix(&prefix).map(decode_uri_component))
        })
}

/// JS `decodeURIComponent` with the raw fallback of `parseCookieValue`.
fn decode_uri_component(raw: &str) -> String {
    let b = raw.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'%' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let hex = b
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok());
        match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
            Some(v) => out.push(v),
            None => return raw.to_owned(),
        }
        i += 3;
    }
    String::from_utf8(out).unwrap_or_else(|_| raw.to_owned())
}

/// JS `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
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

/// Behind the engine gateway TLS ends upstream: `X-Forwarded-Proto`, first comma-separated value.
pub fn is_secure(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("https")
        })
}

fn same_site(headers: &HeaderMap, secure: bool) -> &'static str {
    let native = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|o| NATIVE_ORIGINS.contains(&o));
    if native && secure { "None" } else { "Lax" }
}

/// `Set-Cookie` for a fresh access token; `max_age_secs` is the token lifetime (F7).
pub fn access_cookie(headers: &HeaderMap, token: &str, max_age_secs: u64) -> String {
    access_cookie_at(headers, token, max_age_secs, SystemTime::now())
}

fn access_cookie_at(
    headers: &HeaderMap,
    token: &str,
    max_age_secs: u64,
    now: SystemTime,
) -> String {
    let secure = is_secure(headers);
    let expires = httpdate::fmt_http_date(now + std::time::Duration::from_secs(max_age_secs));
    format!(
        "{ACCESS_COOKIE}={}; Max-Age={max_age_secs}; Path=/; Expires={expires}; HttpOnly{}; SameSite={}",
        encode_uri_component(token),
        if secure { "; Secure" } else { "" },
        same_site(headers, secure),
    )
}

/// `Set-Cookie` that clears the cookie exactly as Express's `clearCookie` does (no `Max-Age`).
pub fn clear_cookie(headers: &HeaderMap) -> String {
    let secure = is_secure(headers);
    format!(
        "{ACCESS_COOKIE}=; Path=/; Expires={}; HttpOnly{}; SameSite={}",
        httpdate::fmt_http_date(UNIX_EPOCH),
        if secure { "; Secure" } else { "" },
        same_site(headers, secure),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use std::time::Duration;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn cookie_value_takes_the_first_match_across_headers() {
        let h = headers(&[
            ("cookie", "a=1; fliks_access=one; fliks_access=two"),
            ("cookie", "fliks_access=three"),
        ]);
        assert_eq!(cookie_value(&h, ACCESS_COOKIE).as_deref(), Some("one"));
        let h = headers(&[("cookie", "a=1"), ("cookie", " fliks_access=x%20y ;b=2")]);
        assert_eq!(cookie_value(&h, ACCESS_COOKIE).as_deref(), Some("x y"));
        assert_eq!(
            cookie_value(
                &headers(&[("cookie", "xfliks_access=1; a=b")]),
                ACCESS_COOKIE
            ),
            None
        );
        assert_eq!(cookie_value(&HeaderMap::new(), ACCESS_COOKIE), None);
    }

    #[test]
    fn cookie_value_survives_non_ascii_cookies() {
        let mut h = HeaderMap::new();
        h.append(
            "cookie",
            HeaderValue::from_bytes(b"x=\xc3\xa9; fliks_access=t").unwrap(),
        );
        assert_eq!(cookie_value(&h, ACCESS_COOKIE).as_deref(), Some("t"));
    }

    #[test]
    fn empty_value_is_present_and_bad_escapes_stay_raw() {
        let h = headers(&[("cookie", "fliks_access=")]);
        assert_eq!(cookie_value(&h, ACCESS_COOKIE).as_deref(), Some(""));
        for raw in ["a%zz", "a%2", "a%", "%ff%fe"] {
            let h = headers(&[("cookie", &format!("fliks_access={raw}"))]);
            assert_eq!(
                cookie_value(&h, ACCESS_COOKIE).as_deref(),
                Some(raw),
                "{raw}"
            );
        }
    }

    #[test]
    fn secure_follows_the_first_forwarded_proto() {
        assert!(!is_secure(&HeaderMap::new()));
        assert!(is_secure(&headers(&[("x-forwarded-proto", "https")])));
        assert!(is_secure(&headers(&[(
            "x-forwarded-proto",
            " HTTPS , http"
        )])));
        assert!(!is_secure(&headers(&[(
            "x-forwarded-proto",
            "http, https"
        )])));
    }

    fn set(h: &[(&'static str, &str)]) -> String {
        access_cookie_at(
            &headers(h),
            "a.b.c",
            3600,
            UNIX_EPOCH + Duration::from_secs(1_700_000_000),
        )
    }

    #[test]
    fn attribute_matrix() {
        let lax = "fliks_access=a.b.c; Max-Age=3600; Path=/; Expires=Tue, 14 Nov 2023 23:13:20 GMT; HttpOnly; SameSite=Lax";
        assert_eq!(set(&[]), lax);
        assert_eq!(set(&[("origin", "capacitor://localhost")]), lax);
        assert_eq!(
            set(&[
                ("x-forwarded-proto", "https"),
                ("origin", "https://evil.example")
            ]),
            format!(
                "{}; Secure; SameSite=Lax",
                lax.trim_end_matches("; SameSite=Lax")
            )
        );
        let none = format!(
            "{}; Secure; SameSite=None",
            lax.trim_end_matches("; SameSite=Lax")
        );
        for o in NATIVE_ORIGINS {
            assert_eq!(set(&[("x-forwarded-proto", "https"), ("origin", o)]), none);
        }
        assert_eq!(
            set(&[
                ("x-forwarded-proto", "https"),
                ("origin", "https://localhost:1")
            ]),
            none.replace("None", "Lax")
        );
    }

    #[test]
    fn clear_cookie_has_no_max_age() {
        assert_eq!(
            clear_cookie(&HeaderMap::new()),
            "fliks_access=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
        );
        let h = headers(&[
            ("x-forwarded-proto", "https"),
            ("origin", "http://localhost"),
        ]);
        assert_eq!(
            clear_cookie(&h),
            "fliks_access=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=None"
        );
    }

    #[test]
    fn value_is_uri_encoded() {
        assert_eq!(encode_uri_component("a b/c=é"), "a%20b%2Fc%3D%C3%A9");
        assert_eq!(decode_uri_component("a%20b%2Fc%3D%C3%A9"), "a b/c=é");
    }
}
