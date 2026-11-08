//! OpenID Connect relying party (`docs/spec/auth.md`): discovery and JWKS caches, the
//! guarded outbound calls, token exchange and the ID and logout token checks.
pub(crate) mod db;
pub(crate) mod providers;
pub(crate) mod routes;
mod sync;

pub(crate) use db::cleanup_logins;
pub use db::{Provider, password_login_admins_only};

/// After sessions were revoked or access changed: close the users' streams and flush the engine.
pub(crate) fn cut_users(st: &crate::state::AppState, users: &[i32]) {
    for &u in users {
        st.hub.drop_connections_for_user(u);
        let engine = st.engine.clone();
        tokio::spawn(async move { engine.revoke_owner(u).await });
    }
}

use crate::net::guard::{self, Net};
use axum::Router;
use base64::{Engine, engine::general_purpose::STANDARD};
use fliks_domain::net::{Class, classify};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, jwk::JwkSet};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(10);
const BODY_CAP: usize = 256 << 10;
const CACHE_TTL: Duration = Duration::from_secs(3600);
const JWKS_REFETCH: Duration = Duration::from_secs(60);
const FAIL_TTL: Duration = Duration::from_secs(30);
const LEEWAY: u64 = 60;
/// What a provider may sign its tokens with; `none` and `HS*` never.
const ALGS: [Algorithm; 9] = [
    Algorithm::RS256,
    Algorithm::RS384,
    Algorithm::RS512,
    Algorithm::PS256,
    Algorithm::PS384,
    Algorithm::PS512,
    Algorithm::ES256,
    Algorithm::ES384,
    Algorithm::EdDSA,
];
const BACKCHANNEL_EVENT: &str = "http://schemas.openid.net/event/backchannel-logout";

pub fn router() -> Router<crate::state::AppState> {
    routes::router().merge(providers::router())
}

/// A failure as a kind: never a URL, a body or a secret.
pub type Fail = String;

#[derive(Debug, Clone)]
pub struct Discovery {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub jwks_uri: String,
    pub userinfo_endpoint: Option<String>,
    pub end_session_endpoint: Option<String>,
    pub algs: Vec<Algorithm>,
    pub auth_methods: Vec<String>,
    pub pkce: bool,
    pub backchannel: bool,
    /// The provider sends `iss` on the authorization response (RFC 9207).
    pub iss_param: bool,
}

struct Entry {
    discovery: Arc<Discovery>,
    at: Instant,
    jwks: Option<Arc<JwkSet>>,
    /// The last key set fetch started, so an unauthenticated flood of unknown `kid`s cannot amplify.
    jwks_at: Option<Instant>,
}

/// The caches and the network every provider call goes through.
pub struct Oidc {
    net: Arc<dyn Net>,
    refetch: Duration,
    cache: Mutex<HashMap<i32, Entry>>,
    failed: Mutex<HashMap<i32, (Instant, Fail)>>,
}

impl Default for Oidc {
    fn default() -> Self {
        Self::with_net(guard::system())
    }
}

enum Body<'a> {
    Get {
        bearer: Option<&'a str>,
    },
    Form {
        form: &'a [(&'a str, &'a str)],
        basic: Option<(&'a str, &'a str)>,
    },
}

/// How the client proves itself at the token endpoint.
#[derive(Debug, PartialEq)]
pub enum ClientAuth {
    None,
    Basic,
    Post,
}

/// Derived, not configured: a secret goes in the Basic header unless the provider lists only the body form.
pub fn client_auth(has_secret: bool, methods: &[String]) -> ClientAuth {
    let has = |m: &str| methods.iter().any(|x| x == m);
    match (
        has_secret,
        has("client_secret_post") && !has("client_secret_basic"),
    ) {
        (false, _) => ClientAuth::None,
        (true, true) => ClientAuth::Post,
        (true, false) => ClientAuth::Basic,
    }
}

/// The value at a dotted path (`realm_access.roles`), a literal top-level key winning over a walk.
pub fn claim_at<'a>(claims: &'a Value, path: &str) -> Option<&'a Value> {
    if let Some(v) = claims.get(path) {
        return Some(v);
    }
    path.split('.').try_fold(claims, |v, k| v.get(k))
}

