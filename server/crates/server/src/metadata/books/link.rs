//! Writes what a `BookMatch` says (`docs/spec/book-metadata.md` rules 10-17).
use super::{
    ANCHOR,
    absorb::{absorb, carry_poster},
    identify::BookMatch,
    merge::{self, Records},
    people, text, work_id,
};
use crate::{
    images::paths::{Target, Variant},
    media::{
        details::set_release_dates,
        editions::{self, Facts},
        external_ids::{self, Link, edition_id},
        field_sources,
        write::fields::{Fields, apply},
    },
    metadata::{MetaError, Override, Upstream},
    state::AppState,
};
use fliks_domain::{
    external_id::{ExternalProvider, Namespace, Namespaces},
    language::normalize_language_code,
    media::{family::Family, kind::MediaKind, release::ReleaseKind},
    metadata::{
        field::Field,
        limiter::Priority,
        merge::{FieldOrder, Provenance},
    },
    persons::sort_name,
};
use serde_json::{Map, Value};
use sqlx::PgConnection;

#[cfg(test)]
type Hook = std::sync::Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync,
>;

#[cfg(test)]
tokio::task_local! {
    /// Runs between the lock read and the write transaction of `attach_with`.
    pub(crate) static BEFORE_TX: Hook;
}

/// Links the work and the edition ids, fetches, merges and writes work and edition facts, credits, series.
pub async fn attach(
    st: &AppState,
    media: i32,
    edition: Option<i32>,
    m: &BookMatch,
    p: Priority,
) -> Result<(), MetaError> {
    attach_with(st, media, edition, Some(m), None, p).await
}

