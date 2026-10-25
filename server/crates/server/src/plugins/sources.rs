//! Catalog sources: refresh, inspect from a catalog, the daily job and auto-update
//! (`plugins.md` rules 25-29).
use super::fetch::ArchiveError;
use super::install::{InstallError, Report, carries_grant, ie};
use super::packages::{self, Package, Source};
use super::{Plugins, archive, catalog, trust};
use crate::state::AppState;
use axum::http::StatusCode;
use nodejs_semver::Version;
use serde_json::{Value, json};
use std::time::Duration;

const CATALOG_CAP: usize = 1 << 20;
const STALE: Duration = Duration::from_secs(6 * 3600);

/// `{ok:true}` or `{ok:false, reason, detail}` (201).
pub type Refresh = Value;

impl Plugins {
    async fn refresh_failed(
        &self,
        s: &Source,
        reason: &str,
        detail: String,
    ) -> sqlx::Result<Refresh> {
        tracing::warn!(
            "catalog refresh failed for source #{} ({reason}): {detail}",
            s.id
        );
        sqlx::query(r#"UPDATE plugin_sources SET "lastRefreshError" = $2, "updatedAt" = now() WHERE id = $1"#)
            .bind(s.id)
            .bind(&detail)
            .execute(&self.db)
            .await?;
        Ok(json!({"ok": false, "reason": reason, "detail": detail}))
    }

    /// Rule 26: verify the exact bytes, parse, filter, store, then enforce the denylist.
    pub async fn refresh_source(&self, s: &Source) -> sqlx::Result<Refresh> {
        let url = match reqwest::Url::parse(&s.url) {
            Ok(u) => u,
            Err(_) => {
                return self
                    .refresh_failed(s, "insecure-url", "source url is not a valid URL".into())
                    .await;
            }
        };
        if url.scheme() != "https" {
            return self
                .refresh_failed(s, "insecure-url", "source url is not https".into())
                .await;
        }
        let f = &self.opts.fetch;
        let sig_url = format!("{}.sig", s.url);
        let (doc, sig) = tokio::join!(
            f.catalog_file(url.as_str(), CATALOG_CAP),
            f.catalog_file(&sig_url, 256)
        );
        let (doc, sig) = match (doc, sig) {
            (Ok(d), Ok(s)) => (d, s),
            (Err(e), _) | (_, Err(e)) => {
                return self.refresh_failed(s, "network-error", e.kind()).await;
            }
        };
        let keys = match &s.public_key {
            Some(k) => match <[u8; 32]>::try_from(k.as_slice()) {
                Ok(k) => vec![("source".to_owned(), k)],
                Err(_) => vec![],
            },
            None => self.opts.keys.clone(),
        };
        let text = String::from_utf8_lossy(&sig);
        let sig = Some(text.trim())
            .filter(|t| !t.is_empty())
            .map(|t| trust::decode(t).unwrap_or_default());
        let (outcome, signed_by) = trust::resolve(&doc, sig.as_deref(), &keys);
        if outcome != trust::Trust::Official {
            return self
                .refresh_failed(
                    s,
                    "bad-signature",
                    format!("catalog signature did not verify ({})", outcome.as_str()),
                )
                .await;
        }
        let Some(parsed) = catalog::parse(&doc) else {
            return self
                .refresh_failed(
                    s,
                    "malformed-catalog",
                    "catalog signature verified but the document did not parse".into(),
                )
                .await;
        };
        let mut filtered = catalog::filter(&parsed, &self.opts.version, self.skip_compat().await);
        filtered["signedByKeyId"] = json!(signed_by);
        sqlx::query(
            r#"UPDATE plugin_sources SET "cachedCatalog" = $2, "lastRefreshedAt" = now(), "lastRefreshError" = NULL,
                 "updatedAt" = now() WHERE id = $1"#,
        )
        .bind(s.id)
        .bind(&filtered)
        .execute(&self.db)
        .await?;
        if s.enabled {
            self.enforce_deny_list(&filtered).await;
        }
        Ok(json!({"ok": true}))
    }

    async fn enforce_deny_list(&self, cached: &Value) {
        let (list, signed) = catalog::deny_list_of(Some(cached));
        if list.is_empty() || signed.is_none() {
            return;
        }
        let Ok(pkgs) = packages::all(&self.db).await else {
            return;
        };
        let sources = vec![(list, signed)];
        for p in pkgs {
            let sha = archive::sha256_hex(&p.archive);
            let denied = catalog::find_denial(
                &catalog::Denied {
                    plugin_id: &p.plugin_id,
                    version: &p.version,
                    sha256: &sha,
                    verified_by: p.verified_by_key_id.as_deref(),
                },
                &sources,
            );
            let Some(reason) = denied else { continue };
            tracing::warn!("plugin \"{}\" revoked by catalog: {reason}", p.plugin_id);
            let _l = self.lock(&p.plugin_id).await;
            self.revoke(&p.plugin_id, &reason).await;
            let _ =
                packages::set_status(&self.db, &p.plugin_id, Some(&format!("revoked: {reason}")))
                    .await;
        }
    }

    /// Rule 28: the version must be installable; fetch, the signed checksum, then the guards.
    pub async fn inspect_from_catalog(
        &self,
        s: &Source,
        plugin_id: &str,
        version: &str,
    ) -> Result<Report, InstallError> {
        let entry = catalog::version_entry_of(s.cached_catalog.as_ref(), plugin_id, version);
        let info = entry.and_then(|e| {
            Some((
                e["zipUrl"].as_str()?.to_owned(),
                e["sha256"].as_str()?.to_owned(),
            ))
        });
        let Some((zip, sha)) = info else {
            return Err(ie(
                StatusCode::NOT_FOUND,
                "PLUGIN_CATALOG_VERSION_NOT_FOUND",
                format!(
                    "\"{plugin_id}@{version}\" is not an installable version on source #{}",
                    s.id
                ),
            ));
        };
        let bytes = self
            .opts
            .fetch
            .archive(&zip, archive::MAX_ARCHIVE_BYTES)
            .await
            .map_err(|e| match e {
                ArchiveError::Timeout => ie(
                    StatusCode::GATEWAY_TIMEOUT,
                    "PLUGIN_FETCH_TIMEOUT",
                    "archive download timed out",
                ),
                ArchiveError::TooLarge => ie(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "PLUGIN_FETCH_TOO_LARGE",
                    "archive is too large",
                ),
                ArchiveError::Failed(m) => ie(StatusCode::BAD_GATEWAY, "PLUGIN_FETCH_FAILED", m),
            })?;
        if archive::sha256_hex(&bytes) != sha {
            return Err(ie(
                StatusCode::UNPROCESSABLE_ENTITY,
                "PLUGIN_CHECKSUM_MISMATCH",
                "the downloaded archive does not match the signed catalog checksum",
            ));
        }
        self.inspect_and_stage(&bytes, "catalog").await
    }

    /// Puts the previous archive back after an unattended upgrade failed to activate, and holds the
    /// failed version so the next run does not retry it.
    async fn roll_back(&self, prev: &Package, failed: &str, why: &str) {
        let restored = async {
            let i = self
                .inspect_bytes(&prev.archive)
                .await
                .map_err(|r| r.detail)?;
            self.promote(&prev.archive, &i, &prev.origin)
                .await
                .map_err(|e| e.message)
        }
        .await;
        if let Err(e) = restored {
            tracing::error!(
                "auto-update: {} not restored to {}: {e}",
                prev.plugin_id,
                prev.version
            );
        }
        let _ = packages::hold_update(&self.db, &prev.plugin_id, failed, "failed", why).await;
    }

    /// Rule 29: the newest installable version, unattended only when official and consent-free.
    pub async fn auto_update(&self) -> Value {
        let mut updated = vec![];
        let mut skipped = vec![];
        let off = crate::settings::setting_value(&self.db, "plugins.auto_update")
            .await
            .ok()
            .flatten()
            .as_deref()
            == Some("false");
        if off {
            return json!({"updated": updated, "skipped": skipped});
        }
        let (Ok(installed), Ok(sources)) = (
            packages::all(&self.db).await,
            packages::sources(&self.db, true).await,
        ) else {
            return json!({"updated": updated, "skipped": skipped});
        };
        for pkg in installed {
            let mut best: Option<(&Source, String)> = None;
            for s in &sources {
                let Some(v) = catalog::newest(s.cached_catalog.as_ref(), &pkg.plugin_id) else {
                    continue;
                };
                let newer = best
                    .as_ref()
                    .is_none_or(|(_, b)| Version::parse(&v).ok() > Version::parse(b).ok());
                if newer {
                    best = Some((s, v));
                }
            }
            let Some((source, version)) = best else {
                continue;
            };
            let (Ok(cur), Ok(new)) = (Version::parse(&pkg.version), Version::parse(&version))
            else {
                continue;
            };
            if new <= cur {
                continue;
            }
            let id = pkg.plugin_id.clone();
            let mut skip = |reason: String| {
                tracing::warn!("auto-update: {id}@{version} skipped — {reason}");
                skipped.push(json!({"pluginId": id, "version": version, "reason": reason}));
            };
            if pkg
                .held_update
                .as_ref()
                .is_some_and(|h| h["version"] == version.as_str() && h["reason"] == "failed")
            {
                skip("it failed to activate before; an admin has to install it".into());
                continue;
            }
            let report = match self
                .inspect_from_catalog(source, &pkg.plugin_id, &version)
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    skip(e.message);
                    continue;
                }
            };
            let (Some(staging), Some(sha)) = (report.staging_id.clone(), report.sha256.clone())
            else {
                skip(
                    report
                        .refusal_code
                        .clone()
                        .unwrap_or_else(|| "not installable".into()),
                );
                continue;
            };
            if report.signature != Some("official") {
                skip(format!(
                    "signature is \"{}\", which needs an admin's acknowledgement",
                    report.signature.unwrap_or("unknown")
                ));
                continue;
            }
            if report
                .capabilities
                .as_ref()
                .is_some_and(|c| c.iter().any(|c| c == "network:internal"))
                && !carries_grant(&pkg, report.signed_by_key_id.as_deref())
            {
                skip(
                    "the new version requests network.internal, which needs an admin's consent"
                        .into(),
                );
                continue;
            }
            let granted = packages::granted_scopes(&self.db, &id).await.ok().flatten();
            let new_scopes: Vec<&str> = granted
                .iter()
                .flat_map(|g| {
                    report
                        .capabilities
                        .iter()
                        .flatten()
                        .filter_map(|c| c.strip_prefix("scope:"))
                        .filter(|s| !g.iter().any(|x| x == s))
                })
                .collect();
            if !new_scopes.is_empty() {
                let detail = new_scopes.join(", ");
                let _ = packages::hold_update(&self.db, &id, &version, "new-scopes", &detail).await;
                skip(format!(
                    "the new version requests scopes ({detail}), which need an admin's consent"
                ));
                continue;
            }
            match self.confirm(&staging, &sha).await {
                Ok(r) if r.status == "active" => {
                    tracing::info!("auto-update: {} {} → {version}", pkg.plugin_id, pkg.version);
                    updated.push(
                        json!({"pluginId": pkg.plugin_id, "from": pkg.version, "to": version}),
                    );
                }
                Ok(r) => {
                    let why = r
                        .reason
                        .unwrap_or_else(|| "install did not activate".into());
                    self.roll_back(&pkg, &version, &why).await;
                    skip(format!("{why}; kept {}", pkg.version));
                }
                Err(e) => skip(e.message),
            }
        }
        if !updated.is_empty() || !skipped.is_empty() {
            tracing::info!(
                "auto-update: {} updated, {} skipped",
                updated.len(),
                skipped.len()
            );
        }
        json!({"updated": updated, "skipped": skipped})
    }
}

fn stale(s: &Source) -> bool {
    match (&s.cached_catalog, s.last_refreshed_at) {
        (Some(_), Some(at)) => (chrono::Utc::now() - at).to_std().unwrap_or_default() > STALE,
        _ => true,
    }
}

/// Every enabled source (the boot pass: only stale ones); one failure never stops the others.
/// `FLIKS_PLUGINS_DISABLED=1` makes no catalog call at all.
pub async fn refresh_all(st: &AppState, stale_only: bool) {
    if st.plugins.opts.disabled {
        return;
    }
    let Ok(sources) = packages::sources(&st.db, true).await else {
        return;
    };
    for s in sources {
        if stale_only && !stale(&s) {
            continue;
        }
        if let Err(e) = st.plugins.refresh_source(&s).await {
            tracing::warn!("catalog refresh threw for source #{}: {e}", s.id);
        }
    }
}

/// The `RefreshPluginSources` body: refresh, then auto-update.
pub fn refresh_and_update(
    st: &AppState,
) -> futures_util::future::BoxFuture<'_, Result<(), String>> {
    Box::pin(async move {
        if st.plugins.opts.disabled {
            return Ok(());
        }
        refresh_all(st, false).await;
        st.plugins.auto_update().await;
        Ok(())
    })
}
