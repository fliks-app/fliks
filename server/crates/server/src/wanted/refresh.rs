//! The `FollowRefresh` job (`docs/spec/wants-follows.md` rules 9-14).
use crate::{
    http::AppError,
    media::write::{book_import::create_book, resolve_target_in},
    metadata::{
        Search,
        books::{ANCHOR, people, text, work_id},
    },
    state::AppState,
};
use chrono::NaiveDate;
use fliks_domain::{
    media::{
        kind::MediaKind,
        wants::{default_wants, is_new, parse_release, parse_wants, same_name},
    },
    metadata::limiter::Priority,
};
use serde_json::{Map, Value};
use sqlx::{FromRow, types::Json as Jsonb};

const PAGES: u32 = 3;
const BACKGROUND: Priority = Priority::Background;

pub(super) enum Source {
    Author {
        person: i32,
        name: String,
        olid: Option<String>,
    },
    Series {
        collection: i32,
        name: String,
        author: Option<String>,
    },
}

pub(super) struct Job {
    user: i32,
    since: NaiveDate,
    source: Source,
}

#[cfg(test)]
impl Job {
    pub(super) fn author(user: i32, person: i32, name: &str, since: NaiveDate) -> Self {
        Self {
            user,
            since,
            source: Source::Author {
                person,
                name: name.into(),
                olid: None,
            },
        }
    }
}

#[derive(FromRow)]
struct AuthorRow {
    #[sqlx(rename = "userId")]
    user: i32,
    #[sqlx(rename = "personId")]
    person: i32,
    since: NaiveDate,
    name: String,
    olid: Option<String>,
}

#[derive(FromRow)]
struct SeriesRow {
    #[sqlx(rename = "userId")]
    user: i32,
    #[sqlx(rename = "collectionId")]
    collection: i32,
    since: NaiveDate,
    name: String,
    author: Option<String>,
}

async fn jobs(st: &AppState) -> sqlx::Result<Vec<Job>> {
    let authors: Vec<AuthorRow> = sqlx::query_as(
        r#"SELECT f."userId", f."personId", f.since, p.name,
                  (SELECT x.value FROM person_external_ids x WHERE x."personId" = p.id AND x.provider = 'openlibrary') AS olid
           FROM person_follows f JOIN persons p ON p.id = f."personId"
           WHERE f."newReleases" ORDER BY f."userId", f."personId""#,
    )
    .fetch_all(&st.db)
    .await?;
    let series: Vec<SeriesRow> = sqlx::query_as(
        r#"SELECT w."userId", w."collectionId", w.since, c.name,
                  (SELECT p.name FROM collection_entries e
                     JOIN media_credits mc ON mc."mediaId" = e."mediaId" AND mc.role = 'author' AND mc."editionId" IS NULL
                     JOIN persons p ON p.id = mc."personId"
                   WHERE e."collectionId" = c.id ORDER BY e.position NULLS LAST, mc.position, p.id LIMIT 1) AS author
           FROM series_watches w JOIN collections c ON c.id = w."collectionId"
           ORDER BY w."userId", w."collectionId""#,
    )
    .fetch_all(&st.db)
    .await?;
    Ok(authors
        .into_iter()
        .map(|r| Job {
            user: r.user,
            since: r.since,
            source: Source::Author {
                person: r.person,
                name: r.name,
                olid: r.olid,
            },
        })
        .chain(series.into_iter().map(|r| Job {
            user: r.user,
            since: r.since,
            source: Source::Series {
                collection: r.collection,
                name: r.name,
                author: r.author,
            },
        }))
        .collect())
}

/// The work id and release of a provider hit that belongs to the job's author or series.
fn belongs(source: &Source, r: &Map<String, Value>) -> Option<(String, Option<NaiveDate>)> {
    let work = work_id(&text(r, "externalId")?)?;
    let ok = match source {
        Source::Author { name, olid, .. } => people(r, "authors").iter().any(|(n, id)| {
            same_name(n, name)
                || matches!((id, olid), (Some(a), Some(b)) if a.eq_ignore_ascii_case(b))
        }),
        Source::Series { name, .. } => r
            .get("series")
            .and_then(|s| s.as_array()?.first()?.get("name")?.as_str())
            .is_some_and(|n| same_name(n, name)),
    };
    let release = text(r, "releaseDate")
        .or_else(|| r.get("year")?.as_i64().map(|y| y.to_string()))
        .and_then(|d| parse_release(&d));
    ok.then_some((work, release))
}

async fn discover(
    st: &AppState,
    job: &Job,
    lang: &fliks_domain::metadata::language::Resolved,
) -> Result<Vec<(String, Option<NaiveDate>)>, String> {
    let mut found: Vec<(String, Option<NaiveDate>)> = vec![];
    for page in 1..=PAGES {
        let (query, title, author, author_id) = match &job.source {
            Source::Author { name, olid, .. } => {
                (name.as_str(), None, Some(name.as_str()), olid.as_deref())
            }
            Source::Series { name, author, .. } => {
                (name.as_str(), Some(name.as_str()), author.as_deref(), None)
            }
        };
        let search = Search {
            kind: MediaKind::Book,
            query,
            year: None,
            title,
            author,
            author_id,
            isbn: None,
            language: None,
            page,
        };
        let hits = st
            .metadata
            .of(ANCHOR)
            .search(&search, lang, BACKGROUND)
            .await
            .map_err(|e| e.to_string())?;
        if hits.is_empty() {
            break;
        }
        for h in &hits {
            if let Some((w, r)) = h.as_object().and_then(|r| belongs(&job.source, r))
                && !found.iter().any(|(f, _)| *f == w)
            {
                found.push((w, r));
            }
        }
    }
    Ok(found)
}

