//! The bulk import of a book library and its manual queue (`docs/spec/book-import.md`).
use crate::{
    events::{Num, SseEvent},
    http::{AppError, auth::Authed, json::iso_ms, validate::PathParams},
    ingest::{
        books,
        disk::{self, BookWork},
        library::file_name,
    },
    libraries::accessible_library_ids,
    metadata::books::ANCHOR,
    state::AppState,
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use fliks_domain::{
    acl::{Action, Subject},
    media::{
        kind::MediaKind,
        path::{join, resolve},
    },
};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool, types::Json as Jsonb};
use std::{collections::HashMap, path::PathBuf, time::Duration};

const QUEUE_LIMIT: i64 = 500;
const RETRY_MIN: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(300);

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/imports/library/{libraryId}/books",
            post(start).get(latest),
        )
        .route("/api/imports/library/{libraryId}/books/queue", get(queue))
}

async fn guard(
    st: &AppState,
    a: &Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<i32, AppError> {
    a.require(Action::Create, Subject::Media)?;
    let PathParams(id) = id?;
    if !accessible_library_ids(&st.db, a).await?.contains(&id) {
        return Err(AppError::not_found(format!("Library #{id} not found")));
    }
    Ok(id)
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct BookImport {
    id: i32,
    #[sqlx(rename = "libraryId")]
    library_id: i32,
    status: String,
    total: Option<i32>,
    pending: i64,
    matched: i64,
    manual: i64,
    skipped: i64,
    failed: i64,
    error: Option<String>,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "createdAt")]
    created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "updatedAt")]
    updated_at: DateTime<Utc>,
    #[serde(with = "iso_ms::opt")]
    #[sqlx(rename = "endedOn")]
    ended_on: Option<DateTime<Utc>>,
}

const STATE: &str = r#"SELECT i.id, i."libraryId", i.status, i.total, i.error, i."createdAt", i."updatedAt", i."endedOn",
    count(*) FILTER (WHERE x.status = 'pending') AS pending,
    count(*) FILTER (WHERE x.status = 'matched') AS matched,
    count(*) FILTER (WHERE x.status = 'manual') AS manual,
    count(*) FILTER (WHERE x.status = 'skipped') AS skipped,
    count(*) FILTER (WHERE x.status = 'failed') AS failed
  FROM book_imports i LEFT JOIN book_import_items x ON x."importId" = i.id"#;

/// `POST /api/imports/library/:libraryId/books` (rule 4).
#[utoipa::path(post, path = "/api/imports/library/{libraryId}/books", responses((status = 202)))]
pub async fn start(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let lib = guard(&st, &a, id).await?;
    let (name, types, folders): (String, Value, i64) = sqlx::query_as(
        r#"SELECT name, "mediaTypes", (SELECT count(*) FROM library_folders WHERE "libraryId" = l.id)
           FROM libraries l WHERE id = $1"#,
    )
    .bind(lib)
    .fetch_one(&st.db)
    .await?;
    if !types
        .as_array()
        .is_some_and(|t| t.iter().any(|t| t == MediaKind::Book.as_str()))
    {
        return Err(AppError::bad_request(format!(
            "Library \"{name}\" does not accept book"
        )));
    }
    if folders == 0 {
        return Err(AppError::bad_request(format!(
            "Library #{lib} has no root path configured"
        )));
    }
    let id = sqlx::query_scalar(
        r#"INSERT INTO book_imports ("libraryId", "userId") VALUES ($1, $2) RETURNING id"#,
    )
    .bind(lib)
    .bind(a.user.id)
    .fetch_one(&st.db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(d) if d.is_unique_violation() => {
            AppError::conflict("errors.already_running")
        }
        e => e.into(),
    })?;
    tracing::info!("Book import #{id} started for library #{lib} \"{name}\"");
    tokio::spawn(run(st.clone(), id));
    Ok((StatusCode::ACCEPTED, Json(state(&st.db, id).await?)))
}