/// `attach` with a record read from the file (`file` provenance), which every merge takes in; without a
/// match only the file record is merged, and no id is linked.
pub async fn attach_with(
    st: &AppState,
    media: i32,
    edition: Option<i32>,
    m: Option<&BookMatch>,
    file: Option<&Map<String, Value>>,
    prio: Priority,
) -> Result<(), MetaError> {
    let Some(ctx) = context(st, media).await? else {
        return Ok(());
    };
    let family = match edition {
        None => Family::Text,
        Some(e) => match editions::of(&st.db, e).await? {
            Some((owner, family)) if owner == media => family,
            _ => return Ok(()),
        },
    };
    let work = match m {
        Some(m) => Some(work_id(&m.work).ok_or_else(|| Upstream::new(None, "not a work id"))?),
        None => None,
    };
    let lang = st.metadata.lang.resolve(Some(&ctx.over)).await?;
    let work_record = match &work {
        Some(work) => {
            if !st.metadata.available(ANCHOR) {
                return Err(Upstream::outage("the work provider is unavailable").into());
            }
            let Value::Object(r) = st
                .metadata
                .work(ANCHOR, MediaKind::Book, work, &lang, prio)
                .await?
            else {
                return Err(Upstream::new(None, "unexpected work record").into());
            };
            r
        }
        None => Map::new(),
    };
    let known = st.namespaces();
    let refs = match (edition, m) {
        (Some(_), Some(m)) => edition_refs(&known, &m.edition),
        (Some(e), None) => edition_refs(&known, &external_ids::edition_ids(&st.db, e).await?),
        _ => vec![],
    };
    let mut records = merge::edition_records(st, &refs, &lang, prio).await?;
    if m.is_none() {
        records.extend(merge::plugin_works(st, media, &lang, prio).await?);
    }
    let provider_backed = work.is_some() || !records.is_empty();
    records.extend(file.map(|f| (Namespace::FILE, f.clone())));
    let mut ids = refs;
    for id in discovered(&known, &records)
        .into_iter()
        .filter(|_| work.is_some())
    {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mut work_locked = field_sources::locked_fields(&st.db, media).await?;
    if !provider_backed {
        // The file alone fills empty fields and its own, never a hand edit.
        let mut c = st.db.acquire().await?;
        work_locked.extend(field_sources::not_from_file(&mut *c, media).await?);
        work_locked.extend(crate::media::write::fields::unsourced(&mut c, media).await?);
    }
    let edition_locked = match edition {
        Some(e) => Some(editions::locked_fields(&st.db, e).await?),
        None => None,
    };
    let order = FieldOrder::book(family, &ctx.first);
    let ((wmap, wprov), emerged) = merge::levels(
        work_record,
        &records,
        &order,
        &work_locked,
        edition_locked.as_deref(),
    );

    #[cfg(test)]
    if let Ok(hook) = BEFORE_TX.try_with(Clone::clone) {
        hook().await;
    }
    let mut tx = st.db.begin().await?;
    // Persons and series are found by name: one lock keeps two attaches from creating both.
    sqlx::query!("SELECT pg_advisory_xact_lock(hashtext('books:link'))")
        .execute(&mut *tx)
        .await?;
    crate::media::write::orphans::hold(&mut tx).await?;
    let alive = sqlx::query_scalar!("SELECT id FROM media WHERE id = $1 FOR UPDATE", media)
        .fetch_optional(&mut *tx)
        .await?;
    if alive.is_none() {
        return Ok(());
    }
    if let Some(e) = edition {
        let held = sqlx::query_scalar!(
            r#"SELECT id FROM editions WHERE id = $1 AND "mediaId" = $2 FOR UPDATE"#,
            e,
            media
        )
        .fetch_optional(&mut *tx)
        .await?;
        if held.is_none() {
            return Ok(());
        }
    }

    let linked = match &work {
        Some(work) => {
            external_ids::link(&mut tx, &known, media, MediaKind::Book, ANCHOR, work).await?
        }
        None => Link::Linked,
    };
    match linked {
        Link::Linked => {}
        Link::Taken => {
            let work = work.as_deref().unwrap_or_default();
            let holder = external_ids::find(&mut *tx, MediaKind::Book, ANCHOR, work).await?;
            // An edition with no library follows its work: another library's work must not take it.
            let same_library = match holder {
                Some(h) => super::absorb::same_library(&mut tx, media, h).await?,
                None => false,
            };
            match holder.filter(|h| *h != media && edition.is_some() && same_library) {
                Some(holder) => {
                    let held = absorb(&mut tx, media, holder).await?;
                    tx.commit().await?;
                    carry_poster(st, media, holder).await;
                    crate::media::write::orphans::release(st, held);
                    return Box::pin(attach_with(st, holder, edition, m, file, prio)).await;
                }
                None => {
                    tracing::warn!("book #{media}: another work or library holds the {work} id");
                    return Ok(());
                }
            }
        }
        Link::Gone => return Ok(()),
    }
    if let Some(e) = edition {
        for (ns, value) in &ids {
            external_ids::link_edition(&mut tx, &known, e, media, *ns, value).await?;
        }
    }

    let title = text(&wmap, "title");
    let poster = text(&wmap, "posterUrl");
    apply(&mut tx, media, &Fields::from_map(MediaKind::Book, &wmap)).await?;
    let subjects = match wmap.get("subjects") {
        Some(Value::Array(a)) if !a.is_empty() => Some(Value::Array(a.clone())),
        _ => None,
    };
    sqlx::query!(
        r#"INSERT INTO book_details ("mediaId", subtitle, subjects) VALUES ($1, $2, $3)
           ON CONFLICT ("mediaId") DO UPDATE SET
             subtitle = COALESCE(EXCLUDED.subtitle, book_details.subtitle),
             subjects = COALESCE(EXCLUDED.subjects, book_details.subjects)"#,
        media,
        text(&wmap, "subtitle"),
        subjects
    )
    .execute(&mut *tx)
    .await?;
    let release = text(&wmap, "releaseDate").and_then(|d| full_date(&d));
    set_release_dates(&mut tx, media, &[(ReleaseKind::Release, release)], true).await?;
    let authors = people(&wmap, "authors");
    replace_credits(
        &mut tx,
        media,
        None,
        "author",
        provider_of(&wprov, Field::Authors),
        &authors,
    )
    .await?;
    // A hand edit committed since `work_locked` was read still wins.
    if !field_sources::locked_fields(&mut *tx, media)
        .await?
        .contains(&Field::Series)
    {
        set_series(&mut tx, media, &wmap, provider_of(&wprov, Field::Series)).await?;
    }
    field_sources::merge_field_sources(&mut tx, media, &wprov).await?;

    if let (Some(e), Some((emap, eprov))) = (edition, &emerged) {
        let work_title = title.clone().unwrap_or(ctx.title);
        let edition_title = emap
            .get("title")
            .map(|_| text(emap, "title").filter(|t| *t != work_title));
        let facts = Facts {
            language: text(emap, "language")
                .map(|l| normalize_language_code(Some(&l)))
                .filter(|l| l != "und"),
            title: edition_title,
            format: text(emap, "format").map(|f| f.to_lowercase()).filter(|f| {
                (1..=8).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_alphanumeric())
            }),
            publisher: text(emap, "publisher"),
            duration_seconds: positive(emap, "durationSeconds"),
            page_count: positive(emap, "pageCount"),
        };
        editions::set_facts(&mut tx, e, &facts).await?;
        let date = text(emap, "releaseDate").and_then(|d| full_date(&d));
        editions::set_release_date(&mut tx, media, e, date.as_deref()).await?;
        for (role, key, field) in [
            ("narrator", "narrators", Field::Narrators),
            ("translator", "translators", Field::Translators),
        ] {
            let list = people(emap, key);
            replace_credits(
                &mut tx,
                media,
                Some(e),
                role,
                provider_of(eprov, field),
                &list,
            )
            .await?;
        }
        editions::merge_field_sources(&mut tx, e, eprov).await?;
    }
    tx.commit().await?;

    if let Some(url) = poster {
        let target = Target::media(media, Variant::Poster);
        if let Some(local) = st.images.download_and_store(&url, &target).await
            && let Err(e) = sqlx::query!(
                r#"UPDATE media SET "posterUrl" = $2 WHERE id = $1"#,
                media,
                local
            )
            .execute(&st.db)
            .await
        {
            tracing::warn!("poster of book #{media}: {e}");
        }
    }
    Ok(())
}

