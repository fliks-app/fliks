//! Host imports (`plugins.md` rules 30-35, 43, 55): bound to the calling instance's plugin.
use super::db::UNAVAILABLE;
use super::logs::Level;
use super::runtime::fliks::plugin::{db, host, log, types as t};
use super::runtime::{Ctx, HostError};
use super::scheduled;
use crate::state::AppState;
use sqlx::PgPool;
use std::time::Instant;

pub fn host_err(code: &str, message: impl Into<String>) -> HostError {
    HostError {
        code: code.into(),
        message: message.into(),
    }
}

fn db_err(e: sqlx::Error) -> HostError {
    let unreachable = matches!(
        e,
        sqlx::Error::Io(_) | sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed
    );
    host_err(
        if unreachable {
            super::db::UNAVAILABLE
        } else {
            "ERR"
        },
        e.to_string(),
    )
}

/// Every installed id, for the ownership rule of `plugin.<id>.*` keys (rule 24).
pub async fn installed_ids(core: &PgPool) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(r#"SELECT "pluginId"::text FROM plugin_packages"#)
        .fetch_all(core)
        .await
}

/// Caller-owned settings with the prefix stripped; null values are absent (F68).
pub async fn config_for(
    core: &PgPool,
    id: &str,
    keys: Option<&[String]>,
) -> sqlx::Result<Vec<(String, String)>> {
    let ids = installed_ids(core).await?;
    let prefix = format!("plugin.{id}.");
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        r#"SELECT "key"::text, "value" FROM app_settings WHERE starts_with("key", $1) ORDER BY "key""#,
    )
    .bind(&prefix)
    .fetch_all(core)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(k, _)| {
            fliks_domain::plugins::setting_owner(k, ids.iter().map(String::as_str)) == Some(id)
        })
        .filter_map(|(k, v)| Some((k[prefix.len()..].to_owned(), v?)))
        .filter(|(k, _)| keys.is_none_or(|ks| ks.contains(k)))
        .collect())
}

