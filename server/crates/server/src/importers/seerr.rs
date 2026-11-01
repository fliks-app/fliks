//! Seerr: connection test and the request import (`importers.md` D).
use super::{dto, fetch};
use crate::{
    events::SseEvent,
    http::{AppError, auth::Authed},
    jobs::{Trigger, run_audited},
    outbound::{LIST_TIMEOUT, TEST_TIMEOUT, base_url, error_text},
    state::AppState,
    users::imported_user,
};
use axum::{Json, http::StatusCode};
use chrono::{DateTime, Utc};
use fliks_domain::{
    acl::{Action, Subject},
    arr_import::map_status,
    media::kind::MediaKind,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};

type Res<T> = Result<T, AppError>;

pub(super) async fn test(st: &AppState, a: Authed, body: Value) -> Res<Json<Value>> {
    a.require(Action::Manage, Subject::Settings)?;
    let c = dto::connection(body, true)?;
    let key = super::resolve_key(st, c.api_key, &c.url, "seerr_api_key", "seerr_url").await?;
    let url = format!("{}/api/v1/settings/main", base_url(&c.url, false));
    let out = match fetch(url, &key, TEST_TIMEOUT).await {
        Err(e) => json!({"ok": false, "message": error_text(e)}),
        Ok(res) if !res.status().is_success() => {
            json!({"ok": false, "message": format!("Request failed with status code {}", res.status().as_u16())})
        }
        Ok(res) => {
            let title = res.json::<Value>().await.ok().and_then(|v| {
                v.get("applicationTitle")
                    .and_then(Value::as_str)
                    .map(String::from)
            });
            json!({"ok": true, "message": format!("Connecté à {}", title.as_deref().unwrap_or("Seerr"))})
        }
    };
    Ok(Json(out))
}

/// `POST /api/imports/seerr/import-requests`: answers at once, the result travels by SSE.
pub(super) async fn start(st: AppState, a: Authed) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Manage, Subject::Settings)?;
    let claim = st
        .busy
        .seerr
        .claim(())
        .ok_or_else(|| AppError::conflict("Import already running"))?;
    st.hub.emit(SseEvent::SeerrImportStarted {});
    tokio::spawn(async move {
        let _claim = claim;
        let job_state = st.clone();
        let ran = run_audited(&st, "ImportSeerrRequests", Trigger::Manual, async move {
            match import(&job_state.db).await {
                Ok(s) => {
                    job_state.hub.emit(SseEvent::SeerrImportCompleted {
                        users: s.users.len() as i64,
                        users_created: s.users_created,
                        imported: s.imported,
                        updated: s.updated,
                        skipped: s.skipped,
                    });
                    Ok(())
                }
                Err(error) => {
                    tracing::error!(%error, "Seerr import failed");
                    job_state.hub.emit(SseEvent::SeerrImportFailed {
                        error: error.clone(),
                    });
                    Err(error)
                }
            }
        })
        .await;
        if !ran {
            st.hub.emit(SseEvent::SeerrImportFailed {
                error: String::new(),
            });
        }
    });
    Ok((StatusCode::CREATED, Json(json!({"ok": true}))))
}

#[derive(Default)]
struct Stats {
    users: HashSet<String>,
    users_created: i64,
    imported: i64,
    updated: i64,
    skipped: i64,
    errors: Vec<String>,
}

enum Outcome {
    Created,
    Updated,
    Skipped,
}

struct MediaRow {
    id: i32,
    title: String,
}

struct Run<'a> {
    db: &'a PgPool,
    base: String,
    key: String,
    media: HashMap<(MediaKind, i32), Option<MediaRow>>,
    titles: HashMap<(String, i32), Option<String>>,
    users: HashMap<String, i32>,
    stats: Stats,
}

const PAGE: usize = 50;