/// The match `attach` is given on a refresh: the work and the edition ids stored for the pair.
pub async fn stored(
    db: &sqlx::PgPool,
    media: i32,
    edition: Option<i32>,
) -> sqlx::Result<Option<BookMatch>> {
    let work = sqlx::query_scalar!(
        r#"SELECT value FROM media_external_ids WHERE "mediaId" = $1 AND provider = $2"#,
        media,
        ANCHOR.as_str()
    )
    .fetch_optional(db)
    .await?;
    let Some(work) = work else { return Ok(None) };
    let edition = match edition {
        Some(e) => external_ids::edition_ids(db, e).await?,
        None => vec![],
    };
    Ok(Some(BookMatch {
        work,
        edition,
        confidence: 100,
    }))
}

struct Ctx {
    title: String,
    first: Vec<Namespace>,
    over: Override,
}

/// The book's title, preferred providers and metadata language; `None` for a media that is not a book.
async fn context(st: &AppState, media: i32) -> sqlx::Result<Option<Ctx>> {
    let row = sqlx::query!(
        r#"SELECT m.title, m."preferredProvider" AS pref, l."preferredProvider" AS lib,
             l."metadataLanguage" AS lang, l."metadataRegion" AS region
           FROM media m LEFT JOIN libraries l ON l.id = m."libraryId"
           WHERE m.id = $1 AND m.type = 'book'"#,
        media
    )
    .fetch_optional(&st.db)
    .await?;
    Ok(row.map(|r| Ctx {
        title: r.title,
        first: [r.pref, r.lib]
            .into_iter()
            .flatten()
            .filter_map(|p| Namespace::parse(&p))
            .collect(),
        over: Override {
            language: r.lang,
            region: r.region,
        },
    }))
}

/// The refs of a match an edition can be looked up by, normalised and deduplicated.
fn edition_refs(known: &Namespaces, given: &[(Namespace, String)]) -> Vec<(Namespace, String)> {
    let mut out = vec![];
    for (ns, v) in given {
        if let Some(v) = edition_id(known, *ns, v)
            && !out.contains(&(*ns, v.clone()))
        {
            out.push((*ns, v));
        }
    }
    out
}

/// The edition ids the records carry (`isbn13`, `asin`, and `externalId` in the record's own namespace).
pub(crate) fn discovered(known: &Namespaces, records: &Records) -> Vec<(Namespace, String)> {
    let mut out = vec![];
    for (p, r) in records {
        let own = text(r, "externalId").map(|v| (*p, v));
        let isbns = match r.get("isbn13") {
            Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
            _ => vec![],
        };
        let listed = isbns.into_iter().map(|v| (Namespace::ISBN, v.to_owned()));
        let asin = text(r, "asin").map(|v| (Namespace::ASIN, v));
        out.extend(edition_refs(
            known,
            &own.into_iter()
                .chain(listed)
                .chain(asin)
                .collect::<Vec<_>>(),
        ));
    }
    out
}

fn provider_of(prov: &Provenance, field: Field) -> Option<Namespace> {
    prov.iter().find(|(f, _)| *f == field).map(|(_, p)| *p)
}

