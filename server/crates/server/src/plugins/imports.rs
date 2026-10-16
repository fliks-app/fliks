//! Host imports (plugins.md rules 30, 34, 35, 55): bound to the calling instance's plugin.

use super::logs::Level;
use super::runtime::fliks::plugin::{db, host, log, types as t};
use super::runtime::{Ctx, HostError};
use super::scheduled;
use sqlx::PgPool;

fn no_method(name: &str) -> HostError {
    HostError {
        code: "ERR_NO_METHOD".into(),
        message: format!("{name} is not in the S8 spike host"),
    }
}

fn host_err(code: &str, message: impl Into<String>) -> HostError {
    HostError {
        code: code.into(),
        message: message.into(),
    }
}

impl Ctx {
    fn scope(&self, s: &str, method: &str) -> Result<(), HostError> {
        if self.sh.scopes.iter().any(|x| x == s) {
            Ok(())
        } else {
            Err(host_err(
                "ERR_DENIED",
                format!(
                    "plugin \"{}\" is missing scope \"{s}\" required for \"{method}\"",
                    self.sh.id
                ),
            ))
        }
    }
}

/// The installed id owning `plugin.<id>.<key>`: the longest matching prefix (rule 24).
fn owner<'a>(key: &str, ids: &'a [String]) -> Option<&'a str> {
    ids.iter()
        .filter(|id| {
            key.strip_prefix("plugin.")
                .and_then(|k| k.strip_prefix(id.as_str()))
                .is_some_and(|r| r.starts_with('.'))
        })
        .max_by_key(|id| id.len())
        .map(String::as_str)
}

