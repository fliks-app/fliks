//! Access and stream JWTs (HS256, key = the secret's UTF-8 bytes, as Nest signs them) and the TTL parsers.
use crate::http::AppError;
use chrono::Utc;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Cast tokens live a fixed 4 h (`auth.md` rule 5).
pub const CAST_TTL_SECS: u64 = 4 * 3600;

/// Any claim value other than `stream` is still "scoped" (`auth.md` rule 10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenScope {
    Stream,
    #[serde(other)]
    Other,
}

#[derive(Serialize)]
struct SignClaims<'a> {
    sub: i32,
    username: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<TokenScope>,
    iat: i64,
    exp: i64,
}

/// What the extractor reads: `username` is ignored (a renamed user's token stays valid).
#[derive(Debug, Deserialize)]
pub struct Claims {
    pub sub: i32,
    pub scope: Option<TokenScope>,
    pub exp: i64,
}

#[derive(Debug, Clone)]
pub struct Signed {
    pub token: String,
    /// Unix seconds, `iat + ttl`.
    pub exp: i64,
}

pub struct Jwt {
    enc: EncodingKey,
    dec: DecodingKey,
    validation: Validation,
    /// `JWT_EXPIRATION`: access token lifetime and cookie `Max-Age`.
    pub access_ttl_secs: u64,
    /// `STREAM_TOKEN_TTL`.
    pub stream_ttl_secs: u64,
}

impl Jwt {
    pub fn new(secret: &str, access_ttl_secs: u64, stream_ttl_secs: u64) -> Self {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 0;
        validation.validate_nbf = true;
        validation.validate_aud = false;
        validation.required_spec_claims = HashSet::from(["exp".to_owned()]);
        Self {
            enc: EncodingKey::from_secret(secret.as_bytes()),
            dec: DecodingKey::from_secret(secret.as_bytes()),
            validation,
            access_ttl_secs,
            stream_ttl_secs,
        }
    }

    pub fn sign_access(&self, user_id: i32, username: &str) -> Result<Signed, AppError> {
        self.sign(user_id, username, None, self.access_ttl_secs)
    }

    pub fn sign_stream(&self, user_id: i32, username: &str) -> Result<Signed, AppError> {
        self.sign(
            user_id,
            username,
            Some(TokenScope::Stream),
            self.stream_ttl_secs,
        )
    }

    pub fn sign_cast(&self, user_id: i32, username: &str) -> Result<Signed, AppError> {
        self.sign(user_id, username, Some(TokenScope::Stream), CAST_TTL_SECS)
    }

    fn sign(
        &self,
        sub: i32,
        username: &str,
        scope: Option<TokenScope>,
        ttl_secs: u64,
    ) -> Result<Signed, AppError> {
        self.sign_at(Utc::now().timestamp(), sub, username, scope, ttl_secs)
    }

    fn sign_at(
        &self,
        iat: i64,
        sub: i32,
        username: &str,
        scope: Option<TokenScope>,
        ttl_secs: u64,
    ) -> Result<Signed, AppError> {
        let exp = iat.saturating_add(i64::try_from(ttl_secs).unwrap_or(i64::MAX));
        let claims = SignClaims {
            sub,
            username,
            scope,
            iat,
            exp,
        };
        let token = jsonwebtoken::encode(&Header::new(Algorithm::HS256), &claims, &self.enc)
            .map_err(|e| {
                tracing::error!(error = %e, "jwt signing failed");
                AppError::plain(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error",
                )
            })?;
        Ok(Signed { token, exp })
    }

    /// HS256 only, `exp` required and enforced with no leeway; `None` for anything else.
    pub fn verify(&self, token: &str) -> Option<Claims> {
        jsonwebtoken::decode::<Claims>(token, &self.dec, &self.validation)
            .ok()
            .map(|d| d.claims)
    }
}

