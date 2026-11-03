//! `media.resolveOrCreate` (`plugins.md` rule 57).
use super::*;
use crate::media::{
    external_ids,
    write::{book_import, import_in},
};
use crate::metadata::books::ANCHOR;
use crate::plugins::imports::{db_err, host_err};
use crate::plugins::runtime::HostError;
use crate::requests::{TitleKey, lock_titles};
use fliks_domain::external_id::Namespace;

/// The media of the work `ids` name, imported when the library has none.
pub async fn resolve_or_create(
    st: &AppState,
    plugin_id: &str,
    kind: &str,
    ids: &[t::ExternalId],
    library_id: Option<u32>,
    folder_id: Option<u32>,
) -> Result<u32, HostError> {
    let kind = MediaKind::parse(kind)
        .filter(|k| k.families().contains(&Family::Video) || *k == MediaKind::Book)
        .ok_or_else(|| host_err("unsupported-kind", format!("kind \"{kind}\" is not served")))?;
    let entries = served_entries(st, kind, ids)?;
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
    let keys: Vec<TitleKey> = entries
        .iter()
        .map(|(ns, value)| TitleKey {
            media_type: kind,
            provider: *ns,
            external_id: value.clone(),
        })
        .collect();
    lock_titles(&mut tx, &keys).await.map_err(lock_err)?;
    let mut found = None;
    for (ns, value) in &entries {
        found = external_ids::find(&mut *tx, kind, *ns, value)
            .await
            .map_err(db_err)?;
        if found.is_some() {
            break;
        }
    }
    let id = match found {
        Some(id) => id,
        None => {
            // Creating under the plugin's namespace now would leave a duplicate once the anchor is back.
            if kind == MediaKind::Book
                && entries.iter().any(|(ns, _)| *ns == ANCHOR)
                && !st.metadata.available(ANCHOR)
            {
                return Err(host_err("unavailable", "the work provider is unavailable"));
            }
            // Rule 31: created through a core entry or one of the caller's own namespaces, which
            // also links the caller's other own entries; the found path changes nothing.
            let own = |ns: &Namespace| {
                ns.core().is_some() || ns.as_str().split(':').next() == Some(plugin_id)
            };
            if !entries.iter().any(|(ns, _)| own(ns)) {
                return Err(host_err(
                    "namespace-not-owned",
                    "namespace not owned by the caller",
                ));
            }
            let Some((ns, value)) = entries
                .iter()
                .find(|(ns, _)| own(ns) && st.metadata.available(*ns))
            else {
                return Err(host_err(
                    "unsupported-provider",
                    "the provider is not available",
                ));
            };
            let links = entries
                .iter()
                .filter(|(n, v)| n.core().is_none() && own(n) && (n, v) != (ns, value))
                .cloned()
                .collect();
            create(st, kind, (*ns, value), (library, folder), links).await?
        }
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
    links: Vec<(Namespace, String)>,
) -> Result<i32, HostError> {
    let created = if kind == MediaKind::Book {
        book_import::create_for_plugin(st, (ns, value), (library, folder), links).await
    } else {
        import_in(
            st,
            kind,
            (ns, value),
            (None, None),
            (library, folder),
            None,
            (None, links),
        )
        .await
    };
    match created {
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

/// Rule 57: the ids of served namespaces, normalised, unique core namespaces first; only
/// creating needs the provider available.
fn served_entries(
    st: &AppState,
    kind: MediaKind,
    ids: &[t::ExternalId],
) -> Result<Vec<(Namespace, String)>, HostError> {
    let served = |ns: Namespace| st.metadata.get(ns).is_some_and(|p| p.supports(kind));
    let parsed: Vec<(Namespace, Option<String>)> = ids
        .iter()
        .filter_map(|i| Some((Namespace::parse(&i.provider)?, i.value.as_str())))
        .filter(|(ns, _)| served(*ns))
        .map(|(ns, v)| (ns, ns.normalize(v)))
        .collect();
    let mut known: Vec<(Namespace, String)> = parsed
        .iter()
        .filter_map(|(ns, v)| Some((*ns, v.clone()?)))
        .collect();
    known.sort_by_key(|(ns, _)| !ns.is_unique());
    // One id per namespace: a media holds one of each (`media_external_ids` is unique by it).
    let mut seen = std::collections::HashSet::new();
    known.retain(|(ns, _)| seen.insert(*ns));
    if known.is_empty() && !parsed.is_empty() {
        return Err(host_err(
            "ERR_VALIDATION",
            "an id is not valid for its namespace",
        ));
    }
    if known.is_empty() {
        return Err(host_err(
            "unsupported-provider",
            "no id names the work for an available provider",
        ));
    }
    Ok(known)
}