/// Re-reads the registration and checks every scope of the method (rule 30).
async fn bound(sh: &super::runtime::Shared, method: &str, need: &[&str]) -> Result<(), HostError> {
    let id = &*sh.id;
    let scopes: Option<Vec<String>> =
        sqlx::query_scalar(r#"SELECT scopes FROM plugin_registrations WHERE "pluginId" = $1"#)
            .bind(id)
            .fetch_optional(&sh.env.core)
            .await
            .map_err(db_err)?;
    let Some(scopes) = scopes else {
        return Err(host_err(
            "ERR_NOT_FOUND",
            format!("plugin \"{id}\" has no active registration"),
        ));
    };
    if let Some(missing) = need.iter().find(|s| !scopes.iter().any(|x| x == *s)) {
        return Err(host_err(
            "ERR_DENIED",
            format!("plugin \"{id}\" is missing scope \"{missing}\" required for \"{method}\""),
        ));
    }
    Ok(())
}

impl Ctx {
    fn app(&self) -> Result<AppState, HostError> {
        self.sh
            .env
            .app
            .get()
            .cloned()
            .ok_or_else(|| host_err("ERR", "core services are not attached"))
    }

    fn track<T>(&mut self, started: Instant, r: Result<T, HostError>) -> Result<T, HostError> {
        self.sh.stats.record(started, r.is_ok());
        if r.as_ref()
            .err()
            .is_some_and(|e| e.code == super::db::UNAVAILABLE)
        {
            self.db_unavailable = true;
        }
        r
    }
}

/// Runs a host method with its binding check on `$scope`s, deadline and counters.
macro_rules! call {
    ($self:ident, $method:literal, [$($scope:literal),*], $deadline:expr, $body:expr) => {{
        let started = Instant::now();
        let sh = $self.sh.clone();
        let r = async {
            bound(&sh, $method, &[$($scope),*]).await?;
            match tokio::time::timeout($deadline, $body).await {
                Ok(r) => r,
                Err(_) => Err(host_err(
                    "ERR_TIMEOUT",
                    format!("host method \"{}\" timed out", $method),
                )),
            }
        }
        .await;
        $self.track(started, r)
    }};
}

const HOST_CALL: std::time::Duration = std::time::Duration::from_secs(8);
const INGEST_CALL: std::time::Duration = std::time::Duration::from_secs(1800);

impl t::Host for Ctx {}

impl host::Host for Ctx {
    async fn media_acquisition_context(
        &mut self,
        media_id: u32,
        season_id: Option<u32>,
        episode_id: Option<u32>,
    ) -> Result<Option<t::AcquisitionTarget>, HostError> {
        let app = self.app();
        call!(
            self,
            "media.acquisitionContext",
            ["media:read"],
            HOST_CALL,
            async {
                let app = app?;
                super::acquisition::context(&app, media_id, season_id, episode_id)
                    .await
                    .map_err(db_err)
            }
        )
    }
    async fn acquisition_candidates(
        &mut self,
        q: t::CandidatesQuery,
    ) -> Result<t::CandidatesPage, HostError> {
        let app = self.app();
        let id = self.sh.id.clone();
        call!(
            self,
            "acquisition.candidates",
            ["acquisition:candidates", "media:read"],
            HOST_CALL,
            async {
                let app = app?;
                let on = (q.available_on.len() == 10)
                    .then(|| chrono::NaiveDate::parse_from_str(&q.available_on, "%Y-%m-%d").ok())
                    .flatten()
                    .ok_or_else(|| host_err("ERR_VALIDATION", "availableOn must be YYYY-MM-DD"))?;
                super::acquisition::candidates(&app, &id, q, on)
                    .await
                    .map_err(db_err)
            }
        )
    }
    async fn releases_match(
        &mut self,
        titles: Vec<t::ReleaseTitle>,
        min_age_minutes: Option<u32>,
    ) -> Result<Vec<t::ReleaseMatch>, HostError> {
        let app = self.app();
        call!(
            self,
            "releases.match",
            ["acquisition:candidates", "media:read"],
            HOST_CALL,
            async {
                let app = app?;
                super::acquisition::matches(&app, titles, min_age_minutes)
                    .await
                    .map_err(db_err)
            }
        )
    }
    async fn releases_score(
        &mut self,
        media_id: u32,
        season_number: Option<u32>,
        episode_number: Option<u32>,
        releases: Vec<t::CandidateRelease>,
    ) -> Result<Vec<t::ScoredRelease>, HostError> {
        let app = self.app();
        call!(
            self,
            "releases.score",
            ["releases:score"],
            HOST_CALL,
            async {
                let app = app?;
                super::acquisition::score(&app, media_id, season_number, episode_number, releases)
                    .await
                    .map_err(db_err)
            }
        )
    }
    async fn media_resolve(
        &mut self,
        q: t::ResolveQuery,
    ) -> Result<Vec<(String, t::ResolvedMedia)>, HostError> {
        let core = self.sh.env.core.clone();
        call!(self, "media.resolve", ["media:read"], HOST_CALL, async {
            let total = q.media_ids.len() + q.season_ids.len() + q.episode_ids.len();
            if total > 100 {
                return Err(host_err(
                    "ERR_VALIDATION",
                    format!("media.resolve: {total} ids exceeds the 100 limit"),
                ));
            }
            resolve(&core, &q).await.map_err(db_err)
        })
    }
    async fn media_exists(&mut self, media_ids: Vec<u32>) -> Result<Vec<u32>, HostError> {
        let core = self.sh.env.core.clone();
        call!(self, "media.exists", ["media:read"], HOST_CALL, async {
            let ids: Vec<i32> = media_ids.iter().map(|i| *i as i32).collect();
            let found: Vec<i32> =
                sqlx::query_scalar("SELECT id FROM media WHERE id = ANY($1) ORDER BY id")
                    .bind(&ids)
                    .fetch_all(&core)
                    .await
                    .map_err(db_err)?;
            Ok(found.into_iter().map(|i| i as u32).collect())
        })
    }
    async fn requests_mark_in_progress(
        &mut self,
        _idempotency_key: String,
        media_id: u32,
        season_number: Option<u32>,
    ) -> Result<(), HostError> {
        let app = self.app();
        call!(
            self,
            "requests.markInProgress",
            ["requests:progress"],
            HOST_CALL,
            async {
                let app = app?;
                crate::requests::Lifecycle::of(&app)
                    .mark_in_progress(media_id as i32, season_number.map(|s| s as i32))
                    .await
                    .map_err(|e| host_err("ERR", e.text()))
            }
        )
    }
    async fn library_ingest(&mut self, r: t::IngestRequest) -> Result<t::IngestResult, HostError> {
        let app = self.app();
        let id = self.sh.id.clone();
        call!(
            self,
            "library.ingest",
            ["ingest:write"],
            INGEST_CALL,
            async {
                let app = app?;
                super::ingest::run(&app, &id, r).await
            }
        )
    }
    async fn events_publish(&mut self, events: Vec<t::AcquisitionEvent>) -> Result<(), HostError> {
        let app = self.app();
        call!(self, "events.publish", ["events:emit"], HOST_CALL, async {
            let app = app?;
            super::events::publish(&app, events).await;
            Ok(())
        })
    }
    async fn notifications_dispatch_grab_started(
        &mut self,
        payload: String,
    ) -> Result<(), HostError> {
        let app = self.app();
        call!(
            self,
            "notifications.dispatch",
            ["events:emit"],
            HOST_CALL,
            async {
                let app = app?;
                let serde_json::Value::Object(map) = serde_json::from_str(&payload)
                    .map_err(|e| host_err("ERR_VALIDATION", format!("payload is not JSON: {e}")))?
                else {
                    return Err(host_err("ERR_VALIDATION", "payload must be an object"));
                };
                crate::notifications::dispatch(&app.db, "grab.started", &map)
                    .await
                    .map_err(db_err)
            }
        )
    }
    async fn counts_set(&mut self, key: String, value: u64) -> Result<(), HostError> {
        let app = self.app();
        let id = self.sh.id.clone();
        call!(self, "counts.set", ["events:emit"], HOST_CALL, async {
            let app = app?;
            app.plugins
                .counts
                .set(&id, &key, value)
                .map_err(|m| host_err("ERR_VALIDATION", m))
        })
    }
    async fn events_emit_own(
        &mut self,
        kind: String,
        payload: String,
        audience: t::Audience,
    ) -> Result<(), HostError> {
        let app = self.app();
        let id = self.sh.id.clone();
        call!(self, "events.emitOwn", ["events:emit"], HOST_CALL, async {
            let app = app?;
            let payload = serde_json::from_str(&payload)
                .map_err(|e| host_err("ERR_VALIDATION", format!("payload is not JSON: {e}")))?;
            super::events::emit_own(&app, &id, &kind, payload, audience).await;
            Ok(())
        })
    }
    async fn progress_set(
        &mut self,
        media_id: u32,
        downloads: Vec<t::DownloadProgress>,
    ) -> Result<(), HostError> {
        let app = self.app();
        call!(self, "progress.set", ["events:emit"], HOST_CALL, async {
            let app = app?;
            super::events::progress_gates()
                .set(&app, media_id as i32, &downloads)
                .await;
            Ok(())
        })
    }

    async fn deadline_remaining_ms(&mut self) -> u64 {
        self.deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u64
    }

    async fn schedule_call(
        &mut self,
        key: String,
        delay_ms: u64,
        payload: String,
    ) -> Result<(), HostError> {
        let env = self.sh.env.clone();
        let id = self.sh.id.clone();
        call!(self, "schedule-call", [], HOST_CALL, async {
            scheduled::schedule(&env.core, &id, &key, delay_ms, &payload)
                .await
                .map_err(|(c, m)| host_err(c, m))?;
            env.wake.notify_one();
            Ok(())
        })
    }
    async fn cancel_call(&mut self, key: String) -> Result<bool, HostError> {
        let core = self.sh.env.core.clone();
        let id = self.sh.id.clone();
        call!(self, "cancel-call", [], HOST_CALL, async {
            scheduled::cancel(&core, &id, &key).await.map_err(db_err)
        })
    }

    async fn config_get(
        &mut self,
        keys: Option<Vec<String>>,
    ) -> Result<Vec<(String, String)>, HostError> {
        let core = self.sh.env.core.clone();
        let id = self.sh.id.clone();
        call!(self, "config.get", ["config:rw"], HOST_CALL, async {
            config_for(&core, &id, keys.as_deref())
                .await
                .map_err(db_err)
        })
    }
    async fn config_set(&mut self, key: String, value: Option<String>) -> Result<(), HostError> {
        let app = self.app();
        let id = self.sh.id.clone();
        call!(self, "config.set", ["config:rw"], HOST_CALL, async {
            config_bounds(&key, value.as_deref())?;
            let app = app?;
            let full = format!("plugin.{id}.{key}");
            let ids = installed_ids(&app.db).await.map_err(db_err)?;
            if fliks_domain::plugins::setting_owner(&full, ids.iter().map(String::as_str))
                != Some(&*id)
            {
                return Err(host_err(
                    "ERR_DENIED",
                    format!("\"{key}\" belongs to another plugin"),
                ));
            }
            crate::settings::write(&app, &[(full, value)], Some(&id))
                .await
                .map_err(db_err)
        })
    }
}

/// Rule 34 bounds of `config.set`.
fn config_bounds(key: &str, value: Option<&str>) -> Result<(), HostError> {
    if !(1..=256).contains(&key.chars().count()) {
        return Err(host_err("ERR_VALIDATION", "key must be 1-256 chars"));
    }
    if value.is_some_and(|v| v.len() > 64 * 1024) {
        return Err(host_err("ERR_VALIDATION", "value over 64 KiB"));
    }
    Ok(())
}

async fn resolve(
    core: &PgPool,
    q: &t::ResolveQuery,
) -> sqlx::Result<Vec<(String, t::ResolvedMedia)>> {
    let kind = |k: &str| {
        if k == "movie" {
            t::MediaKind::Movie
        } else {
            t::MediaKind::Series
        }
    };
    let ids = |v: &[u32]| v.iter().map(|i| *i as i32).collect::<Vec<i32>>();
    let mut out = vec![];
    let rows: Vec<(i32, String, String, Option<i32>)> = sqlx::query_as(
        r#"SELECT id, title, type::text, "libraryId" FROM media WHERE id = ANY($1) ORDER BY id"#,
    )
    .bind(ids(&q.media_ids))
    .fetch_all(core)
    .await?;
    for (id, title, k, lib) in rows {
        out.push((
            format!("media:{id}"),
            t::ResolvedMedia {
                title,
                kind: kind(&k),
                library_id: lib.unwrap_or(0) as u32,
                season_number: None,
                episode_number: None,
                episode_title: None,
            },
        ));
    }
    let rows: Vec<(i32, i32, String, String, Option<i32>)> = sqlx::query_as(
        r#"SELECT s.id, s."seasonNumber", m.title, m.type::text, m."libraryId"
             FROM seasons s JOIN media m ON m.id = s."mediaId" WHERE s.id = ANY($1) ORDER BY s.id"#,
    )
    .bind(ids(&q.season_ids))
    .fetch_all(core)
    .await?;
    for (id, n, title, k, lib) in rows {
        out.push((
            format!("season:{id}"),
            t::ResolvedMedia {
                title,
                kind: kind(&k),
                library_id: lib.unwrap_or(0) as u32,
                season_number: Some(n as u32),
                episode_number: None,
                episode_title: None,
            },
        ));
    }
    type Row = (i32, i32, i32, Option<String>, String, String, Option<i32>);
    let rows: Vec<Row> = sqlx::query_as(
        r#"SELECT e.id, s."seasonNumber", e."episodeNumber", e.title, m.title, m.type::text, m."libraryId"
             FROM episodes e JOIN seasons s ON s.id = e."seasonId" JOIN media m ON m.id = s."mediaId"
            WHERE e.id = ANY($1) ORDER BY e.id"#,
    )
    .bind(ids(&q.episode_ids))
    .fetch_all(core)
    .await?;
    for (id, s, e, et, title, k, lib) in rows {
        out.push((
            format!("episode:{id}"),
            t::ResolvedMedia {
                title,
                kind: kind(&k),
                library_id: lib.unwrap_or(0) as u32,
                season_number: Some(s as u32),
                episode_number: Some(e as u32),
                episode_title: et,
            },
        ));
    }
    Ok(out)
}

fn no_db() -> db::DbError {
    db::DbError {
        code: "ERR_DENIED".into(),
        message: "plugin has no database schema".into(),
    }
}

impl Ctx {
    fn db_seen(&mut self, r: &Result<impl Sized, db::DbError>) {
        if r.as_ref().err().is_some_and(|e| e.code == UNAVAILABLE) {
            self.db_unavailable = true;
        }
    }
}

impl db::Host for Ctx {
    async fn query(
        &mut self,
        sql: String,
        params: Vec<db::Param>,
    ) -> Result<db::RowSet, db::DbError> {
        let r = match &self.sh.db {
            Some(d) => d.query(&sql, &params).await,
            None => Err(no_db()),
        };
        self.db_seen(&r);
        r
    }
    async fn execute(&mut self, sql: String, params: Vec<db::Param>) -> Result<u64, db::DbError> {
        let r = match &self.sh.db {
            Some(d) => d.execute(&sql, &params).await,
            None => Err(no_db()),
        };
        self.db_seen(&r);
        r
    }
    async fn migrate(
        &mut self,
        migrations: Vec<db::Migration>,
    ) -> Result<Vec<String>, db::DbError> {
        let list: Vec<(String, String)> = migrations.into_iter().map(|m| (m.name, m.up)).collect();
        let r = match &self.sh.db {
            Some(d) => d.migrate(&list).await,
            None => Err(no_db()),
        };
        self.db_seen(&r);
        if r.as_ref().is_ok_and(|a| !a.is_empty())
            && let Some(app) = self.sh.env.app.get()
        {
            app.plugins.probe_core_fks(&self.sh.id).await;
        }
        r
    }
}

impl log::Host for Ctx {
    async fn log(&mut self, level: log::Level, message: String) {
        let level = match level {
            log::Level::Debug => Level::Debug,
            log::Level::Info => Level::Info,
            log::Level::Warn => Level::Warn,
            log::Level::Error => Level::Error,
        };
        self.sh.env.logs.push(&self.sh.id, level, &message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_set_bounds() {
        let code = |k: &str, v: Option<&str>| config_bounds(k, v).err().map(|e| e.code);
        assert_eq!(code("a", Some("x")), None);
        assert_eq!(code(&"é".repeat(256), None), None);
        assert_eq!(
            code(&"a".repeat(257), None).as_deref(),
            Some("ERR_VALIDATION")
        );
        assert_eq!(code("", None).as_deref(), Some("ERR_VALIDATION"));
        let big = "x".repeat(64 * 1024 + 1);
        assert_eq!(code("a", Some(&big)).as_deref(), Some("ERR_VALIDATION"));
        assert_eq!(code("a", Some(&big[1..])), None);
    }
}