async fn state(db: &PgPool, id: i32) -> Result<Value, AppError> {
    let s: BookImport = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{STATE} WHERE i.id = $1 GROUP BY i.id"
    )))
    .bind(id)
    .fetch_one(db)
    .await?;
    Ok(json!(s))
}

/// `GET /api/imports/library/:libraryId/books` (rule 9).
#[utoipa::path(get, path = "/api/imports/library/{libraryId}/books", responses((status = 200)))]
pub async fn latest(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Json<Value>, AppError> {
    let lib = guard(&st, &a, id).await?;
    let id: Option<i32> = sqlx::query_scalar(
        r#"SELECT id FROM book_imports WHERE "libraryId" = $1 ORDER BY id DESC LIMIT 1"#,
    )
    .bind(lib)
    .fetch_optional(&st.db)
    .await?;
    match id {
        Some(id) => Ok(Json(state(&st.db, id).await?)),
        None => Err(AppError::not_found("errors.book_import_not_found")),
    }
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct QueueItem {
    id: i32,
    #[sqlx(rename = "importId")]
    import_id: i32,
    #[sqlx(rename = "mediaId")]
    media_id: i32,
    title: String,
    #[sqlx(rename = "folderName")]
    folder_name: String,
    files: Jsonb<Vec<String>>,
    error: Option<String>,
}

fn queued() -> String {
    format!(
        r#"FROM book_import_items x JOIN book_imports i ON i.id = x."importId"
  WHERE i."libraryId" = $1 AND x.status = 'manual' AND x."mediaId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM media_external_ids e
                    WHERE e."mediaId" = x."mediaId" AND e.provider = '{}')"#,
        ANCHOR.as_str()
    )
}

/// `GET /api/imports/library/:libraryId/books/queue` (rule 11).
#[utoipa::path(get, path = "/api/imports/library/{libraryId}/books/queue", responses((status = 200)))]
pub async fn queue(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Json<Value>, AppError> {
    let lib = guard(&st, &a, id).await?;
    let items: Vec<QueueItem> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT x.id, x."importId", x."mediaId", x.title, x."folderName", x.files, x.error
           {} ORDER BY x.id LIMIT {QUEUE_LIMIT}"#,
        queued()
    )))
    .bind(lib)
    .fetch_all(&st.db)
    .await?;
    let total: i64 =
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) {}", queued())))
            .bind(lib)
            .fetch_one(&st.db)
            .await?;
    Ok(Json(json!({"total": total, "items": items})))
}

/// Continues every import a restart interrupted (rule 10).
pub async fn resume(st: &AppState) {
    let ids: Vec<i32> =
        sqlx::query_scalar("SELECT id FROM book_imports WHERE status = 'running' ORDER BY id")
            .fetch_all(&st.db)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("Book imports not resumed: {e}");
                vec![]
            });
    for id in ids {
        tracing::info!("Book import #{id} resumed");
        tokio::spawn(run(st.clone(), id));
    }
}

/// Runs one import to its end and records how it ended; the caller detaches it.
pub async fn run(st: AppState, id: i32) {
    let key = format!("BookImport:{id}");
    let r = drive(&st, id, &key).await;
    st.hub.activity().remove(&key);
    let (status, error) = match &r {
        Ok(()) => ("completed", None),
        Err(e) => ("failed", Some(e.clone())),
    };
    if let Err(e) = sqlx::query(
        r#"UPDATE book_imports SET status = $2, error = $3, "endedOn" = now() WHERE id = $1"#,
    )
    .bind(id)
    .bind(status)
    .bind(&error)
    .execute(&st.db)
    .await
    {
        tracing::error!("Book import #{id}: cannot record {status}: {e}");
    }
    match r {
        Ok(()) => tracing::info!("Book import #{id} completed"),
        Err(e) => tracing::error!("Book import #{id} failed: {e}"),
    }
}

struct Job {
    library: i32,
    user: i32,
    name: String,
}

