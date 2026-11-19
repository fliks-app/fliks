//! `fka_` action tokens: a signed, expiring right to run one action as one user (`push.md` rule 41).
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

pub const PREFIX: &str = "fka_";
pub const ACTIONS: [&str; 4] = [
    "request.approve",
    "request.decline",
    "follow.accept",
    "follow.decline",
];

#[derive(Debug, PartialEq)]
pub struct Grant {
    pub user: i32,
    pub action: String,
    pub target: i32,
    pub exp: i64,
}

fn mac(key: &[u8], g: &Grant) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("hmac takes any key length");
    m.update(
        format!(
            "fliks-push-action:{}.{}.{}.{}",
            g.user, g.action, g.target, g.exp
        )
        .as_bytes(),
    );
    super::identity::hex(&m.finalize().into_bytes())
}

pub fn mint(key: &[u8], g: &Grant) -> String {
    format!(
        "{PREFIX}{}.{}.{}.{}.{}",
        g.user,
        g.action,
        g.target,
        g.exp,
        mac(key, g)
    )
}

/// `None` for a malformed token or a bad signature.
pub fn parse(key: &[u8], token: &str) -> Option<Grant> {
    let mut f = token.strip_prefix(PREFIX)?.splitn(5, ':');
    let g = Grant {
        user: f.next()?.parse().ok()?,
        action: f.next()?.to_owned(),
        target: f.next()?.parse().ok()?,
        exp: f.next()?.parse().ok()?,
    };
    let given = f.next()?;
    bool::from(mac(key, &g).as_bytes().ct_eq(given.as_bytes())).then_some(g)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_refuses_a_tampered_token() {
        let g = Grant {
            user: 4,
            action: "request.approve".into(),
            target: 9,
            exp: 1_800_000_000,
        };
        let t = mint(b"k", &g);
        assert_eq!(parse(b"k", &t), Some(g));
        assert!(parse(b"other", &t).is_none());
        assert!(parse(b"k", &t.replace(":9:", ":8:")).is_none());
        assert!(parse(b"k", "fka_1:x").is_none());
        assert!(parse(b"k", "fkj_1:2:3").is_none());
    }
}