/// Adds the work for the follow when nobody has; `Ok(false)` when it is known, the follow gone or off.
pub(super) async fn add(st: &AppState, job: &Job, work: &str) -> Result<bool, AppError> {
    let mut lock = st.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("follows:work:{}:{work}", ANCHOR.as_str()))
        .execute(&mut *lock)
        .await?;
    let follow: Option<(i32, Jsonb<Value>)> = match &job.source {
        Source::Author { person, .. } => {
            sqlx::query_as(
                r#"SELECT "libraryId", wants FROM person_follows
                   WHERE "userId" = $1 AND "personId" = $2 AND role = 'author' AND "newReleases" FOR SHARE"#,
            )
            .bind(job.user)
            .bind(person)
            .fetch_optional(&mut *lock)
            .await?
        }
        Source::Series { collection, .. } => {
            sqlx::query_as(
                r#"SELECT "libraryId", wants FROM series_watches
                   WHERE "userId" = $1 AND "collectionId" = $2 FOR SHARE"#,
            )
            .bind(job.user)
            .bind(collection)
            .fetch_optional(&mut *lock)
            .await?
        }
    };
    let Some((library, wants)) = follow else {
        return Ok(false);
    };
    let known: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM media_external_ids WHERE kind = 'book' AND provider = $1 AND value = $2)
                OR EXISTS (SELECT 1 FROM discovered_works WHERE provider = $1 AND value = $2)"#,
    )
    .bind(ANCHOR.as_str())
    .bind(work)
    .fetch_one(&mut *lock)
    .await?;
    if known {
        return Ok(false);
    }
    let target = resolve_target_in(st, &[library], MediaKind::Book, Some(library), None).await?;
    let wants =
        parse_wants(&wants.0, MediaKind::Book).unwrap_or_else(|_| default_wants(MediaKind::Book));
    let id = create_book(
        st,
        &target,
        None,
        Some(job.user),
        work,
        BACKGROUND,
        Some(&wants),
    )
    .await?;
    sqlx::query(r#"INSERT INTO discovered_works (provider, value, "mediaId") VALUES ($1, $2, $3)"#)
        .bind(ANCHOR.as_str())
        .bind(work)
        .bind(id)
        .execute(&mut *lock)
        .await?;
    lock.commit().await?;
    Ok(true)
}

async fn stamp(st: &AppState, job: &Job) -> sqlx::Result<()> {
    match &job.source {
        Source::Author { person, .. } => {
            sqlx::query(
                r#"UPDATE person_follows SET "refreshedAt" = now()
                   WHERE "userId" = $1 AND "personId" = $2 AND role = 'author'"#,
            )
            .bind(job.user)
            .bind(person)
            .execute(&st.db)
            .await
        }
        Source::Series { collection, .. } => {
            sqlx::query(
                r#"UPDATE series_watches SET "refreshedAt" = now() WHERE "userId" = $1 AND "collectionId" = $2"#,
            )
            .bind(job.user)
            .bind(collection)
            .execute(&st.db)
            .await
        }
    }
    .map(drop)
}

/// Runs every follow and watch once; a failing one is logged and the rest go on.
pub async fn run(st: &AppState) -> Result<(), String> {
    let jobs = jobs(st).await.map_err(|e| e.to_string())?;
    if jobs.is_empty() {
        return Ok(());
    }
    if !st.metadata.available(ANCHOR) {
        return Err("the work provider is unavailable".into());
    }
    let lang = st
        .metadata
        .lang
        .resolve(None)
        .await
        .map_err(|e| e.to_string())?;
    let (mut added, mut failed) = (0, 0);
    for job in &jobs {
        let hits = match discover(st, job, &lang).await {
            Ok(h) => h,
            Err(e) => {
                tracing::warn!("FollowRefresh: discovery failed: {e}");
                failed += 1;
                continue;
            }
        };
        for (work, _) in hits.into_iter().filter(|(_, r)| is_new(*r, job.since)) {
            match add(st, job, &work).await {
                Ok(true) => {
                    added += 1;
                    tracing::info!("FollowRefresh: added {work} for user #{}", job.user);
                }
                Ok(false) => {}
                Err(e) => tracing::warn!("FollowRefresh: {work} not added: {}", e.text()),
            }
        }
        if let Err(e) = stamp(st, job).await {
            tracing::warn!("FollowRefresh: cannot stamp a follow: {e}");
        }
    }
    tracing::info!(
        "FollowRefresh: {added} title(s) added, {failed} failed of {} follow(s)",
        jobs.len()
    );
    if failed == jobs.len() {
        return Err("every follow failed".into());
    }
    Ok(())
}
