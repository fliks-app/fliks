//! `POST /api/media/import` for a book (`docs/spec/book-metadata.md` rule 21).
use super::{
    body::Body,
    identified::{
        Creation, Row, TAKEN, announce, create_identified, discard, held_elsewhere, insert_row,
    },
    import::{Target, creation_folder, resolve_target},
};
use crate::{
    http::{AppError, auth::Authed},
    libraries::{accessible_library_ids, paths_visible},
    media::{
        books, editions,
        external_ids::{self, edition_id},
        hydrate, wants,
    },
    metadata::{
        Upstream,
        books::{
            ANCHOR,
            identify::{BookMatch, work_of},
            link::{attach, discovered, replace_credits, stored},
            merge, people, text, work_id,
        },
        {fail, unavailable},
    },
    state::AppState,
};
use axum::{Json, http::StatusCode};
use fliks_domain::external_id::Namespace;
use fliks_domain::{
    media::kind::MediaKind,
    media::{
        AUDIO_EXTS,
        family::Family,
        wants::{MAX_WANTS, WantSpec, parse_wants},
    },
    metadata::limiter::Priority,
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
const NOT_READABLE: &str = "errors.book_library_not_accessible";

pub(super) async fn import_book(
    st: &AppState,
    a: &Authed,
    v: Value,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let b = Body::new(v, &FIELDS)?;
    let bad = |m: &str| AppError::bad_request(vec![m.to_owned()]);
    let provider = b.required(b.str("provider")?, "provider", "must be a string")?;
    let ns = Namespace::parse(&provider)
        .filter(|n| *n == ANCHOR || st.metadata.serves(*n, MediaKind::Book))
        .ok_or_else(|| {
            let others = st.metadata.serving(MediaKind::Book);
            let mut served = vec![ANCHOR.as_str().to_owned()];
            for n in others.into_iter().map(Namespace::id_namespace) {
                if !served.iter().any(|s| s == n.as_str()) {
                    served.push(n.as_str().to_owned());
                }
            }
            bad(&format!(
                "provider must be one of the following values: {}",
                served.join(", ")
            ))
        })?;
    let external = b.required(b.str("externalId")?, "externalId", "must be a string")?;
    let id = match ns {
        ANCHOR => {
            work_id(&external).ok_or_else(|| bad("externalId must be an Open Library work id"))?
        }
        _ => ns
            .normalize(&external)
            .ok_or_else(|| bad(&format!("externalId is not a {provider} id")))?,
    };
    let (library, folder) = (b.id("libraryId")?.flatten(), b.id("folderId")?.flatten());
    let readable = accessible_library_ids(&st.db, a).await?;
    if held_book_in(&st.db, ns, &id, &readable).await?.is_some() {
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
    let id = create_identified(
        st,
        &Creation {
            kind: MediaKind::Book,
            id: (ns, &id),
            target: &target,
            profiles: (None, None),
            user: Some(a.user.id).filter(|u| *u != 0),
            links: vec![],
            seasons: None,
            wants: wants.as_deref(),
            prio: Priority::Interactive,
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
    pub user: Option<i32>,
    pub work: &'a str,
    pub prio: Priority,
    pub wants: Option<&'a [WantSpec]>,
    pub discovered: bool,
    /// Ids of the caller's own namespaces, linked with the media.
    pub links: &'a [(Namespace, String)],
}

/// Creates the book from its provider record; a failure after the row exists deletes it.
pub(crate) async fn create_book(st: &AppState, new: &NewBook<'_>) -> Result<i32, AppError> {
    let NewBook {
        target,
        user,
        work,
        prio,
        wants,
        discovered,
        links,
    } = *new;
    let lang = crate::metadata::library_language(st, target.id).await?;
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
        .map_err(|e| meta_error(ANCHOR, e))?
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
    let name = creation_folder(st, MediaKind::Book, &title, year).await?;

    let row = Row {
        kind: MediaKind::Book,
        title: &title,
        year: year.map(|y| y as i32),
        folder: &name,
        overview: None,
        provider: None,
        refreshed: false,
    };
    let (id, mut tx) = insert_row(st, &row, target, user, links, wants).await?;
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
        discard(st, id, MediaKind::Book).await;
        e
    };
    let m = BookMatch {
        work: work.to_owned(),
        edition: vec![],
        confidence: 100,
    };
    if let Err(e) = attach(st, id, None, &m, prio).await {
        return Err(undo(meta_error(ANCHOR, e)).await);
    }
    match stored(&st.db, id, None).await {
        Ok(Some(m)) if m.work == work => {}
        Ok(_) => return Err(undo(AppError::conflict(TAKEN)).await),
        Err(e) => return Err(undo(e.into()).await),
    }
    announce(st, (id, MediaKind::Book, &title), target.id, (user, None)).await?;
    Ok(id)
}

/// A book from a provider id: an anchor work, an edition under the work its ISBN or ASIN names (else
/// unmatched), or a plugin work with no anchor id.
pub(crate) async fn create_book_from(st: &AppState, c: &Creation<'_>) -> Result<i32, AppError> {
    Ok(book_from(st, c, None).await?.0)
}

/// `create_book_from`, except that an edition whose anchor work a book already holds joins that book;
/// the flag tells whether the book is new. `readable` is the caller's libraries.
pub(crate) async fn book_or_held(
    st: &AppState,
    c: &Creation<'_>,
    readable: &[i32],
) -> Result<(i32, bool), AppError> {
    book_from(st, c, Some(readable)).await
}

async fn book_from(
    st: &AppState,
    c: &Creation<'_>,
    join: Option<&[i32]>,
) -> Result<(i32, bool), AppError> {
    let (ns, value) = c.id;
    if ns == ANCHOR {
        let work = work_id(value)
            .ok_or_else(|| AppError::bad_request("an Open Library work id is needed"))?;
        return Ok((create_book(st, &new_book(c, &work)).await?, true));
    }
    if !st.metadata.answers(ns) {
        return Err(AppError::bad_request("the provider is not available"));
    }
    if matches!(ns, Namespace::Core(_)) {
        return create_from_edition(st, c, join).await;
    }
    let lang = crate::metadata::library_language(st, c.target.id).await?;
    let Value::Object(record) = st
        .metadata
        .work(ns, MediaKind::Book, value, &lang, c.prio)
        .await
        .map_err(|e| meta_error(ns, e))?
    else {
        return Err(unavailable(
            "request",
            ns,
            &Upstream::new(None, "unexpected work record"),
        ));
    };
    let own = std::iter::once((ns, value.to_owned()))
        .chain(c.links.iter().cloned())
        .collect();
    Ok((insert_unanchored(st, c, &record, ns, own).await?, true))
}

fn new_book<'a>(c: &'a Creation<'a>, work: &'a str) -> NewBook<'a> {
    NewBook {
        target: c.target,
        user: c.user,
        work,
        prio: c.prio,
        wants: c.wants,
        discovered: false,
        links: &c.links,
    }
}

fn meta_error(ns: Namespace, e: crate::metadata::MetaError) -> AppError {
    match e {
        crate::metadata::MetaError::Upstream(e) => fail(ns, &e, true),
        crate::metadata::MetaError::Db(e) => e.into(),
    }
}

/// An edition of a core provider (Google Books, BnF, ...): the book of the anchor work its ISBN or ASIN
/// names, else an unmatched book that settle identifies from the files; the edition keeps its ids.
async fn create_from_edition(
    st: &AppState,
    c: &Creation<'_>,
    join: Option<&[i32]>,
) -> Result<(i32, bool), AppError> {
    let (ns, value) = c.id;
    let pick = edition_id(ns, value)
        .ok_or_else(|| AppError::bad_request(format!("{ns} names no book edition")))?;
    let lang = crate::metadata::library_language(st, c.target.id).await?;
    let mut ids = vec![(ns, pick)];
    let records = merge::edition_records(st, &ids, &lang, c.prio)
        .await
        .map_err(|e| meta_error(ns, e))?;
    let Some((from, record)) = records.iter().find(|(p, _)| *p == ns).or(records.first()) else {
        return Err(AppError::not_found(
            "the provider does not know this edition",
        ));
    };
    for id in discovered(&records) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let hinted: Vec<_> = ids
        .iter()
        .filter(|(n, _)| *n == Namespace::ISBN || *n == Namespace::ASIN)
        .cloned()
        .collect();
    let audio = record
        .get("durationSeconds")
        .and_then(Value::as_i64)
        .is_some_and(|d| d > 0)
        || text(record, "format").is_some_and(|f| AUDIO_EXTS.contains(&format!(".{f}").as_str()));
    let family = if audio { Family::Audio } else { Family::Text };
    let work = work_of(st, &hinted, &lang, c.prio).await;
    let held = match (&work, join) {
        (Some(work), Some(_)) => external_ids::find(&st.db, MediaKind::Book, ANCHOR, work).await?,
        _ => None,
    };
    let id = match (&work, held) {
        (_, Some(held)) => same_library(&st.db, held, c.target.id, join.unwrap_or_default())
            .await
            .map(|_| held)?,
        (Some(work), None) => create_book(st, &new_book(c, work)).await?,
        (None, None) => insert_unanchored(st, c, record, *from, c.links.clone()).await?,
    };
    let edition = match add_edition(&st.db, id, family, &ids).await {
        Ok(e) => e,
        Err(e) => {
            if held.is_none() {
                let guard = st.ingest.media.lock(id).await;
                if let Err(d) = super::delete::remove_media(st, &guard, id).await {
                    tracing::warn!("book #{id} left behind after a failed import: {}", d.text());
                }
            }
            return Err(e);
        }
    };
    if let Some(work) = work {
        let m = BookMatch {
            work,
            edition: ids,
            confidence: 100,
        };
        if let Err(e) = attach(st, id, Some(edition), &m, c.prio).await {
            tracing::warn!("edition #{edition} of book #{id} not merged: {e:?}");
        }
    }
    Ok((id, held.is_none()))
}

/// An edition never lands on a book of another library: 400 when the caller can read that library, else 409.
async fn same_library(
    db: &sqlx::PgPool,
    media: i32,
    library: i32,
    readable: &[i32],
) -> Result<(), AppError> {
    let held: Option<i32> = sqlx::query_scalar(r#"SELECT "libraryId" FROM media WHERE id = $1"#)
        .bind(media)
        .fetch_one(db)
        .await?;
    match held == Some(library) {
        true => Ok(()),
        false => Err(held_elsewhere(held, readable)),
    }
}

/// The edition an import makes before any file exists, holding the ids the provider gave.
async fn add_edition(
    db: &sqlx::PgPool,
    media: i32,
    family: Family,
    ids: &[(Namespace, String)],
) -> Result<i32, AppError> {
    let mut tx = db.begin().await?;
    let edition: i32 = sqlx::query_scalar(
        r#"INSERT INTO editions ("mediaId", family) VALUES ($1, $2) RETURNING id"#,
    )
    .bind(media)
    .bind(family.as_str())
    .fetch_one(&mut *tx)
    .await?;
    for (ns, value) in ids {
        external_ids::link_edition(&mut tx, edition, media, *ns, value).await?;
    }
    tx.commit().await?;
    Ok(edition)
}

/// The book of a provider record with no anchor id: `own` is linked to the media, `pref` is its preferred
/// provider and the wants are those of `c` (every family when unset).
async fn insert_unanchored(
    st: &AppState,
    c: &Creation<'_>,
    record: &serde_json::Map<String, Value>,
    pref: Namespace,
    own: Vec<(Namespace, String)>,
) -> Result<i32, AppError> {
    let target = c.target;
    let title = text(record, "title").ok_or_else(|| {
        unavailable(
            "request",
            pref,
            &Upstream::new(None, "the work has no title"),
        )
    })?;
    let year = record
        .get("year")
        .and_then(Value::as_i64)
        .or_else(|| text(record, "releaseDate")?.get(..4)?.parse().ok())
        .filter(|y| (1..=9999).contains(y))
        .map(|y| y as i32);
    let name = creation_folder(st, MediaKind::Book, &title, year.map(i64::from)).await?;
    let overview = text(record, "overview");
    let row = Row {
        kind: MediaKind::Book,
        title: &title,
        year,
        folder: &name,
        overview: overview.as_deref(),
        provider: Some(pref),
        refreshed: true,
    };
    let (id, mut tx) = insert_row(st, &row, target, c.user, &own, c.wants).await?;
    sqlx::query(r#"INSERT INTO book_details ("mediaId") VALUES ($1) ON CONFLICT DO NOTHING"#)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let authors = people(record, "authors");
    replace_credits(&mut tx, id, None, "author", None, &authors).await?;
    tx.commit().await?;
    announce(
        st,
        (id, MediaKind::Book, &title),
        target.id,
        (c.user, Some(pref)),
    )
    .await?;
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
            user: added_by.filter(|u| *u != 0),
            work,
            prio: Priority::Interactive,
            wants: Some(wants),
            discovered: false,
            links: &[],
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

/// The book that holds `id` of `ns`: an edition provider's id sits on an edition, the others on the work.
pub(crate) async fn held_book(
    db: &sqlx::PgPool,
    ns: Namespace,
    id: &str,
) -> sqlx::Result<Option<i32>> {
    match ns {
        Namespace::Core(_) if ns != ANCHOR => editions::media_of_id(db, ns, id).await,
        _ => external_ids::find(db, MediaKind::Book, ns, id).await,
    }
}

/// `held_book` limited to the books of `readable` libraries, so an answer never names another one.
pub(crate) async fn held_book_in(
    db: &sqlx::PgPool,
    ns: Namespace,
    id: &str,
    readable: &[i32],
) -> sqlx::Result<Option<i32>> {
    let Some(media) = held_book(db, ns, id).await? else {
        return Ok(None);
    };
    let library: Option<i32> = sqlx::query_scalar(r#"SELECT "libraryId" FROM media WHERE id = $1"#)
        .bind(media)
        .fetch_optional(db)
        .await?
        .flatten();
    Ok(library.filter(|l| readable.contains(l)).map(|_| media))
}
