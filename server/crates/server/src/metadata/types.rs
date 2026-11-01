//! Shapes the clients share with their callers (`metadata.md` rules 6, 10, 34).
use super::http::Upstream;
use serde_json::Value;

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

/// `PersonCreditItem` objects (meta rule 34), one list per side.
#[derive(Debug, Clone, Default)]
pub struct Credits {
    pub cast: Vec<Value>,
    pub crew: Vec<Value>,
}
