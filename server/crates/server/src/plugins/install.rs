//! Install, upgrade, uninstall, enable, disable, restart (`plugins.md` rules 12, 17-23).
use super::manifest::{self, Inspected};
use super::packages::{self, Package};
use super::{Plugins, archive::Refusal};
use crate::sync::MutexExt;
use axum::http::StatusCode;
use nodejs_semver::Version;
use serde::Serialize;
use serde_json::{Value, json};

/// `PluginInstallException`: `{code, message}` with its status.
#[derive(Debug, Clone, PartialEq)]
pub struct InstallError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
}

pub fn ie(status: StatusCode, code: &str, message: impl Into<String>) -> InstallError {
    InstallError {
        status,
        code: code.into(),
        message: message.into(),
    }
}

impl axum::response::IntoResponse for InstallError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            axum::Json(json!({"code": self.code, "message": self.message})),
        )
            .into_response()
    }
}

fn internal(e: sqlx::Error) -> InstallError {
    ie(
        StatusCode::INTERNAL_SERVER_ERROR,
        "PLUGIN_INSTALL_FAILED",
        e.to_string(),
    )
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub installable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusal_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staging_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_by_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatible: Option<bool>,
}

impl Report {
    pub fn refused(r: Refusal) -> Self {
        Report {
            installable: false,
            refusal_code: Some(r.code.into()),
            detail: Some(r.detail),
            ..Default::default()
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub plugin_id: String,
    pub version: String,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    plugin_id: String,
    name: Value,
    version: String,
    kind: Value,
    origin: String,
    status: String,
    status_reason: Option<String>,
    signature: String,
    verified_by_key_id: Option<String>,
    enabled: bool,
    process_state: Option<&'static str>,
    status_message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    held_update: Option<Value>,
}

/// An upgrade from a `pluginApi` 1 package by the same key carries the grant forward.
pub fn carries_grant(existing: &Package, new_signed_by: Option<&str>) -> bool {
    existing.manifest["pluginApi"].as_f64() == Some(1.0)
        && existing.verified_by_key_id.is_some()
        && existing.verified_by_key_id.as_deref() == new_signed_by
}

impl Plugins {
    pub fn summary(&self, p: &Package) -> Summary {
        let process = p.is_process();
        Summary {
            plugin_id: p.plugin_id.clone(),
            name: p.manifest["name"].clone(),
            version: p.version.clone(),
            kind: p.manifest["kind"].clone(),
            origin: p.origin.clone(),
            status: p.status.clone(),
            status_reason: self
                .db_wait_reason(&p.plugin_id)
                .or_else(|| p.status_reason.clone()),
            signature: p.signature.clone(),
            verified_by_key_id: p.verified_by_key_id.clone(),
            enabled: p.enabled,
            process_state: process
                .then(|| self.state_of(&p.plugin_id).map(|s| s.as_str()))
                .flatten(),
            status_message: if process {
                self.status_message(&p.plugin_id)
            } else {
                String::new()
            },
            held_update: p.held_update.clone(),
        }
    }

    pub async fn allow_unsigned(&self) -> bool {
        crate::settings::setting_value(&self.db, "plugins.allow_unsigned")
            .await
            .ok()
            .flatten()
            .as_deref()
            == Some("true")
    }

    pub async fn inspect_bytes(&self, bytes: &[u8]) -> Result<Inspected, Refusal> {
        let allow = self.allow_unsigned().await;
        manifest::inspect(bytes, allow, &self.opts.keys)
    }

    /// Whether this install would newly ask for `network.internal` (rules 4, 12, 29).
    pub async fn network_newly_requested(&self, i: &Inspected) -> bool {
        if !manifest::requests_network(&i.manifest) {
            return false;
        }
        match packages::find(&self.db, &i.id).await.ok().flatten() {
            Some(e) => !e.network_internal && !carries_grant(&e, i.signed_by.as_deref()),
            None => true,
        }
    }

    pub async fn report(&self, i: &Inspected, staging_id: String) -> Report {
        let compatible = manifest::api_supported(&i.manifest)
            && manifest::fliks_satisfied(
                i.manifest["fliks"].as_str().unwrap_or_default(),
                &self.opts.version,
            );
        Report {
            installable: true,
            staging_id: Some(staging_id),
            sha256: Some(i.archive.sha256.clone()),
            id: Some(i.id.clone()),
            name: i.manifest["name"].as_str().map(str::to_owned),
            version: Some(i.version.clone()),
            kind: Some(i.kind().to_owned()),
            signature: Some(i.signature.as_str()),
            signed_by_key_id: i.signed_by.clone(),
            capabilities: Some(manifest::capabilities(
                &i.manifest,
                self.network_newly_requested(i).await,
            )),
            compatible: Some(compatible),
            ..Default::default()
        }
    }

    /// V1-V7 in memory, then staged; nothing is activated.
    pub async fn inspect_and_stage(
        &self,
        bytes: &[u8],
        origin: &str,
    ) -> Result<Report, InstallError> {
        let i = match self.inspect_bytes(bytes).await {
            Ok(i) => i,
            Err(r) => return Ok(Report::refused(r)),
        };
        let (id, _) = self.staging.stage(bytes, origin).await.map_err(|e| match e {
            super::staging::StageError::Limit => ie(
                StatusCode::TOO_MANY_REQUESTS,
                "PLUGIN_STAGING_LIMIT",
                format!(
                    "at most {} staged installs may exist at once — confirm or wait for one to be swept",
                    super::staging::MAX_STAGED
                ),
            ),
            super::staging::StageError::Io(m) => ie(StatusCode::INTERNAL_SERVER_ERROR, "PLUGIN_INSTALL_FAILED", m),
        })?;
        Ok(self.report(&i, id).await)
    }

    /// Rule 18: a fresh read of the staged bytes, the whole inspect again, then promote.
    pub async fn confirm(
        &self,
        staging_id: &str,
        sha256: &str,
    ) -> Result<InstallResult, InstallError> {
        let bytes = self.staging.read(staging_id).await.ok_or_else(|| {
            ie(
                StatusCode::NOT_FOUND,
                "PLUGIN_STAGING_NOT_FOUND",
                format!("no staged upload \"{staging_id}\""),
            )
        })?;
        if super::archive::sha256_hex(&bytes) != sha256 {
            return Err(ie(
                StatusCode::CONFLICT,
                "PLUGIN_STAGING_STALE",
                "the staged bytes no longer match the hash the client saw",
            ));
        }
        let i = self
            .inspect_bytes(&bytes)
            .await
            .map_err(|r| ie(StatusCode::UNPROCESSABLE_ENTITY, r.code, r.detail))?;
        let origin = self.staging.origin(staging_id).await;
        let r = self.promote(&bytes, &i, origin).await;
        self.staging.discard(staging_id).await;
        r
    }

    /// Rule 19: denylist, provisioning, the row, then registration.
    /// No install, upgrade, enable or restart while a restore holds its claim.
    fn refuse_while_restoring(&self) -> Result<(), InstallError> {
        if self.restoring() {
            return Err(ie(
                StatusCode::CONFLICT,
                "PLUGIN_BUSY",
                "a restore is running",
            ));
        }
        Ok(())
    }

    pub async fn promote(
        &self,
        bytes: &[u8],
        i: &Inspected,
        origin: &str,
    ) -> Result<InstallResult, InstallError> {
        self.refuse_while_restoring()?;
        let id = &i.id;
        let m = &i.manifest;
        if i.signature == super::trust::Trust::Unsigned {
            tracing::warn!(
                "installing \"{id}\" {} unsigned: nothing vouches for its code",
                i.version
            );
        }
        if let Some(reason) = self
            .denial(id, &i.version, &i.archive.sha256, i.signed_by.as_deref())
            .await
            .map_err(internal)?
        {
            return Err(ie(StatusCode::FORBIDDEN, "PLUGIN_DENIED", reason));
        }
        let pending = {
            let _l = self.lock(id).await;
            let existing = packages::find(&self.db, id).await.map_err(internal)?;
            if let Some(e) = &existing
                && let (Ok(new), Ok(old)) = (Version::parse(&i.version), Version::parse(&e.version))
                && new < old
            {
                tracing::warn!(
                    "installing \"{id}\" {} over the newer {}",
                    i.version,
                    e.version
                );
            }
            if let Some(e) = &existing
                && e.verified_by_key_id.is_some()
                && e.verified_by_key_id != i.signed_by
            {
                return Err(ie(
                    StatusCode::CONFLICT,
                    "PLUGIN_SIGNER_CHANGED",
                    "the signer differs from the installed version: uninstall the plugin first",
                ));
            }
            manifest::check_files(i)
                .map_err(|r| ie(StatusCode::UNPROCESSABLE_ENTITY, r.code, r.detail))?;
            if m["kind"] == "process" && m["database"]["schema"] == Value::Bool(true) {
                let refs: Vec<String> = m["database"]["coreRefs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect();
                super::db::provision(&self.db, id, &refs)
                    .await
                    .map_err(|e| {
                        ie(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "PLUGIN_DB_PROVISION_FAILED",
                            e.message,
                        )
                    })?;
            }
            let enabled = packages::upsert(
                &self.db,
                packages::Upsert {
                    plugin_id: id,
                    version: &i.version,
                    archive: bytes,
                    origin,
                    signature: i.signature.as_str(),
                    verified_by: i.signed_by.as_deref(),
                    manifest: m,
                    network_internal: manifest::requests_network(m),
                },
            )
            .await
            .map_err(internal)?;
            packages::grant_scopes(&self.db, id, m)
                .await
                .map_err(internal)?;
            if !enabled {
                tracing::info!("plugin \"{id}\" upgraded while disabled — not activated");
                return Ok(InstallResult {
                    plugin_id: id.clone(),
                    version: i.version.clone(),
                    status: "active",
                    reason: None,
                    detail: None,
                });
            }
            let pkg = packages::find(&self.db, id)
                .await
                .map_err(internal)?
                .ok_or_else(|| {
                    ie(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "PLUGIN_INSTALL_FAILED",
                        "the package row vanished",
                    )
                })?;
            self.register(&pkg).await
        };
        let outcome = match pending {
            Ok(p) => self.settle(p).await,
            Err(f) => Err(f),
        };
        match outcome {
            Ok(()) => Ok(InstallResult {
                plugin_id: id.clone(),
                version: i.version.clone(),
                status: "active",
                reason: None,
                detail: None,
            }),
            Err(f) => {
                let reason = format!("{}: {}", f.reason, f.detail);
                packages::set_status(&self.db, id, Some(&reason))
                    .await
                    .map_err(internal)?;
                tracing::warn!(
                    "plugin \"{id}\" installed but not activated ({}): {}",
                    f.reason,
                    f.detail
                );
                Ok(InstallResult {
                    plugin_id: id.clone(),
                    version: i.version.clone(),
                    status: "failed",
                    reason: Some(f.reason.into()),
                    detail: Some(f.detail),
                })
            }
        }
    }

    pub async fn find_installed(&self, id: &str) -> Result<Package, InstallError> {
        packages::find(&self.db, id)
            .await
            .map_err(internal)?
            .ok_or_else(|| {
                ie(
                    StatusCode::NOT_FOUND,
                    "PLUGIN_NOT_FOUND",
                    format!("plugin \"{id}\" is not installed"),
                )
            })
    }

    /// Rule 20: idempotent, safe on anything already gone.
    pub async fn uninstall(&self, id: &str) -> sqlx::Result<()> {
        let _l = self.lock(id).await;
        self.forget(id).await;
        packages::delete_registration(&self.db, id).await?;
        let Some(pkg) = packages::find(&self.db, id).await? else {
            return Ok(());
        };
        let ids = super::imports::installed_ids(&self.db).await?;
        let keys: Vec<String> = sqlx::query_scalar(
            r#"SELECT "key"::text FROM app_settings WHERE starts_with("key", $1)"#,
        )
        .bind(format!("plugin.{id}."))
        .fetch_all(&self.db)
        .await?;
        let owned: Vec<String> = keys
            .into_iter()
            .filter(|k| {
                fliks_domain::plugins::setting_owner(k, ids.iter().map(String::as_str)) == Some(id)
            })
            .collect();
        sqlx::query(r#"DELETE FROM app_settings WHERE "key" = ANY($1)"#)
            .bind(&owned)
            .execute(&self.db)
            .await?;
        if pkg.is_process() {
            super::db::deprovision(&self.db, id).await?;
        }
        sqlx::query(r#"DELETE FROM plugin_scheduled_calls WHERE "pluginId" = $1"#)
            .bind(id)
            .execute(&self.db)
            .await?;
        if let Some(wasm) = super::archive::read(&pkg.archive)
            .ok()
            .and_then(|a| a.get("plugin.wasm").map(super::archive::sha256_hex))
            && let Ok(rd) = std::fs::read_dir(self.opts.runtime_dir.join("cwasm"))
        {
            for e in rd.flatten() {
                if e.file_name()
                    .to_string_lossy()
                    .starts_with(&format!("{wasm}-"))
                {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        packages::delete(&self.db, id).await?;
        let _ = std::fs::remove_dir_all(self.opts.runtime_dir.join("data").join(id));
        self.fk_warnings.lock_clean().remove(id);
        Ok(())
    }

    pub async fn disable(&self, id: &str) -> Result<Summary, InstallError> {
        let _l = self.lock(id).await;
        let mut pkg = self.find_installed(id).await?;
        if pkg.enabled {
            pkg.enabled = false;
            packages::set_enabled(&self.db, id, false)
                .await
                .map_err(internal)?;
            self.unregister(id).await;
        }
        Ok(self.summary(&pkg))
    }

    pub async fn enable(&self, id: &str) -> Result<Summary, InstallError> {
        self.refuse_while_restoring()?;
        let pending = {
            let _l = self.lock(id).await;
            let pkg = self.find_installed(id).await?;
            if pkg.enabled {
                return Ok(self.summary(&pkg));
            }
            packages::set_enabled(&self.db, id, true)
                .await
                .map_err(internal)?;
            self.register(&pkg).await
        };
        let outcome = match pending {
            Ok(p) => self.settle(p).await,
            Err(f) => Err(f),
        };
        let reason = outcome.err().map(|f| format!("{}: {}", f.reason, f.detail));
        packages::set_status(&self.db, id, reason.as_deref())
            .await
            .map_err(internal)?;
        Ok(self.summary(&self.find_installed(id).await?))
    }

    /// Rule 23: a fresh registration with a fresh breaker; 503 with the reason when it fails.
    pub async fn restart(&self, id: &str) -> Result<(), InstallError> {
        self.refuse_while_restoring()?;
        let pending = {
            let _l = self.lock(id).await;
            let pkg = self.find_installed(id).await?;
            if !pkg.is_process() {
                return Err(ie(
                    StatusCode::BAD_REQUEST,
                    "PLUGIN_NOT_PROCESS_TIER",
                    format!("plugin \"{id}\" is not a process-tier plugin"),
                ));
            }
            if !pkg.enabled {
                let f = self
                    .fail(
                        id,
                        super::registry::fail("disabled", "this plugin is disabled"),
                    )
                    .await;
                Err(f)
            } else {
                self.register(&pkg).await
            }
        };
        let outcome = match pending {
            Ok(p) => self.settle(p).await,
            Err(f) => Err(f),
        };
        let reason = outcome
            .as_ref()
            .err()
            .map(|f| format!("{}: {}", f.reason, f.detail));
        packages::set_status(&self.db, id, reason.as_deref())
            .await
            .map_err(internal)?;
        match reason {
            None => Ok(()),
            Some(r) => Err(ie(StatusCode::SERVICE_UNAVAILABLE, "PLUGIN_UNAVAILABLE", r)),
        }
    }
}