/// Nest's `ms()` grammar (`ms@2.1`): a number then an optional unit, a bare number is milliseconds.
pub fn parse_ms(s: &str) -> Option<f64> {
    if s.len() > 100 {
        return None;
    }
    let digits = |from: usize| s[from..].bytes().take_while(u8::is_ascii_digit).count();
    let neg = usize::from(s.starts_with('-'));
    let int = digits(neg);
    let mut end = neg + int;
    if s[end..].starts_with('.') {
        let frac = digits(end + 1);
        if frac == 0 {
            return None;
        }
        end += 1 + frac;
    } else if int == 0 {
        return None;
    }
    let n: f64 = s[..end].parse().ok()?;
    let rest = s[end..].trim_start_matches(' ').to_ascii_lowercase();
    const SEC: f64 = 1000.0;
    const DAY: f64 = 86_400.0 * SEC;
    let unit = match rest.as_str() {
        "" | "ms" | "msec" | "msecs" | "millisecond" | "milliseconds" => 1.0,
        "s" | "sec" | "secs" | "second" | "seconds" => SEC,
        "m" | "min" | "mins" | "minute" | "minutes" => 60.0 * SEC,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600.0 * SEC,
        "d" | "day" | "days" => DAY,
        "w" | "week" | "weeks" => 7.0 * DAY,
        "y" | "yr" | "yrs" | "year" | "years" => 365.25 * DAY,
        _ => return None,
    };
    Some(n * unit)
}

/// `expiresIn` seconds as jsonwebtoken computes them (`floor(ms / 1000)`); unset, empty, unparsable or
/// shorter than 1 s falls back to `default` with a warning.
pub fn ttl_secs(name: &str, raw: Option<&str>, default: u64) -> u64 {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return default;
    };
    match parse_ms(raw).map(|ms| (ms / 1000.0).floor()) {
        Some(s) if s >= 1.0 && s < u64::MAX as f64 => s as u64,
        _ => {
            tracing::warn!("{name}={raw:?} is not a duration of at least 1 s, using {default} s");
            default
        }
    }
}

