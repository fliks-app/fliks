use crate::{
    http::{AppError, auth::Authed},
    images::{ImageStore, paths::Target},
    libraries::{accessible_library_ids, paths_visible},
    media::{books, hydrate},
    metadata::{
        Credits, Metadata, PersonDetails, Upstream,
        books::{ANCHOR, author_works, routes::hit as book_hit},
        mark_existing, unavailable,
    },
    state::AppState,
};
use axum::http::StatusCode;
use fliks_domain::{
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::{language::Resolved, limiter::Priority},
    persons::{Owned, link, needs_refresh, tsquery},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::HashSet;

/// The columns the refresh and the credits need; the JSON shape is read with `person_json`.
#[derive(Debug, Clone)]
pub struct Person {
    pub id: i32,
    pub provider: Option<String>,
    pub tmdb_id: Option<i32>,
    /// The MusicBrainz artist id, held beside (or instead of) a video id.
    pub musicbrainz: Option<String>,
    pub name: String,
    pub refreshed_ms: Option<i64>,
}

fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("Person #{id} not found"))
}

pub async fn find(db: &PgPool, id: i32) -> Result<Person, AppError> {
    sqlx::query!(
        r#"SELECT x.provider AS "provider?", x.value::int AS "tmdb_id?", p.name, p."metadataRefreshedAt" AS refreshed,
  (SELECT m.value FROM person_external_ids m WHERE m."personId" = p.id AND m.provider = 'musicbrainz') AS musicbrainz
FROM persons p LEFT JOIN person_ids x ON x."personId" = p.id WHERE p.id = $1"#,
        id
    )
    .fetch_optional(db)
    .await?
    .map(|r| Person {
        id,
        provider: r.provider,
        tmdb_id: r.tmdb_id,
        musicbrainz: r.musicbrainz,
        name: r.name,
        refreshed_ms: r.refreshed.map(|t| t.timestamp_millis()),
    })
    .ok_or_else(|| not_found(id))
}

/// `Person` as the API serialises it (`persons.md` header).
async fn person_json(db: &PgPool, id: i32) -> Result<Value, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT jsonb_build_object('id', p.id, 'createdAt', iso_ms(p."createdAt"), 'updatedAt', iso_ms(p."updatedAt"),
    'provider', x.provider, 'tmdbId', x.value::int, 'name', p.name, 'avatarUrl', p."avatarUrl", 'biography', p.biography,
    'birthday', p.birthday, 'deathday', p.deathday, 'placeOfBirth', p."placeOfBirth",
    'knownForDepartment', p."knownForDepartment", 'departments', p.departments,
    'metadataRefreshedAt', iso_ms(p."metadataRefreshedAt")) AS "json!: Value"
FROM persons p LEFT JOIN person_ids x ON x."personId" = p.id WHERE p.id = $1"#,
        id
    )
    .fetch_one(db)
    .await
}

/// Rules 2-7: the first 1000 persons by name for a blank `q`, else prefix terms ANDed, best rank first, 50 at most.
pub async fn search(db: &PgPool, q: &str) -> Result<Vec<Value>, sqlx::Error> {
    if q.is_empty() {
        return sqlx::query_scalar!(
            r#"SELECT jsonb_build_object('id', p.id, 'createdAt', iso_ms(p."createdAt"), 'updatedAt', iso_ms(p."updatedAt"),
    'provider', x.provider, 'tmdbId', x.value::int, 'name', p.name, 'avatarUrl', p."avatarUrl", 'biography', p.biography,
    'birthday', p.birthday, 'deathday', p.deathday, 'placeOfBirth', p."placeOfBirth",
    'knownForDepartment', p."knownForDepartment", 'departments', p.departments,
    'metadataRefreshedAt', iso_ms(p."metadataRefreshedAt")) AS "json!: Value"
FROM persons p LEFT JOIN person_ids x ON x."personId" = p.id ORDER BY p.name ASC, p.id ASC LIMIT 1000"#
        )
        .fetch_all(db)
        .await;
    }
    let Some(tsq) = tsquery(q) else {
        return Ok(vec![]);
    };
    sqlx::query_scalar!(
        r#"SELECT jsonb_build_object('id', p.id, 'createdAt', iso_ms(p."createdAt"), 'updatedAt', iso_ms(p."updatedAt"),
    'provider', x.provider, 'tmdbId', x.value::int, 'name', p.name, 'avatarUrl', p."avatarUrl", 'biography', p.biography,
    'birthday', p.birthday, 'deathday', p.deathday, 'placeOfBirth', p."placeOfBirth",
    'knownForDepartment', p."knownForDepartment", 'departments', p.departments,
    'metadataRefreshedAt', iso_ms(p."metadataRefreshedAt")) AS "json!: Value"