/// Caller-owned settings with the prefix stripped; null values are absent.
pub async fn config_for(
    core: &PgPool,
    id: &str,
    keys: Option<&[String]>,
) -> sqlx::Result<Vec<(String, String)>> {
    let ids: Vec<String> = sqlx::query_scalar(r#"SELECT "pluginId"::text FROM plugin_packages"#)
        .fetch_all(core)
        .await?;
    let prefix = format!("plugin.{id}.");
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as(r#"SELECT "key"::text, "value" FROM app_settings WHERE starts_with("key", $1) ORDER BY "key""#)
            .bind(&prefix)
            .fetch_all(core)
            .await?;
    Ok(rows
        .into_iter()
        .filter(|(k, _)| owner(k, &ids) == Some(id))
        .filter_map(|(k, v)| Some((k[prefix.len()..].to_owned(), v?)))
        .filter(|(k, _)| keys.is_none_or(|ks| ks.contains(k)))
        .collect())
}

impl t::Host for Ctx {}

impl host::Host for Ctx {
    async fn media_acquisition_context(
        &mut self,
        _: u32,
        _: Option<u32>,
        _: Option<u32>,
    ) -> Result<Option<t::AcquisitionTarget>, HostError> {
        Err(no_method("media.acquisitionContext"))
    }
    async fn acquisition_candidates(
        &mut self,
        _: t::CandidatesQuery,
    ) -> Result<t::CandidatesPage, HostError> {
        Err(no_method("acquisition.candidates"))
    }
    async fn releases_match(
        &mut self,
        _: Vec<t::ReleaseTitle>,
        _: Option<u32>,
    ) -> Result<Vec<t::ReleaseMatch>, HostError> {
        Err(no_method("releases.match"))
    }
    async fn releases_score(
        &mut self,
        _: u32,
        _: Option<u32>,
        _: Option<u32>,
        _: Vec<t::CandidateRelease>,
    ) -> Result<Vec<t::ScoredRelease>, HostError> {
        Err(no_method("releases.score"))
    }
    async fn media_resolve(
        &mut self,
        _: t::ResolveQuery,
    ) -> Result<Vec<(String, t::ResolvedMedia)>, HostError> {
        Err(no_method("media.resolve"))
    }
    async fn media_exists(&mut self, _: Vec<u32>) -> Result<Vec<u32>, HostError> {
        Err(no_method("media.exists"))
    }
    async fn requests_mark_in_progress(
        &mut self,
        _: String,
        _: u32,
        _: Option<u32>,
    ) -> Result<(), HostError> {
        Err(no_method("requests.markInProgress"))
    }
    async fn library_ingest(&mut self, _: t::IngestRequest) -> Result<t::IngestResult, HostError> {
        Err(no_method("library.ingest"))
    }
    async fn events_publish(&mut self, _: Vec<t::AcquisitionEvent>) -> Result<(), HostError> {
        Err(no_method("events.publish"))
    }
    async fn notifications_dispatch_grab_started(&mut self, _: String) -> Result<(), HostError> {
        Err(no_method("notifications.dispatch"))
    }
    async fn counts_set(&mut self, _: String, _: u64) -> Result<(), HostError> {
        Err(no_method("counts.set"))
    }
    async fn events_emit_own(
        &mut self,
        _: String,
        _: String,
        _: t::Audience,
    ) -> Result<(), HostError> {
        Err(no_method("events.emitOwn"))
    }
    async fn progress_set(&mut self, _: u32, _: Vec<t::DownloadProgress>) -> Result<(), HostError> {
        Err(no_method("progress.set"))
    }

    async fn schedule_call(
        &mut self,
        key: String,
        delay_ms: u64,
        payload: String,
    ) -> Result<(), HostError> {
        let env = &self.sh.env;
        scheduled::schedule(&env.core, &self.sh.id, &key, delay_ms, &payload)
            .await
            .map_err(|(c, m)| host_err(c, m))?;
        env.wake.notify_one();
        Ok(())
    }
    async fn cancel_call(&mut self, key: String) -> Result<bool, HostError> {
        scheduled::cancel(&self.sh.env.core, &self.sh.id, &key)
            .await
            .map_err(|e| host_err("ERR", e.to_string()))
    }

    async fn config_get(
        &mut self,
        keys: Option<Vec<String>>,
    ) -> Result<Vec<(String, String)>, HostError> {
        self.scope("config:rw", "config.get")?;
        config_for(&self.sh.env.core, &self.sh.id, keys.as_deref())
            .await
            .map_err(|e| host_err("ERR", e.to_string()))
    }
    async fn config_set(&mut self, key: String, value: Option<String>) -> Result<(), HostError> {
        self.scope("config:rw", "config.set")?;
        let core = &self.sh.env.core;
        let full = format!("plugin.{}.{key}", self.sh.id);
        let ids: Vec<String> =
            sqlx::query_scalar(r#"SELECT "pluginId"::text FROM plugin_packages"#)
                .fetch_all(core)
                .await
                .map_err(|e| host_err("ERR", e.to_string()))?;
        if owner(&full, &ids) != Some(&*self.sh.id) {
            return Err(host_err(
                "ERR_DENIED",
                format!("\"{key}\" belongs to another plugin"),
            ));
        }
        sqlx::query(
            r#"INSERT INTO app_settings ("key", "value") VALUES ($1, $2)
               ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()"#,
        )
        .bind(&full)
        .bind(value)
        .execute(core)
        .await
        .map_err(|e| host_err("ERR", e.to_string()))?;
        Ok(())
    }
}

fn no_db() -> db::DbError {
    db::DbError {
        code: "ERR_DENIED".into(),
        message: "plugin has no database schema".into(),
    }
}

impl db::Host for Ctx {
    async fn query(
        &mut self,
        sql: String,
        params: Vec<db::Param>,
    ) -> Result<db::RowSet, db::DbError> {
        self.sh
            .db
            .as_ref()
            .ok_or_else(no_db)?
            .query(&sql, &params)
            .await
    }
    async fn execute(&mut self, sql: String, params: Vec<db::Param>) -> Result<u64, db::DbError> {
        self.sh
            .db
            .as_ref()
            .ok_or_else(no_db)?
            .execute(&sql, &params)
            .await
    }
    async fn migrate(
        &mut self,
        migrations: Vec<db::Migration>,
    ) -> Result<Vec<String>, db::DbError> {
        let list: Vec<(String, String)> = migrations.into_iter().map(|m| (m.name, m.up)).collect();
        self.sh.db.as_ref().ok_or_else(no_db)?.migrate(&list).await
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
    use super::owner;

    #[test]
    fn longest_owner_wins() {
        let ids = vec!["fliks".to_owned(), "fliks.download".to_owned()];
        assert_eq!(
            owner("plugin.fliks.download.key", &ids),
            Some("fliks.download")
        );
        assert_eq!(owner("plugin.fliks.key", &ids), Some("fliks"));
        assert_eq!(owner("plugin.fliksx.key", &ids), None);
    }
}
