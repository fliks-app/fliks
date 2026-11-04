//! One way to create a media from a provider id, whatever its kind (`docs/spec/media-write.md` rule 25).
use super::{
    book_import::create_book_from,
    comic_import::create_comic_from,
    import::{Import, Target, import_title},
    resolve_profile,
};
use crate::{http::AppError, state::AppState};
use fliks_domain::{
    external_id::Namespace,
    media::{kind::MediaKind, wants::WantSpec},
    metadata::limiter::Priority,
};

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
