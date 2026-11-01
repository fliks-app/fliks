//! The persons and credits half of `persistMediaMetadata` (`media-write.md` rule 58).
use super::service::{Details, n, s};
use crate::{http::AppError, images::paths::Target, persons::service::Person, state::AppState};
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};

const AVATAR_CONCURRENCY: usize = 8;

fn credits(d: &Details, key: &str) -> Vec<Value> {
    d.raw
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn ext(c: &Value) -> Option<i32> {
    n(c, "externalId")
}

/// `persistMediaMetadata` (rule 58): the `media_metadata` row, persons, cast and crew.
pub async fn persist_credits(st: &AppState, media_id: i32, d: &Details) -> Result<(), AppError> {
    persist_metadata_row(st, media_id, d).await?;
    let provider = d
        .raw
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("tmdb");
    let (cast, crew) = (credits(d, "cast"), credits(d, "crew"));
    let all: Vec<&Value> = cast.iter().chain(&crew).collect();
    let mut unique: Vec<i32> = vec![];
    for id in all.iter().filter_map(|c| ext(c)) {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    let mut people: HashMap<i32, Person> = HashMap::new();
    if !unique.is_empty() {
        people = upsert_persons(st, provider, &unique, &all).await?;
    }
    replace_credits(st, media_id, &cast, &crew, &people).await?;
    if unique.is_empty() {
        return Ok(());
    }
    merge_departments(st, &cast, &crew, &people).await?;
    Ok(())
}

async fn persist_metadata_row(st: &AppState, media_id: i32, d: &Details) -> Result<(), AppError> {
    let r = &d.raw;
    let big = |k: &str| r.get(k).and_then(Value::as_i64);
    let set = |k: &str| r.get(k).is_some();
    let val = |k: &str| r.get(k).filter(|v| !v.is_null()).cloned();
    let (budget, revenue) = (big("budget"), big("revenue"));
    let tagline = s(r, "tagline");
    let popularity = r.get("popularity").and_then(Value::as_f64);
    let votes = n(r, "voteCount");
    let language = s(r, "originalLanguage");
    let (countries, companies, videos, keywords) = (
        val("productionCountries"),
        val("productionCompanies"),
        val("videos"),
        val("keywords"),
    );
    let flags = [
        set("productionCountries"),
        set("productionCompanies"),
        set("videos"),
        set("keywords"),
    ];
    sqlx::query!(
        r#"INSERT INTO media_metadata ("mediaId", budget, revenue, tagline, popularity, "voteCount",
             "originalLanguage", "productionCountries", "productionCompanies", videos, keywords)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT ("mediaId") DO UPDATE SET
             budget = COALESCE(EXCLUDED.budget, media_metadata.budget),
             revenue = COALESCE(EXCLUDED.revenue, media_metadata.revenue),
             tagline = COALESCE(EXCLUDED.tagline, media_metadata.tagline),
             popularity = COALESCE(EXCLUDED.popularity, media_metadata.popularity),
             "voteCount" = COALESCE(EXCLUDED."voteCount", media_metadata."voteCount"),
             "originalLanguage" = COALESCE(EXCLUDED."originalLanguage", media_metadata."originalLanguage"),
             "productionCountries" = CASE WHEN $12 THEN EXCLUDED."productionCountries" ELSE media_metadata."productionCountries" END,
             "productionCompanies" = CASE WHEN $13 THEN EXCLUDED."productionCompanies" ELSE media_metadata."productionCompanies" END,
             videos = CASE WHEN $14 THEN EXCLUDED.videos ELSE media_metadata.videos END,
             keywords = CASE WHEN $15 THEN EXCLUDED.keywords ELSE media_metadata.keywords END"#,
        media_id,
        budget,
        revenue,
        tagline,
        popularity,
        votes,
        language,
        countries,
        companies,
        videos,
        keywords,
        flags[0],
        flags[1],
        flags[2],
        flags[3]
    )
    .execute(&st.db)
    .await?;
    Ok(())
}

/// Existing persons by `(provider, value)`, the missing ones inserted with their id row under a
/// per-provider lock, avatars and changed names written with a concurrency of 8.
async fn upsert_persons(
    st: &AppState,
    provider: &str,
    ids: &[i32],
    credits: &[&Value],
) -> Result<HashMap<i32, Person>, AppError> {
    let credit_of = |id: i32| credits.iter().find(|c| ext(c) == Some(id)).copied();
    let name_of = |id: i32| credit_of(id).and_then(|c| s(c, "name")).unwrap_or_default();
    let mut tx = st.db.begin().await?;
    sqlx::query!(
        "SELECT pg_advisory_xact_lock(hashtext('persons:' || $1::text))",
        provider
    )
    .execute(&mut *tx)
    .await?;
    let mut rows = person_rows(&mut *tx, provider, ids).await?;
    let missing: Vec<i32> = ids
        .iter()
        .copied()
        .filter(|i| !rows.contains_key(i))
        .collect();
    if !missing.is_empty() {
        let names: Vec<String> = missing.iter().map(|i| name_of(*i)).collect();
        let values: Vec<String> = missing.iter().map(i32::to_string).collect();
        let new_ids = sqlx::query_scalar!(
            r#"SELECT nextval('persons_id_seq')::int AS "id!" FROM generate_series(1, $1::int)"#,
            missing.len() as i32
        )
        .fetch_all(&mut *tx)
        .await?;
        sqlx::query!(
            "INSERT INTO persons (id, name) SELECT * FROM UNNEST($1::int[], $2::text[])",
            &new_ids,
            &names
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query!(
            r#"INSERT INTO person_external_ids ("personId", provider, value)
               SELECT t.id, $1, t.value FROM UNNEST($2::int[], $3::text[]) AS t(id, value)"#,
            provider,
            &new_ids,
            &values
        )
        .execute(&mut *tx)
        .await?;
        for ((ext_id, id), name) in missing.iter().zip(new_ids).zip(names) {
            rows.insert(
                *ext_id,
                Person {
                    id,
                    provider: Some(provider.to_owned()),
                    tmdb_id: Some(*ext_id),
                    name,
                    refreshed_ms: None,
                },
            );
        }
    }
    tx.commit().await?;
    let jobs: Vec<(i32, Option<String>, Option<String>)> = ids
        .iter()
        .filter_map(|ext_id| {
            let p = rows.get(ext_id)?;
            let c = credit_of(*ext_id)?;
            let name = s(c, "name").filter(|n| !missing.contains(ext_id) && *n != p.name);
            let avatar = s(c, "avatarUrl").filter(|a| !a.is_empty());
            (name.is_some() || avatar.is_some()).then_some((p.id, name, avatar))
        })
        .collect();
    stream::iter(jobs)
        .for_each_concurrent(AVATAR_CONCURRENCY, |(id, name, avatar)| async move {
            let local = match avatar {
                Some(url) => st.images.download_and_store(&url, &Target::person(id)).await,
                None => None,
            };
            if name.is_none() && local.is_none() {
                return;
            }
            if let Err(e) = sqlx::query!(
                r#"UPDATE persons SET name = COALESCE($2, name), "avatarUrl" = COALESCE($3, "avatarUrl") WHERE id = $1"#,
                id,
                name,
                local
            )
            .execute(&st.db)
            .await
            {
                tracing::warn!("person #{id} not updated: {e}");
            }
        })
        .await;
    Ok(rows)
}

async fn person_rows<'e>(
    db: impl sqlx::PgExecutor<'e>,
    provider: &str,
    ids: &[i32],
) -> Result<HashMap<i32, Person>, sqlx::Error> {
    let values: Vec<String> = ids.iter().map(i32::to_string).collect();
    Ok(sqlx::query!(
        r#"SELECT p.id, x.value::int AS "tmdb_id!", p.name, p."metadataRefreshedAt" AS refreshed
           FROM person_external_ids x JOIN persons p ON p.id = x."personId"
           WHERE x.provider = $1 AND x.value = ANY($2)"#,
        provider,
        &values
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|r| {
        (
            r.tmdb_id,
            Person {
                id: r.id,
                provider: Some(provider.to_owned()),
                tmdb_id: Some(r.tmdb_id),
                name: r.name,
                refreshed_ms: r.refreshed.map(|t| t.timestamp_millis()),
            },
        )
    })
    .collect())
}

#[derive(Default)]
struct Credit {
    person: i32,
    role: &'static str,
    position: i32,
    character: Option<String>,
    job: Option<String>,
    department: Option<String>,
}

/// The cast and crew `media_credits` of a media replaced in one transaction.
async fn replace_credits(
    st: &AppState,
    media_id: i32,
    cast: &[Value],
    crew: &[Value],
    people: &HashMap<i32, Person>,
) -> Result<(), sqlx::Error> {
    let person = |c: &Value| ext(c).and_then(|e| people.get(&e)).map(|p| p.id);
    let text = |c: &Value, k: &str| s(c, k).unwrap_or_default();
    let mut rows: Vec<Credit> = cast
        .iter()
        .filter_map(|c| {
            Some(Credit {
                person: person(c)?,
                role: "cast",
                position: n(c, "order").unwrap_or(0),
                character: Some(text(c, "character")),
                ..Credit::default()
            })
        })
        .collect();
    let crew_rows = crew.iter().filter_map(|c| {
        Some(Credit {
            person: person(c)?,
            role: "crew",
            job: Some(text(c, "job")),
            department: Some(text(c, "department")),
            ..Credit::default()
        })
    });
    for (i, mut r) in crew_rows.enumerate() {
        r.position = i as i32;
        rows.push(r);
    }
    let mut tx = st.db.begin().await?;
    // Two writers of one media's credits queue here instead of interleaving their rows.
    sqlx::query!(
        "SELECT 1 AS one FROM media WHERE id = $1 FOR UPDATE",
        media_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    sqlx::query!(
        r#"DELETE FROM media_credits
           WHERE "mediaId" = $1 AND role IN ('cast', 'crew') AND "editionId" IS NULL"#,
        media_id
    )
    .execute(&mut *tx)
    .await?;
    if !rows.is_empty() {
        let persons: Vec<i32> = rows.iter().map(|r| r.person).collect();
        let roles: Vec<&str> = rows.iter().map(|r| r.role).collect();
        let positions: Vec<i32> = rows.iter().map(|r| r.position).collect();
        let characters: Vec<Option<&str>> = rows.iter().map(|r| r.character.as_deref()).collect();
        let jobs: Vec<Option<&str>> = rows.iter().map(|r| r.job.as_deref()).collect();
        let depts: Vec<Option<&str>> = rows.iter().map(|r| r.department.as_deref()).collect();
        sqlx::query!(
            r#"INSERT INTO media_credits ("mediaId", "personId", role, position, character, job, department)
               SELECT $1, t.p, t.r, t.o, t.c, t.j, t.d
               FROM UNNEST($2::int[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[]) AS t(p, r, o, c, j, d)"#,
            media_id,
            &persons,
            &roles as &[&str],
            &positions,
            &characters as &[Option<&str>],
            &jobs as &[Option<&str>],
            &depts as &[Option<&str>]
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// Each person's departments merged with the ones this title gives them, sorted.
async fn merge_departments(
    st: &AppState,
    cast: &[Value],
    crew: &[Value],
    people: &HashMap<i32, Person>,
) -> Result<(), sqlx::Error> {
    let mut wanted: HashMap<i32, BTreeSet<String>> = HashMap::new();
    for c in cast {
        if let Some(e) = ext(c) {
            wanted.entry(e).or_default().insert("Acting".into());
        }
    }
    for c in crew {
        if let Some(e) = ext(c) {
            wanted
                .entry(e)
                .or_default()
                .insert(s(c, "department").unwrap_or_default());
        }
    }
    let rows: Vec<Value> = wanted
        .into_iter()
        .filter_map(|(e, new)| Some(json!({"id": people.get(&e)?.id, "depts": new})))
        .collect();
    sqlx::query!(
        r#"UPDATE persons p SET departments = (
             SELECT COALESCE(jsonb_agg(d ORDER BY d COLLATE "C"), '[]'::jsonb)
             FROM (SELECT jsonb_array_elements_text(p.departments) AS d
                   UNION SELECT jsonb_array_elements_text(x.depts)) t)
           FROM jsonb_to_recordset($1::jsonb) AS x(id int, depts jsonb) WHERE p.id = x.id"#,
        Value::Array(rows)
    )
    .execute(&st.db)
    .await?;
    Ok(())
}