async fn import(db: &PgPool) -> Result<Stats, String> {
    let (url, key) = (
        crate::settings::setting_value(db, "seerr_url")
            .await
            .map_err(|e| e.to_string())?,
        crate::settings::setting_value(db, "seerr_api_key")
            .await
            .map_err(|e| e.to_string())?,
    );
    let (Some(url), Some(key)) = (url.filter(|u| !u.is_empty()), key.filter(|k| !k.is_empty()))
    else {
        return Err("Configure Seerr URL and API key first".into());
    };
    let mut run = Run {
        db,
        base: base_url(&url, false),
        key,
        media: HashMap::new(),
        titles: HashMap::new(),
        users: HashMap::new(),
        stats: Stats::default(),
    };
    let mut skip = 0;
    loop {
        let url = format!(
            "{}/api/v1/request?take={PAGE}&skip={skip}&filter=all&sort=added",
            run.base
        );
        let res = fetch(url, &run.key, LIST_TIMEOUT)
            .await
            .map_err(error_text)?;
        if !res.status().is_success() {
            return Err(format!(
                "Request failed with status code {}",
                res.status().as_u16()
            ));
        }
        let page: Value = res.json().await.map_err(error_text)?;
        let total = page["pageInfo"]["results"].as_u64().unwrap_or(0) as usize;
        let results = page["results"].as_array().cloned().unwrap_or_default();
        if results.is_empty() {
            break;
        }
        for req in &results {
            match run.apply(req).await {
                Ok(Outcome::Created) => run.stats.imported += 1,
                Ok(Outcome::Updated) => run.stats.updated += 1,
                Ok(Outcome::Skipped) => run.stats.skipped += 1,
                Err(e) => run.stats.errors.push(format!(
                    "request #{}: {e}",
                    req["id"].as_i64().unwrap_or_default()
                )),
            }
        }
        skip += results.len();
        if skip >= total {
            break;
        }
    }
    Ok(run.stats)
}

fn parse_time(v: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(Into::into)
}

