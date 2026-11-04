//! Ed25519 trust (`plugins.md` rule 15): compiled-in keys, detached base64 signatures.
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

/// Never remove a published key: old signatures must stay verifiable.
pub const OFFICIAL_KEYS: [(&str, &str); 1] = [(
    "release-2026",
    "Cj0i8YENJdTuC0I0pPPZbNuzo4tgIcpMnCjlb8rtaKs=",
)];

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Trust {
    Official,
    Unverified,
    Unsigned,
}

impl Trust {
    pub fn as_str(self) -> &'static str {
        match self {
            Trust::Official => "official",
            Trust::Unverified => "unverified",
            Trust::Unsigned => "unsigned",
        }
    }
}

pub type Keys = Vec<(String, [u8; 32])>;

pub fn official_keys() -> Keys {
    OFFICIAL_KEYS
        .iter()
        .filter_map(|(id, b)| Some(((*id).to_owned(), decode(b)?.try_into().ok()?)))
        .collect()
}

/// Base64 as `Buffer.from(_, 'base64')` reads a signature file: surrounding ASCII whitespace
/// trimmed (the catalog packager writes a trailing newline), padding optional.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let t = text.trim_matches(|c: char| c.is_ascii_whitespace());
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(t.trim_end_matches('='))
        .ok()
}

/// `None` signature is `unsigned`; one no key verifies (an empty set included) is `unverified`.
pub fn resolve(data: &[u8], sig: Option<&[u8]>, keys: &Keys) -> (Trust, Option<String>) {
    let Some(sig) = sig else {
        return (Trust::Unsigned, None);
    };
    let Ok(sig) = Signature::from_slice(sig) else {
        return (Trust::Unverified, None);
    };
    for (id, raw) in keys {
        if let Ok(k) = VerifyingKey::from_bytes(raw)
            && k.verify(data, &sig).is_ok()
        {
            return (Trust::Official, Some(id.clone()));
        }
    }
    (Trust::Unverified, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn signature_text_with_a_trailing_newline_verifies() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let keys = vec![("k".to_owned(), sk.verifying_key().to_bytes())];
        let sig = sk.sign(b"manifest").to_bytes();
        let text = format!(
            "{}\n",
            base64::engine::general_purpose::STANDARD.encode(sig)
        );
        let bytes = decode(&text).unwrap();
        assert_eq!(bytes.len(), 64);
        assert_eq!(resolve(b"manifest", Some(&bytes), &keys).0, Trust::Official);
        assert_eq!(resolve(b"other", Some(&bytes), &keys).0, Trust::Unverified);
        assert_eq!(
            resolve(b"manifest", Some(&bytes), &vec![]).0,
            Trust::Unverified
        );
        assert_eq!(resolve(b"manifest", None, &keys).0, Trust::Unsigned);
        assert_eq!(official_keys().len(), 1);
    }
}
