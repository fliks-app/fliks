//! The write of a provider's volume and issues, shared by import, identify and refresh
//! (`docs/spec/comics.md` rules 42-43).
use super::{Fetched, fetch};
use crate::{
    http::AppError,
    images::paths::{Target, Variant},
    ingest::comics::edition,
    media::{field_sources, items::lock_versions},
    metadata::Override,
    state::AppState,
};
use fliks_domain::{
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::{field::Field, limiter::Priority},
};
use std::collections::HashMap;

/// The metadata language of the media's library.
pub(crate) async fn language_of_library(
    st: &AppState,
    library: i32,
) -> Result<fliks_domain::metadata::language::Resolved, AppError> {
    let over: (Option<String>, Option<String>) = sqlx::query_as(
        r#"SELECT "metadataLanguage", "metadataRegion" FROM libraries WHERE id = $1"#,
    )
    .bind(library)
    .fetch_one(&st.db)
    .await?;
    Ok(st
        .metadata
        .lang
        .resolve(Some(&Override {
            language: over.0,
            region: over.1,
        }))
        .await?)
}

/// Writes `f` to the comic `media`, linked to `(ns, id)`: the volume fields that are not locked,
/// then the issues merged by `(kind, sort)`.
pub async fn write(st: &AppState, media: i32, ns: Namespace, f: &Fetched) -> Result<(), AppError> {
    let w = &f.work;
    let mut tx = st.db.begin().await?;
    lock_versions(&mut tx, media).await?;
    let alive: Option<String> =
        sqlx::query_scalar(r#"SELECT type FROM media WHERE id = $1 FOR UPDATE"#)
            .bind(media)
            .fetch_optional(&mut *tx)
            .await?;
    if alive.as_deref() != Some(MediaKind::Comic.as_str()) {
        return Ok(());
    }
    let locked = field_sources::locked_fields(&mut *tx, media).await?;
    let free = |f: Field| !locked.contains(&f);
    let mut provenance = vec![];
    let mut take = |field: Field, given: bool| {
        let on = given && free(field);
        if on {
            provenance.push((field, ns));
        }
        on
    };
    let (title, overview) = (
        take(Field::Title, true).then(|| w.title.clone()),
        take(Field::Overview, w.overview.is_some())
            .then(|| w.overview.clone())
            .flatten(),
    );
    let year = take(Field::Year, w.year.is_some())
        .then_some(w.year)
        .flatten();
    let poster = take(Field::PosterUrl, w.poster_url.is_some())
        .then(|| w.poster_url.clone())
        .flatten();
    let publisher = take(Field::Publisher, w.publisher.is_some())
        .then(|| w.publisher.clone())
        .flatten();
    let volume = take(Field::Details, w.volume.is_some())
        .then_some(w.volume)
        .flatten();
    sqlx::query(
        r#"UPDATE media SET title = COALESCE($2, title), overview = COALESCE($3, overview),
             year = COALESCE($4, year), "posterUrl" = COALESCE($5, "posterUrl"),
             "metadataRefreshedAt" = now() WHERE id = $1"#,
    )
    .bind(media)
    .bind(&title)
    .bind(&overview)
    .bind(year)
    .bind(&poster)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"INSERT INTO comic_details ("mediaId", publisher, "startYear", volume) VALUES ($1, $2, $3, $4)
           ON CONFLICT ("mediaId") DO UPDATE SET publisher = COALESCE($2, comic_details.publisher),
             "startYear" = COALESCE($3, comic_details."startYear"), volume = COALESCE($4, comic_details.volume)"#,
    )
    .bind(media)
    .bind(&publisher)
    .bind(year)
    .bind(volume)
    .execute(&mut *tx)
    .await?;
    field_sources::set_field_sources(&mut tx, media, &provenance).await?;

    let edition = edition(&mut tx, media).await?;
    let rows: Vec<(i32, String, f64)> = sqlx::query_as(
        r#"SELECT "itemId", kind, "sortNumber"::float8 FROM comic_issues WHERE "mediaId" = $1"#,
    )
    .bind(media)
    .fetch_all(&mut *tx)
    .await?;
    let held: HashMap<(String, i64), i32> = rows
        .into_iter()
        .map(|(item, kind, sort)| ((kind, (sort * 100.0).round() as i64), item))
        .collect();
    for i in &f.issues {
        let (kind, sort) = i.key();
        if let Some(item) = held.get(&(kind.to_owned(), sort)) {
            sqlx::query(
                r#"UPDATE comic_issues SET label = CASE WHEN 'label' = ANY("lockedFields") THEN label ELSE $2 END
                   WHERE "itemId" = $1"#,
            )
            .bind(item)
            .bind(&i.label)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"UPDATE items i SET
                     title = CASE WHEN 'title' = ANY(ci."lockedFields") THEN i.title ELSE COALESCE($2, i.title) END,
                     "airDate" = CASE WHEN 'releaseDate' = ANY(ci."lockedFields") THEN i."airDate"
                       ELSE COALESCE($3::text::date, i."airDate") END
                   FROM comic_issues ci WHERE ci."itemId" = i.id AND i.id = $1"#,
            )
            .bind(item)
            .bind(&i.title)
            .bind(&i.release_date)
            .execute(&mut *tx)
            .await?;
            continue;
        }
        let item: i32 = sqlx::query_scalar(
            r#"INSERT INTO items ("mediaId", "editionId", monitored, title, "airDate")
               VALUES ($1, $2, (SELECT monitored FROM media WHERE id = $1), $3, $4::text::date) RETURNING id"#,
        )
        .bind(media)
        .bind(edition)
        .bind(&i.title)
        .bind(&i.release_date)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query(
            r#"INSERT INTO comic_issues ("itemId", "mediaId", kind, "sortNumber", label)
               VALUES ($1, $2, $3, $4::text::numeric, $5)"#,
        )
        .bind(item)
        .bind(media)
        .bind(kind)
        .bind(i.sort_text())
        .bind(&i.label)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    if let Some(url) = poster
        && let Some(local) = st
            .images
            .download_and_store(&url, &Target::media(media, Variant::Poster))
            .await
        && let Err(e) = sqlx::query(r#"UPDATE media SET "posterUrl" = $2 WHERE id = $1"#)
            .bind(media)
            .bind(local)
            .execute(&st.db)
            .await
    {
        tracing::warn!("poster of comic #{media}: {e}");
    }
    Ok(())
}

/// The provider id a refresh reads: the pinned `preferredProvider` when the media holds its id,
/// else the first comic provider of the order whose id it holds.
async fn linked(st: &AppState, media: i32) -> Result<Option<(Namespace, String)>, AppError> {
    let pin: Option<String> =
        sqlx::query_scalar(r#"SELECT "preferredProvider" FROM media WHERE id = $1"#)
            .bind(media)
            .fetch_optional(&st.db)
            .await?
            .flatten();
    let ids: Vec<(String, String)> = sqlx::query_as(
        r#"SELECT provider::text, value FROM media_external_ids WHERE "mediaId" = $1"#,
    )
    .bind(media)
    .fetch_all(&st.db)
    .await?;
    let order = st.metadata.order(MediaKind::Comic);
    let mut held: Vec<(usize, Namespace, String)> = ids
        .into_iter()
        .filter_map(|(p, v)| {
            let ns = Namespace::parse(&p).filter(|n| n.core().is_none())?;
            let rank = if pin.as_deref() == Some(p.as_str()) {
                0
            } else {
                1 + order.iter().position(|o| *o == ns)?
            };
            Some((rank, ns, v))
        })
        .collect();
    held.sort_by_key(|h| h.0);
    Ok(held.into_iter().next().map(|(_, ns, v)| (ns, v)))
}

/// Reads the provider the media is linked to again and writes it (rule 43); `false` when the media
/// holds no comic provider id.
pub async fn refresh(st: &AppState, media: i32, prio: Priority) -> Result<bool, AppError> {
    let Some((ns, id)) = linked(st, media).await? else {
        return Ok(false);
    };
    let library: Option<i32> = sqlx::query_scalar(r#"SELECT "libraryId" FROM media WHERE id = $1"#)
        .bind(media)
        .fetch_optional(&st.db)
        .await?
        .flatten();
    let lang = match library {
        Some(l) => language_of_library(st, l).await?,
        None => st.metadata.lang.resolve(None).await?,
    };
    let fetched = fetch(st, ns, &id, &lang, prio).await?;
    write(st, media, ns, &fetched).await?;
    Ok(true)
}