/// A groups claim as a list: an array of strings, or one string.
pub fn groups_at(claims: &Value, path: &str) -> Vec<String> {
    match claim_at(claims, path) {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
        _ => vec![],
    }
}

fn form_encode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

impl Oidc {
    pub fn with_net(net: Arc<dyn Net>) -> Self {
        Self {
            net,
            refetch: JWKS_REFETCH,
            cache: Mutex::default(),
            failed: Mutex::default(),
        }
    }

    /// The minimum gap between two key set fetches forced by an unknown `kid`.
    pub fn with_refetch(mut self, gap: Duration) -> Self {
        self.refetch = gap;
        self
    }

    /// Forgets a provider's discovery and keys: its row changed or is gone.
    pub fn invalidate(&self, id: i32) {
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        self.failed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    }

    /// One guarded request: one lookup, vetted addresses (private ones allowed, metadata and
    /// reserved ones not), the connection pinned to them, no redirect, 10 s, 256 KiB.
    async fn fetch(
        &self,
        url: &str,
        ca_pem: Option<&str>,
        body: Body<'_>,
    ) -> Result<Vec<u8>, Fail> {
        let u = reqwest::Url::parse(url).map_err(|_| "invalid url".to_owned())?;
        if !matches!(u.scheme(), "http" | "https") {
            return Err("invalid url".into());
        }
        let host = u
            .host_str()
            .unwrap_or_default()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        let port = u.port_or_known_default().unwrap_or(443);
        let addrs = guard::vet(&*self.net, &host, port, true)
            .await
            .map_err(|_| "address refused".to_owned())?;
        if u.scheme() == "http" && addrs.iter().any(|a| classify(a.ip()) != Class::Private) {
            return Err("http needs a private address".into());
        }
        #[cfg(any(test, feature = "parity"))]
        let addrs: Vec<_> = addrs.into_iter().map(|a| self.net.route(a)).collect();
        let mut b = guard::client_builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .user_agent("Fliks-OIDC/1.0")
            .resolve_to_addrs(&host, &addrs);
        if let Some(pem) = ca_pem.filter(|p| !p.trim().is_empty()) {
            for c in reqwest::Certificate::from_pem_bundle(pem.as_bytes())
                .map_err(|_| "invalid ca".to_owned())?
            {
                b = b.add_root_certificate(c);
            }
        }
        let client = b.build().map_err(|_| "network error".to_owned())?;
        let req = match body {
            Body::Get { bearer } => {
                let r = client.get(u).header("accept", "application/json");
                match bearer {
                    Some(t) => r.bearer_auth(t),
                    None => r,
                }
            }
            Body::Form { form, basic } => {
                let r = client
                    .post(u)
                    .form(form)
                    .header("accept", "application/json");
                match basic {
                    Some((id, secret)) => r.header(
                        "authorization",
                        format!(
                            "Basic {}",
                            STANDARD.encode(format!("{}:{}", form_encode(id), form_encode(secret)))
                        ),
                    ),
                    None => r,
                }
            }
        };
        let mut res = req.send().await.map_err(|e| {
            if e.is_timeout() {
                "timeout"
            } else {
                "network error"
            }
            .to_owned()
        })?;
        if !res.status().is_success() {
            return Err(format!("status {}", res.status().as_u16()));
        }
        if res.content_length().is_some_and(|l| l as usize > BODY_CAP) {
            return Err("response too large".into());
        }
        let mut out = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|_| "network error".to_owned())? {
            out.extend_from_slice(&chunk);
            if out.len() > BODY_CAP {
                return Err("response too large".into());
            }
        }
        Ok(out)
    }

    async fn get_json(
        &self,
        url: &str,
        ca: Option<&str>,
        bearer: Option<&str>,
    ) -> Result<Value, Fail> {
        let bytes = self.fetch(url, ca, Body::Get { bearer }).await?;
        serde_json::from_slice(&bytes).map_err(|_| "invalid json".into())
    }

    /// The provider's discovery document, checked: same issuer, usable endpoints.
    pub async fn discover_uncached(
        &self,
        issuer: &str,
        ca: Option<&str>,
    ) -> Result<Discovery, Fail> {
        let url = format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        );
        let doc = self.get_json(&url, ca, None).await.map_err(|e| {
            if e == "invalid json" {
                "invalid discovery".into()
            } else {
                e
            }
        })?;
        parse_discovery(issuer, &doc).ok_or_else(|| "invalid discovery".into())
    }

    pub async fn discover(&self, p: &Provider) -> Result<Arc<Discovery>, Fail> {
        {
            let c = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(e) = c.get(&p.id).filter(|e| e.at.elapsed() < CACHE_TTL) {
                return Ok(e.discovery.clone());
            }
            if let Some((at, why)) = self
                .failed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&p.id)
                && at.elapsed() < FAIL_TTL
            {
                return Err(why.clone());
            }
        }
        let d = match self.discover_uncached(&p.issuer, p.ca_pem.as_deref()).await {
            Ok(d) => Arc::new(d),
            Err(e) => {
                self.failed
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(p.id, (Instant::now(), e.clone()));
                return Err(e);
            }
        };
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).insert(
            p.id,
            Entry {
                discovery: d.clone(),
                at: Instant::now(),
                jwks: None,
                jwks_at: None,
            },
        );
        Ok(d)
    }

    /// The provider's key set; `force` refetches, at most once a minute.
    async fn jwks(&self, p: &Provider, d: &Discovery, force: bool) -> Result<Arc<JwkSet>, Fail> {
        let stale = {
            let mut c = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            let Some(e) = c.get_mut(&p.id) else {
                return Err("no discovery".into());
            };
            let gap = if force { self.refetch } else { CACHE_TTL };
            if let Some(set) = &e.jwks
                && e.jwks_at.is_some_and(|at| at.elapsed() < gap)
            {
                return Ok(set.clone());
            }
            if force && e.jwks_at.is_some_and(|at| at.elapsed() < self.refetch) {
                return Err("keys fetched too recently".into());
            }
            e.jwks_at = Some(Instant::now());
            e.jwks.clone()
        };
        let fetched = self.get_json(&d.jwks_uri, p.ca_pem.as_deref(), None).await;
        let set: Arc<JwkSet> = match fetched
            .and_then(|doc| serde_json::from_value(doc).map_err(|_| "invalid jwks".to_owned()))
        {
            Ok(s) => Arc::new(s),
            Err(e) => return stale.ok_or(e),
        };
        if let Some(e) = self
            .cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&p.id)
        {
            e.jwks = Some(set.clone());
        }
        Ok(set)
    }

    /// Signature, `alg` and the registered claims of a token the provider signed. `aud` and the
    /// rest of the per-token rules are the caller's.
    pub async fn verify(&self, p: &Provider, d: &Discovery, token: &str) -> Result<Value, Fail> {
        let bad = |m: &str| m.to_owned();
        let header = jsonwebtoken::decode_header(token).map_err(|_| bad("bad token"))?;
        if !ALGS.contains(&header.alg) || !d.algs.contains(&header.alg) {
            return Err(bad("algorithm refused"));
        }
        let mut set = self.jwks(p, d, false).await?;
        let key = |set: &JwkSet| match header.kid.as_deref() {
            Some(kid) => set.find(kid).cloned(),
            None if set.keys.len() == 1 => set.keys.first().cloned(),
            None => None,
        };
        let jwk = match key(&set) {
            Some(k) => k,
            None => {
                set = self.jwks(p, d, true).await?;
                key(&set).ok_or_else(|| bad("unknown key"))?
            }
        };
        let key = DecodingKey::from_jwk(&jwk).map_err(|_| bad("unusable key"))?;
        let mut v = Validation::new(header.alg);
        v.leeway = LEEWAY;
        v.validate_aud = false;
        v.set_issuer(&[&p.issuer]);
        v.set_required_spec_claims(&["exp", "iss"]);
        jsonwebtoken::decode::<Value>(token, &key, &v)
            .map(|t| t.claims)
            .map_err(|e| format!("invalid token: {:?}", e.kind()))
    }

    /// The ID token of a code exchange: every check of OIDC Core 3.1.3.7 that applies to the code flow.
    pub async fn verify_id_token(
        &self,
        p: &Provider,
        d: &Discovery,
        token: &str,
        nonce: &str,
    ) -> Result<Value, Fail> {
        let claims = self.verify(p, d, token).await?;
        check_audience(&claims, &p.client_id)?;
        if claims.get("nonce").and_then(Value::as_str) != Some(nonce) {
            return Err("nonce mismatch".into());
        }
        if claims
            .get("sub")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err("no subject".into());
        }
        if claims.get("iat").and_then(Value::as_u64).is_none() {
            return Err("no iat".into());
        }
        Ok(claims)
    }

    /// A back-channel logout token (OIDC Back-Channel Logout 1.0 section 2.6).
    pub async fn verify_logout_token(
        &self,
        p: &Provider,
        d: &Discovery,
        token: &str,
    ) -> Result<Value, Fail> {
        let claims = self.verify(p, d, token).await?;
        check_audience(&claims, &p.client_id)?;
        let iat = claims.get("iat").and_then(Value::as_u64).ok_or("no iat")?;
        if iat > jsonwebtoken::get_current_timestamp() + LEEWAY {
            return Err("iat in the future".into());
        }
        if claims
            .get("jti")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err("no jti".into());
        }
        if claims.get("nonce").is_some() {
            return Err("nonce present".into());
        }
        if claims
            .get("events")
            .and_then(|e| e.get(BACKCHANNEL_EVENT))
            .is_none_or(|e| !e.is_object())
        {
            return Err("no logout event".into());
        }
        let has = |k: &str| {
            claims
                .get(k)
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
        };
        if !has("sid") && !has("sub") {
            return Err("no sid or sub".into());
        }
        Ok(claims)
    }

    pub async fn exchange_code(
        &self,
        p: &Provider,
        d: &Discovery,
        redirect_uri: &str,
        code: &str,
        verifier: &str,
    ) -> Result<TokenResponse, Fail> {
        let secret = p.client_secret.as_deref().filter(|s| !s.is_empty());
        let auth = client_auth(secret.is_some(), &d.auth_methods);
        let mut form = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ];
        let mut basic = None;
        match (auth, secret) {
            (ClientAuth::Basic, Some(s)) => basic = Some((p.client_id.as_str(), s)),
            (ClientAuth::Post, Some(s)) => {
                form.push(("client_id", &p.client_id));
                form.push(("client_secret", s));
            }
            _ => form.push(("client_id", &p.client_id)),
        }
        let bytes = self
            .fetch(
                &d.token_endpoint,
                p.ca_pem.as_deref(),
                Body::Form { form: &form, basic },
            )
            .await?;
        serde_json::from_slice(&bytes).map_err(|_| "invalid token response".into())
    }

    pub async fn userinfo(
        &self,
        p: &Provider,
        d: &Discovery,
        access_token: &str,
    ) -> Result<Value, Fail> {
        let url = d
            .userinfo_endpoint
            .as_deref()
            .ok_or("no userinfo endpoint")?;
        self.get_json(url, p.ca_pem.as_deref(), Some(access_token))
            .await
    }
}