async fn drive(st: &AppState, id: i32, key: &str) -> Result<(), String> {
    let db = |e: sqlx::Error| e.to_string();
    let Some((library, user, total, name)) = sqlx::query_as::<_, (i32, i32, Option<i32>, String)>(
        r#"SELECT i."libraryId", i."userId", i.total, l.name FROM book_imports i
           JOIN libraries l ON l.id = i."libraryId" WHERE i.id = $1"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await
    .map_err(db)?
    else {
        return Ok(());
    };
    let job = Job {
        library,
        user,
        name,
    };
    if total.is_none() {
        plan(st, id, &job).await?;
    }
    let mut wait = RETRY_MIN;
    loop {
        let next: Option<Item> = sqlx::query_as(
            r#"SELECT id, "folderId", "folderName", title, year, files FROM book_import_items
               WHERE "importId" = $1 AND status = 'pending' ORDER BY id LIMIT 1"#,
        )
        .bind(id)
        .fetch_optional(&st.db)
        .await
        .map_err(db)?;
        let (pending, total): (i64, i64) = sqlx::query_as(
            r#"SELECT count(*) FILTER (WHERE status = 'pending'), count(*)
               FROM book_import_items WHERE "importId" = $1"#,
        )
        .bind(id)
        .fetch_one(&st.db)
        .await
        .map_err(db)?;
        progress(st, key, &job, total - pending, total, next.as_ref());
        let Some(item) = next else {
            return Ok(());
        };
        let done = import_item(st, &job, &item).await;
        let saved = sqlx::query(
            r#"UPDATE book_import_items SET status = $2, "mediaId" = (SELECT id FROM media WHERE id = $3),
               error = $4 WHERE id = $1"#,
        )
        .bind(item.id)
        .bind(done.status)
        .bind(done.media)
        .bind(&done.error)
        .execute(&st.db)
        .await;
        if let Err(e) = &saved {
            tracing::warn!("Book import #{id}: item #{} not saved: {e}", item.id);
            sqlx::query(
                r#"UPDATE book_import_items SET status = 'failed', "mediaId" = NULL, error = $2 WHERE id = $1"#,
            )
            .bind(item.id)
            .bind(e.to_string())
            .execute(&st.db)
            .await
            .map_err(db)?;
        }
        if done.status == "pending" && saved.is_ok() {
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(RETRY_MAX);
        } else {
            wait = RETRY_MIN;
        }
    }
}

fn progress(st: &AppState, key: &str, job: &Job, current: i64, total: i64, item: Option<&Item>) {
    st.hub.emit(SseEvent::TaskProgress {
        command: "BookImport".into(),
        current: Num(current as f64),
        total: Num(total as f64),
        message: item.map(|i| i.title.clone()).unwrap_or_default(),
        subject: None,
    });
    if item.is_some() {
        st.hub.activity().upsert_running(
            key,
            "BookImport",
            Some(disk::subject_titled(&job.name)),
            Some(Num(current as f64)),
            Some(Num(total as f64)),
            None,
        );
    }
}

/// Rule 5: classifies the books of every folder and records the items and the total in one transaction.
async fn plan(st: &AppState, id: i32, job: &Job) -> Result<(), String> {
    let db = |e: sqlx::Error| e.to_string();
    let folders: Vec<(i32, String)> = sqlx::query_as(
        r#"SELECT id, path FROM library_folders WHERE "libraryId" = $1 ORDER BY position, id"#,
    )
    .bind(job.library)
    .fetch_all(&st.db)
    .await
    .map_err(db)?;
    if folders.is_empty() {
        return Err("The library has no folder".into());
    }
    let linked = disk::linked_owners(st, job.library).await.map_err(db)?;
    let mut items = vec![];
    for (folder, path) in folders {
        let root = PathBuf::from(resolve(&path, "/"));
        if !root.is_dir() {
            return Err(format!("Folder \"{path}\" is not readable"));
        }
        let r = root.clone();
        let all = tokio::task::spawn_blocking(move || {
            let mut out = vec![];
            disk::collect(&r, 0, true, &mut out);
            out
        })
        .await
        .map_err(|e| e.to_string())?;
        let by_rel: HashMap<String, PathBuf> = all
            .into_iter()
            .filter(|p| books::is_book_file(&file_name(p)))
            .filter_map(|p| Some((crate::ingest::fsx::rel_under(&root, &p)?, p)))
            .collect();
        let rels: Vec<String> = by_rel.keys().cloned().collect();
        for w in books::plan::plan(&rels, |r| linked.get(&by_rel[r]).cloned()) {
            items.push((folder, w));
        }
    }
    let mut tx = st.db.begin().await.map_err(db)?;
    for (folder, w) in &items {
        sqlx::query(
            r#"INSERT INTO book_import_items ("importId", "folderId", "groupKey", "folderName", title, year, files)
               VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING"#,
        )
        .bind(id)
        .bind(folder)
        .bind(&w.name_path)
        .bind(w.anchor.clone().unwrap_or_default())
        .bind(&w.title)
        .bind(w.year)
        .bind(Jsonb(&w.files))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    }
    sqlx::query(r#"UPDATE book_imports SET total = $2 WHERE id = $1"#)
        .bind(id)
        .bind(items.len() as i32)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(db)
}

#[derive(FromRow)]
struct Item {
    id: i32,
    #[sqlx(rename = "folderId")]
    folder_id: i32,
    #[sqlx(rename = "folderName")]
    folder_name: String,
    title: String,
    year: Option<i32>,
    files: Jsonb<Vec<String>>,
}

struct Done {
    status: &'static str,
    media: Option<i32>,
    error: Option<String>,
}

fn failed(error: String) -> Done {
    Done {
        status: "failed",
        media: None,
        error: Some(error),
    }
}

/// Rules 6-8: links the work, then identifies it before the next item starts.
async fn import_item(st: &AppState, job: &Job, item: &Item) -> Done {
    let linked = loop {
        let folder: Option<String> =
            match sqlx::query_scalar(r#"SELECT path FROM library_folders WHERE id = $1"#)
                .bind(item.folder_id)
                .fetch_optional(&st.db)
                .await
            {
                Ok(f) => f,
                Err(e) => return failed(e.to_string()),
            };
        let Some(folder) = folder else {
            return failed("The folder no longer exists".into());
        };
        let files = item
            .files
            .0
            .iter()
            .map(|r| PathBuf::from(resolve(&join(&folder, r), "/")))
            .collect();
        let work = BookWork {
            library_id: job.library,
            folder_id: item.folder_id,
            folder_path: folder,
            folder_name: item.folder_name.clone(),
            title: item.title.clone(),
            year: item.year,
            files,
        };
        match disk::link_book_work(st, job.user, work).await {
            Ok(l) => break l,
            Err(e) if e.text() == disk::FOLDER_MOVED => {}
            Err(e) => return failed(e.text()),
        }
    };
    let errors = (!linked.errors.is_empty()).then(|| linked.errors.join("; "));
    if linked.linked == 0 {
        return match errors {
            Some(e) => failed(e),
            None => Done {
                status: "skipped",
                media: None,
                error: None,
            },
        };
    }
    let media = linked.media_id;
    st.ingest.settle.cancel(media);
    if let Err(e) = books::identify_media(st, media).await {
        tracing::warn!("Book import: identification of book #{media}: {}", e.cause);
        return Done {
            status: if e.retry { "pending" } else { "failed" },
            media: Some(media),
            error: Some(e.cause),
        };
    }
    let matched = sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM media_external_ids WHERE "mediaId" = $1 AND provider = $2)"#,
    )
    .bind(media)
    .bind(ANCHOR.as_str())
    .fetch_one(&st.db)
    .await;
    match matched {
        Ok(matched) => Done {
            status: if matched { "matched" } else { "manual" },
            media: Some(media),
            error: errors,
        },
        Err(e) => failed(e.to_string()),
    }
}