/// `parseInt(raw, 10)` must be finite and `> 0`, else `default` (`refresh-token.service.ts:51`).
pub fn positive_int_or(raw: Option<&str>, default: i64) -> i64 {
    let s = raw.unwrap_or_default().trim_start();
    let end = s
        .char_indices()
        .find(|&(i, c)| !(c.is_ascii_digit() || (i == 0 && (c == '-' || c == '+'))))
        .map_or(s.len(), |(i, _)| i);
    s[..end].parse().ok().filter(|n| *n > 0).unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use jsonwebtoken::{Algorithm, EncodingKey, Header};
    use serde_json::json;

    const SECRET: &str = "0123456789abcdef";

    fn jwt() -> Jwt {
        Jwt::new(SECRET, 3600, 43_200)
    }

    fn forge(alg: Algorithm, key: &str, claims: serde_json::Value) -> String {
        jsonwebtoken::encode(
            &Header::new(alg),
            &claims,
            &EncodingKey::from_secret(key.as_bytes()),
        )
        .unwrap()
    }

    #[test]
    fn ms_grammar() {
        for (s, ms) in [
            ("3600", 3600.0),
            ("1h", 3_600_000.0),
            ("1 hour", 3_600_000.0),
            ("2 Hours", 7_200_000.0),
            ("1.5h", 5_400_000.0),
            (".5s", 500.0),
            ("7d", 604_800_000.0),
            ("1w", 604_800_000.0),
            ("1y", 31_557_600_000.0),
            ("30m", 1_800_000.0),
            ("90 secs", 90_000.0),
            ("-1h", -3_600_000.0),
        ] {
            assert_eq!(parse_ms(s), Some(ms), "{s}");
        }
        for s in [
            "", "h", "1 x", "1.", " 1h", "1h ", "1 h m", "--1", "1e3", "1\n",
        ] {
            assert_eq!(parse_ms(s), None, "{s:?}");
        }
        assert_eq!(parse_ms(&"1".repeat(101)), None);
    }

    #[test]
    fn jwt_expiration_is_milliseconds_when_unitless() {
        assert_eq!(ttl_secs("JWT_EXPIRATION", Some("3600"), 3600), 3);
        assert_eq!(ttl_secs("JWT_EXPIRATION", Some("3600s"), 1), 3600);
        assert_eq!(ttl_secs("JWT_EXPIRATION", Some("15m"), 1), 900);
        assert_eq!(ttl_secs("JWT_EXPIRATION", Some("1.9s"), 1), 1);
        assert_eq!(ttl_secs("JWT_EXPIRATION", None, 3600), 3600);
        assert_eq!(ttl_secs("JWT_EXPIRATION", Some(""), 3600), 3600);
    }

    #[test]
    fn unusable_durations_fall_back() {
        for raw in ["soon", "0", "999", "-1h", "0s"] {
            assert_eq!(ttl_secs("X", Some(raw), 77), 77, "{raw}");
        }
    }

    #[test]
    fn refresh_days_follow_parse_int() {
        for (raw, want) in [
            (Some("30"), 30),
            (Some(" 14 "), 14),
            (Some("7days"), 7),
            (Some("1.9"), 1),
            (Some("0"), 60),
            (Some("-5"), 60),
            (Some("abc"), 60),
            (Some(""), 60),
            (None, 60),
        ] {
            assert_eq!(positive_int_or(raw, 60), want, "{raw:?}");
        }
    }

    #[test]
    fn signed_access_token_round_trips_without_scope() {
        let j = jwt();
        let s = j.sign_access(7, "ana").unwrap();
        let c = j.verify(&s.token).unwrap();
        assert_eq!((c.sub, c.scope, c.exp), (7, None, s.exp));
        let raw = jsonwebtoken::dangerous::insecure_decode::<serde_json::Value>(&s.token)
            .unwrap()
            .claims;
        assert_eq!(raw["username"], "ana");
        assert!(raw.get("scope").is_none());
        assert_eq!(
            raw["exp"].as_i64().unwrap() - raw["iat"].as_i64().unwrap(),
            3600
        );
    }

    #[test]
    fn stream_and_cast_tokens_carry_the_scope() {
        let j = jwt();
        let (s, c) = (j.sign_stream(1, "a").unwrap(), j.sign_cast(1, "a").unwrap());
        assert_eq!(j.verify(&s.token).unwrap().scope, Some(TokenScope::Stream));
        assert_eq!(j.verify(&c.token).unwrap().scope, Some(TokenScope::Stream));
        assert_eq!(c.exp - Utc::now().timestamp(), CAST_TTL_SECS as i64);
    }

    #[test]
    fn rejects_bad_signature_expiry_algorithm_and_shape() {
        let j = jwt();
        let now = Utc::now().timestamp();
        let ok = json!({"sub": 1, "exp": now + 60});
        assert!(
            j.verify(&forge(Algorithm::HS256, SECRET, ok.clone()))
                .is_some()
        );
        assert!(
            j.verify(&forge(Algorithm::HS256, "other", ok.clone()))
                .is_none()
        );
        assert!(j.verify(&forge(Algorithm::HS384, SECRET, ok)).is_none());
        let expired = json!({"sub": 1, "exp": now - 1});
        assert!(
            j.verify(&forge(Algorithm::HS256, SECRET, expired))
                .is_none()
        );
        let no_exp = json!({"sub": 1});
        assert!(j.verify(&forge(Algorithm::HS256, SECRET, no_exp)).is_none());
        let nbf = json!({"sub": 1, "exp": now + 60, "nbf": now + 30});
        assert!(j.verify(&forge(Algorithm::HS256, SECRET, nbf)).is_none());
        for sub in [json!("1"), json!(1.5), json!(null)] {
            let bad = json!({"sub": sub, "exp": now + 60});
            assert!(j.verify(&forge(Algorithm::HS256, SECRET, bad)).is_none());
        }
        assert!(
            j.verify(&forge(Algorithm::HS256, SECRET, json!({"exp": now + 60})))
                .is_none()
        );
        let b64 = |b: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
        let none = format!(
            "{}.{}.",
            b64(br#"{"alg":"none","typ":"JWT"}"#),
            b64(br#"{"sub":1,"exp":9999999999}"#)
        );
        assert!(j.verify(&none).is_none());
        assert!(j.verify("").is_none() && j.verify("a.b.c").is_none());
    }

    #[test]
    fn unknown_scope_is_still_scoped() {
        let j = jwt();
        let t = forge(
            Algorithm::HS256,
            SECRET,
            json!({"sub": 1, "exp": Utc::now().timestamp() + 60, "scope": "cast"}),
        );
        assert_eq!(j.verify(&t).unwrap().scope, Some(TokenScope::Other));
        let t = forge(
            Algorithm::HS256,
            SECRET,
            json!({"sub": 1, "exp": Utc::now().timestamp() + 60, "scope": null}),
        );
        assert_eq!(j.verify(&t).unwrap().scope, None);
    }

    #[test]
    fn key_is_the_utf8_bytes_of_the_secret_not_hex_decoded() {
        let hex = "00ff00ff";
        let t = Jwt::new(hex, 60, 60).sign_access(1, "a").unwrap().token;
        assert!(Jwt::new(hex, 60, 60).verify(&t).is_some());
        let decoded = String::from_utf8_lossy(&[0, 255, 0, 255]).into_owned();
        assert!(Jwt::new(&decoded, 60, 60).verify(&t).is_none());
    }
}