#[derive(Deserialize)]
pub struct TokenResponse {
    pub id_token: Option<String>,
    pub access_token: Option<String>,
}

/// `aud` holds the client id; with several audiences `azp` must be it too, and a present `azp` always.
fn check_audience(claims: &Value, client_id: &str) -> Result<(), Fail> {
    let aud: Vec<&str> = match claims.get("aud") {
        Some(Value::String(s)) => vec![s],
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    };
    if !aud.contains(&client_id) {
        return Err("audience mismatch".into());
    }
    let azp = claims.get("azp").and_then(Value::as_str);
    if azp.is_some_and(|a| a != client_id) || (aud.len() > 1 && azp.is_none()) {
        return Err("authorized party mismatch".into());
    }
    Ok(())
}

fn parse_discovery(issuer: &str, doc: &Value) -> Option<Discovery> {
    if doc.get("issuer")?.as_str()? != issuer {
        return None;
    }
    let url = |k: &str| {
        doc.get(k)
            .and_then(Value::as_str)
            .filter(|u| {
                reqwest::Url::parse(u).is_ok_and(|u| matches!(u.scheme(), "http" | "https"))
            })
            .map(str::to_owned)
    };
    let strings = |k: &str| -> Option<Vec<String>> {
        doc.get(k).and_then(Value::as_array).map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
    };
    // Core 1.0 default when the list is absent.
    let listed =
        strings("id_token_signing_alg_values_supported").unwrap_or_else(|| vec!["RS256".into()]);
    let algs = ALGS
        .iter()
        .copied()
        .filter(|a| listed.iter().any(|l| format!("{a:?}") == *l))
        .collect();
    Some(Discovery {
        authorization_endpoint: url("authorization_endpoint")?,
        token_endpoint: url("token_endpoint")?,
        jwks_uri: url("jwks_uri")?,
        userinfo_endpoint: url("userinfo_endpoint"),
        end_session_endpoint: url("end_session_endpoint"),
        algs,
        auth_methods: strings("token_endpoint_auth_methods_supported")
            .unwrap_or_else(|| vec!["client_secret_basic".into()]),
        pkce: strings("code_challenge_methods_supported")
            .is_some_and(|m| m.iter().any(|x| x == "S256")),
        iss_param: doc
            .get("authorization_response_iss_parameter_supported")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        backchannel: doc
            .get("backchannel_logout_supported")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// Where a login returns: a closed set, never a client-supplied URL.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum ReturnTo {
    Web,
    App,
    Loopback(u16),
}

impl ReturnTo {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "web" => Some(Self::Web),
            "app" => Some(Self::App),
            _ => {
                let port = s.strip_prefix("http://127.0.0.1:")?.strip_suffix("/oidc")?;
                let canonical = !port.starts_with('0') && port.bytes().all(|b| b.is_ascii_digit());
                port.parse::<u16>()
                    .ok()
                    .filter(|p| canonical && *p >= 1024)
                    .map(Self::Loopback)
            }
        }
    }

    /// The stored form, the one `parse` reads back.
    pub fn as_text(self) -> String {
        match self {
            Self::Web => "web".into(),
            Self::App => "app".into(),
            Self::Loopback(p) => format!("http://127.0.0.1:{p}/oidc"),
        }
    }

    /// The redirect carrying `params`: a fragment for the web (out of logs), a query elsewhere.
    pub fn redirect(self, public_url: &str, params: &[(&str, &str)]) -> String {
        let q = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params)
            .finish();
        match self {
            Self::Web => format!("{public_url}/oidc/complete#{q}"),
            Self::App => format!("media.fliks.app:/oidc/complete?{q}"),
            Self::Loopback(p) => format!("http://127.0.0.1:{p}/oidc?{q}"),
        }
    }
}

