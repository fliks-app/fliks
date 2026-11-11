//! The encrypted secret of a `subsonic` row (`docs/spec/device-tokens.md` rule 15).
use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit, Nonce,
    aead::{Aead, Payload},
};

const NONCE: usize = 12;

/// `nonce || ciphertext`, the owner as associated data so a row moved to another user stays unreadable.
pub fn seal(key: &[u8], owner: i32, secret: &str) -> Vec<u8> {
    let mut nonce = [0u8; NONCE];
    getrandom::fill(&mut nonce).expect("os rng");
    let msg = secret.as_bytes();
    let aad = owner.to_be_bytes();
    let sealed = ChaCha20Poly1305::new_from_slice(key)
        .expect("32-byte key")
        .encrypt(&Nonce::from(nonce), Payload { msg, aad: &aad })
        .expect("encryption of a short message");
    [nonce.as_slice(), &sealed].concat()
}

/// The secret, `None` for a blob another key sealed or that was altered.
pub fn open(key: &[u8], owner: i32, blob: &[u8]) -> Option<String> {
    let (nonce, body) = blob.split_at_checked(NONCE)?;
    let aad = owner.to_be_bytes();
    let plain = ChaCha20Poly1305::new_from_slice(key)
        .ok()?
        .decrypt(
            <&Nonce>::try_from(nonce).ok()?,
            Payload {
                msg: body,
                aad: &aad,
            },
        )
        .ok()?;
    String::from_utf8(plain).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_opens_with_its_key_and_owner_only() {
        let key = [7u8; 32];
        let blob = seal(&key, 5, "fkd_secret");
        assert!(!blob.windows(10).any(|w| w == b"fkd_secret"));
        assert_eq!(open(&key, 5, &blob).as_deref(), Some("fkd_secret"));
        assert_eq!(open(&key, 6, &blob), None);
        assert_eq!(open(&[8u8; 32], 5, &blob), None);
        let mut bad = blob.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert_eq!(open(&key, 5, &bad), None);
        assert_ne!(seal(&key, 5, "x"), seal(&key, 5, "x"));
        assert_eq!(open(&key, 5, &blob[..4]), None);
    }
}
