//! Shapes the providers share with their callers (`metadata.md` rules 6, 10, 34).
use serde_json::Value;

/// A failed upstream call; `reason` never contains the request URL (rule 21).
#[derive(Debug, Clone)]
pub struct Upstream {
    pub status: Option<u16>,
    reason: String,
    outage: bool,
}

impl Upstream {
    pub fn new(status: Option<u16>, reason: impl Into<String>) -> Self {
        Self {
            status,
            reason: reason.into(),
            outage: false,
        }
    }

    /// No answer to expect soon and no status: a transport failure, an open circuit, a provider off.
    pub fn outage(reason: impl Into<String>) -> Self {
        Self {
            outage: true,
            ..Self::new(None, reason)
        }
    }

    /// Retrying later can succeed: the provider is unreachable, throttled or failing on its side.
    pub fn is_outage(&self) -> bool {
        self.outage || matches!(self.status, Some(429 | 500..=599))
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn is_not_found(&self) -> bool {
        self.status == Some(404)
    }

    pub fn is_unauthorized(&self) -> bool {
        self.status == Some(401)
    }

    /// The provider's daily quota is spent: no request was made.
    pub fn quota(name: &str) -> Self {
        Self::new(Some(429), format!("{name} daily quota spent"))
    }

    /// The provider (or the limiter) asks for fewer calls: 429 or 503.
    pub fn is_throttled(&self) -> bool {
        matches!(self.status, Some(429 | 503))
    }
}

impl std::fmt::Display for Upstream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason)
    }
}

#[derive(Debug)]
pub enum MetaError {
    Upstream(Upstream),
    Db(sqlx::Error),
}

impl From<Upstream> for MetaError {
    fn from(e: Upstream) -> Self {
        Self::Upstream(e)
    }
}

impl From<sqlx::Error> for MetaError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e)
    }
}

/// A person as a provider describes it; `None` is JS `undefined` (the stored value is kept).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PersonDetails {
    pub name: Option<String>,
    pub biography: Option<String>,
    pub birthday: Option<String>,
    pub deathday: Option<String>,
    pub place_of_birth: Option<String>,
    pub avatar_url: Option<String>,
    pub known_for_department: Option<String>,
}

/// `PersonCreditItem` objects (meta rule 34), one list per side; a music provider answers `albums`, the
/// discography of an artist (`music.md`), instead.
#[derive(Debug, Clone, Default)]
pub struct Credits {
    pub cast: Vec<Value>,
    pub crew: Vec<Value>,
    pub albums: Vec<Value>,
}
