//! `media.resolveOrCreate` (`plugins.md` rule 57).
use super::*;
use crate::media::{external_ids, write::import_for_request};
use crate::plugins::imports::{db_err, host_err};
use crate::plugins::runtime::HostError;
use crate::requests::{TitleKey, lock_title};
use fliks_domain::external_id::ExternalProvider;

const TMDB: ExternalProvider = ExternalProvider::Tmdb;

/// The media of the work `ids` name, imported when the library has none.
pub async fn resolve_or_create(
    st: &AppState,
    kind: &str,
    ids: &[t::ExternalId],
    library_id: Option<u32>,
) -> Result<u32, HostError> {
    let kind = MediaKind::parse(kind)
        .filter(|k| k.families().contains(&Family::Video))
        .ok_or_else(|| host_err("unsupported-kind", format!("kind \"{kind}\" is not served")))?;
    let tmdb = ids
        .iter()
        .find(|i| i.provider == TMDB.as_str())
        .ok_or_else(|| {
            host_err(
                "unsupported-provider",
                "a tmdb id is needed to name the work",
            )
        })?;
    let tmdb: i32 = TMDB
        .normalize(&tmdb.value)
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| host_err("ERR_VALIDATION", "tmdb id is not a canonical integer"))?;
    let library = library_id
        .map(i32::try_from)
        .transpose()
        .map_err(|_| host_err("ERR_VALIDATION", "libraryId is out of range"))?;
    let mut tx = st.db.begin().await.map_err(db_err)?;
    sqlx::query("SET LOCAL lock_timeout = 30000")
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    lock_title(&mut tx, &TitleKey::tmdb(kind, tmdb))
        .await
        .map_err(lock_err)?;
    let found = external_ids::find_numeric(&mut *tx, kind, TMDB, tmdb).await;
    let id = match found.map_err(db_err)? {
        Some(id) => id,
        None => create(st, kind, tmdb, library).await?,
    };
    tx.commit().await.map_err(db_err)?;
    Ok(id as u32)
}

/// A lock wait past `lock_timeout` is the call's own timeout, not a database fault.
fn lock_err(e: sqlx::Error) -> HostError {
    if e.as_database_error().and_then(|d| d.code()).as_deref() == Some("55P03") {
        return host_err("ERR_TIMEOUT", "another create of this title holds the lock");
    }
    db_err(e)
}

async fn create(
    st: &AppState,
    kind: MediaKind,
    tmdb: i32,
    library: Option<i32>,
) -> Result<i32, HostError> {
    if !st.metadata.available(TMDB) {
        return Err(host_err("unsupported-provider", "TMDB is not configured"));
    }
    match import_for_request(st, kind, tmdb, (None, None), library, None, None).await {
        Ok(id) => Ok(id),
        // Held by an import that does not take the title lock: the media exists now.
        Err(e) if e.status() == 409 => external_ids::find_numeric(&st.db, kind, TMDB, tmdb)
            .await
            .map_err(db_err)?
            .ok_or_else(|| {
                host_err(
                    "ERR_CONFLICT",
                    format!(
                        "an id of provider \"{TMDB}\" is held by another media of kind \"{kind}\""
                    ),
                )
            }),
        Err(e) => Err(host_err(
            match e.status().as_u16() {
                400 => "ERR_VALIDATION",
                404 => "ERR_NOT_FOUND",
                _ => "ERR",
            },
            e.text(),
        )),
    }
}