FROM persons p LEFT JOIN person_ids x ON x."personId" = p.id WHERE p."searchVector" @@ to_tsquery('simple', $1)
ORDER BY ts_rank(p."searchVector", to_tsquery('simple', $1)) DESC, p.name ASC, p.id ASC LIMIT 50"#,
        tsq
    )
    .fetch_all(db)
    .await
}

/// Rule 11: the stored provider (TMDB when its key is missing); a 404 asks the other one and pins the id row to it.
async fn call_provider<T, Fut>(
    md: &Metadata,
    db: &PgPool,
    p: &mut Person,
    call: impl Fn(Namespace) -> Fut,
) -> Result<(T, Namespace), (Namespace, Upstream)>
where
    Fut: std::future::Future<Output = Result<T, Upstream>>,
{
    let primary = md.named(p.provider.as_deref()).unwrap_or(Namespace::TMDB);
    let e = match call(primary).await {
        Ok(v) => return Ok((v, primary)),
        Err(e) => e,
    };
    let Some(other) = md.person_fallback(primary).filter(|_| e.is_not_found()) else {
        return Err((primary, e));
    };
    let v = call(other).await.map_err(|e| (other, e))?;
    tracing::info!("person {} is known to {}, pinning", p.id, other.as_str());
    // Another person may already hold that (provider, value): keep this one's provider.
    match sqlx::query!(
        r#"UPDATE person_external_ids SET provider = $2 WHERE "personId" = $1 AND provider = $3"#,
        p.id,
        other.as_str(),
        p.provider
    )
    .execute(db)
    .await
    {
        Ok(_) => p.provider = Some(other.as_str().to_owned()),
        Err(e) => tracing::warn!("person {} not pinned to {}: {e}", p.id, other.as_str()),
    }
    Ok((v, other))
}

/// A MusicBrainz artist: the provider keyed by `musicbrainz` answers the whole record, the next providers
/// of `metadata.provider_order.album` that serve its ids fill a missing image or biography.
/// The MusicBrainz artist `mbid` as its providers describe it.
pub async fn provider_artist(st: &AppState, mbid: &str) -> Result<PersonDetails, AppError> {
    let lang = st.metadata.lang.resolve(None).await?;
    music_details(&st.metadata, &lang, mbid)
        .await
        .map_err(|e| AppError::with_message(StatusCode::BAD_GATEWAY, e))
}

async fn music_details(
    md: &Metadata,
    lang: &Resolved,
    mbid: &str,
) -> Result<PersonDetails, String> {
    let mut providers = md
        .person_providers(MediaKind::Album, Namespace::MUSICBRAINZ)
        .into_iter();
    let first = providers
        .next()
        .ok_or("no provider serves MusicBrainz artists")?;
    let ask = |pr: Namespace| async move {
        md.of(pr)
            .fetch_person(mbid, lang, Priority::Interactive)
            .await
    };
    let mut d = ask(first)
        .await
        .map_err(|e| format!("{}: {e}", first.as_str()))?;
    let missing = |s: &Option<String>| s.as_deref().is_none_or(str::is_empty);
    for pr in providers {
        if !missing(&d.avatar_url) && !missing(&d.biography) {
            break;
        }
        match ask(pr).await {
            Ok(f) => {
                if missing(&d.avatar_url) {
                    d.avatar_url = f.avatar_url;
                }
                if missing(&d.biography) {
                    d.biography = f.biography;
                }
            }
            Err(e) => tracing::warn!("person fill from {}: {e}", pr.as_str()),
        }
    }
    Ok(d)
}

