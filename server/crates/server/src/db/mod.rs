pub mod migrate;

pub use migrate::{MigrateError, adopt_typeorm, migrate, pending_version};

use fliks_domain::media::kind::{MediaKind, UnknownKind};

/// Decodes a `media.type` / `requests."mediaType"` value (`text` under a `CHECK`).
pub fn kind(s: &str) -> Result<MediaKind, sqlx::Error> {
    MediaKind::parse(s).ok_or_else(|| sqlx::Error::Decode(Box::new(UnknownKind(s.to_owned()))))
}
