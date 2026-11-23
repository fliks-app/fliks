pub mod migrate;
pub mod role;

pub use migrate::{Ledger, MigrateError, adopt_typeorm, ledger_row, migrate, pending_version};

use fliks_domain::media::kind::{MediaKind, UnknownKind};

/// Decodes a `media.type` / `requests."mediaType"` value (`text` under a `CHECK`).
pub fn kind(s: &str) -> Result<MediaKind, sqlx::Error> {
    MediaKind::parse(s).ok_or_else(|| sqlx::Error::Decode(Box::new(UnknownKind(s.to_owned()))))
}

/// SQL expression for `server_version_num`, for statements that read it with other columns.
pub(crate) const SERVER_VERSION_SQL: &str = "current_setting('server_version_num')::int";

/// `pg_proc` rows (alias `p`) of the advisory lock functions: core serialises on predictable keys.
pub(crate) const ADVISORY_LOCK_FUNCTIONS: &str = r"p.pronamespace = 'pg_catalog'::regnamespace
     AND p.proname ~ '^pg_(try_)?advisory_(xact_)?lock(_shared)?$'";

/// `server_version_num` of the connected server.
pub async fn server_version<'e>(db: impl sqlx::PgExecutor<'e>) -> sqlx::Result<i32> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT {SERVER_VERSION_SQL}")))
        .fetch_one(db)
        .await
}