async fn try_refresh(
    db: &PgPool,
    md: &Metadata,
    images: &ImageStore,
    lang: &Resolved,
    p: &mut Person,
) -> Result<(), String> {
    let d = if let Some(ext) = p.tmdb_id.map(|id| id.to_string()) {
        let ext = &ext;
        call_provider(md, db, p, |pr| async move {
            md.of(pr)
                .fetch_person(ext, lang, Priority::Interactive)
                .await
        })
        .await
        .map_err(|(pr, e)| format!("{}: {e}", pr.as_str()))?
        .0
    } else if let Some(mbid) = &p.musicbrainz {
        music_details(md, lang, mbid).await?
    } else {
        return Ok(());
    };
    let avatar = match d.avatar_url.as_deref().filter(|u| !u.is_empty()) {
        Some(url) => images.download_and_store(url, &Target::person(p.id)).await,
        None => None,
    };
    sqlx::query(
        r#"UPDATE persons SET name = COALESCE($2, name), "avatarUrl" = COALESCE($3, "avatarUrl"),
  biography = COALESCE($4, biography), birthday = COALESCE($5::text::date, birthday),
  deathday = COALESCE($6::text::date, deathday), "placeOfBirth" = COALESCE($7, "placeOfBirth"),
  "knownForDepartment" = COALESCE($8, "knownForDepartment"), "sortName" = COALESCE($9, "sortName"),
  disambiguation = COALESCE($10, disambiguation), "artistType" = COALESCE($11, "artistType"),
  "metadataRefreshedAt" = now()
WHERE id = $1"#,
    )
    .bind(p.id)
    .bind(&d.name)
    .bind(&avatar)
    .bind(&d.biography)
    .bind(&d.birthday)
    .bind(&d.deathday)
    .bind(&d.place_of_birth)
    .bind(&d.known_for_department)
    .bind(&d.sort_name)
    .bind(&d.disambiguation)
    .bind(&d.artist_type)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    if let (Some(asked), Some(now)) = (&p.musicbrainz, &d.canonical_id)
        && asked != now
    {
        let moved = crate::metadata::music::aliases::redirect_person(db, p.id, asked, now)
            .await
            .map_err(|e| e.to_string())?;
        tracing::info!("person {} merged upstream: {moved:?}", p.id);
    }
    Ok(())
}

/// Rules 9-15: refresh a person unseen for 7 days; every failure is swallowed and the stored row served.
pub async fn ensure_details_loaded(
    db: &PgPool,
    md: &Metadata,
    images: &ImageStore,
    lang: &Resolved,
    p: &mut Person,
) {
    if !needs_refresh(p.refreshed_ms, chrono::Utc::now().timestamp_millis()) {
        return;
    }
    if let Err(e) = try_refresh(db, md, images, lang, p).await {
        tracing::warn!("person {} not refreshed: {e}", p.id);
    }
}

/// The cast (or crew) rows of a person for media in libraries the caller can read.
async fn credit_rows(
    st: &AppState,
    a: &Authed,
    person: i32,
    person_json: &Value,
    crew: bool,
) -> Result<Vec<Value>, AppError> {
    let rows: Vec<(i32, Value)> = if crew {
        sqlx::query!(
            r#"SELECT mc."mediaId" AS media_id, jsonb_build_object('id', mc.id, 'createdAt', iso_ms(mc."createdAt"),
  'updatedAt', iso_ms(mc."updatedAt"), 'job', mc.job, 'department', mc.department) AS "json!: Value"
FROM media_credits mc WHERE mc."personId" = $1 AND mc.role = 'crew' ORDER BY mc.position ASC, mc.id ASC"#,
            person
        )
        .fetch_all(&st.db)
        .await?
        .into_iter()
        .map(|r| (r.media_id, r.json))
        .collect()
    } else {
        sqlx::query!(
            r#"SELECT mc."mediaId" AS media_id, jsonb_build_object('id', mc.id, 'createdAt', iso_ms(mc."createdAt"),
  'updatedAt', iso_ms(mc."updatedAt"), 'character', mc.character, 'order', mc.position) AS "json!: Value"
FROM media_credits mc WHERE mc."personId" = $1 AND mc.role = 'cast' ORDER BY mc.position ASC, mc.id ASC"#,
            person
        )
        .fetch_all(&st.db)
        .await?
        .into_iter()
        .map(|r| (r.media_id, r.json))
        .collect()
    };
    let wanted: Vec<i32> = rows
        .iter()
        .map(|r| r.0)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let libs = accessible_library_ids(&st.db, a).await?;
    let readable = sqlx::query_scalar!(
        r#"SELECT id AS "id!" FROM media WHERE id = ANY($1) AND "libraryId" = ANY($2) AND type = ANY($3)"#,
        &wanted,
        &libs,
        &a.kinds.names()
    )
    .fetch_all(&st.db)
    .await?;
    let media = hydrate::credit_media(&st.db, &readable, paths_visible(&a.perms)).await?;
    // A media can appear on several rows: serialise it once per row.
    let mut out = vec![];
    for (media_id, mut row) in rows {
        let Some(m) = media.get(&media_id) else {
            continue;
        };
        row["media"] = m.clone();
        row["person"] = person_json.clone();
        out.push(row);
    }
    Ok(out)
}

