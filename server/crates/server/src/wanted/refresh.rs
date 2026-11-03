//! The `FollowRefresh` job (`docs/spec/wants-follows.md` rules 9-14).
use crate::{
    http::{AppError, auth::Authed},
    libraries::accessible_library_ids,
    media::{
        wants,
        write::{
            book_import::{NewBook, create_book},
            resolve_target_in,
        },
    },
    metadata::{
        Search,
        books::{ANCHOR, people, text, work_id},
    },
    state::AppState,
};
use chrono::NaiveDate;
use fliks_domain::{
    acl::{Action, Subject},
    media::{
        kind::MediaKind,
        wants::{default_wants, is_new, parse_release_end, parse_wants, same_name},
    },
    metadata::limiter::Priority,
};
use serde_json::{Map, Value};
use sqlx::{FromRow, types::Json as Jsonb};

const PAGES: u32 = 3;
const BACKGROUND: Priority = Priority::Background;
/// Backstop for the connection that holds a work's advisory lock while the book is created.
const LOCK_IDLE: &str = "10min";

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
    library: i32,
    since: NaiveDate,
    source: Source,
}

#[cfg(test)]
impl Job {
    pub(super) fn author(user: i32, person: i32, name: &str, since: NaiveDate) -> Self {
        Self {
            user,
            library: 1,
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
    #[sqlx(rename = "libraryId")]
    library: i32,
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
    #[sqlx(rename = "libraryId")]
    library: i32,
    #[sqlx(rename = "collectionId")]
    collection: i32,
    since: NaiveDate,
    name: String,
    author: Option<String>,
}

/// The follows and watches of enabled users, an author only while they are credited or have an Open Library id.
async fn jobs(st: &AppState) -> sqlx::Result<Vec<Job>> {
    let authors: Vec<AuthorRow> = sqlx::query_as(
        r#"SELECT f."userId", f."libraryId", f."personId", f.since, p.name, x.value AS olid
           FROM person_follows f
             JOIN users u ON u.id = f."userId" AND u.enabled
             JOIN persons p ON p.id = f."personId"
             LEFT JOIN person_external_ids x ON x."personId" = p.id AND x.provider = 'openlibrary'
           WHERE f."newReleases"
             AND (x.value IS NOT NULL
                  OR EXISTS (SELECT 1 FROM media_credits c WHERE c."personId" = p.id AND c.role = 'author'))
           ORDER BY f."userId", f."personId""#,
    )
    .fetch_all(&st.db)
    .await?;
    let series: Vec<SeriesRow> = sqlx::query_as(
        r#"SELECT w."userId", w."libraryId", w."collectionId", w.since, c.name,
                  (SELECT p.name FROM collection_entries e
                     JOIN media_credits mc ON mc."mediaId" = e."mediaId" AND mc.role = 'author' AND mc."editionId" IS NULL
                     JOIN persons p ON p.id = mc."personId"
                   WHERE e."collectionId" = c.id ORDER BY e.position NULLS LAST, mc.position, p.id LIMIT 1) AS author
           FROM series_watches w
             JOIN users u ON u.id = w."userId" AND u.enabled
             JOIN collections c ON c.id = w."collectionId"
           ORDER BY w."userId", w."collectionId""#,
    )
    .fetch_all(&st.db)
    .await?;
    Ok(authors
        .into_iter()
        .map(|r| Job {
            user: r.user,
            library: r.library,
            since: r.since,
            source: Source::Author {
                person: r.person,
                name: r.name,
                olid: r.olid,
            },
        })
        .chain(series.into_iter().map(|r| Job {
            user: r.user,
            library: r.library,
            since: r.since,
            source: Source::Series {
                collection: r.collection,
                name: r.name,
                author: r.author,
            },
        }))
        .collect())
}

/// Whether the follower may still add books to `library`: enabled, `media.create`, library readable.
async fn allowed(st: &AppState, user: i32, library: i32) -> Result<bool, AppError> {
    let Some(a) = Authed::load(&st.db, user).await? else {
        return Ok(false);
    };
    Ok(a.perms.can(Action::Create, &Subject::Media)
        && accessible_library_ids(&st.db, &a).await?.contains(&library))
}

/// The work id and release of a provider hit that belongs to the job's author or series.
fn belongs(source: &Source, r: &Map<String, Value>) -> Option<(String, Option<NaiveDate>)> {
    let work = work_id(&text(r, "externalId")?)?;
    let ok = match source {
        Source::Author {
            olid: Some(olid), ..
        } => people(r, "authors")
            .iter()
            .any(|(_, id)| id.as_deref().is_some_and(|i| i.eq_ignore_ascii_case(olid))),
        Source::Author { name, .. } => people(r, "authors").iter().any(|(n, _)| same_name(n, name)),
        Source::Series { name, .. } => r
            .get("series")
            .and_then(|s| s.as_array()?.first()?.get("name")?.as_str())
            .is_some_and(|n| same_name(n, name)),
    };
    let release = text(r, "releaseDate")
        .or_else(|| r.get("year")?.as_i64().map(|y| y.to_string()))
        .and_then(|d| parse_release_end(&d));
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

/// Adds the work for the follow when nobody has; `Ok(false)` when it is known, the follow gone or off,
/// or the follower no longer allowed. Only an advisory lock is held across the creation, never a row lock.
pub(super) async fn add(st: &AppState, job: &Job, work: &str) -> Result<bool, AppError> {
    let mut lock = st.db.begin().await?;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SET LOCAL idle_in_transaction_session_timeout = '{LOCK_IDLE}'"
    )))
    .execute(&mut *lock)
    .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("follows:work:{}:{work}", ANCHOR.as_str()))
        .execute(&mut *lock)
        .await?;
    let follow: Option<(i32, Jsonb<Value>)> = match &job.source {
        Source::Author { person, .. } => {
            sqlx::query_as(
                r#"SELECT "libraryId", wants FROM person_follows
                   WHERE "userId" = $1 AND "personId" = $2 AND role = 'author' AND "newReleases""#,
            )
            .bind(job.user)
            .bind(person)
            .fetch_optional(&mut *lock)
            .await?
        }
        Source::Series { collection, .. } => {
            sqlx::query_as(
                r#"SELECT "libraryId", wants FROM series_watches
                   WHERE "userId" = $1 AND "collectionId" = $2"#,
            )
            .bind(job.user)
            .bind(collection)
            .fetch_optional(&mut *lock)
            .await?
        }
    };
    let Some((library, specs)) = follow else {
        return Ok(false);
    };
    if !allowed(st, job.user, library).await? {
        return Ok(false);
    }
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
    let mut specs =
        parse_wants(&specs.0, MediaKind::Book).unwrap_or_else(|_| default_wants(MediaKind::Book));
    wants::drop_unknown_profiles(&st.db, &mut specs).await?;
    create_book(
        st,
        &NewBook {
            target: &target,
            folder: None,
            user: Some(job.user),
            work,
            prio: BACKGROUND,
            wants: Some(&specs),
            discovered: true,
            links: &[],
        },
    )
    .await?;
    lock.commit().await?;
    Ok(true)
}