fn positive(m: &Map<String, Value>, key: &str) -> Option<i32> {
    m.get(key)
        .and_then(Value::as_i64)
        .filter(|n| *n > 0)
        .and_then(|n| i32::try_from(n).ok())
}

/// `YYYY`, `YYYY-MM` and `YYYY-MM-DD` (more is cut) as a full date, the first day of a short one.
fn full_date(s: &str) -> Option<String> {
    let head: String = s.trim().chars().take(10).collect();
    let full = match head.len() {
        4 => format!("{head}-01-01"),
        7 => format!("{head}-01"),
        10 => head,
        _ => return None,
    };
    chrono::NaiveDate::parse_from_str(&full, "%Y-%m-%d")
        .ok()
        .map(|_| full)
}

/// The id of `provider` for a person, in the namespace `person_external_ids` keeps it under.
fn person_id(provider: Namespace, id: &str) -> Option<(&'static str, String)> {
    match provider {
        Namespace::OPENLIBRARY => ExternalProvider::OpenLibrary
            .normalize(id)
            .filter(|v| v.ends_with('A'))
            .map(|v| ("openlibrary", v)),
        Namespace::AUDIBLE | Namespace::AUDNEXUS => {
            ExternalProvider::Asin.normalize(id).map(|v| ("asin", v))
        }
        Namespace::BNF => (6..=12)
            .contains(&id.len())
            .then_some(id)
            .filter(|v| v.bytes().all(|b| b.is_ascii_digit()))
            .map(|v| ("bnf", v.to_owned())),
        _ => None,
    }
}

/// The person with this provider id, else with this name, else a new one; a missing id and a missing
/// sort name are added.
async fn person(
    c: &mut PgConnection,
    provider: Option<Namespace>,
    name: &str,
    id: Option<&str>,
) -> sqlx::Result<i32> {
    let ext = provider.zip(id).and_then(|(p, i)| person_id(p, i));
    let by_id =
        match &ext {
            Some((ns, value)) => sqlx::query_scalar!(
                r#"SELECT "personId" FROM person_external_ids WHERE provider = $1 AND value = $2"#,
                *ns,
                value
            )
            .fetch_optional(&mut *c)
            .await?,
            None => None,
        };
    let sort = sort_name(name);
    let found = match by_id {
        Some(id) => Some(id),
        None => {
            // A person holding another id of the same provider is someone else, and so is a
            // person known only from films or series.
            sqlx::query_scalar!(
                r#"SELECT p.id FROM persons p
                   WHERE name_key(p.name) = name_key($1)
                     AND (NOT EXISTS (SELECT 1 FROM media_credits c JOIN media m ON m.id = c."mediaId"
                                       WHERE c."personId" = p.id AND m.type IN ('movie', 'series'))
                          OR EXISTS (SELECT 1 FROM media_credits c JOIN media m ON m.id = c."mediaId"
                                      WHERE c."personId" = p.id AND m.type IN ('book', 'comic')))
                     AND NOT EXISTS (SELECT 1 FROM person_external_ids x
                                      WHERE x."personId" = p.id AND x.provider = $2 AND x.value <> $3)
                   ORDER BY p.id LIMIT 1"#,
                name,
                ext.as_ref().map(|(ns, _)| *ns),
                ext.as_ref().map(|(_, v)| v.as_str())
            )
            .fetch_optional(&mut *c)
            .await?
        }
    };
    let id = match found {
        Some(id) => {
            sqlx::query!(
                r#"UPDATE persons SET "sortName" = $2 WHERE id = $1 AND "sortName" IS NULL AND $2::text IS NOT NULL"#,
                id,
                sort
            )
            .execute(&mut *c)
            .await?;
            id
        }
        None => {
            sqlx::query_scalar!(
                r#"INSERT INTO persons (name, "sortName") VALUES ($1, $2) RETURNING id"#,
                name,
                sort
            )
            .fetch_one(&mut *c)
            .await?
        }
    };
    if let Some((ns, value)) = ext {
        sqlx::query!(
            r#"INSERT INTO person_external_ids ("personId", provider, value) VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING"#,
            id,
            ns,
            value
        )
        .execute(&mut *c)
        .await?;
    }
    Ok(id)
}