impl Run<'_> {
    async fn apply(&mut self, req: &Value) -> Result<Outcome, String> {
        let db_err = |e: sqlx::Error| e.to_string();
        let who = &req["requestedBy"];
        let username = [
            "jellyfinUsername",
            "plexUsername",
            "username",
            "displayName",
        ]
        .iter()
        .find_map(|k| who[*k].as_str().filter(|s| !s.is_empty()))
        .map_or("", str::trim);
        if username.is_empty() {
            return Ok(Outcome::Skipped);
        }
        let media_type = if req["type"] == "tv" {
            MediaKind::Series
        } else {
            MediaKind::Movie
        };
        let Some(tmdb) = req["media"]["tmdbId"]
            .as_i64()
            .filter(|n| *n >= 1)
            .and_then(|n| i32::try_from(n).ok())
        else {
            return Ok(Outcome::Skipped);
        };
        let user = self.user(username).await.map_err(db_err)?;
        if !self.media.contains_key(&(media_type, tmdb)) {
            let row = sqlx::query!(
                r#"SELECT id, title FROM media WHERE id = (SELECT "mediaId" FROM media_external_ids
                     WHERE kind = $2 AND provider = $3 AND value = $1::int4::text)"#,
                tmdb,
                media_type.as_str(),
                crate::media::external_ids::TMDB
            )
            .fetch_optional(self.db)
            .await
            .map_err(db_err)?;
            self.media.insert(
                (media_type, tmdb),
                row.map(|r| MediaRow {
                    id: r.id,
                    title: r.title,
                }),
            );
        }
        let media = self.media[&(media_type, tmdb)]
            .as_ref()
            .map(|m| (m.id, m.title.clone()));
        let status = map_status(req["status"].as_i64(), req["media"]["status"].as_i64());
        let mut title = match &media {
            Some((_, t)) => t.clone(),
            None => req["media"]["title"]
                .as_str()
                .or_else(|| req["media"]["name"].as_str())
                .unwrap_or_default()
                .to_owned(),
        };
        if title.is_empty() {
            title = self
                .fetch_title(req["type"].as_str().unwrap_or_default(), tmdb)
                .await
                .unwrap_or_default();
        }
        let seasons = media_type
            .has_seasons()
            .then(|| req["seasons"].as_array().filter(|a| !a.is_empty()))
            .flatten()
            .map(|a| Value::Array(a.iter().map(|s| s["seasonNumber"].clone()).collect()));
        let created = parse_time(&req["createdAt"]).unwrap_or_else(Utc::now);
        let updated = parse_time(&req["updatedAt"]).unwrap_or(created);
        let media_id = media.map(|(id, _)| id);
        if let Some(id) = media_id {
            sqlx::query!(
                r#"UPDATE media SET "addedById" = $1 WHERE id = $2 AND "addedById" IS NULL"#,
                user,
                id
            )
            .execute(self.db)
            .await
            .map_err(db_err)?;
        }
        let existing = sqlx::query!(
            r#"SELECT id, status::text AS "status!", seasons, "mediaId" AS media_id, title,
                      "createdAt" AS created_at, "updatedAt" AS updated_at
               FROM requests WHERE "userId" = $1 AND "tmdbId" = $2 AND "mediaType" = $3
                 AND kind = 'add' ORDER BY id LIMIT 1"#,
            user,
            tmdb,
            media_type.as_str()
        )
        .fetch_optional(self.db)
        .await
        .map_err(db_err)?;
        let Some(e) = existing else {
            sqlx::query!(
                r#"INSERT INTO requests ("userId", "mediaType", "tmdbId", title, status, seasons, "mediaId",
                                         "createdAt", "updatedAt")
                   VALUES ($1, $2, $3, $4, $5::text::requests_status_enum, $6, $7, $8, $9)"#,
                user,
                media_type.as_str(),
                tmdb,
                title,
                status,
                seasons,
                media_id,
                created,
                updated
            )
            .execute(self.db)
            .await
            .map_err(db_err)?;
            return Ok(Outcome::Created);
        };
        let new_title = (e.title.is_empty() && !title.is_empty()).then_some(title.as_str());
        let new_media = media_id.filter(|m| Some(*m) != e.media_id);
        let changed = e.status != status
            || e.seasons != seasons
            || new_title.is_some()
            || new_media.is_some();
        if changed {
            sqlx::query!(
                r#"UPDATE requests SET status = $2::text::requests_status_enum, seasons = $3,
                          "mediaId" = COALESCE($4, "mediaId"), title = COALESCE($5, title)
                   WHERE id = $1"#,
                e.id,
                status,
                seasons,
                new_media,
                new_title
            )
            .execute(self.db)
            .await
            .map_err(db_err)?;
        }
        // The trigger bumps `updatedAt` on any change, so Seerr's times are written back afterwards.
        if changed
            || e.created_at.timestamp_millis() != created.timestamp_millis()
            || e.updated_at.timestamp_millis() != updated.timestamp_millis()
        {
            sqlx::query!(
                r#"UPDATE requests SET "createdAt" = $2, "updatedAt" = $3 WHERE id = $1"#,
                e.id,
                created,
                updated
            )
            .execute(self.db)
            .await
            .map_err(db_err)?;
        }
        Ok(Outcome::Updated)
    }

    async fn user(&mut self, username: &str) -> Result<i32, sqlx::Error> {
        self.stats.users.insert(username.to_owned());
        if let Some(id) = self.users.get(username) {
            return Ok(*id);
        }
        let (id, created) = imported_user(self.db, username, "local").await?;
        self.stats.users_created += i64::from(created);
        self.users.insert(username.to_owned(), id);
        Ok(id)
    }

    /// `GET /api/v1/<movie|tv>/<tmdbId>`; any error is `None`, cached either way.
    async fn fetch_title(&mut self, kind: &str, tmdb: i32) -> Option<String> {
        if let Some(t) = self.titles.get(&(kind.to_owned(), tmdb)) {
            return t.clone();
        }
        let url = format!("{}/api/v1/{kind}/{tmdb}", self.base);
        let title = async {
            let res = fetch(url, &self.key, TEST_TIMEOUT)
                .await
                .map_err(error_text)?;
            if !res.status().is_success() {
                return Err(format!("status {}", res.status().as_u16()));
            }
            let v: Value = res.json().await.map_err(error_text)?;
            let field = if kind == "movie" { "title" } else { "name" };
            Ok(v[field]
                .as_str()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty()))
        }
        .await
        .unwrap_or_else(|e: String| {
            tracing::warn!(tmdb, error = %e, "Seerr title lookup");
            None
        });
        self.titles.insert((kind.to_owned(), tmdb), title.clone());
        title
    }
}
