//! Device tokens (`docs/spec/device-tokens.md`): credentials of readers and sync apps, stored as a hash.
mod reject;
mod routes;

use fliks_engine_core::api::{ResolveCredentialSource as Source, ResolvePurpose as Purpose};
use md5::{Digest as _, Md5};
use sha2::Sha256;
use sqlx::PgPool;

pub use reject::Reject;
pub use routes::*;

const PREFIX: &str = "fkd_";
const TOKEN_LEN: usize = PREFIX.len() + 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Opds,
    Kosync,
    Kobo,
}

impl Kind {
    pub const ALL: [Self; 3] = [Self::Opds, Self::Kosync, Self::Kobo];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Opds => "opds",
            Self::Kosync => "kosync",
            Self::Kobo => "kobo",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }

    /// The credential sources that open the engine data plane with this kind.
    fn sources(self) -> &'static [Source] {
        match self {
            Self::Opds => &[Source::Basic],
            Self::Kosync => &[],
            Self::Kobo => &[Source::Path],
        }
    }

    /// The file purposes this kind resolves: a Kobo reads book downloads only (`kobo.md` rule 2).
    pub fn opens(self, purpose: Purpose) -> bool {
        match self {
            Self::Opds => purpose != Purpose::Live,
            Self::Kosync => false,
            Self::Kobo => purpose == Purpose::Download,
        }
    }

    /// What is hashed: a kosync client sends MD5(password), the password being the token.
    fn secret(self, token: &str) -> String {
        match self {
            Self::Kosync => hex(&Md5::digest(token)),
            Self::Opds | Self::Kobo => token.to_owned(),
        }
    }
}

pub(crate) fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn hash(secret: &str) -> String {
    hex(&Sha256::digest(secret))
}

/// A new token for `kind` and the hash to store.
pub fn issue(kind: Kind) -> (String, String) {
    let token = format!("{PREFIX}{}", crate::config::random_hex(32));
    let stored = hash(&kind.secret(&token));
    (token, stored)
}

/// `fkd_` + 64 lowercase hex: anything else cannot be a token, so it costs no lookup.
pub fn well_formed(s: &str) -> bool {
    s.len() == TOKEN_LEN
        && s.strip_prefix(PREFIX).is_some_and(|h| {
            h.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

/// The owner and kind of the token `secret` when its kind opens the data plane through `source`; a hit stamps `lastUsedAt`.
pub async fn lookup(
    db: &PgPool,
    secret: &str,
    source: Source,
) -> Result<Option<(i32, Kind)>, sqlx::Error> {
    let kinds: Vec<&str> = Kind::ALL
        .into_iter()
        .filter(|k| k.sources().contains(&source))
        .map(Kind::as_str)
        .collect();
    let row: Option<(i32, String)> = sqlx::query_as(
        r#"UPDATE device_tokens SET "lastUsedAt" = now()
           WHERE "hash" = $1 AND "kind"::text = ANY($2) RETURNING "userId", "kind"::text"#,
    )
    .bind(hash(secret))
    .bind(&kinds)
    .fetch_optional(db)
    .await?;
    Ok(row.and_then(|(owner, k)| Some((owner, Kind::parse(&k)?))))
}

/// The owner of the `kosync` row whose token has the MD5 `key` (`kosync.md` rule 3); a hit stamps `lastUsedAt`.
pub async fn kosync_owner(db: &PgPool, key: &str) -> Result<Option<i32>, sqlx::Error> {
    sqlx::query_scalar(
        r#"UPDATE device_tokens SET "lastUsedAt" = now()
           WHERE "hash" = $1 AND "kind" = 'kosync' RETURNING "userId""#,
    )
    .bind(hash(key))
    .fetch_optional(db)
    .await
}

/// `(row id, owner)` of the `kobo` token `token` (`kobo.md` rule 1); `lastUsedAt` is stamped at most once a minute.
pub async fn kobo_owner(db: &PgPool, token: &str) -> Result<Option<(i32, i32)>, sqlx::Error> {
    let row: Option<(i32, i32, bool)> = sqlx::query_as(
        r#"SELECT id, "userId", ("lastUsedAt" IS NULL OR "lastUsedAt" < now() - interval '1 minute')
           FROM device_tokens WHERE "hash" = $1 AND "kind" = 'kobo'"#,
    )
    .bind(hash(token))
    .fetch_optional(db)
    .await?;
    let Some((id, owner, stale)) = row else {
        return Ok(None);
    };
    if stale {
        sqlx::query(r#"UPDATE device_tokens SET "lastUsedAt" = now() WHERE id = $1"#)
            .bind(id)
            .execute(db)
            .await?;
    }
    Ok(Some((id, owner)))
}

/// Whether some kind opens the data plane through `source`.
pub fn accepts(source: Source) -> bool {
    Kind::ALL.iter().any(|k| k.sources().contains(&source))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_hash_is_stored_and_kosync_hashes_the_md5_of_the_token() {
        let (token, stored) = issue(Kind::Opds);
        assert!(well_formed(&token));
        assert_eq!(stored.len(), 64);
        assert!(!stored.contains(&token));
        assert_eq!(stored, hash(&token));
        let (token, stored) = issue(Kind::Kosync);
        let md5 = hex(&Md5::digest(&token));
        assert_eq!(stored, hash(&md5));
        assert_ne!(stored, hash(&token));
        assert!(!well_formed(&md5), "the x-auth-key is no token");
    }

    #[test]
    fn tokens_are_random_and_shaped() {
        assert_ne!(issue(Kind::Opds).0, issue(Kind::Opds).0);
        let good = format!("{PREFIX}{}", "a".repeat(64));
        assert!(well_formed(&good));
        for bad in [
            "",
            "fkd_",
            &good[..TOKEN_LEN - 1],
            &format!("{good}0"),
            &good.to_uppercase(),
            &format!("{PREFIX}{}", "g".repeat(64)),
            &format!("xxx_{}", "a".repeat(64)),
        ] {
            assert!(!well_formed(bad), "{bad:?}");
        }
    }

    #[test]
    fn opds_opens_the_data_plane_through_basic_and_kobo_through_the_path() {
        assert!(accepts(Source::Basic) && accepts(Source::Path));
        for s in [Source::Cookie, Source::Bearer, Source::Query] {
            assert!(!accepts(s), "{s:?}");
        }
        assert_eq!(Kind::Kobo.sources(), &[Source::Path]);
        assert!(Kind::Kosync.sources().is_empty());
        assert_eq!(Kind::parse("opds"), Some(Kind::Opds));
        assert_eq!(Kind::parse("kobo"), Some(Kind::Kobo));
        assert_eq!(Kind::parse("nope"), None);
    }
}
