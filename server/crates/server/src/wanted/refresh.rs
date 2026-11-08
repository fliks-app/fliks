//! The `FollowRefresh` job (`docs/spec/wants-follows.md` rules 9-14).
use crate::{
    http::{AppError, auth::Authed},
    libraries::{accessible_library_ids, metadata_profile},
    media::{
        wants,
        write::{
            Creation,
            album_import::create_album_from,
            book_import::{NewBook, create_book},
            resolve_target_in,
        },
    },
    metadata::{
        books::{ANCHOR, author_works, series_works, text, work_id},
        music::target,
    },
    state::AppState,
};
use chrono::NaiveDate;
use fliks_domain::{
    acl::{Action, Subject},
    external_id::Namespace,
    media::{
        kind::MediaKind,
        wants::{default_wants, is_new, parse_release_end, parse_wants},
    },
    metadata::limiter::Priority,
};
use serde_json::Value;
use sqlx::{FromRow, types::Json as Jsonb};

const BACKGROUND: Priority = Priority::Background;
/// Backstop for the connection that holds a work's advisory lock while the book is created.
const LOCK_IDLE: &str = "10min";

pub(super) enum Source {
    /// An artist, by its MusicBrainz id.
    Artist { person: i32, mbid: String },
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
           WHERE f."newReleases" AND f.role = 'author'
             AND (x.value IS NOT NULL
                  OR EXISTS (SELECT 1 FROM media_credits c WHERE c."personId" = p.id AND c.role = 'author'))
           ORDER BY f."userId", f."personId""#,
    )
    .fetch_all(&st.db)
    .await?;
    let artists: Vec<AuthorRow> = sqlx::query_as(
        r#"SELECT f."userId", f."libraryId", f."personId", f.since, p.name, x.value AS olid
           FROM person_follows f
             JOIN users u ON u.id = f."userId" AND u.enabled
             JOIN persons p ON p.id = f."personId"
             JOIN person_external_ids x ON x."personId" = p.id AND x.provider = 'musicbrainz'
           WHERE f."newReleases" AND f.role = 'artist'
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
        .chain(artists.into_iter().filter_map(|r| {
            Some(Job {
                user: r.user,
                library: r.library,
                since: r.since,
                source: Source::Artist {
                    person: r.person,
                    mbid: r.olid?,
                },
            })
        }))
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

async fn discover(
    st: &AppState,
    job: &Job,
    lang: &fliks_domain::metadata::language::Resolved,
) -> Result<Vec<(String, Option<NaiveDate>)>, String> {
    let hits = match &job.source {
        Source::Artist { mbid, .. } => return discover_albums(st, job, mbid, lang).await,
        Source::Author { name, olid, .. } => {
            author_works(st, lang, name, olid.as_deref(), BACKGROUND).await
        }
        Source::Series { name, author, .. } => {
            series_works(st, lang, name, author.as_deref(), BACKGROUND).await
        }
    }
    .map_err(|e| e.to_string())?;
    Ok(hits
        .iter()
        .filter_map(|r| {
            let work = work_id(&text(r, "externalId")?)?;
            let release = text(r, "releaseDate")
                .or_else(|| r.get("year")?.as_i64().map(|y| y.to_string()))
                .and_then(|d| parse_release_end(&d));
            Some((work, release))
        })
        .collect())
}

/// The release groups of the artist the library's profile wants, with their release dates.
async fn discover_albums(
    st: &AppState,
    job: &Job,
    mbid: &str,
    lang: &fliks_domain::metadata::language::Resolved,
) -> Result<Vec<(String, Option<NaiveDate>)>, String> {
    let profile = metadata_profile(&st.db, job.library)
        .await
        .map_err(|e| e.to_string())?;
    let albums = st
        .metadata
        .albums(Namespace::MUSICBRAINZ, mbid, lang, BACKGROUND)
        .await
        .map_err(|e| format!("{e:?}"))?;
    let mut seen = std::collections::HashSet::new();
    Ok(albums
        .iter()
        .filter_map(|raw| {
            let a = fliks_domain::music::provider::album(raw).ok()?;
            let secondary: Vec<String> =
                a.secondary_types.iter().map(|t| (*t).to_owned()).collect();
            (profile.allows_group(a.primary_type, &secondary) && seen.insert(a.external_id.clone()))
                .then(|| {
                    let release = raw["firstReleaseDate"].as_str().and_then(parse_release_end);
                    (a.external_id, release)
                })
        })
        .collect())
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
        .bind(format!(
            "follows:work:{}:{work}",
            provider_of(&job.source).as_str()
        ))
        .execute(&mut *lock)
        .await?;
    let follow: Option<(i32, Jsonb<Value>)> = match &job.source {
        Source::Artist { person, .. } => {
            sqlx::query_as(
                r#"SELECT "libraryId", wants FROM person_follows
                   WHERE "userId" = $1 AND "personId" = $2 AND role = 'artist' AND "newReleases""#,
            )
            .bind(job.user)
            .bind(person)
            .fetch_optional(&mut *lock)
            .await?
        }
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
    let kind = kind_of(&job.source);
    let known: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM media_external_ids WHERE kind = $3 AND provider = $1 AND value = $2)
                OR EXISTS (SELECT 1 FROM media_external_id_aliases WHERE kind = $3 AND provider = $1 AND value = $2)
                OR EXISTS (SELECT 1 FROM discovered_works WHERE provider = $1 AND value = $2)"#,
    )
    .bind(provider_of(&job.source).as_str())
    .bind(work)
    .bind(kind.as_str())
    .fetch_one(&mut *lock)
    .await?;
    if known {
        return Ok(false);
    }
    let target = resolve_target_in(st, &[library], kind, Some(library), None).await?;
    let mut specs = parse_wants(&specs.0, kind).unwrap_or_else(|e| {
        let follow = match &job.source {
            Source::Artist { person, .. } => format!("artist person {person}"),
            Source::Author { person, .. } => format!("author person {person}"),
            Source::Series { collection, .. } => format!("series collection {collection}"),
        };
        tracing::warn!(
            "follow of user {} ({follow}): corrupt wants, using the defaults: {e}",
            job.user
        );
        default_wants(kind)
    });
    wants::drop_unknown_profiles(&st.db, &mut specs).await?;
    if kind == MediaKind::Album {
        add_album(st, job, &target, work, &specs).await?;
        lock.commit().await?;
        return Ok(true);
    }
    create_book(
        st,
        &NewBook {
            target: &target,
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

/// The kind a follow adds and the namespace its titles are known by.
fn kind_of(s: &Source) -> MediaKind {
    match s {
        Source::Artist { .. } => MediaKind::Album,
        _ => MediaKind::Book,
    }
}

fn provider_of(s: &Source) -> Namespace {
    match s {
        Source::Artist { .. } => Namespace::MUSICBRAINZ,
        _ => ANCHOR,
    }
}

/// Creates the release group as a monitored album, remembers it was discovered, and picks its target edition.
async fn add_album(
    st: &AppState,
    job: &Job,
    target_library: &crate::media::write::Target,
    work: &str,
    specs: &[fliks_domain::media::wants::WantSpec],
) -> Result<(), AppError> {
    let id = create_album_from(
        st,
        &Creation {
            kind: MediaKind::Album,
            id: (Namespace::MUSICBRAINZ, work),
            target: target_library,
            profiles: (None, None),
            user: Some(job.user),
            links: vec![],
            seasons: None,
            wants: Some(specs),
            prio: BACKGROUND,
        },
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO discovered_works (provider, value, "mediaId") VALUES ('musicbrainz', $1, $2)
           ON CONFLICT DO NOTHING"#,
    )
    .bind(work)
    .bind(id)
    .execute(&st.db)
    .await?;
    if let Err(e) = target::ensure(st, id, BACKGROUND).await {
        tracing::warn!(
            "FollowRefresh: album #{id} has no target edition yet: {}",
            e.text()
        );
    }
    Ok(())
}

async fn stamp(st: &AppState, job: &Job, failed: i32) -> sqlx::Result<()> {
    match &job.source {
        Source::Artist { person, .. } => {
            sqlx::query(
                r#"UPDATE person_follows SET "refreshedAt" = now(), "failedAdds" = $3
                   WHERE "userId" = $1 AND "personId" = $2 AND role = 'artist'"#,
            )
            .bind(job.user)
            .bind(person)
            .bind(failed)
            .execute(&st.db)
            .await
        }
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
    if let Err(e) = target::sweep(st).await {
        tracing::warn!("FollowRefresh: target editions not swept: {}", e.text());
    }
    let jobs = jobs(st).await.map_err(|e| e.to_string())?;
    if jobs.is_empty() {
        return Ok(());
    }
    if jobs.iter().any(|j| kind_of(&j.source) == MediaKind::Book) && !st.metadata.available(ANCHOR)
    {
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
        if matches!(job.source, Source::Artist { .. })
            && !st.metadata.available(Namespace::MUSICBRAINZ)
        {
            failed += 1;
            continue;
        }
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

#[cfg(test)]
mod artist_tests {
    use super::*;
    use crate::metadata::music::tests::{ARTIST, GROUP, MusicFake, RELEASE};
    use serde_json::json;
    use sqlx::PgPool;
    use std::sync::Arc;

    const SINGLE: &str = "6c1e4f20-b4a2-4a53-9d0e-5a1c1f7a2b01";

    fn fake() -> Arc<MusicFake> {
        let f = Arc::new(MusicFake::default());
        *f.albums.lock().unwrap() = vec![
            json!({"externalId": GROUP, "title": "Alpha", "primaryType": "album", "firstReleaseDate": "1999-05-01"}),
            json!({"externalId": SINGLE, "title": "Beta", "primaryType": "single", "firstReleaseDate": "2001"}),
        ];
        f.works.lock().unwrap().insert(
            GROUP.into(),
            json!({"externalId": GROUP, "title": "Alpha", "primaryType": "album", "year": 1999,
                   "firstReleaseDate": "1999-05-01", "mediaType": "album",
                   "artists": [{"name": "Ana", "id": ARTIST}]}),
        );
        f.children.lock().unwrap().insert(
            GROUP.into(),
            vec![json!({"externalId": RELEASE, "title": "Alpha", "country": "FR", "status": "official", "trackCount": 2})],
        );
        f.editions.lock().unwrap().insert(
            RELEASE.into(),
            json!({"externalId": RELEASE, "title": "Alpha", "country": "FR", "status": "official", "media": "cd",
                   "trackCount": 2, "tracks": [
                {"title": "One", "discNumber": 1, "position": 1, "number": 1, "durationMs": 100000,
                 "recordingId": "11111111-1111-4111-8111-111111111111"},
                {"title": "Two", "discNumber": 1, "position": 2, "number": 2, "durationMs": 100000,
                 "recordingId": "11111111-1111-4111-8111-111111111112"}]}),
        );
        f
    }

    #[sqlx::test(migrations = false)]
    async fn an_artist_follow_adds_the_new_albums_its_profile_wants_once(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            r#"INSERT INTO users (id, username, "isAdmin") VALUES (1, 'admin', true);
               INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Music', '["album"]');
               INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
               INSERT INTO persons (id, name) VALUES (1, 'Ana');
               INSERT INTO person_external_ids ("personId", provider, value) VALUES (1, 'musicbrainz', '{ARTIST}');
               INSERT INTO person_follows ("userId", "personId", role, "newReleases", "libraryId", wants, since)
                 VALUES (1, 1, 'artist', true, 1, '[{{"family": "audio"}}]', '1990-01-01')"#
        )))
        .execute(&db)
        .await
        .unwrap();
        let st = AppState::new(
            db.clone(),
            crate::config::Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        );
        st.metadata.add_plugin(fake());
        run(&st).await.unwrap();
        let albums: Vec<(String, bool)> =
            sqlx::query_as("SELECT title, monitored FROM media WHERE type = 'album'")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(
            albums,
            [("Alpha".to_owned(), true)],
            "the single is not wanted by the default profile"
        );
        let ledger: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM discovered_works WHERE provider = 'musicbrainz'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(ledger, 1);
        let wanted: i64 = sqlx::query_scalar(
            r#"SELECT count(*) FROM items i JOIN album_details ad ON ad."targetEditionId" = i."editionId" WHERE i.monitored"#,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(wanted, 2, "the target edition's tracks are wanted");
        let stamped: Option<i32> = sqlx::query_scalar(
            r#"SELECT "failedAdds" FROM person_follows WHERE "refreshedAt" IS NOT NULL"#,
        )
        .fetch_optional(&db)
        .await
        .unwrap();
        assert_eq!(stamped, Some(0));
        run(&st).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM media WHERE type = 'album'")
                .fetch_one(&db)
                .await
                .unwrap(),
            1,
            "a known album is not added again"
        );
    }
}