/// The username a new account gets: the claim, else the email's local part, else a hash of `sub`.
pub fn username_base(claim: Option<&str>, email: Option<&str>, sub: &str) -> String {
    use sha2::{Digest, Sha256};
    let pick = |s: Option<&str>| {
        s.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let name = pick(claim)
        .or_else(|| pick(email.and_then(|e| e.split('@').next())))
        .unwrap_or_else(|| {
            let h: String = Sha256::digest(sub.as_bytes())
                .iter()
                .take(4)
                .map(|b| format!("{b:02x}"))
                .collect();
            format!("user-{h}")
        });
    name.chars().take(255).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn return_targets_are_a_closed_set() {
        assert_eq!(ReturnTo::parse("web"), Some(ReturnTo::Web));
        assert_eq!(ReturnTo::parse("app"), Some(ReturnTo::App));
        assert_eq!(
            ReturnTo::parse("http://127.0.0.1:43210/oidc"),
            Some(ReturnTo::Loopback(43210))
        );
        for bad in [
            "http://127.0.0.1:1023/oidc",
            "http://127.0.0.1:65536/oidc",
            "http://127.0.0.1:0443/oidc",
            "http://127.0.0.1:+4433/oidc",
            "http://127.0.0.1:4433/other",
            "http://127.0.0.1:4433/oidc/x",
            "http://localhost:4433/oidc",
            "http://127.0.0.1.evil.test:4433/oidc",
            "http://127.0.0.1:4433@evil.test/oidc",
            "https://127.0.0.1:4433/oidc",
            "https://evil.test",
            "",
        ] {
            assert_eq!(ReturnTo::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn redirects_carry_the_params_by_target() {
        let p = [("code", "a b"), ("state", "s")];
        assert_eq!(
            ReturnTo::Web.redirect("https://x.test", &p),
            "https://x.test/oidc/complete#code=a+b&state=s"
        );
        assert_eq!(
            ReturnTo::App.redirect("https://x.test", &p),
            "media.fliks.app:/oidc/complete?code=a+b&state=s"
        );
        assert_eq!(
            ReturnTo::Loopback(5000).redirect("", &p),
            "http://127.0.0.1:5000/oidc?code=a+b&state=s"
        );
    }

    #[test]
    fn usernames_fall_back_from_claim_to_email_to_subject() {
        assert_eq!(username_base(Some(" ann "), Some("a@x.test"), "s"), "ann");
        assert_eq!(username_base(Some(""), Some("bob@x.test"), "s"), "bob");
        assert_eq!(
            username_base(None, None, "sub-1"),
            username_base(None, None, "sub-1")
        );
        assert!(username_base(None, None, "sub-1").starts_with("user-"));
        assert_ne!(
            username_base(None, None, "sub-1"),
            username_base(None, None, "sub-2")
        );
        assert_eq!(
            username_base(Some(&"é".repeat(300)), None, "s")
                .chars()
                .count(),
            255
        );
    }

    #[test]
    fn only_asymmetric_algorithms_are_allowed() {
        assert!(
            !ALGS.contains(&Algorithm::HS256)
                && !ALGS.contains(&Algorithm::HS384)
                && !ALGS.contains(&Algorithm::HS512)
        );
        let d = parse_discovery(
            "https://i.test",
            &json!({"issuer": "https://i.test", "authorization_endpoint": "https://i.test/a",
                    "token_endpoint": "https://i.test/t", "jwks_uri": "https://i.test/k",
                    "id_token_signing_alg_values_supported": ["HS256", "none", "ES256", "RS256"]}),
        )
        .unwrap();
        assert_eq!(d.algs, vec![Algorithm::RS256, Algorithm::ES256]);
    }

    #[test]
    fn discovery_needs_its_own_issuer_and_endpoints() {
        let ok = json!({"issuer": "https://i.test", "authorization_endpoint": "https://i.test/a",
                        "token_endpoint": "https://i.test/t", "jwks_uri": "https://i.test/k"});
        assert!(parse_discovery("https://i.test", &ok).is_some());
        assert!(parse_discovery("https://other.test", &ok).is_none());
        let mut no_token = ok.clone();
        no_token["token_endpoint"] = json!("javascript:alert(1)");
        assert!(parse_discovery("https://i.test", &no_token).is_none());
        assert!(!parse_discovery("https://i.test", &ok).unwrap().pkce);
    }

    #[test]
    fn groups_come_from_a_dotted_path_or_a_literal_key() {
        let c = json!({"groups": ["a", "b"], "realm_access": {"roles": ["r"]}, "one": "x", "https://x.test/g": ["lit"]});
        assert_eq!(groups_at(&c, "groups"), ["a", "b"]);
        assert_eq!(groups_at(&c, "realm_access.roles"), ["r"]);
        assert_eq!(groups_at(&c, "one"), ["x"]);
        assert_eq!(groups_at(&c, "https://x.test/g"), ["lit"]);
        assert!(groups_at(&c, "missing.path").is_empty());
        assert!(groups_at(&json!({"groups": 3}), "groups").is_empty());
    }

    #[test]
    fn client_auth_is_derived_from_the_secret_and_the_advertised_methods() {
        let v = |m: &[&str]| m.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            client_auth(false, &v(&["client_secret_post"])),
            ClientAuth::None
        );
        assert_eq!(
            client_auth(true, &v(&["client_secret_basic", "client_secret_post"])),
            ClientAuth::Basic
        );
        assert_eq!(
            client_auth(true, &v(&["client_secret_post"])),
            ClientAuth::Post
        );
        assert_eq!(
            client_auth(true, &v(&["private_key_jwt"])),
            ClientAuth::Basic
        );
    }

    #[test]
    fn audience_and_authorized_party() {
        assert!(check_audience(&json!({"aud": "c"}), "c").is_ok());
        assert!(check_audience(&json!({"aud": ["c"]}), "c").is_ok());
        assert!(check_audience(&json!({"aud": ["c", "x"], "azp": "c"}), "c").is_ok());
        assert!(check_audience(&json!({"aud": ["c", "x"]}), "c").is_err());
        assert!(check_audience(&json!({"aud": ["c"], "azp": "x"}), "c").is_err());
        assert!(check_audience(&json!({"aud": "x"}), "c").is_err());
        assert!(check_audience(&json!({}), "c").is_err());
    }
}
