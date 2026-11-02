//! `media.resolveOrCreate` (`plugins.md` rule 57).
use super::*;
use crate::media::{external_ids, write::import_in};
use crate::plugins::imports::{db_err, host_err};
use crate::plugins::runtime::HostError;
use crate::requests::{TitleKey, lock_title};
use fliks_domain::external_id::Namespace;

/// The media of the work `ids` name, imported when the library has none.
pub async fn resolve_or_create(
    st: &AppState,
    kind: &str,
    ids: &[t::ExternalId],
    library_id: Option<u32>,
    folder_id: Option<u32>,
) -> Result<u32, HostError> {
    let kind = MediaKind::parse(kind)
        .filter(|k| k.families().contains(&Family::Video))
        .ok_or_else(|| host_err("unsupported-kind", format!("kind \"{kind}\" is not served")))?;
    let (ns, value) = entry(st, kind, ids)?;
    let library = library_id
        .map(i32::try_from)
        .transpose()
        .map_err(|_| host_err("ERR_VALIDATION", "libraryId is out of range"))?;
    let folder = folder_id
        .map(i32::try_from)
        .transpose()
        .map_err(|_| host_err("ERR_VALIDATION", "folderId is out of range"))?;
    let mut tx = st.db.begin().await.map_err(db_err)?;
    sqlx::query("SET LOCAL lock_timeout = 30000")
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    lock_title(
        &mut tx,
        &TitleKey {
            media_type: kind,
            provider: ns,
            external_id: value.clone(),
        },
    )
    .await
    .map_err(lock_err)?;
    let found = external_ids::find(&mut *tx, kind, ns, &value).await;
    let id = match found.map_err(db_err)? {
        Some(id) => id,
        None => create(st, kind, (ns, &value), (library, folder)).await?,
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
    (ns, value): (Namespace, &str),
    (library, folder): (Option<i32>, Option<i32>),
) -> Result<i32, HostError> {
    if !st.metadata.available(ns) {
        return Err(host_err(
            "unsupported-provider",
            "the provider is not available",
        ));
    }
    match import_in(
        st,
        kind,
        (ns, value),
        (None, None),
        (library, folder),
        None,
        None,
    )
    .await
    {
        Ok(id) => Ok(id),
        // Held by an import that does not take the title lock: the media exists now.
        Err(e) if e.status() == 409 => external_ids::find(&st.db, kind, ns, value)
            .await
            .map_err(db_err)?
            .ok_or_else(|| {
                host_err(
                    "ERR_CONFLICT",
                    format!(
                        "an id of provider \"{ns}\" is held by another media of kind \"{kind}\""
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

/// Rule 57: the first id of a unique core namespace an available provider serves, else the first
/// id of any namespace an available provider serves for `kind`; each id normalised by its namespace.
fn entry(
    st: &AppState,
    kind: MediaKind,
    ids: &[t::ExternalId],
) -> Result<(Namespace, String), HostError> {
    let served = |ns: Namespace| {
        st.metadata.available(ns) && st.metadata.get(ns).is_some_and(|p| p.supports(kind))
    };
    let parsed: Vec<(Namespace, Option<String>)> = ids
        .iter()
        .filter_map(|i| Some((Namespace::parse(&i.provider)?, i.value.as_str())))
        .map(|(ns, v)| (ns, ns.normalize(v)))
        .collect();
    let known: Vec<(Namespace, String)> = parsed
        .iter()
        .filter_map(|(ns, v)| Some((*ns, v.clone()?)))
        .collect();
    let picked = known
        .iter()
        .find(|(ns, _)| ns.is_unique() && served(*ns))
        .or_else(|| known.iter().find(|(ns, _)| served(*ns)))
        .cloned();
    if picked.is_none() && parsed.iter().any(|(ns, v)| v.is_none() && served(*ns)) {
        return Err(host_err(
            "ERR_VALIDATION",
            "an id is not valid for its namespace",
        ));
    }
    picked.ok_or_else(|| {
        host_err(
            "unsupported-provider",
            "no id names the work for an available provider",
        )
    })
}
