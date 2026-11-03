use super::{
    config::{self, Smtp},
    devices::FORMATS,
    message,
};
use crate::{
    http::{
        AppError,
        auth::{Authed, SessionAuthed},
        json::iso_ms,
        validate::{PathParams, ValidJson},
    },
    state::AppState,
    stream::{book_format, resolve_file},
};
use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use fliks_domain::acl::{Action, Subject};
use lettre::AsyncTransport;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
use tokio::{io::AsyncReadExt, sync::Semaphore};

const PER_HOUR: i64 = 20;
const IN_FLIGHT: i64 = 3;
const RECENT: i64 = 20;
const ERROR_MAX: usize = 300;
/// A mail holds the file, its base64 body and the wire copy (3-4 times the file), so one at a time.
static SLOTS: Semaphore = Semaphore::const_new(1);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookSend {
    id: i32,
    device_name: String,
    file_name: String,
    bytes: i64,
    status: String,
    error: Option<String>,
    #[serde(with = "iso_ms")]
    created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct SendDto {
    file_id: i32,
}

fn too_many() -> AppError {
    AppError::with_message(
        StatusCode::TOO_MANY_REQUESTS,
        "send_to_device.error_rate_limited",
    )
}

#[utoipa::path(post, path = "/api/email-devices/{id}/send", responses((status = 202)))]
pub async fn send(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(dto): ValidJson<SendDto>,
) -> Result<(StatusCode, Json<BookSend>), AppError> {
    a.require(Action::Create, Subject::EmailDevice)?;
    let smtp = config::load(&st.db)
        .await?
        .ok_or_else(|| AppError::bad_request("send_to_device.error_not_configured"))?;
    // The same file ACL as a download: a hidden file answers like a missing one.
    let file = resolve_file(&st, Some(&a), i64::from(dto.file_id)).await?;
    let ext = file.ext.trim_start_matches('.');
    if !FORMATS.contains(&ext) {
        return Err(AppError::bad_request("send_to_device.error_format"));
    }
    if file.size > smtp.max_bytes {
        return Err(AppError::payload_too_large("send_to_device.error_too_big"));
    }
    let name = message::attachment_name(&file.relative_path);
    let mut tx = st.db.begin().await?;
    // The user row serialises two requests, so the limits hold.
    sqlx::query_scalar!(
        r#"SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE"#,
        a.user.id
    )
    .fetch_one(&mut *tx)
    .await?;
    let device = sqlx::query!(
        r#"SELECT name, kind, address, formats FROM email_devices WHERE id = $1 AND "userId" = $2"#,
        id,
        a.user.id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("email_devices.error_unknown"))?;
    if device.kind == "other" && !a.perms.can(Action::Manage, &Subject::Settings) {
        return Err(AppError::forbidden("email_devices.error_kind_forbidden"));
    }
    if !device.formats.iter().any(|f| f == ext) {
        return Err(AppError::bad_request("send_to_device.error_format"));
    }
    // A job that died without a trace stops counting as unfinished after the age bound.
    let counts = sqlx::query!(
        r#"SELECT count(*) FILTER (WHERE "createdAt" > now() - interval '1 hour') AS "hour!",
                  count(*) FILTER (WHERE status IN ('queued', 'sending')
                                   AND "updatedAt" > now() - interval '15 minutes') AS "flying!"
           FROM book_sends WHERE "userId" = $1"#,
        a.user.id
    )
    .fetch_one(&mut *tx)
    .await?;
    if counts.hour >= PER_HOUR || counts.flying >= IN_FLIGHT {
        return Err(too_many());
    }
    let row = sqlx::query_as!(
        BookSend,
        r#"INSERT INTO book_sends ("userId", "deviceId", "deviceName", "fileId", "fileName", bytes)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, "deviceName" AS device_name, "fileName" AS file_name, bytes, status, error,
                     "createdAt" AS created_at, "updatedAt" AS updated_at"#,
        a.user.id,
        id,
        device.name,
        file.id,
        name,
        i64::try_from(file.size).unwrap_or(i64::MAX)
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(
        user = a.user.id,
        device = id,
        file = file.id,
        send = row.id,
        "book send queued"
    );
    let job = Job {
        id: row.id,
        path: file.absolute,
        name: row.file_name.clone(),
        size: file.size,
        mime: book_format(&file.ext).unwrap_or("application/octet-stream"),
        to: device.address,
    };
    tokio::spawn(run(st, job));
    Ok((StatusCode::ACCEPTED, Json(row)))
}

struct Job {
    id: i32,
    path: PathBuf,
    name: String,
    size: u64,
    mime: &'static str,
    to: String,
}

async fn run(st: AppState, job: Job) {
    let Ok(_slot) = SLOTS.acquire().await else {
        return;
    };
    let id = job.id;
    let result = deliver(&st, job).await;
    let (status, error) = match result {
        Ok(()) => ("sent", None),
        Err(e) => {
            tracing::warn!(send = id, "book send failed: {}", e.detail);
            ("failed", Some(e.code))
        }
    };
    if let Err(e) = sqlx::query!(
        r#"UPDATE book_sends SET status = $2, error = $3 WHERE id = $1"#,
        id,
        status,
        error
    )
    .execute(&st.db)
    .await
    {
        tracing::error!(send = id, "book send: cannot record {status}: {e}");
    }
}

struct Failure {
    /// What the user sees: never a host name or a server answer.
    code: &'static str,
    detail: String,
}

fn fail(code: &'static str, detail: impl ToString) -> Failure {
    Failure {
        code,
        detail: detail.to_string(),
    }
}

async fn deliver(st: &AppState, job: Job) -> Result<(), Failure> {
    sqlx::query!(
        r#"UPDATE book_sends SET status = 'sending' WHERE id = $1"#,
        job.id
    )
    .execute(&st.db)
    .await
    .map_err(|e| fail("internal", e))?;
    let smtp = config::load(&st.db)
        .await
        .map_err(|e| fail("internal", e))?
        .ok_or_else(|| fail("not_configured", "smtp no longer configured"))?;
    let mut data = Vec::new();
    let read = async {
        tokio::fs::File::open(&job.path)
            .await?
            .take(smtp.max_bytes + 1)
            .read_to_end(&mut data)
            .await
    };
    tokio::time::timeout(Smtp::budget(job.size as usize), read)
        .await
        .map_err(|_| fail("file_unreadable", "file read timed out"))?
        .map_err(|e| fail("file_unreadable", e))?;
    if data.len() as u64 > smtp.max_bytes {
        return Err(fail("too_big", "file grew past the limit"));
    }
    let to = message::parse_address(&job.to).ok_or_else(|| fail("internal", "stored address"))?;
    let from = smtp.from.clone();
    // Encoding the attachment is CPU work, so it stays off the async workers.
    let (envelope, raw) = tokio::task::spawn_blocking(move || {
        message::book_raw(&from, to, &job.name, job.mime, data)
    })
    .await
    .map_err(|e| fail("internal", e))?
    .map_err(|e| fail("internal", e))?;
    let transport = smtp.transport().map_err(|e| fail("not_configured", e))?;
    match tokio::time::timeout(Smtp::budget(raw.len()), transport.send_raw(&envelope, &raw)).await {
        Err(_) => Err(fail("timeout", "smtp i/o timed out")),
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) if e.is_permanent() || e.is_transient() => Err(fail("rejected", e)),
        Ok(Err(e)) => Err(fail("connection", e)),
    }
}

/// Rows a restart left unfinished: the mail may or may not have gone out.
pub async fn sweep(db: &sqlx::PgPool) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE book_sends SET status = 'failed', error = 'interrupted'
           WHERE status IN ('queued', 'sending')"#
    )
    .execute(db)
    .await
    .map(drop)
}