/// Replaces the credits of `role` on the work (`edition` `None`) or on an edition; an empty list changes nothing.
pub(crate) async fn replace_credits(
    c: &mut PgConnection,
    media: i32,
    edition: Option<i32>,
    role: &str,
    provider: Option<Namespace>,
    list: &[(String, Option<String>)],
) -> sqlx::Result<()> {
    if list.is_empty() {
        return Ok(());
    }
    let mut persons: Vec<i32> = vec![];
    for (name, id) in list {
        let p = person(c, provider, name, id.as_deref()).await?;
        if !persons.contains(&p) {
            persons.push(p);
        }
    }
    let positions: Vec<i32> = (0..persons.len() as i32).collect();
    sqlx::query!(
        r#"DELETE FROM media_credits WHERE "mediaId" = $1 AND role = $2 AND "editionId" IS NOT DISTINCT FROM $3"#,
        media,
        role,
        edition
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"INSERT INTO media_credits ("mediaId", "editionId", "personId", role, position)
           SELECT $1, $2, t.p, $3, t.o FROM UNNEST($4::int[], $5::int[]) AS t(p, o)"#,
        media,
        edition,
        role,
        &persons,
        &positions
    )
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// `(position, label)` of a series position: a number is the position, anything else the label.
fn position(s: &str) -> (Option<String>, Option<String>) {
    let t = s.trim().replace(',', ".");
    match t.parse::<f64>() {
        Ok(n) if n.is_finite() && n >= 0.0 => (Some(n.to_string()), None),
        _ if t.is_empty() => (None, None),
        _ => (None, Some(t)),
    }
}

/// Puts the media in the series of the merged `series` entries and out of any other; an empty list changes nothing.
async fn set_series(
    c: &mut PgConnection,
    media: i32,
    merged: &Map<String, Value>,
    provider: Option<Namespace>,
) -> sqlx::Result<()> {
    let Some(Value::Array(entries)) = merged.get("series") else {
        return Ok(());
    };
    let mut keep = vec![];
    for e in entries {
        let Some(name) = e
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|n| !n.is_empty())
        else {
            continue;
        };
        let at = match e.get("position") {
            Some(Value::String(s)) => position(s),
            Some(Value::Number(n)) => position(&n.to_string()),
            _ => (None, None),
        };
        let ext = match (provider, e.get("id").and_then(Value::as_str)) {
            (Some(Namespace::AUDIBLE), Some(i)) => {
                ExternalProvider::Asin.normalize(i).map(|v| ("asin", v))
            }
            (Some(Namespace::BNF), Some(i)) => {
                ExternalProvider::Bnf.normalize(i).map(|v| ("bnf", v))
            }
            _ => None,
        };
        let id = collection(c, media, name, ext.as_ref()).await?;
        enter(c, media, id, at).await?;
        keep.push(id);
    }
    if keep.is_empty() {
        return Ok(());
    }
    leave_others(c, media, &keep).await
}