/// `GET /api/persons/:id`.
pub async fn detail(st: &AppState, a: &Authed, id: i32) -> Result<Value, AppError> {
    let mut p = find(&st.db, id).await?;
    let lang = st.metadata.lang.resolve(None).await?;
    ensure_details_loaded(&st.db, &st.metadata, &st.images, &lang, &mut p).await;
    let person = person_json(&st.db, id).await?;
    let (cast, crew) = tokio::try_join!(
        credit_rows(st, a, id, &person, false),
        credit_rows(st, a, id, &person, true)
    )?;
    Ok(json!({"person": person, "cast": cast, "crew": crew}))
}

/// Rule 20: each credit gets the owned media of its `(type, id)` the caller can read, else `null`.
async fn link_credits(
    st: &AppState,
    a: &Authed,
    served: Namespace,
    credits: Credits,
) -> Result<(Vec<Value>, Vec<Value>), AppError> {
    let ids: Vec<i32> = credits
        .cast
        .iter()
        .chain(&credits.crew)
        .filter_map(|c| c.get("externalId").and_then(Value::as_i64))
        .filter(|n| *n != 0)
        .filter_map(|n| i32::try_from(n).ok())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut owned = vec![];
    if !ids.is_empty() {
        let libs = accessible_library_ids(&st.db, a).await?;
        let wanted: Vec<String> = ids.iter().map(i32::to_string).collect();
        let rows: Vec<(i32, String, i32)> = sqlx::query!(
            r#"SELECT m.id AS "id!", m.type AS "kind!", e.value::int AS "ext!"
               FROM media_external_ids e JOIN media m ON m.id = e."mediaId"
               WHERE e.provider = $3 AND e.value = ANY($1) AND m."libraryId" = ANY($2)
                 AND m.type = ANY($4)
               ORDER BY m.id ASC"#,
            &wanted,
            &libs,
            served.as_str(),
            &a.kinds.names()
        )
        .fetch_all(&st.db)
        .await?
        .into_iter()
        .map(|r| (r.id, r.kind, r.ext))
        .collect();
        owned = rows
            .into_iter()
            .map(|(id, kind, ext)| {
                Ok(Owned {
                    id,
                    kind: crate::db::kind(&kind)?,
                    external_id: i64::from(ext),
                })
            })
            .collect::<sqlx::Result<_>>()?;
    }
    let attach = |items: Vec<Value>| -> Vec<Value> {
        items
            .into_iter()
            .map(|mut c| {
                let ext = c
                    .get("externalId")
                    .and_then(Value::as_i64)
                    .unwrap_or_default();
                let kind = c
                    .get("mediaType")
                    .and_then(Value::as_str)
                    .and_then(MediaKind::parse);
                c["mediaId"] = kind
                    .and_then(|k| link(&owned, ext, k))
                    .map_or(Value::Null, Value::from);
                c
            })
            .collect()
    };
    Ok((attach(credits.cast), attach(credits.crew)))
}

/// `GET /api/persons/:id/provider-credits`.
pub async fn provider_credits(st: &AppState, a: &Authed, id: i32) -> Result<Value, AppError> {
    let mut p = find(&st.db, id).await?;
    let lang = st.metadata.lang.resolve(None).await?;
    let Some(ext) = p.tmdb_id.map(|id| id.to_string()) else {
        return Ok(json!({"provider": null, "cast": [], "crew": []}));
    };
    let md = &*st.metadata;
    let (ext, lang) = (&ext, &lang);
    let (credits, served) = call_provider(md, &st.db, &mut p, |pr| async move {
        md.of(pr)
            .person_credits(ext, lang, Priority::Interactive)
            .await
    })
    .await
    .map_err(|(pr, e)| {
        AppError::with_message(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            format!("Metadata request failed on {}: {}", pr.as_str(), e.reason()),
        )
    })?;
    let (cast, crew) = link_credits(st, a, served, credits).await?;
    Ok(json!({"provider": p.provider, "cast": cast, "crew": crew}))
}

