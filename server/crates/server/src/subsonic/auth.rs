//! Credentials of a call (`docs/spec/opensubsonic.md` rules 7-12): `apiKey`, `u` + `p`, `u` + `t` + `s`.
use super::{Params, render::SubError};
use crate::{
    device_tokens::{self, hex},
    http::auth::Authed,
    state::AppState,
};
use fliks_domain::acl::{Action, Subject};
use md5::{Digest as _, Md5};
use std::net::IpAddr;
use subtle::ConstantTimeEq;

/// No username can hold a NUL, so this bucket of the login limiter is never a user's.
const THROTTLE_KEY: &str = "\0subsonic";
/// A sync opens many calls at once and a success gives its attempt back, so only failures add up.
const MAX_FAILS: u32 = 60;
const WRONG: &str = "Wrong username or password";

fn wrong() -> SubError {
    SubError::new(40, WRONG)
}

fn hex_decode(s: &str) -> Option<String> {
    if s.len() % 2 != 0 {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
}

/// The authenticated caller and the id of the `subsonic` row that vouched for them.
pub async fn authenticate(
    st: &AppState,
    ip: Option<IpAddr>,
    p: &Params,
) -> Result<(Authed, i32), SubError> {
    let key = p.get("apiKey");
    let user = p.get("u");
    if key.is_some() && ["u", "p", "t", "s"].iter().any(|n| p.get(n).is_some()) {
        return Err(SubError::new(
            43,
            "Multiple conflicting authentication mechanisms provided",
        ));
    }
    if !st.login_throttle.attempt_with(ip, THROTTLE_KEY, MAX_FAILS) {
        return Err(SubError::new(
            40,
            "Too many failed attempts, try again later",
        ));
    }
    let (row, owner_name) = match (key, user) {
        (Some(key), _) => (
            by_secret(st, key)
                .await?
                .ok_or_else(|| SubError::new(44, "Invalid API key"))?,
            None,
        ),
        (None, Some(u)) => (by_password(st, u, p).await?.ok_or_else(wrong)?, Some(u)),
        (None, None) => return Err(SubError::missing("u")),
    };
    let a = Authed::load(&st.db, row.owner)
        .await?
        .filter(|a| owner_name.is_none_or(|u| a.user.username.to_lowercase() == u.to_lowercase()))
        .ok_or_else(wrong)?;
    a.require(Action::Read, Subject::Media)
        .map_err(|_| SubError::new(50, "User is not authorized for the given operation"))?;
    st.login_throttle.refund(ip, THROTTLE_KEY);
    device_tokens::touch(&st.db, row.id).await?;
    Ok((a, row.id))
}

/// The row whose secret is `secret`, found by hash.
async fn by_secret(
    st: &AppState,
    secret: &str,
) -> Result<Option<device_tokens::SubsonicRow>, SubError> {
    if !device_tokens::well_formed(secret) {
        return Ok(None);
    }
    Ok(device_tokens::subsonic_by_hash(&st.db, secret).await?)
}

async fn by_password(
    st: &AppState,
    username: &str,
    p: &Params,
) -> Result<Option<device_tokens::SubsonicRow>, SubError> {
    if let Some(pw) = p.get("p") {
        let secret = match pw.strip_prefix("enc:") {
            Some(h) => hex_decode(h),
            None => Some(pw.to_owned()),
        };
        return Ok(match secret {
            Some(s) => by_secret(st, &s).await?,
            None => None,
        });
    }
    let (Some(t), Some(salt)) = (p.get("t"), p.get("s")) else {
        return Err(SubError::missing("p"));
    };
    let t = t.to_ascii_lowercase();
    let mut found = None;
    for row in device_tokens::subsonic_of_username(&st.db, username).await? {
        let secret = row
            .secret
            .as_deref()
            .and_then(|blob| device_tokens::open(&st.subsonic_key, row.owner, blob));
        let Some(secret) = secret else { continue };
        let expected = hex(&Md5::digest(format!("{secret}{salt}")));
        if bool::from(expected.as_bytes().ct_eq(t.as_bytes())) {
            found = Some(row);
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::hex_decode;

    #[test]
    fn enc_values_decode_from_hex() {
        assert_eq!(hex_decode("6162").as_deref(), Some("ab"));
        assert_eq!(hex_decode("616"), None);
        assert_eq!(hex_decode("zz"), None);
        assert_eq!(hex_decode("ff"), None, "not UTF-8");
    }
}