async fn stamp(st: &AppState, job: &Job, failed: i32) -> sqlx::Result<()> {
    match &job.source {
        Source::Author { person, .. } => {
            sqlx::query(
                r#"UPDATE person_follows SET "refreshedAt" = now(), "failedAdds" = $3
                   WHERE "userId" = $1 AND "personId" = $2 AND role = 'author'"#,
            )
            .bind(job.user)
            .bind(person)
            .bind(failed)
            .execute(&st.db)
            .await
        }
        Source::Series { collection, .. } => {
            sqlx::query(
                r#"UPDATE series_watches SET "refreshedAt" = now(), "failedAdds" = $3
                   WHERE "userId" = $1 AND "collectionId" = $2"#,
            )
            .bind(job.user)
            .bind(collection)
            .bind(failed)
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
    let (mut added, mut failed, mut ran) = (0, 0, 0);
    for job in &jobs {
        match allowed(st, job.user, job.library).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(e) => {
                tracing::warn!(
                    "FollowRefresh: cannot check user #{}: {}",
                    job.user,
                    e.text()
                );
                continue;
            }
        }
        ran += 1;
        let hits = match discover(st, job, &lang).await {
            Ok(h) => h,
            Err(e) => {
                tracing::warn!("FollowRefresh: discovery failed: {e}");
                failed += 1;
                continue;
            }
        };
        let mut failed_adds = 0;
        for (work, _) in hits.into_iter().filter(|(_, r)| is_new(*r, job.since)) {
            match add(st, job, &work).await {
                Ok(true) => {
                    added += 1;
                    tracing::info!("FollowRefresh: added {work} for user #{}", job.user);
                }
                Ok(false) => {}
                Err(e) => {
                    failed_adds += 1;
                    tracing::warn!("FollowRefresh: {work} not added: {}", e.text());
                }
            }
        }
        if let Err(e) = stamp(st, job, failed_adds).await {
            tracing::warn!("FollowRefresh: cannot stamp a follow: {e}");
        }
    }
    tracing::info!("FollowRefresh: {added} title(s) added, {failed} failed of {ran} follow(s)");
    if ran > 0 && failed == ran {
        return Err("every follow failed".into());
    }
    Ok(())
}
