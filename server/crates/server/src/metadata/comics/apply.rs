//! The write of a provider's volume and issues, shared by import, identify and refresh
//! (`docs/spec/comics.md` rules 42-43).
use super::{Fetched, fetch};
use crate::{
    http::AppError,
    images::paths::{Target, Variant},
    ingest::{comics::edition, record::file_records},
    media::{
        field_sources,
        items::lock_versions,
        write::fields::{Fields, apply, merge_unmatched},
    },
    metadata::Override,
    state::AppState,
};
use fliks_domain::comics::provider::Issue;
use fliks_domain::{
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::{
        field::Field,
        limiter::Priority,
        merge::{FieldOrder, merge},
    },
};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

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
/// then the issues merged by `(kind, sortNumber)` (a special by its label: its sort is a rank).
pub async fn write(st: &AppState, media: i32, ns: Namespace, f: &Fetched) -> Result<(), AppError> {
    let w = &f.work;
    // Only a stored local copy is ever written as the poster.
    let stored = match &w.poster_url {
        Some(url)
            if !field_sources::locked_fields(&st.db, media)
                .await?
                .contains(&Field::PosterUrl) =>
        {
            st.images
                .download_and_store(url, &Target::media(media, Variant::Poster))
                .await
        }
        _ => None,
    };
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
    let mut provided = Map::new();
    for (k, v) in [
        ("title", Some(Value::from(w.title.clone()))),
        ("overview", w.overview.clone().map(Value::from)),
        ("year", w.year.map(Value::from)),
        ("posterUrl", stored.map(Value::from)),
        ("publisher", w.publisher.clone().map(Value::from)),
        ("volume", w.volume.map(Value::from)),
    ] {
        if let Some(v) = v {
            provided.insert(k.into(), v);
        }
    }
    let mut records = vec![(ns, provided)];
    let files = file_records(st, media).await;
    records.extend(files.into_iter().map(|r| (Namespace::FILE, r)));
    let (merged, provenance) = merge(&records, &FieldOrder::new(MediaKind::Comic, &[ns]), &locked);
    apply(&mut tx, media, &Fields::from_map(MediaKind::Comic, &merged)).await?;
    set_details(&mut tx, media, &merged).await?;
    field_sources::merge_field_sources(&mut tx, media, &provenance).await?;
    merge_issues(&mut tx, media, &f.issues).await?;
    tx.commit().await?;
    Ok(())
}

/// The volume's `comic_details` from a merged record: a key the merge left out leaves its column.
pub(crate) async fn set_details(
    c: &mut sqlx::PgConnection,
    media: i32,
    m: &Map<String, Value>,
) -> sqlx::Result<()> {
    let int = |k: &str| {
        m.get(k)
            .and_then(Value::as_i64)
            .and_then(|n| i32::try_from(n).ok())
    };
    sqlx::query(
        r#"INSERT INTO comic_details ("mediaId", publisher, "startYear", volume) VALUES ($1, $2, $3, $4)
           ON CONFLICT ("mediaId") DO UPDATE SET publisher = COALESCE($2, comic_details.publisher),
             "startYear" = COALESCE($3, comic_details."startYear"), volume = COALESCE($4, comic_details.volume)"#,
    )
    .bind(media)
    .bind(m.get("publisher").and_then(Value::as_str))
    .bind(int("year"))
    .bind(int("volume"))
    .execute(c)
    .await?;
    Ok(())
}