/// The daily prune: a send log older than 30 days is of no use, and `book_sends` grows by up to 20
/// rows per user per hour.
pub async fn prune(db: &sqlx::PgPool) -> sqlx::Result<u64> {
    sqlx::query(r#"DELETE FROM book_sends WHERE "createdAt" < now() - interval '30 days'"#)
        .execute(db)
        .await
        .map(|r| r.rows_affected())
}

#[utoipa::path(get, path = "/api/book-sends", responses((status = 200)))]
pub async fn recent(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
) -> Result<Json<Vec<BookSend>>, AppError> {
    let rows = sqlx::query_as!(
        BookSend,
        r#"SELECT id, "deviceName" AS device_name, "fileName" AS file_name, bytes, status, error,
                  "createdAt" AS created_at, "updatedAt" AS updated_at
           FROM book_sends WHERE "userId" = $1 ORDER BY id DESC LIMIT $2"#,
        a.user.id,
        RECENT
    )
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestDto {
    to: String,
}

/// The admin's test: unlike a user's send, the answer carries the server's own error text.
#[utoipa::path(post, path = "/api/email/test", responses((status = 200)))]
pub async fn test_send(
    State(st): State<AppState>,
    authed: Authed,
    ValidJson(dto): ValidJson<TestDto>,
) -> Result<Json<Value>, AppError> {
    authed.require(Action::Manage, Subject::Settings)?;
    let to = message::parse_address(&dto.to)
        .ok_or_else(|| AppError::bad_request(vec!["to must be an e-mail address"]))?;
    let smtp = config::load(&st.db)
        .await?
        .ok_or_else(|| AppError::bad_request("send_to_device.error_not_configured"))?;
    let outcome = async {
        let mail = message::test(&smtp.from, to)?;
        let transport = smtp.transport()?;
        tokio::time::timeout(Smtp::budget(0), transport.send(mail))
            .await
            .map_err(|_| "the mail server took too long".to_owned())?
            .map(drop)
            .map_err(|e| e.to_string())
    }
    .await;
    Ok(Json(match outcome {
        Ok(()) => json!({"ok": true, "message": "Test message sent"}),
        Err(e) => json!({"ok": false, "message": message::clean(&e, ERROR_MAX)}),
    }))
}
