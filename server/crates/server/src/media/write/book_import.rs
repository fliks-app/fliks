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
    media::wants::{MAX_WANTS, WantSpec, parse_wants},
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
const NOT_READABLE: &str = "errors.book_library_not_accessible";

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
    if let Some(w) = &wants {
        wants::check_profiles(&st.db, w).await?;
    }
    let id = create_book(
        st,
        &NewBook {
            target: &target,
            folder,
            user: Some(a.user.id).filter(|u| *u != 0),
            work: &work,
            prio: Priority::Interactive,
            wants: wants.as_deref(),
            discovered: false,
        },
    )
    .await?;
    let acl = accessible_library_ids(&st.db, a).await?;
    let mut media = hydrate::detail_for(&st.db, id, paths_visible(&a.perms), Some(&acl))
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    media["book"] = books::detail(&st.db, id, a.user.id, &acl).await?;
    Ok((StatusCode::CREATED, Json(media)))
}

/// What `create_book` makes: the anchor `work` in `target`, wished with `wants` (default: one per family),
/// added by `user`; `discovered` also writes the `discovered_works` ledger row with the media.
pub(crate) struct NewBook<'a> {
    pub target: &'a Target,
    pub folder: Option<i32>,
    pub user: Option<i32>,
    pub work: &'a str,
    pub prio: Priority,
    pub wants: Option<&'a [WantSpec]>,
    pub discovered: bool,
}

/// Creates the book from its provider record; a failure after the row exists deletes it.
pub(crate) async fn create_book(st: &AppState, new: &NewBook<'_>) -> Result<i32, AppError> {
    let NewBook {
        target,
        folder,
        user,
        work,
        prio,
        wants,
        discovered,
    } = *new;
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
        wants::replace(&mut tx, id, w)
            .await
            .map_err(|e| wants::write_error(e, id))?;
    }
    if discovered {
        sqlx::query(
            r#"INSERT INTO discovered_works (provider, value, "mediaId") VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(ANCHOR.as_str())
        .bind(work)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let undo = async |e: AppError| {
        if let Err(d) = sqlx::query(r#"DELETE FROM discovered_works WHERE "mediaId" = $1"#)
            .bind(id)
            .execute(&st.db)
            .await
        {
            tracing::warn!("ledger row of book #{id} left behind: {d}");
        }
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

/// A book request approval: the work in the request's library with the requested editions wished; a work
/// already in the library gets the missing ones added to its wants. `readable` is the requester's library
/// scope: an existing work outside it is refused.
pub async fn import_book_for_request(
    st: &AppState,
    work: &str,
    wants: &[WantSpec],
    (library, folder): (Option<i32>, Option<i32>),
    (added_by, readable): (Option<i32>, &[i32]),
) -> Result<i32, AppError> {
    if let Some(id) = add_to_existing(st, work, wants, readable).await? {
        return Ok(id);
    }
    let all = super::all_library_ids(&st.db).await?;
    let target = super::resolve_target_in(st, &all, MediaKind::Book, library, folder).await?;
    let created = create_book(
        st,
        &NewBook {
            target: &target,
            folder,
            user: added_by.filter(|u| *u != 0),
            work,
            prio: Priority::Interactive,
            wants: Some(wants),
            discovered: false,
        },
    )
    .await;
    match created {
        // lost a race with another import of the work: it is there now
        Err(e) if e.status() == StatusCode::CONFLICT => {
            add_to_existing(st, work, wants, readable).await?.ok_or(e)
        }
        r => r,
    }
}

/// Adds the wants the work lacks when it is already in the library, under its row lock; the union stays
/// within `MAX_WANTS`. A work in a library outside `readable` is 403.
async fn add_to_existing(
    st: &AppState,
    work: &str,
    wants: &[WantSpec],
    readable: &[i32],
) -> Result<Option<i32>, AppError> {
    let Some(id) = external_ids::find(&st.db, MediaKind::Book, ANCHOR, work).await? else {
        return Ok(None);
    };
    let mut tx = st.db.begin().await?;
    let library: Option<Option<i32>> =
        sqlx::query_scalar(r#"SELECT "libraryId" FROM media WHERE id = $1 FOR UPDATE"#)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(library) = library else {
        return Ok(None);
    };
    if !library.is_some_and(|l| readable.contains(&l)) {
        return Err(AppError::forbidden(NOT_READABLE));
    }
    let held: Vec<(String, Option<String>)> =
        sqlx::query_as(r#"SELECT family, language FROM wants WHERE "mediaId" = $1"#)
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    let missing: Vec<WantSpec> = wants
        .iter()
        .filter(|w| {
            !held
                .iter()
                .any(|(f, l)| *f == w.family.as_str() && *l == w.language)
        })
        .cloned()
        .collect();
    if held.len() + missing.len() > MAX_WANTS {
        return Err(AppError::bad_request(format!(
            "the book would hold more than {MAX_WANTS} wants"
        )));
    }
    if !missing.is_empty() {
        wants::add(&mut tx, id, &missing)
            .await
            .map_err(|e| wants::write_error(e, id))?;
    }
    tx.commit().await?;
    Ok(Some(id))
}