/// The issues merged onto the volume's, one statement per step whatever their number.
async fn merge_issues(
    tx: &mut sqlx::PgConnection,
    media: i32,
    issues: &[Issue],
) -> Result<(), AppError> {
    if issues.is_empty() {
        return Ok(());
    }
    let kinds: Vec<&str> = issues.iter().map(|i| i.kind).collect();
    let sorts: Vec<String> = issues.iter().map(Issue::sort_text).collect();
    let labels: Vec<&str> = issues.iter().map(|i| i.label.as_str()).collect();
    let matched: Vec<(i32, i32)> = sqlx::query_as(
        r#"SELECT DISTINCT ON (t.i) t.i::int, ci."itemId"
           FROM UNNEST($2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS t(kind, sort, label, i)
           JOIN comic_issues ci ON ci."mediaId" = $1 AND ci.kind = t.kind
             AND CASE WHEN t.kind = 'special' THEN ci.label = t.label
                      ELSE ci."sortNumber" = t.sort::numeric END
           ORDER BY t.i, ci."itemId""#,
    )
    .bind(media)
    .bind(&kinds)
    .bind(&sorts)
    .bind(&labels)
    .fetch_all(&mut *tx)
    .await?;
    let held: HashMap<usize, i32> = matched
        .into_iter()
        .map(|(i, item)| (i as usize - 1, item))
        .collect();

    let (mut ids, mut m_labels, mut m_titles, mut m_dates) = (vec![], vec![], vec![], vec![]);
    for (n, i) in issues.iter().enumerate() {
        if let Some(item) = held.get(&n) {
            ids.push(*item);
            m_labels.push(i.label.as_str());
            m_titles.push(i.title.as_deref());
            m_dates.push(i.release_date.as_deref());
        }
    }
    if !ids.is_empty() {
        sqlx::query(
            r#"UPDATE comic_issues ci SET label = u.label
               FROM UNNEST($1::int[], $2::text[]) AS u(item, label)
               WHERE ci."itemId" = u.item AND ci.kind <> 'special' AND NOT ('label' = ANY(ci."lockedFields"))"#,
        )
        .bind(&ids)
        .bind(&m_labels)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"UPDATE items i SET
                 title = CASE WHEN 'title' = ANY(ci."lockedFields") THEN i.title ELSE COALESCE(u.title, i.title) END,
                 "airDate" = CASE WHEN 'releaseDate' = ANY(ci."lockedFields") THEN i."airDate"
                   ELSE COALESCE(u.date::date, i."airDate") END
               FROM UNNEST($1::int[], $2::text[], $3::text[]) AS u(item, title, date)
               JOIN comic_issues ci ON ci."itemId" = u.item
               WHERE i.id = u.item"#,
        )
        .bind(&ids)
        .bind(&m_titles)
        .bind(&m_dates)
        .execute(&mut *tx)
        .await?;
    }

    let fresh: Vec<(usize, &Issue)> = issues
        .iter()
        .enumerate()
        .filter(|(n, _)| !held.contains_key(n))
        .collect();
    if fresh.is_empty() {
        return Ok(());
    }
    // A special's sort is the provider's rank: another special may hold it, so take the next free.
    let mut taken: HashSet<i64> = sqlx::query_scalar::<_, f64>(
        r#"SELECT "sortNumber"::float8 FROM comic_issues WHERE "mediaId" = $1 AND kind = 'special'"#,
    )
    .bind(media)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|s| (s * 100.0).round() as i64)
    .collect();
    let (mut f_kinds, mut f_sorts, mut f_labels, mut f_titles, mut f_dates) =
        (vec![], vec![], vec![], vec![], vec![]);
    for (_, i) in &fresh {
        let mut key = i.key().1;
        if i.kind == "special" {
            while !taken.insert(key) {
                key += 100;
            }
        }
        f_kinds.push(i.kind);
        f_sorts.push(format!("{}", key as f64 / 100.0));
        f_labels.push(i.label.as_str());
        f_titles.push(i.title.as_deref());
        f_dates.push(i.release_date.as_deref());
    }
    let edition = edition(&mut *tx, media).await?;
    let new_ids: Vec<i32> = sqlx::query_scalar(
        r#"SELECT nextval(pg_get_serial_sequence('items', 'id'))::int FROM generate_series(1, $1::int)"#,
    )
    .bind(fresh.len() as i32)
    .fetch_all(&mut *tx)
    .await?;
    sqlx::query(
        r#"INSERT INTO items (id, "mediaId", "editionId", monitored, title, "airDate")
           SELECT u.id, $1, $2, (SELECT monitored FROM media WHERE id = $1) AND (u.date IS NULL OR u.date::date > CURRENT_DATE),
                  u.title, u.date::date
           FROM UNNEST($3::int[], $4::text[], $5::text[]) AS u(id, title, date)"#,
    )
    .bind(media)
    .bind(edition)
    .bind(&new_ids)
    .bind(&f_titles)
    .bind(&f_dates)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"INSERT INTO comic_issues ("itemId", "mediaId", kind, "sortNumber", label)
           SELECT u.id, $1, u.kind, u.sort::numeric, u.label
           FROM UNNEST($2::int[], $3::text[], $4::text[], $5::text[]) AS u(id, kind, sort, label)"#,
    )
    .bind(media)
    .bind(&new_ids)
    .bind(&f_kinds)
    .bind(&f_sorts)
    .bind(&f_labels)
    .execute(&mut *tx)
    .await?;
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
/// holds no comic provider id, its files are merged alone then.
pub async fn refresh(st: &AppState, media: i32, prio: Priority) -> Result<bool, AppError> {
    let Some((ns, id)) = linked(st, media).await? else {
        merge_unmatched(st, media).await?;
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
