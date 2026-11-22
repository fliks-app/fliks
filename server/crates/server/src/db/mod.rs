pub mod migrate;
pub mod role;

pub use migrate::{Ledger, MigrateError, adopt_typeorm, ledger_row, migrate, pending_version};

use fliks_domain::media::kind::{MediaKind, UnknownKind};

/// Decodes a `media.type` / `requests."mediaType"` value (`text` under a `CHECK`).
pub fn kind(s: &str) -> Result<MediaKind, sqlx::Error> {
    MediaKind::parse(s).ok_or_else(|| sqlx::Error::Decode(Box::new(UnknownKind(s.to_owned()))))
}

/// `server_version_num` of the connected server.
pub async fn server_version<'e>(db: impl sqlx::PgExecutor<'e>) -> sqlx::Result<i32> {
    sqlx::query_scalar("SELECT current_setting('server_version_num')::int")
        .fetch_one(db)
        .await
}
