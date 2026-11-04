//! `POST /api/media/import` for a comic volume (`docs/spec/comics.md` rule 41).
use super::{
    body::Body,
    identified::{Creation, Row, TAKEN, announce, discard, insert_row},
    import::{creation_folder, resolve_target},
};
use crate::{
    http::{AppError, auth::Authed},
    libraries::{accessible_library_ids, paths_visible},
    media::{
        comics,
        external_ids::{self, Link},
        hydrate,
    },
    metadata::comics::{fetch, routes::comic_provider, write},
    state::AppState,
};
use axum::{Json, http::StatusCode};
use fliks_domain::{media::kind::MediaKind, metadata::limiter::Priority};
use serde_json::Value;

const FIELDS: [&str; 5] = ["type", "provider", "externalId", "libraryId", "folderId"];

pub(super) async fn import_comic(
    st: &AppState,
    a: &Authed,
    v: Value,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let b = Body::new(v, &FIELDS)?;
    let name = b.required(b.str("provider")?, "provider", "must be a string")?;
    let external = b.required(b.str("externalId")?, "externalId", "must be a string")?;
    let (library, folder) = (b.id("libraryId")?.flatten(), b.id("folderId")?.flatten());
    let ns = comic_provider(&st.metadata, &name)?;
    let id = ns
        .normalize(&external)
        .ok_or_else(|| AppError::bad_request(vec![format!("externalId is not a {name} id")]))?;
    if external_ids::find(&st.db, MediaKind::Comic, ns, &id)
        .await?
        .is_some()
    {
        return Err(AppError::conflict(TAKEN));
    }
    let target = resolve_target(st, a, MediaKind::Comic, library, folder).await?;
    let media = create_comic_from(
        st,
        &Creation {
            kind: MediaKind::Comic,
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
    let mut out = hydrate::detail_for(&st.db, media, paths_visible(&a.perms), Some(&acl))
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(media))?;
    out["comic"] = comics::detail(&st.db, media, a.user.id, &acl).await?;
    Ok((StatusCode::CREATED, Json(out)))
}

/// Creates the comic volume from its provider record; a failure after the row exists deletes it.
pub(crate) async fn create_comic_from(st: &AppState, c: &Creation<'_>) -> Result<i32, AppError> {
    let (ns, id) = c.id;
    let lang = crate::metadata::library_language(st, c.target.id).await?;
    let fetched = fetch(st, ns, id, &lang, c.prio).await?;
    let title = fetched.work.title.clone();
    let folder_name = creation_folder(
        st,
        MediaKind::Comic,
        &title,
        fetched.work.year.map(i64::from),
    )
    .await?;
    let same: Option<i32> = sqlx::query_scalar(
        r#"SELECT id FROM media WHERE type = 'comic' AND "libraryId" = $1 AND "folderName" = $2 LIMIT 1"#,
    )
    .bind(c.target.id)
    .bind(&folder_name)
    .fetch_optional(&st.db)
    .await?;
    if let Some(other) = same {
        return Err(AppError::conflict(format!(
            "{TAKEN}: identify comic #{other} against this provider instead"
        )));
    }
    let row = Row {
        kind: MediaKind::Comic,
        title: &title,
        year: fetched.work.year,
        folder: &folder_name,
        overview: None,
        provider: Some(ns),
        refreshed: false,
    };
    let (media, mut tx) = insert_row(st, &row, c.target, c.user, &c.links, None).await?;
    if external_ids::link(&mut tx, media, MediaKind::Comic, ns, id).await? != Link::Linked {
        return Err(AppError::conflict(TAKEN));
    }
    tx.commit().await?;
    if let Err(e) = write(st, media, ns, &fetched).await {
        discard(st, media, MediaKind::Comic).await;
        return Err(e);
    }
    announce(st, (media, MediaKind::Comic, &title), c.target.id, c.user).await?;
    Ok(media)
}
