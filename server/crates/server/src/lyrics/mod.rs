//! Lyrics of tracks (`docs/spec/music.md` rules 61-70).
pub mod discover;
pub mod providers;
pub mod queue;
pub mod store;

use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, patch, post},
};
use fliks_domain::{
    acl::{Action, Subject},
    lyrics::{self, Format, Parsed},
    metadata::limiter::Priority,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use store::Row;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/items/{itemId}/lyrics", get(list).put(put))
        .route("/api/items/{itemId}/lyrics/fetch", post(fetch))
        .route("/api/lyrics/{id}", patch(update).delete(remove))
}

/// The entry of rule 66; `enhanced` adds the agents and the word cues.
fn entry(r: &Row, enhanced: bool, artist: &str, title: &str) -> Value {
    let synced = r.sync != "none";
    let mut o = Map::new();
    o.insert("id".into(), json!(r.id));
    o.insert("kind".into(), json!(r.kind));
    o.insert("lang".into(), json!(r.lang));
    o.insert("synced".into(), json!(synced));
    o.insert("offset".into(), json!(r.offset_ms));
    o.insert("displayArtist".into(), json!(artist));
    o.insert("displayTitle".into(), json!(title));
    o.insert("source".into(), json!(r.source));
    if let Some(s) = &r.source_ref {
        o.insert("sourceRef".into(), json!(s));
    }
    o.insert("reviewed".into(), json!(r.reviewed));
    o.insert("preferred".into(), json!(r.preferred));
    let lines: Vec<Value> = r
        .doc
        .0
        .lines
        .iter()
        .map(|l| match (synced, l.start) {
            (true, Some(s)) => json!({"start": s, "value": l.text}),
            _ => json!({"value": l.text}),
        })
        .collect();
    o.insert("line".into(), Value::Array(lines));
    if enhanced {
        o.insert("agents".into(), json!(r.doc.0.agents));
        let cue_lines: Vec<Value> = r
            .doc
            .0
            .lines
            .iter()
            .enumerate()
            .filter(|(_, l)| !l.cues.is_empty())
            .map(|(i, l)| {
                let cues: Vec<Value> = l
                    .cues
                    .iter()
                    .map(|c| {
                        json!({"start": c.start, "end": c.end,
                            "value": l.text.get(c.byte_start..c.byte_end).unwrap_or(""),
                            "byteStart": c.byte_start, "byteEnd": c.byte_end})
                    })
                    .collect();
                let mut cl = json!({"index": i, "start": l.start, "end": l.end, "value": l.text, "cue": cues});
                if let Some(a) = &l.agent_id {
                    cl["agentId"] = json!(a);
                }
                cl
            })
            .collect();
        if !cue_lines.is_empty() {
            o.insert("cueLine".into(), Value::Array(cue_lines));
        }
    }
    Value::Object(o)
}

async fn assert_track(st: &AppState, a: &Authed, item: i32) -> Result<(), AppError> {
    crate::music::assert_track(st, a, item).await
}

