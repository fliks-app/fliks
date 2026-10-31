pub mod migrate;

pub use migrate::{MigrateError, adopt_typeorm, migrate};

/// Decodes a `media.type` / `requests."mediaType"` value (`text` under a `CHECK`).
pub fn kind(s: &str) -> Result<fliks_domain::media::kind::MediaKind, sqlx::Error> {
    s.parse().map_err(|e| sqlx::Error::Decode(Box::new(e)))
}