/// Writes the media's work-level entry of a series.
async fn enter(
    c: &mut PgConnection,
    media: i32,
    series: i32,
    at: (Option<String>, Option<String>),
) -> sqlx::Result<()> {
    sqlx::query!(
        r#"INSERT INTO collection_entries ("collectionId", "mediaId", position, "positionLabel")
           VALUES ($1, $2, $3::text::numeric, $4)
           ON CONFLICT ON CONSTRAINT "UQ_collection_entries" DO UPDATE
           SET position = EXCLUDED.position, "positionLabel" = EXCLUDED."positionLabel",
                        "positionEnd" = NULL"#,
        series,
        media,
        at.0,
        at.1
    )
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// Takes the media out of every work-level series but `keep`, deleting a series left empty.
async fn leave_others(c: &mut PgConnection, media: i32, keep: &[i32]) -> sqlx::Result<()> {
    sqlx::query!(
        r#"WITH left_ AS (
             DELETE FROM collection_entries
              WHERE "mediaId" = $1 AND "itemId" IS NULL AND NOT ("collectionId" = ANY($2))
              RETURNING "collectionId")
           DELETE FROM collections c WHERE c.id IN (SELECT "collectionId" FROM left_)
             AND NOT EXISTS (SELECT 1 FROM collection_entries e
                              WHERE e."collectionId" = c.id AND e."mediaId" <> $1)
             AND NOT EXISTS (SELECT 1 FROM series_watches w WHERE w."collectionId" = c.id)"#,
        media,
        keep
    )
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// The series a hand edit names: an existing collection by id, or one by name.
pub(crate) enum Pick<'a> {
    Id(i32),
    Name(&'a str),
}

/// Puts the media in one series at `position` (`None`: in none), as a hand edit (rule 26). A name
/// keeps the media's current series of that `name_key`, so a re-save never swaps the collection.
pub(crate) async fn put_series(
    c: &mut PgConnection,
    media: i32,
    entry: Option<(Pick<'_>, Option<&str>)>,
) -> sqlx::Result<()> {
    let mut keep = vec![];
    if let Some((pick, at)) = entry {
        let id = match pick {
            Pick::Id(id) => id,
            Pick::Name(name) => {
                let current = sqlx::query_scalar!(
                    r#"SELECT c.id FROM collection_entries e JOIN collections c ON c.id = e."collectionId"
                       WHERE e."mediaId" = $1 AND e."itemId" IS NULL AND name_key(c.name) = name_key($2)
                       ORDER BY c.id LIMIT 1"#,
                    media,
                    name
                )
                .fetch_optional(&mut *c)
                .await?;
                match current {
                    Some(id) => id,
                    None => collection(c, media, name, None).await?,
                }
            }
        };
        enter(c, media, id, at.map_or((None, None), position)).await?;
        keep.push(id);
    }
    leave_others(c, media, &keep).await
}

/// The series with this id, else with this name among the series of books sharing an author with `media`,
/// else a new one; it gains the id when it lacks it.
async fn collection(
    c: &mut PgConnection,
    media: i32,
    name: &str,
    ext: Option<&(&'static str, String)>,
) -> sqlx::Result<i32> {
    let by_id = match ext {
        Some((ns, value)) => {
            sqlx::query_scalar!(
                r#"SELECT "collectionId" FROM collection_external_ids WHERE provider = $1 AND value = $2"#,
                *ns,
                value
            )
            .fetch_optional(&mut *c)
            .await?
        }
        None => None,
    };
    let found = match by_id {
        Some(id) => Some(id),
        None => {
            sqlx::query_scalar!(
                r#"SELECT c.id FROM collections c
                   WHERE name_key(c.name) = name_key($1) AND EXISTS (
                     SELECT 1 FROM collection_entries e
                       JOIN media_credits a ON a."mediaId" = e."mediaId" AND a.role = 'author' AND a."editionId" IS NULL
                       JOIN media_credits mine ON mine."mediaId" = $2 AND mine.role = 'author'
                         AND mine."editionId" IS NULL AND mine."personId" = a."personId"
                      WHERE e."collectionId" = c.id)
                   ORDER BY c.id LIMIT 1"#,
                name,
                media
            )
            .fetch_optional(&mut *c)
            .await?
        }
    };
    let id = match found {
        Some(id) => id,
        None => {
            sqlx::query_scalar!(
                "INSERT INTO collections (name) VALUES ($1) RETURNING id",
                name
            )
            .fetch_one(&mut *c)
            .await?
        }
    };
    if let Some((ns, value)) = ext {
        sqlx::query!(
            r#"INSERT INTO collection_external_ids ("collectionId", provider, value) VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING"#,
            id,
            *ns,
            value
        )
        .execute(&mut *c)
        .await?;
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;

    #[sqlx::test(migrations = false)]
    async fn an_id_less_credit_skips_persons_known_only_from_video(pool: PgPool) {
        crate::db::migrate(&pool).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO libraries (id, name) VALUES (1, 'L');
               INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES
                 (1, 'Film', 'movie', 1, 'f'), (2, 'Book', 'book', 1, 'b');"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let mut ids = vec![];
        for (name, media) in [("Jane Doe", 1), ("Mia Roe", 1), ("Eve Poe", 0)] {
            let id: i32 = sqlx::query_scalar("INSERT INTO persons (name) VALUES ($1) RETURNING id")
                .bind(name)
                .fetch_one(&pool)
                .await
                .unwrap();
            for m in (media > 0)
                .then_some(media)
                .into_iter()
                .chain((name == "Mia Roe").then_some(2))
            {
                sqlx::query(r#"INSERT INTO media_credits ("mediaId", "personId", role, character, position) VALUES ($1, $2, 'cast', 'X', 0)"#)
                    .bind(m)
                    .bind(id)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            ids.push(id);
        }
        let mut c = pool.acquire().await.unwrap();
        let fresh = person(&mut c, None, "Doe Jane", None).await.unwrap();
        assert!(!ids.contains(&fresh));
        assert_eq!(
            person(&mut c, None, "Roe, Mia", None).await.unwrap(),
            ids[1]
        );
        assert_eq!(person(&mut c, None, "Poe Eve", None).await.unwrap(), ids[2]);
    }
}
