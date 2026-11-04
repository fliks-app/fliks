//! One way to create a media from a provider id, whatever its kind (`docs/spec/media-write.md` rule 25).
use super::{
    book_import::create_book_from,
    comic_import::create_comic_from,
    import::{Import, Target, import_title},
    resolve_profile,
};
use crate::{
    events::DomainEvent,
    http::AppError,
    media::{
        external_ids,
        items::{self, NewWant},
        wants,
    },
    state::AppState,
};
use fliks_domain::{
    external_id::Namespace,
    media::{kind::MediaKind, wants::WantSpec},
    metadata::limiter::Priority,
};
use sqlx::{Postgres, Transaction};

pub(super) const TAKEN: &str = "This title is already in the library";

/// What `create_identified` makes: the `kind` media of the provider id `id` (already normalised), in
/// `target`, added by `user`.
pub struct Creation<'a> {
    pub kind: MediaKind,
    pub id: (Namespace, &'a str),
    pub target: &'a Target,
    /// Video only: the quality and language profiles, the library defaults when unset.
    pub profiles: (Option<i32>, Option<i32>),
    pub user: Option<i32>,
    /// Ids of other namespaces linked with the media before it is announced.
    pub links: Vec<(Namespace, String)>,
    /// Series only: the seasons to monitor, every one but the specials when unset.
    pub seasons: Option<Vec<i32>>,
    /// Book only: the wants, one per family when unset.
    pub wants: Option<&'a [WantSpec]>,
    pub prio: Priority,
}

/// The id of the media created from the provider id, through the creator of its kind. The caller has
/// resolved the target and checked that no media holds the id.
pub async fn create_identified(st: &AppState, c: &Creation<'_>) -> Result<i32, AppError> {
    match c.kind {
        MediaKind::Movie | MediaKind::Series => {
            let (ns, value) = c.id;
            let imp = Import {
                media_type: c.kind,
                library_id: c.target.id,
                folder_id: c.target.folder_id,
                quality_profile_id: resolve_profile(
                    &st.db,
                    false,
                    c.profiles.0,
                    c.target.default_quality,
                )
                .await?,
                language_profile_id: resolve_profile(
                    &st.db,
                    true,
                    c.profiles.1,
                    c.target.default_language,
                )
                .await?,
                added_by: c.user,
                monitored_seasons: c.seasons.clone(),
                links: c.links.clone(),
            };
            import_title(st, Some(ns.as_str().into()), value.to_owned(), imp, c.prio).await
        }
        MediaKind::Book => create_book_from(st, c).await,
        MediaKind::Comic => create_comic_from(st, c).await,
    }
}

/// The columns a book or a comic is created with.
pub(super) struct Row<'a> {
    pub kind: MediaKind,
    pub title: &'a str,
    pub year: Option<i32>,
    pub folder: &'a str,
    pub overview: Option<&'a str>,
    /// The provider the media is pinned to.
    pub provider: Option<Namespace>,
    pub refreshed: bool,
}

/// Inserts the row of a book or a comic with its wants and `links`, in a transaction left open for the
/// kind's own rows; a taken folder name is 409. `wants` default to one per family.
pub(super) async fn insert_row(
    st: &AppState,
    row: &Row<'_>,
    target: &Target,
    user: Option<i32>,
    links: &[(Namespace, String)],
    wants: Option<&[WantSpec]>,
) -> Result<(i32, Transaction<'static, Postgres>), AppError> {
    let mut tx = st.db.begin().await?;
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO media (title, "originalTitle", year, type, status, monitored, overview,
             "libraryId", "folderName", "preferredProvider", "metadataRefreshedAt", "addedById")
           VALUES ($1, $1, $2, $3, 'released', true, $4, $5, $6, $7,
             CASE WHEN $8 THEN now() END, $9)
           RETURNING id"#,
    )
    .bind(row.title)
    .bind(row.year)
    .bind(row.kind.as_str())
    .bind(row.overview)
    .bind(target.id)
    .bind(row.folder)
    .bind(row.provider.map(Namespace::as_str))
    .bind(row.refreshed)
    .bind(user)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        if e.as_database_error().and_then(|d| d.code()).as_deref() == Some("23505") {
            AppError::conflict(TAKEN)
        } else {
            e.into()
        }
    })?;
    let want = NewWant {
        quality_profile_id: None,
        folder_id: target.folder_id,
    };
    items::create_shell(&mut tx, id, row.kind, want).await?;
    for (ns, value) in links {
        external_ids::link(&mut tx, id, row.kind, *ns, value).await?;
    }
    if let Some(w) = wants {
        wants::replace(&mut tx, id, w)
            .await
            .map_err(|e| wants::write_error(e, id))?;
    }
    Ok((id, tx))
}

/// Deletes the media of a creation that failed after its commit.
pub(super) async fn discard(st: &AppState, id: i32, kind: MediaKind) {
    if let Err(e) = sqlx::query!("DELETE FROM media WHERE id = $1", id)
        .execute(&st.db)
        .await
    {
        tracing::warn!("{kind} #{id} left behind after a failed import: {e}");
    }
}

/// Logs and announces a media created in `library`.
pub(super) async fn announce(
    st: &AppState,
    (id, kind, title): (i32, MediaKind, &str),
    library: i32,
    user: Option<i32>,
) -> Result<(), AppError> {
    tracing::info!("Imported {kind} \"{title}\" (#{id}) into library #{library}");
    st.hub.emit_domain(DomainEvent::MediaImported {
        media_id: i64::from(id),
        external_ids: external_ids::refs(&st.db, id).await?,
        media_type: kind,
        library_id: Some(i64::from(library)),
        added_by_user_id: user.map(i64::from),
    });
    Ok(())
}