/// `GET /api/persons/:id/bibliography` (`persons.md` rule 23).
pub async fn bibliography(st: &AppState, a: &Authed, id: i32) -> Result<Value, AppError> {
    let p = find(&st.db, id).await?;
    if !a.kinds.has(MediaKind::Book) {
        return Ok(json!([]));
    }
    let olid: Option<String> = sqlx::query_scalar(
        r#"SELECT value FROM person_external_ids WHERE "personId" = $1 AND provider = 'openlibrary'"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await?;
    let md = &st.metadata;
    let (Some(olid), true) = (
        olid,
        md.available(ANCHOR) && md.of(ANCHOR).has_search(MediaKind::Book),
    ) else {
        return Ok(json!([]));
    };
    let lang = md.lang.resolve(None).await?;
    let works = author_works(st, &lang, &p.name, Some(&olid), Priority::Interactive)
        .await
        .map_err(|e| unavailable("search", ANCHOR, &e))?;
    let known = st.namespaces();
    let mut hits: Vec<Value> = works
        .into_iter()
        .filter_map(|r| book_hit(&known, ANCHOR, &Value::Object(r)))
        .collect();
    mark_existing(&st.db, a, MediaKind::Book, &mut hits).await?;
    Ok(Value::Array(hits))
}

/// `books-api.md` A9: the people credited in `role` (`author` or `narrator`) on readable books.
pub async fn people(
    db: &PgPool,
    role: &str,
    scope: &[i32],
    acl: &[i32],
    tsq: Option<&str>,
    by_works: bool,
    paging: Option<(i64, i64)>,
) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT jsonb_build_object('id', p.id, 'name', p.name, 'sortName', p."sortName", 'avatarUrl', p."avatarUrl",
  'workCount', COUNT(DISTINCT m.id)::int) AS "json!: Value"
FROM persons p JOIN media_credits mc ON mc."personId" = p.id JOIN media m ON m.id = mc."mediaId"
WHERE m.type = 'book' AND m."libraryId" = ANY($1) AND mc.role = $3
  AND (($3 = 'author' AND mc."editionId" IS NULL)
    OR ($3 = 'narrator' AND EXISTS (SELECT 1 FROM editions e
          WHERE e.id = mc."editionId" AND COALESCE(e."libraryId", m."libraryId") = ANY($2))))
  AND ($4::text IS NULL OR p."searchVector" @@ to_tsquery('simple', $4))
GROUP BY p.id
ORDER BY CASE WHEN $5 THEN -COUNT(DISTINCT m.id) ELSE 0 END, COALESCE(p."sortName", p.name), p.id
LIMIT $6 OFFSET $7"#,
        scope,
        acl,
        role,
        tsq,
        by_works,
        paging.map(|p| p.0),
        paging.map(|p| p.1)
    )
    .fetch_all(db)
    .await
}

/// `books-api.md` A9: the readable books of a person in `role`, by series and standalone.
pub async fn works(
    db: &PgPool,
    id: i32,
    role: &str,
    uid: i32,
    acl: &[i32],
) -> Result<Value, AppError> {
    find(db, id).await?;
    let works = sqlx::query_scalar!(
        r#"SELECT m.id AS "id!" FROM media m
WHERE m.type = 'book' AND m."libraryId" = ANY($1) AND EXISTS (
  SELECT 1 FROM media_credits mc WHERE mc."mediaId" = m.id AND mc."personId" = $2 AND mc.role = $3
    AND (($3 = 'author' AND mc."editionId" IS NULL)
      OR ($3 = 'narrator' AND EXISTS (SELECT 1 FROM editions e
            WHERE e.id = mc."editionId" AND COALESCE(e."libraryId", m."libraryId") = ANY($1)))))
ORDER BY m.title, m.id"#,
        acl,
        id,
        role
    )
    .fetch_all(db)
    .await?;
    let entries = sqlx::query!(
        r#"SELECT c.id AS "cid!", c.name AS "cname!", e."mediaId" AS "media_id!", e.position::float8 AS position,
  e."positionEnd"::float8 AS position_end, e."positionLabel" AS position_label
FROM collection_entries e JOIN collections c ON c.id = e."collectionId"
WHERE e."itemId" IS NULL AND e."mediaId" = ANY($1)
ORDER BY c.name, c.id, e.position NULLS LAST, e."mediaId""#,
        &works
    )
    .fetch_all(db)
    .await?;
    let media = books::summaries(db, &works, uid, acl).await?;
    let num = crate::collections::service::num;
    let mut series: Vec<Value> = vec![];
    let mut last = None;
    for e in &entries {
        if last != Some(e.cid) {
            series.push(json!({"collection": {"id": e.cid, "name": e.cname}, "works": []}));
            last = Some(e.cid);
        }
        let Some(m) = media.get(&e.media_id) else {
            continue;
        };
        if let Some(w) = series.last_mut().and_then(|s| s["works"].as_array_mut()) {
            w.push(json!({
                "position": e.position.map(num), "positionEnd": e.position_end.map(num),
                "positionLabel": e.position_label, "media": m,
            }));
        }
    }
    let standalone: Vec<&Value> = works
        .iter()
        .filter(|w| !entries.iter().any(|e| e.media_id == **w))
        .filter_map(|w| media.get(w))
        .collect();
    Ok(json!({"series": series, "standalone": standalone}))
}

