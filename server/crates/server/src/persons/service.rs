use crate::{
    http::{AppError, auth::Authed},
    images::{ImageStore, paths::Target},
    libraries::{accessible_library_ids, paths_visible},
    media::hydrate,
    metadata::{Credits, Metadata, Upstream},
    state::AppState,
};
use fliks_domain::{
    external_id::ExternalProvider,
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
    pub name: String,
    pub refreshed_ms: Option<i64>,
}

fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("Person #{id} not found"))
}

pub async fn find(db: &PgPool, id: i32) -> Result<Person, AppError> {
    sqlx::query!(
        r#"SELECT x.provider AS "provider?", x.value::int AS "tmdb_id?", p.name, p."metadataRefreshedAt" AS refreshed
FROM persons p LEFT JOIN person_ids x ON x."personId" = p.id WHERE p.id = $1"#,
        id
    )
    .fetch_optional(db)
    .await?
    .map(|r| Person {
        id,
        provider: r.provider,
        tmdb_id: r.tmdb_id,
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
    call: impl Fn(ExternalProvider) -> Fut,
) -> Result<(T, ExternalProvider), (ExternalProvider, Upstream)>
where
    Fut: std::future::Future<Output = Result<T, Upstream>>,
{
    let primary = md
        .resolve_person(p.provider.as_deref())
        .unwrap_or(ExternalProvider::Tmdb);
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

async fn try_refresh(
    db: &PgPool,
    md: &Metadata,
    images: &ImageStore,
    lang: &Resolved,
    p: &mut Person,
) -> Result<(), String> {
    let Some(ext) = p.tmdb_id.map(|id| id.to_string()) else {
        return Ok(());
    };
    let ext = &ext;
    let (d, _) = call_provider(md, db, p, |pr| async move {
        md.of(pr)
            .fetch_person(ext, lang, Priority::Interactive)
            .await
    })
    .await
    .map_err(|(pr, e)| format!("{}: {e}", pr.as_str()))?;
    let avatar = match d.avatar_url.as_deref().filter(|u| !u.is_empty()) {
        Some(url) => images.download_and_store(url, &Target::person(p.id)).await,
        None => None,
    };
    sqlx::query!(
        r#"UPDATE persons SET name = COALESCE($2, name), "avatarUrl" = COALESCE($3, "avatarUrl"),
  biography = COALESCE($4, biography), birthday = COALESCE($5::text::date, birthday),
  deathday = COALESCE($6::text::date, deathday), "placeOfBirth" = COALESCE($7, "placeOfBirth"),
  "knownForDepartment" = COALESCE($8, "knownForDepartment"), "metadataRefreshedAt" = now()
WHERE id = $1"#,
        p.id,
        d.name,
        avatar,
        d.biography,
        d.birthday,
        d.deathday,
        d.place_of_birth,
        d.known_for_department
    )
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
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
        r#"SELECT id AS "id!" FROM media WHERE id = ANY($1) AND "libraryId" = ANY($2)"#,
        &wanted,
        &libs
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
    served: ExternalProvider,
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
               ORDER BY m.id ASC"#,
            &wanted,
            &libs,
            served.as_str()
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
