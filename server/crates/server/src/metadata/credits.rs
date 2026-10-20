//! The persons and credits half of `persistMediaMetadata` (`media-write.md` rule 58).
use super::service::{Details, n, s};
use crate::{
    http::AppError,
    images::paths::Target,
    persons::service::{Person, ensure_details_loaded},
    state::AppState,
};
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
    let lang = st.metadata.lang.resolve(None).await?;
    let mut order: Vec<i32> = people.keys().copied().collect();
    order.sort_unstable();
    for key in order {
        if let Some(p) = people.get_mut(&key) {
            ensure_details_loaded(&st.db, &st.metadata, &st.images, &lang, p).await;
        }
    }
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

/// Existing persons by `(provider, tmdbId)`, the missing ones inserted in one statement, avatars and
/// changed names written with a concurrency of 8.
async fn upsert_persons(
    st: &AppState,
    provider: &str,
    ids: &[i32],
    credits: &[&Value],
) -> Result<HashMap<i32, Person>, AppError> {
    let credit_of = |id: i32| credits.iter().find(|c| ext(c) == Some(id)).copied();
    let name_of = |id: i32| credit_of(id).and_then(|c| s(c, "name")).unwrap_or_default();
    let mut rows = person_rows(st, provider, ids).await?;
    let missing: Vec<i32> = ids
        .iter()
        .copied()
        .filter(|i| !rows.contains_key(i))
        .collect();
    let mut fresh: Vec<i32> = vec![];
    if !missing.is_empty() {
        let names: Vec<String> = missing.iter().map(|i| name_of(*i)).collect();
        sqlx::query!(
            r#"INSERT INTO persons (provider, "tmdbId", name)
               SELECT $1, t.id, t.name FROM UNNEST($2::int[], $3::text[]) AS t(id, name)
               ON CONFLICT (provider, "tmdbId") DO NOTHING"#,
            provider,
            &missing,
            &names
        )
        .execute(&st.db)
        .await?;
        let inserted = person_rows(st, provider, &missing).await?;
        fresh = inserted.keys().copied().collect();
        rows.extend(inserted);
    }
    let jobs: Vec<(i32, Option<String>, Option<String>)> = ids
        .iter()
        .filter_map(|ext_id| {
            let p = rows.get(ext_id)?;
            let c = credit_of(*ext_id)?;
            let name = s(c, "name").filter(|n| !fresh.contains(ext_id) && *n != p.name);
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

async fn person_rows(
    st: &AppState,
    provider: &str,
    ids: &[i32],
) -> Result<HashMap<i32, Person>, sqlx::Error> {
    Ok(sqlx::query!(
        r#"SELECT id, "tmdbId" AS tmdb_id, name, "metadataRefreshedAt" AS refreshed FROM persons
           WHERE provider = $1 AND "tmdbId" = ANY($2)"#,
        provider,
        ids
    )
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .map(|r| {
        (
            r.tmdb_id,
            Person {
                id: r.id,
                provider: provider.to_owned(),
                tmdb_id: r.tmdb_id,
                name: r.name,
                refreshed_ms: r.refreshed.map(|t| t.timestamp_millis()),
            },
        )
    })
    .collect())
}

/// `media_cast` and `media_crew` replaced in one transaction.
async fn replace_credits(
    st: &AppState,
    media_id: i32,
    cast: &[Value],
    crew: &[Value],
    people: &HashMap<i32, Person>,
) -> Result<(), sqlx::Error> {
    let person = |c: &Value| ext(c).and_then(|e| people.get(&e)).map(|p| p.id);
    let text = |c: &Value, k: &str| s(c, k).unwrap_or_default();
    let mut tx = st.db.begin().await?;
    // Two writers of one media's credits queue here instead of interleaving their rows.
    sqlx::query!(
        "SELECT 1 AS one FROM media WHERE id = $1 FOR UPDATE",
        media_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    sqlx::query!(r#"DELETE FROM media_cast WHERE "mediaId" = $1"#, media_id)
        .execute(&mut *tx)
        .await?;
    if !cast.is_empty() {
        let (ids, chars, order): (Vec<Option<i32>>, Vec<String>, Vec<i32>) = cast
            .iter()
            .map(|c| (person(c), text(c, "character"), n(c, "order").unwrap_or(0)))
            .collect();
        sqlx::query!(
            r#"INSERT INTO media_cast ("mediaId", "personId", character, "order")
               SELECT $1, t.p, t.c, t.o FROM UNNEST($2::int[], $3::text[], $4::int[]) AS t(p, c, o)"#,
            media_id,
            &ids as &[Option<i32>],
            &chars,
            &order
        )
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query!(r#"DELETE FROM media_crew WHERE "mediaId" = $1"#, media_id)
        .execute(&mut *tx)
        .await?;
    if !crew.is_empty() {
        let (ids, jobs, depts): (Vec<Option<i32>>, Vec<String>, Vec<String>) = crew
            .iter()
            .map(|c| (person(c), text(c, "job"), text(c, "department")))
            .collect();
        sqlx::query!(
            r#"INSERT INTO media_crew ("mediaId", "personId", job, department)
               SELECT $1, t.p, t.j, t.d FROM UNNEST($2::int[], $3::text[], $4::text[]) AS t(p, j, d)"#,
            media_id,
            &ids as &[Option<i32>],
            &jobs,
            &depts
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
