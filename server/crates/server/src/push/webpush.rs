//! Web Push without a relay: endpoint allow-list, VAPID (RFC 8292) and the POST of an encrypted record.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use reqwest::Url;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(10);
const JWT_TTL_SECS: i64 = 12 * 3600;
const CACHE: Duration = Duration::from_secs(3600);

/// Hosts of the push services the browsers use; a suffix entry starts with a dot.
const HOSTS: [&str; 8] = [
    "fcm.googleapis.com",
    // FCM of Chromium builds outside the stable channel (Beta, Dev, Canary, distribution packages).
    "jmt17.google.com",
    "updates.push.services.mozilla.com",
    ".push.services.mozilla.com",
    "web.push.apple.com",
    ".push.apple.com",
    ".notify.windows.com",
    "android.googleapis.com",
];

fn known(host: &str) -> bool {
    HOSTS.iter().any(|h| match h.strip_prefix('.') {
        Some(_) => host.ends_with(h),
        None => host == *h,
    })
}

/// An `https` endpoint on a known push service, no credentials, default port.
pub fn endpoint(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    let ok = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.host_str().is_some_and(known);
    ok.then_some(url)
}

pub fn origin(url: &Url) -> String {
    format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default())
}

pub fn public_key(key: &SigningKey) -> String {
    B64.encode(key.verifying_key().to_encoded_point(false).as_bytes())
}

pub fn jwt(key: &SigningKey, aud: &str, sub: &str, now: i64) -> String {
    let head = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = B64.encode(
        json!({"aud": aud, "exp": now + JWT_TTL_SECS, "sub": sub})
            .to_string()
            .as_bytes(),
    );
    let sig: Signature = key.sign(format!("{head}.{claims}").as_bytes());
    format!("{head}.{claims}.{}", B64.encode(sig.to_bytes()))
}

/// VAPID tokens per origin, valid for an hour.
#[derive(Default)]
pub struct Tokens(Mutex<HashMap<String, (String, Instant)>>);

impl Tokens {
    pub fn header(&self, key: &SigningKey, origin: &str, sub: &str) -> String {
        let mut g = crate::sync::MutexExt::lock_clean(&self.0);
        let token = match g.get(origin).filter(|(_, at)| at.elapsed() < CACHE) {
            Some((t, _)) => t.clone(),
            None => {
                let t = jwt(key, origin, sub, chrono::Utc::now().timestamp());
                g.insert(origin.to_owned(), (t.clone(), Instant::now()));
                t
            }
        };
        format!("vapid t={token}, k={}", public_key(key))
    }
}

pub enum Outcome {
    Sent,
    /// 404 or 410: the subscription is gone.
    Gone,
    Failed(String),
}

pub struct Request<'a> {
    pub url: &'a Url,
    pub authorization: String,
    pub ttl: u32,
    pub urgent: bool,
    pub body: Vec<u8>,
}

pub async fn send(r: Request<'_>) -> Outcome {
    let client =
        match crate::vetted::client_for(r.url, crate::net::guard::open_builder().timeout(TIMEOUT))
            .await
        {
            Ok(c) => c,
            Err(e) => return Outcome::Failed(e),
        };
    let res = client
        .post(r.url.clone())
        .header("Authorization", r.authorization)
        .header("TTL", r.ttl.to_string())
        .header("Urgency", if r.urgent { "high" } else { "normal" })
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .body(r.body)
        .send()
        .await;
    match res {
        Ok(res) if res.status().is_success() => Outcome::Sent,
        Ok(res) if matches!(res.status().as_u16(), 404 | 410) => Outcome::Gone,
        Ok(res) => Outcome::Failed(format!("push service answered {}", res.status().as_u16())),
        Err(e) if e.is_timeout() => Outcome::Failed("timeout".into()),
        Err(e) => Outcome::Failed(e.without_url().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_https_push_services() {
        for ok in [
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://jmt17.google.com/fcm/send/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/x",
            "https://web.push.apple.com/Qx",
            "https://wns2-par02p.notify.windows.com/w/?token=x",
        ] {
            assert!(endpoint(ok).is_some(), "{ok}");
        }
        for bad in [
            "http://fcm.googleapis.com/x",
            "https://evil.example/x",
            "https://fcm.googleapis.com.evil.example/x",
            "https://user@fcm.googleapis.com/x",
            "https://fcm.googleapis.com:8443/x",
            "https://127.0.0.1/x",
            "notaurl",
        ] {
            assert!(endpoint(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn vapid_jwt_verifies() {
        use p256::ecdsa::signature::Verifier;
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let t = jwt(
            &key,
            "https://fcm.googleapis.com",
            "mailto:a@example.test",
            1_800_000_000,
        );
        let parts: Vec<&str> = t.split('.').collect();
        let sig = Signature::from_slice(&B64.decode(parts[2]).unwrap()).unwrap();
        key.verifying_key()
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
            .unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&B64.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["exp"], 1_800_000_000 + JWT_TTL_SECS);
    }
}