async fn body(
    st: &AppState,
    item: i32,
    enhanced: bool,
    kind: Option<&str>,
    lang: Option<&str>,
) -> Result<Value, AppError> {
    let mut rows = store::list(&st.db, item).await?;
    store::sort(&mut rows);
    rows.retain(|r| kind.is_none_or(|k| r.kind == k) && lang.is_none_or(|l| r.lang == l));
    let (title, artist): (Option<String>, Option<String>) = sqlx::query_as(
        r#"SELECT i.title, (SELECT string_agg(p.name, ', ' ORDER BY c.position) FROM item_credits c
             JOIN persons p ON p.id = c."personId" WHERE c."itemId" = i.id AND c.role = 'artist')
           FROM items i WHERE i.id = $1"#,
    )
    .bind(item)
    .fetch_one(&st.db)
    .await?;
    let (title, artist) = (title.unwrap_or_default(), artist.unwrap_or_default());
    let mut out = json!({
        "structuredLyrics": rows.iter().map(|r| entry(r, enhanced, &artist, &title)).collect::<Vec<_>>(),
    });
    if rows.iter().all(|r| r.kind != "main") {
        let instrumental: bool = sqlx::query_scalar(
            r#"SELECT EXISTS (SELECT 1 FROM lyrics_lookups WHERE "itemId" = $1 AND status = 'instrumental')"#,
        )
        .bind(item)
        .fetch_one(&st.db)
        .await?;
        if instrumental {
            out["instrumental"] = json!(true);
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct ListQuery {
    enhanced: Option<bool>,
    kind: Option<String>,
    lang: Option<String>,
}

#[utoipa::path(get, path = "/api/items/{itemId}/lyrics", responses((status = 200), (status = 404)))]
pub async fn list(
    State(st): State<AppState>,
    a: Authed,
    PathParams(item): PathParams<i32>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    assert_track(&st, &a, item).await?;
    Ok(Json(
        body(
            &st,
            item,
            q.enhanced == Some(true),
            q.kind.as_deref(),
            q.lang.as_deref(),
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PutDto {
    kind: Option<String>,
    lang: Option<String>,
    format: Option<String>,
    body: Option<String>,
    lines: Option<Vec<LineDto>>,
    offset_ms: Option<i32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LineDto {
    start: Option<i64>,
    end: Option<i64>,
    text: String,
}

fn bad(m: impl Into<String>) -> AppError {
    AppError::bad_request(vec![m.into()])
}

fn layer(kind: Option<&str>, lang: Option<&str>) -> Result<(String, String), AppError> {
    let kind = kind.unwrap_or("main");
    if !["main", "translation", "pronunciation"].contains(&kind) {
        return Err(bad("kind must be main, translation or pronunciation"));
    }
    let lang = match lang {
        Some(l) => lyrics::lang_code(l)
            .ok_or_else(|| bad("lang must be 1 to 8 letters or digits, then an optional region"))?,
        None => "und".into(),
    };
    Ok((kind.to_owned(), lang))
}

#[utoipa::path(put, path = "/api/items/{itemId}/lyrics", responses((status = 200), (status = 400), (status = 404)))]
pub async fn put(
    State(st): State<AppState>,
    a: Authed,
    PathParams(item): PathParams<i32>,
    ValidJson(dto): ValidJson<PutDto>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Update, Subject::Media)?;
    assert_track(&st, &a, item).await?;
    let (mut parsed, raw): (Parsed, Option<String>) = match (&dto.body, &dto.lines) {
        (Some(text), None) => {
            let format = dto
                .format
                .as_deref()
                .and_then(Format::parse)
                .ok_or_else(|| bad("format must be lrc, elrc, ttml, srt or plain"))?;
            let p =
                lyrics::parse(format, text).map_err(|e| bad(format!("unreadable lyrics: {e}")))?;
            (p, Some(text.clone()))
        }
        (None, Some(lines)) => {
            let l: Vec<_> = lines
                .iter()
                .map(|l| (l.start, l.end, l.text.clone()))
                .collect();
            let p = lyrics::from_lines(&l).map_err(|e| bad(format!("unreadable lyrics: {e}")))?;
            (p, None)
        }
        _ => return Err(bad("send either body and format, or lines")),
    };
    let given = dto.lang.clone().or_else(|| parsed.lang.clone());
    let (kind, lang) = layer(dto.kind.as_deref(), given.as_deref())?;
    if let Some(o) = dto.offset_ms {
        if o.abs() > lyrics::MAX_OFFSET_MS {
            return Err(bad("offsetMs is out of range"));
        }
        parsed.offset_ms = o;
    }
    let file: Option<(i32, Option<i32>)> = sqlx::query_as(
        r#"SELECT ip."mediaFileId", td."durationMs" FROM item_parts ip
           JOIN track_details td ON td."itemId" = ip."itemId"
           WHERE ip."itemId" = $1 ORDER BY ip.version LIMIT 1"#,
    )
    .bind(item)
    .fetch_optional(&st.db)
    .await?;
    let id = store::upsert(
        &st.db,
        &store::New {
            item,
            file: file.map(|f| f.0),
            kind: &kind,
            lang: &lang,
            source: "user",
            source_ref: None,
            parsed: &parsed,
            raw: raw.as_deref(),
            duration_ms: file.and_then(|f| f.1),
            reviewed: true,
        },
    )
    .await?;
    // An edit that changed the text is not "the same text": the stored offset is the one just sent.
    sqlx::query(r#"UPDATE lyrics SET "offsetMs" = $2, reviewed = true WHERE id = $1"#)
        .bind(id)
        .bind(parsed.offset_ms)
        .execute(&st.db)
        .await?;
    providers::write_back(&st, id).await;
    Ok(Json(body(&st, item, false, None, None).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PatchDto {
    offset_ms: Option<i32>,
    preferred: Option<bool>,
    reviewed: Option<bool>,
}

async fn row_for(st: &AppState, a: &Authed, id: i32) -> Result<Row, AppError> {
    let row = store::get(&st.db, id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Lyrics #{id} not found")))?;
    assert_track(st, a, row.item_id).await?;
    Ok(row)
}

#[utoipa::path(patch, path = "/api/lyrics/{id}", responses((status = 200), (status = 400), (status = 404)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
    ValidJson(dto): ValidJson<PatchDto>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Update, Subject::Media)?;
    let row = row_for(&st, &a, id).await?;
    if let Some(o) = dto.offset_ms {
        if o.abs() > lyrics::MAX_OFFSET_MS {
            return Err(bad("offsetMs is out of range"));
        }
        sqlx::query(r#"UPDATE lyrics SET "offsetMs" = $2, reviewed = true WHERE id = $1"#)
            .bind(id)
            .bind(o)
            .execute(&st.db)
            .await?;
    }
    if let Some(r) = dto.reviewed {
        sqlx::query("UPDATE lyrics SET reviewed = $2 WHERE id = $1")
            .bind(id)
            .bind(r)
            .execute(&st.db)
            .await?;
    }
    if let Some(p) = dto.preferred {
        let mut tx = st.db.begin().await?;
        sqlx::query(
            r#"SELECT id FROM lyrics WHERE "itemId" = $1 AND kind = $2 AND lang = $3 FOR UPDATE"#,
        )
        .bind(row.item_id)
        .bind(&row.kind)
        .bind(&row.lang)
        .fetch_all(&mut *tx)
        .await?;
        sqlx::query(
            r#"UPDATE lyrics SET preferred = false WHERE "itemId" = $1 AND kind = $2 AND lang = $3"#,
        )
        .bind(row.item_id)
        .bind(&row.kind)
        .bind(&row.lang)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE lyrics SET preferred = $2 WHERE id = $1")
            .bind(id)
            .bind(p)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    Ok(Json(body(&st, row.item_id, false, None, None).await?))
}

#[utoipa::path(delete, path = "/api/lyrics/{id}", responses((status = 204), (status = 404)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    a.require(Action::Update, Subject::Media)?;
    row_for(&st, &a, id).await?;
    sqlx::query("DELETE FROM lyrics WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FetchDto {
    force: Option<bool>,
}

#[utoipa::path(post, path = "/api/items/{itemId}/lyrics/fetch", responses((status = 200), (status = 404)))]
pub async fn fetch(
    State(st): State<AppState>,
    a: Authed,
    PathParams(item): PathParams<i32>,
    ValidJson(dto): ValidJson<FetchDto>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Update, Subject::Media)?;
    assert_track(&st, &a, item).await?;
    let files: Vec<(i32, std::path::PathBuf)> = sqlx::query_as::<_, (i32, String, String)>(
        r#"SELECT mf.id, lf.path, mf."relativePath" FROM item_parts ip
           JOIN media_files mf ON mf.id = ip."mediaFileId" JOIN library_folders lf ON lf.id = mf."folderId"
           WHERE ip."itemId" = $1"#,
    )
    .bind(item)
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .map(|(id, folder, rel)| (id, std::path::Path::new(&folder).join(rel)))
    .collect();
    let mut listings: std::collections::HashMap<std::path::PathBuf, Vec<String>> =
        Default::default();
    for (id, path) in files {
        let dir = path
            .parent()
            .unwrap_or(std::path::Path::new(""))
            .to_path_buf();
        if !listings.contains_key(&dir) {
            let names = discover::listing(&dir).await;
            listings.insert(dir.clone(), names);
        }
        let emb = crate::ingest::music::embedded_of(&st, &path).await;
        let duration: Option<i32> =
            sqlx::query_scalar(r#"SELECT "durationMs" FROM track_details WHERE "itemId" = $1"#)
                .bind(item)
                .fetch_optional(&st.db)
                .await?
                .flatten();
        discover::file(&st, item, id, &path, duration, &emb, &listings[&dir]).await?;
    }
    providers::fetch(&st, item, dto.force == Some(true), Priority::Interactive)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(body(&st, item, false, None, None).await?))
}
