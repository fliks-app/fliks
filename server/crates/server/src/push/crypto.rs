//! RFC 8291 message encryption (`aes128gcm`, one record) for Web Push and the mobile relay payload.
use aes_gcm::{Aes128Gcm, KeyInit, aead::Aead};
use hkdf::Hkdf;
use p256::{PublicKey, SecretKey, ecdh::diffie_hellman, elliptic_curve::sec1::ToEncodedPoint};
use sha2::Sha256;

pub const AUTH_LEN: usize = 16;
const RECORD_SIZE: u32 = 4096;

/// A subscription's public key (65-byte uncompressed point) and 16-byte auth secret.
pub struct Recipient {
    pub p256dh: Vec<u8>,
    pub auth: Vec<u8>,
}

impl Recipient {
    pub fn parse(p256dh: &str, auth: &str) -> Option<Self> {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
        let r = Self {
            p256dh: B64.decode(p256dh.trim_end_matches('=')).ok()?,
            auth: B64.decode(auth.trim_end_matches('=')).ok()?,
        };
        let on_curve = r.p256dh.len() == 65 && PublicKey::from_sec1_bytes(&r.p256dh).is_ok();
        (on_curve && r.auth.len() == AUTH_LEN).then_some(r)
    }
}

pub fn encrypt(plaintext: &[u8], to: &Recipient) -> Result<Vec<u8>, String> {
    let secret = loop {
        if let Ok(k) = SecretKey::from_slice(&super::identity::random::<32>()) {
            break k;
        }
    };
    encrypt_with(plaintext, to, &secret, super::identity::random::<16>())
}

/// `encrypt` with the sender's ephemeral key and salt given, for the RFC vector.
pub fn encrypt_with(
    plaintext: &[u8],
    to: &Recipient,
    secret: &SecretKey,
    salt: [u8; 16],
) -> Result<Vec<u8>, String> {
    let ua = PublicKey::from_sec1_bytes(&to.p256dh).map_err(|_| "bad subscription key")?;
    let as_public = secret.public_key().to_encoded_point(false);
    let shared = diffie_hellman(secret.to_nonzero_scalar(), ua.as_affine());
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(&to.p256dh);
    key_info.extend_from_slice(as_public.as_bytes());
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&to.auth), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| "hkdf")?;
    let prk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| "hkdf")?;
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| "hkdf")?;
    let mut record = plaintext.to_vec();
    record.push(2);
    let sealed = Aes128Gcm::new(&cek.into())
        .encrypt(&nonce.into(), record.as_slice())
        .map_err(|_| "encrypt")?;
    let mut out = Vec::with_capacity(86 + sealed.len());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    out.push(65);
    out.extend_from_slice(as_public.as_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};

    fn b(s: &str) -> Vec<u8> {
        B64.decode(s).unwrap()
    }

    /// RFC 8291 Appendix A.
    #[test]
    fn reproduces_the_rfc_example() {
        let to = Recipient {
            p256dh: b(
                "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
            ),
            auth: b("BTBZMqHH6r4Tts7J_aSIgg"),
        };
        let secret =
            SecretKey::from_slice(&b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let salt: [u8; 16] = b("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let out = encrypt_with(
            b"When I grow up, I want to be a watermelon",
            &to,
            &secret,
            salt,
        )
        .unwrap();
        let want = b(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
        );
        assert_eq!(out, want);
    }

    #[test]
    fn overhead_is_103_bytes() {
        let sk = SecretKey::from_slice(&super::super::identity::random::<32>()).unwrap();
        let to = Recipient {
            p256dh: sk.public_key().to_encoded_point(false).as_bytes().to_vec(),
            auth: vec![1; 16],
        };
        assert_eq!(encrypt(&[0; 100], &to).unwrap().len(), 203);
    }

    #[test]
    fn parse_refuses_a_bad_key_or_secret() {
        assert!(Recipient::parse("AAAA", "AAAAAAAAAAAAAAAAAAAAAA").is_none());
        assert!(
            Recipient::parse(
                "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
                "AAAA"
            )
            .is_none()
        );
    }
}