/// The artists (album or track credits) or composers of readable, owned music, with their counts.
pub async fn music_people(
    db: &PgPool,
    role: &str,
    scope: &[i32],
    acl: &[i32],
    tsq: Option<&str>,
    by_works: bool,
    paging: Option<(i64, i64)>,
) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(
        r#"WITH rel AS (
  SELECT c."personId" AS pid, m.id AS mid, NULL::int AS iid FROM media_credits c JOIN media m ON m.id = c."mediaId"
   WHERE $3 = 'artist' AND c.role = 'artist' AND c."editionId" IS NULL AND m.type = 'album'
     AND m."libraryId" = ANY($1)
     AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."mediaId" = m.id)
  UNION ALL
  SELECT c."personId", i."mediaId", i.id FROM item_credits c JOIN items i ON i.id = c."itemId"
   JOIN media m ON m.id = i."mediaId" JOIN editions e ON e.id = i."editionId"
   WHERE c.role = $3 AND m.type = 'album' AND m."libraryId" = ANY($1)
     AND COALESCE(e."libraryId", m."libraryId") = ANY($2)
     AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = i.id)
  UNION ALL
  SELECT c."personId", i."mediaId", i.id FROM media_credits c JOIN items i ON i."mediaId" = c."mediaId"
   JOIN media m ON m.id = i."mediaId" JOIN editions e ON e.id = i."editionId"
   WHERE $3 = 'artist' AND c.role = 'artist' AND c."editionId" IS NULL AND m.type = 'album'
     AND m."libraryId" = ANY($1) AND COALESCE(e."libraryId", m."libraryId") = ANY($2)
     AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = i.id)
     AND NOT EXISTS (SELECT 1 FROM item_credits t WHERE t."itemId" = i.id AND t.role = 'artist'))
SELECT jsonb_build_object('id', p.id, 'name', p.name, 'sortName', p."sortName", 'avatarUrl', p."avatarUrl",
  'workCount', count(DISTINCT rel.mid)::int, 'albumCount', count(DISTINCT rel.mid)::int,
  'trackCount', count(DISTINCT rel.iid)::int)
FROM rel JOIN persons p ON p.id = rel.pid
WHERE ($4::text IS NULL OR p."searchVector" @@ to_tsquery('simple', $4))
GROUP BY p.id
ORDER BY CASE WHEN $5 THEN -count(DISTINCT rel.mid) ELSE 0 END, COALESCE(p."sortName", p.name), p.id
LIMIT $6 OFFSET $7"#,
    )
    .bind(scope)
    .bind(acl)
    .bind(role)
    .bind(tsq)
    .bind(by_works)
    .bind(paging.map(|p| p.0))
    .bind(paging.map(|p| p.1))
    .fetch_all(db)
    .await
}

