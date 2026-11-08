//! `POST /api/media/import` for an album: a release group of a music provider (`docs/spec/music.md` rule 31).
use super::{
    body::Body,
    identified::{Creation, Row, TAKEN, announce, discard, insert_row},
    import::{creation_folder, resolve_target},
};
use crate::{
    http::{AppError, auth::Authed},
    libraries::{accessible_library_ids, paths_visible},
    media::{
        external_ids::{self, Link},
        hydrate,
    },
    metadata::music::{Written, fetch, write_album},
    state::AppState,
};
use axum::{Json, http::StatusCode};
use fliks_domain::{media::kind::MediaKind, metadata::limiter::Priority, naming};
use serde_json::Value;

const FIELDS: [&str; 5] = ["type", "provider", "externalId", "libraryId", "folderId"];

pub(super) async fn import_album(
    st: &AppState,
    a: &Authed,
    v: Value,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let b = Body::new(v, &FIELDS)?;
    let name = b.required(b.str("provider")?, "provider", "must be a string")?;
    let external = b.required(b.str("externalId")?, "externalId", "must be a string")?;
    let (library, folder) = (b.id("libraryId")?.flatten(), b.id("folderId")?.flatten());
    let known = st.namespaces();
    let ns = known
        .parse(&name)
        .filter(|n| st.metadata.serves(*n, MediaKind::Album))
        .ok_or_else(|| {
            AppError::bad_request(format!(
                "provider must be one of the following values: {name}"
            ))
        })?;
    let id = known
        .normalize(ns, &external)
        .ok_or_else(|| AppError::bad_request(vec![format!("externalId is not a {name} id")]))?;
    if external_ids::find(&st.db, MediaKind::Album, ns, &id)
        .await?
        .is_some()
    {
        return Err(AppError::conflict(TAKEN));
    }
    let target = resolve_target(st, a, MediaKind::Album, library, folder).await?;
    let media = create_album_from(
        st,
        &Creation {
            kind: MediaKind::Album,
            id: (ns, &id),
            target: &target,
            profiles: (None, None),
            user: Some(a.user.id).filter(|u| *u != 0),
            links: vec![],
            seasons: None,
            wants: None,
            prio: Priority::Interactive,
        },
    )
    .await?;
    let acl = accessible_library_ids(&st.db, a).await?;
    let out = hydrate::detail_for(&st.db, media, paths_visible(&a.perms), Some(&acl))
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(media))?;
    Ok((StatusCode::CREATED, Json(out)))
}

/// A folder component of a title or an artist: no separator, no dot at the ends.
fn component(s: &str) -> String {
    s.replace(['/', '\\'], "-")
        .trim()
        .trim_matches('.')
        .to_owned()
}

/// Creates the album from its release group; a failure after the row exists deletes it. The folder is the
/// title, then `Artist - Title` when a folder of that name is taken, until the naming scopes (acquisition).
pub(crate) async fn create_album_from(st: &AppState, c: &Creation<'_>) -> Result<i32, AppError> {
    let (ns, id) = c.id;
    let lang = crate::metadata::library_language(st, c.target.id).await?;
    let fetched = fetch(st, ns, id, &lang, c.prio).await?;
    let title = fetched.album.title.clone();
    let year = fetched.album.year.map(i64::from);
    let mut folder = creation_folder(st, MediaKind::Album, &title, year).await?;
    let taken = |folder: String| async move {
        sqlx::query_scalar::<_, i32>(
            r#"SELECT id FROM media WHERE type = 'album' AND "libraryId" = $1 AND "folderName" = $2 LIMIT 1"#,
        )
        .bind(c.target.id)
        .bind(folder)
        .fetch_optional(&st.db)
        .await
    };
    if taken(folder.clone()).await?.is_some() {
        let artist = fetched.album.artists.first().map(|a| component(&a.name));
        let named = format!("{} - {}", artist.unwrap_or_default(), component(&title));
        folder = naming::validate_folder_path(&named)
            .map(str::to_owned)
            .map_err(|_| AppError::bad_request(format!("Invalid folder name for \"{title}\"")))?;
        if taken(folder.clone()).await?.is_some() {
            return Err(AppError::conflict(format!(
                "{TAKEN}: a folder of that name exists"
            )));
        }
    }
    let row = Row {
        kind: MediaKind::Album,
        title: &title,
        year: fetched.album.year,
        folder: &folder,
        overview: None,
        provider: Some(ns),
        refreshed: false,
    };
    // The canonical id is what the album is linked to: a merged id the caller asked for becomes an alias.
    let canonical = fetched.album.external_id.clone();
    let (media, mut tx) = insert_row(st, &row, c.target, c.user, &c.links, None).await?;
    if external_ids::link(
        &mut tx,
        &st.namespaces(),
        media,
        MediaKind::Album,
        ns,
        &canonical,
    )
    .await?
        != Link::Linked
    {
        return Err(AppError::conflict(TAKEN));
    }
    tx.commit().await?;
    match write_album(st, media, ns, &fetched, &canonical, &lang, c.prio).await {
        Ok(Written::Done) => {}
        Ok(Written::Folded(_)) => {}
        Err(e) => {
            discard(st, media, MediaKind::Album).await;
            return Err(e);
        }
    }
    if canonical != id
        && let Err(e) = sqlx::query(
            r#"INSERT INTO media_external_id_aliases ("mediaId", kind, provider, value) VALUES ($1, 'album', $2, $3)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(media)
        .bind(ns.as_str())
        .bind(id)
        .execute(&st.db)
        .await
    {
        tracing::warn!("alias of album #{media} not kept: {e}");
    }
    announce(
        st,
        (media, MediaKind::Album, &title),
        c.target.id,
        (c.user, None),
    )
    .await?;
    Ok(media)
}
