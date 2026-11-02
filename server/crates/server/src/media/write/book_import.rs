//! `POST /api/media/import` for a book (`docs/spec/book-metadata.md` rule 21).
use super::{
    body::Body,
    import::{Target, folder_format, resolve_target},
};
use crate::{
    events::DomainEvent,
    http::{AppError, auth::Authed},
    libraries::{accessible_library_ids, paths_visible},
    media::{
        books,
        external_ids::{self},
        hydrate,
        items::{self, NewWant},
        wants,
    },
    metadata::{
        Override, Upstream,
        books::{
            ANCHOR,
            identify::BookMatch,
            link::{attach, stored},
            text, work_id,
        },
        {fail, unavailable},
    },
    state::AppState,
};
use axum::{Json, http::StatusCode};
use fliks_domain::{
    media::kind::MediaKind,
    media::wants::{WantSpec, parse_wants},
    metadata::limiter::Priority,
    naming::{self, BookNameTokens, validate_folder_path},
};
use serde_json::Value;

const FIELDS: [&str; 6] = [
    "type",
    "provider",
    "externalId",
    "libraryId",
    "folderId",
    "wants",
];
const TAKEN: &str = "This title is already in the library";

pub(super) async fn import_book(
    st: &AppState,
    a: &Authed,
    v: Value,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let b = Body::new(v, &FIELDS)?;
    let bad = |m: &str| AppError::bad_request(vec![m.to_owned()]);
    let provider = b.required(b.str("provider")?, "provider", "must be a string")?;
    if provider != ANCHOR.as_str() {
        return Err(AppError::bad_request(vec![format!(
            "provider must be one of the following values: {}",
            ANCHOR.as_str()
        )]));
    }
    let external = b.required(b.str("externalId")?, "externalId", "must be a string")?;
    let work =
        work_id(&external).ok_or_else(|| bad("externalId must be an Open Library work id"))?;
    let (library, folder) = (b.id("libraryId")?.flatten(), b.id("folderId")?.flatten());
    if external_ids::find(&st.db, MediaKind::Book, ANCHOR, &work)
        .await?
        .is_some()
    {
        return Err(AppError::conflict(TAKEN));
    }
    let target = resolve_target(st, a, MediaKind::Book, library, folder).await?;

    let wants = match b.0.get("wants") {
        None => None,
        Some(w) => Some(parse_wants(w, MediaKind::Book).map_err(|m| bad(&m))?),
    };
    let id = create_book(
        st,
        &target,
        folder,
        Some(a.user.id).filter(|u| *u != 0),
        &work,
        Priority::Interactive,
        wants.as_deref(),
    )
    .await?;
    let acl = accessible_library_ids(&st.db, a).await?;
    let mut media = hydrate::detail_for(&st.db, id, paths_visible(&a.perms), Some(&acl))
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    media["book"] = books::detail(&st.db, id, a.user.id, &acl).await?;
    Ok((StatusCode::CREATED, Json(media)))
}

/// Creates the book of an anchor work in `target` from its provider record, wished with `wants` (default: one
/// per family) and added by `user`. A failure after the row exists deletes it.
pub(crate) async fn create_book(
    st: &AppState,
    target: &Target,
    folder: Option<i32>,
    user: Option<i32>,
    work: &str,
    prio: Priority,
    wants: Option<&[WantSpec]>,
) -> Result<i32, AppError> {
    let over = sqlx::query!(
        r#"SELECT "metadataLanguage" AS language, "metadataRegion" AS region FROM libraries WHERE id = $1"#,
        target.id
    )
    .fetch_one(&st.db)
    .await?;
    let lang = st
        .metadata
        .lang
        .resolve(Some(&Override {
            language: over.language,
            region: over.region,
        }))
        .await?;
    let meta_fail = |e| match e {
        crate::metadata::MetaError::Upstream(e) => fail(ANCHOR, &e, true),
        crate::metadata::MetaError::Db(e) => e.into(),
    };
    if !st.metadata.available(ANCHOR) {
        return Err(unavailable(
            "request",
            ANCHOR,
            &Upstream::new(None, "the work provider is unavailable"),
        ));
    }
    let Value::Object(record) = st
        .metadata
        .work(ANCHOR, MediaKind::Book, work, &lang, prio)
        .await
        .map_err(meta_fail)?
    else {
        return Err(unavailable(
            "request",
            ANCHOR,
            &Upstream::new(None, "unexpected work record"),
        ));
    };
    let Some(title) = text(&record, "title") else {
        return Err(unavailable(
            "request",
            ANCHOR,
            &Upstream::new(None, "the work has no title"),
        ));
    };
    let year = record
        .get("year")
        .and_then(Value::as_i64)
        .filter(|y| (1..=9999).contains(y));
    let format = folder_format(&st.db, MediaKind::Book).await?;
    let name = naming::apply_book_format(
        &format,
        &BookNameTokens {
            title: title.clone(),
            year,
            ..Default::default()
        },
    );
    let name = validate_folder_path(&name)
        .map_err(|_| AppError::bad_request(format!("Invalid folder name for \"{title}\"")))?
        .to_owned();

    let mut tx = st.db.begin().await?;
    let id = sqlx::query_scalar!(
        r#"INSERT INTO media (title, "originalTitle", year, type, status, monitored, "libraryId",
             "folderName", "addedById")
           VALUES ($1, $1, $2, 'book', 'released', true, $3, $4, $5)
           RETURNING id"#,
        title,
        year.map(|y| y as i32),
        target.id,
        name,
        user
    )
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
        id,
        MediaKind::Book,
        NewWant {
            quality_profile_id: None,
            folder_id: folder,
        },
    )
    .await?;
    if let Some(w) = wants {
        wants::replace(&mut tx, id, w).await?;
    }
    tx.commit().await?;

    let undo = async |e: AppError| {
        if let Err(d) = sqlx::query!("DELETE FROM media WHERE id = $1", id)
            .execute(&st.db)
            .await
        {
            tracing::warn!("book #{id} left behind after a failed import: {d}");
        }
        e
    };
    let m = BookMatch {
        work: work.to_owned(),
        edition: vec![],
        confidence: 100,
    };
    if let Err(e) = attach(st, id, None, &m, prio).await {
        return Err(undo(meta_fail(e)).await);
    }
    match stored(&st.db, id, None).await {
        Ok(Some(m)) if m.work == work => {}
        Ok(_) => return Err(undo(AppError::conflict(TAKEN)).await),
        Err(e) => return Err(undo(e.into()).await),
    }
    tracing::info!(
        "Imported book \"{title}\" (#{id}) into library #{}",
        target.id
    );
    st.hub.emit_domain(DomainEvent::MediaImported {
        media_id: i64::from(id),
        external_ids: external_ids::refs(&st.db, id).await?,
        media_type: MediaKind::Book,
        library_id: Some(i64::from(target.id)),
        added_by_user_id: user.map(i64::from),
    });
    Ok(id)
}