/// `GET /api/persons/:id/discography`: the owned albums credited to the artist merged by release-group id
/// with the provider's discography; the owned ones alone when no provider answers.
pub async fn discography(st: &AppState, a: &Authed, id: i32) -> Result<Value, AppError> {
    let mut p = find(&st.db, id).await?;
    let lang = st.metadata.lang.resolve(None).await?;
    ensure_details_loaded(&st.db, &st.metadata, &st.images, &lang, &mut p).await;
    let acl = if a.kinds.has(MediaKind::Album) {
        accessible_library_ids(&st.db, a).await?
    } else {
        vec![]
    };
    let artist: Value = sqlx::query_scalar(
        r#"SELECT jsonb_build_object('id', p.id, 'name', p.name, 'sortName', p."sortName",
  'disambiguation', p.disambiguation, 'artistType', p."artistType", 'biography', p.biography,
  'imageUrl', p."avatarUrl", 'avatarUrl', p."avatarUrl",
  'following', EXISTS (SELECT 1 FROM person_follows f WHERE f."userId" = $2 AND f."personId" = p.id
                        AND f.role = 'artist'))
FROM persons p WHERE p.id = $1"#,
    )
    .bind(id)
    .bind(a.user.id)
    .fetch_one(&st.db)
    .await?;
    let owned: Vec<Value> = sqlx::query_scalar(
        r#"SELECT jsonb_build_object('mediaId', m.id, 'externalId', x.value, 'title', m.title, 'year', m.year,
  'primaryType', ad."primaryType", 'secondaryTypes', COALESCE(to_jsonb(ad."secondaryTypes"), '[]'::jsonb),
  'posterUrl', m."posterUrl", 'owned', true, 'monitored', m.monitored,
  'trackCount', GREATEST(t.n, COALESCE(te."trackCount", 0)), 'ownedTrackCount', t.owned)
FROM media m JOIN media_credits c ON c."mediaId" = m.id AND c.role = 'artist' AND c."editionId" IS NULL
LEFT JOIN album_details ad ON ad."mediaId" = m.id
LEFT JOIN editions te ON te.id = ad."targetEditionId"
LEFT JOIN media_external_ids x ON x."mediaId" = m.id AND x.kind = 'album' AND x.provider = 'musicbrainz'
CROSS JOIN LATERAL (SELECT count(*) AS n,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = i.id)) AS owned
  FROM items i JOIN editions e ON e.id = i."editionId"
  WHERE i."mediaId" = m.id AND (i."editionId" = ad."targetEditionId" OR ad."targetEditionId" IS NULL)
    AND COALESCE(e."libraryId", m."libraryId") = ANY($2)) t
WHERE c."personId" = $1 AND m.type = 'album' AND m."libraryId" = ANY($2)
ORDER BY m.year DESC NULLS LAST, m.title, m.id"#,
    )
    .bind(id)
    .bind(&acl)
    .fetch_all(&st.db)
    .await?;
    let mut albums = owned;
    let mut partial = false;
    if let Some(mbid) = &p.musicbrainz {
        let md = &st.metadata;
        let mut credits = None;
        for pr in md.person_providers(MediaKind::Album, Namespace::MUSICBRAINZ) {
            match md
                .of(pr)
                .person_credits(mbid, &lang, Priority::Interactive)
                .await
            {
                Ok(c) => {
                    credits = Some(c);
                    break;
                }
                Err(e) if e.status == Some(404) => credits = Some(Credits::default()),
                Err(e) => {
                    tracing::warn!("discography of person {id} from {}: {e}", pr.as_str());
                    partial = true;
                }
            }
        }
        partial &= credits.is_none();
        let held: HashSet<String> = albums
            .iter()
            .filter_map(|v| v["externalId"].as_str().map(str::to_owned))
            .collect();
        let aliases: HashSet<String> = sqlx::query_scalar(
            r#"SELECT a.value FROM media_external_id_aliases a JOIN media m ON m.id = a."mediaId"
               WHERE a.provider = 'musicbrainz' AND a.kind = 'album' AND m."libraryId" = ANY($1)"#,
        )
        .bind(&acl)
        .fetch_all(&st.db)
        .await?
        .into_iter()
        .collect();
        for al in fliks_domain::music::provider::albums(&credits.unwrap_or_default().albums).kept {
            if held.contains(&al.external_id) || aliases.contains(&al.external_id) {
                continue;
            }
            albums.push(json!({
                "mediaId": null, "externalId": al.external_id, "title": al.title, "year": al.year,
                "primaryType": al.primary_type, "secondaryTypes": al.secondary_types,
                "posterUrl": al.poster_url, "owned": false, "monitored": false,
                "trackCount": 0, "ownedTrackCount": 0,
            }));
        }
        albums.sort_by_key(|v| {
            (
                std::cmp::Reverse(v["year"].as_i64()),
                v["title"].as_str().map(str::to_lowercase),
            )
        });
    }
    Ok(json!({"artist": artist, "albums": albums, "partial": partial}))
}
