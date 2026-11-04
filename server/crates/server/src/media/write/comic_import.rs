//! `POST /api/media/import` for a comic volume (`docs/spec/comics.md` rule 41).
use super::{
    body::Body,
    identified::Creation,
    import::{creation_folder, resolve_target},
};
use crate::{
    events::DomainEvent,
    http::{AppError, auth::Authed},
    libraries::{accessible_library_ids, paths_visible},
    media::{
        comics,
        external_ids::{self, Link},
        hydrate,
        items::{self, NewWant},
    },
    metadata::comics::{fetch, routes::comic_provider, write},
    state::AppState,
};
use axum::{Json, http::StatusCode};
use fliks_domain::{media::kind::MediaKind, metadata::limiter::Priority};
use serde_json::Value;

const FIELDS: [&str; 5] = ["type", "provider", "externalId", "libraryId", "folderId"];
const TAKEN: &str = "This title is already in the library";

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
    let user = c.user;
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
    let mut tx = st.db.begin().await?;
    let media: i32 = sqlx::query_scalar(
        r#"INSERT INTO media (title, "originalTitle", year, type, status, monitored, "libraryId",
             "folderName", "addedById", "preferredProvider")
           VALUES ($1, $1, $2, 'comic', 'released', true, $3, $4, $5, $6)
           RETURNING id"#,
    )
    .bind(&title)
    .bind(fetched.work.year)
    .bind(c.target.id)
    .bind(&folder_name)
    .bind(user)
    .bind(ns.as_str())
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        if e.as_database_error().and_then(|d| d.code()).as_deref() == Some("23505") {
            AppError::conflict(TAKEN)
        } else {
            e.into()
        }
    })?;
    items::create_shell(
        &mut tx,
        media,
        MediaKind::Comic,
        NewWant {
            quality_profile_id: None,
            folder_id: c.target.folder_id,
        },
    )
    .await?;
    let linked = external_ids::link(&mut tx, media, MediaKind::Comic, ns, id).await?;
    for (n, v) in &c.links {
        external_ids::link(&mut tx, media, MediaKind::Comic, *n, v).await?;
    }
    tx.commit().await?;

    let undo = async |e: AppError| {
        if let Err(d) = sqlx::query!("DELETE FROM media WHERE id = $1", media)
            .execute(&st.db)
            .await
        {
            tracing::warn!("comic #{media} left behind after a failed import: {d}");
        }
        e
    };
    if linked != Link::Linked {
        return Err(undo(AppError::conflict(TAKEN)).await);
    }
    if let Err(e) = write(st, media, ns, &fetched).await {
        return Err(undo(e).await);
    }
    tracing::info!(
        "Imported comic \"{title}\" (#{media}) into library #{}",
        c.target.id
    );
    st.hub.emit_domain(DomainEvent::MediaImported {
        media_id: i64::from(media),
        external_ids: external_ids::refs(&st.db, media).await?,
        media_type: MediaKind::Comic,
        library_id: Some(i64::from(c.target.id)),
        added_by_user_id: user.map(i64::from),
    });
    Ok(media)
}
