//! Plugin export and import (`plugins.md` rules 53-54, C102, C103), on the plugin's own role:
//! its triggers, defaults and policies are plugin code and stay in the rule-35 sandbox.
use super::Plugins;
use super::db::{PluginDb, schema};
use super::install::{InstallError, ie};
use super::packages::Package;
use axum::http::StatusCode;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use tokio_postgres::{GenericClient, IsolationLevel};

fn quote(i: &str) -> String {
    format!("\"{}\"", i.replace('"', "\"\""))
}

/// The server's own text for a database error (`tokio_postgres` displays only "db error").
trait Detail {
    fn detail(&self) -> String;
}

impl Detail for tokio_postgres::Error {
    fn detail(&self) -> String {
        self.as_db_error()
            .map_or_else(|| self.to_string(), |d| d.message().to_owned())
    }
}

impl Detail for sqlx::Error {
    fn detail(&self) -> String {
        self.to_string()
    }
}

impl Detail for &str {
    fn detail(&self) -> String {
        (*self).to_owned()
    }
}

impl Detail for String {
    fn detail(&self) -> String {
        self.clone()
    }
}

fn internal(e: impl Detail) -> InstallError {
    ie(
        StatusCode::INTERNAL_SERVER_ERROR,
        "PLUGIN_DB_PROVISION_FAILED",
        e.detail(),
    )
}

fn malformed() -> InstallError {
    ie(
        StatusCode::BAD_REQUEST,
        "PLUGIN_EXPORT_MALFORMED",
        "not a recognisable plugin export document",
    )
}

/// Base tables of the plugin schema, the `_`-prefixed bookkeeping excluded.
async fn tables(c: &impl GenericClient, s: &str) -> Result<Vec<String>, tokio_postgres::Error> {
    let rows = c
        .query(
            "SELECT table_name::text FROM information_schema.tables
              WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
            &[&s],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| r.get::<_, String>(0))
        .filter(|t| !t.starts_with('_'))
        .collect())
}

/// Writable columns: generated ones are skipped, the dropped ones never listed.
async fn columns(
    c: &impl GenericClient,
    s: &str,
    t: &str,
) -> Result<BTreeSet<String>, tokio_postgres::Error> {
    let rows = c
        .query(
            "SELECT a.attname::text FROM pg_attribute a
              WHERE a.attrelid = ($1::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                AND a.attgenerated = ''",
            &[&format!("{}.{}", quote(s), quote(t))],
        )
        .await?;
    Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
}

/// Parents first by the schema's own foreign keys; on a cycle the first remaining table goes next.
async fn fk_order(
    c: &impl GenericClient,
    s: &str,
    names: &[String],
) -> Result<Vec<String>, tokio_postgres::Error> {
    let rows = c
        .query(
            "SELECT cl.relname::text, fcl.relname::text FROM pg_constraint con
               JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
               JOIN pg_class fcl ON fcl.oid = con.confrelid JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
              WHERE con.contype = 'f' AND ns.nspname = $1 AND fns.nspname = $1",
            &[&s],
        )
        .await?;
    let mut deps: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for r in &rows {
        let (child, parent): (String, String) = (r.get(0), r.get(1));
        if child != parent && names.contains(&child) && names.contains(&parent) {
            deps.entry(child).or_default().insert(parent);
        }
    }
    let mut out: Vec<String> = vec![];
    let mut left: Vec<&String> = names.iter().collect();
    while !left.is_empty() {
        let ready = left.iter().position(|n| {
            deps.get(*n)
                .is_none_or(|ps| ps.iter().all(|p| out.contains(p)))
        });
        out.push(left.remove(ready.unwrap_or(0)).clone());
    }
    Ok(out)
}

impl Plugins {
    async fn owned_settings(&self, id: &str) -> sqlx::Result<Map<String, Value>> {
        let ids = super::imports::installed_ids(&self.db).await?;
        let rows: Vec<(String, Option<String>)> =
            sqlx::query_as(r#"SELECT "key"::text, "value" FROM app_settings WHERE starts_with("key", $1) ORDER BY "key""#)
                .bind(format!("plugin.{id}."))
                .fetch_all(&self.db)
                .await?;
        Ok(rows
            .into_iter()
            .filter(|(k, _)| {
                fliks_domain::plugins::setting_owner(k, ids.iter().map(String::as_str)) == Some(id)
            })
            .map(|(k, v)| (k, v.map_or(Value::Null, Value::String)))
            .collect())
    }

    fn has_schema(m: &Value) -> bool {
        m["kind"] == "process" && m["database"]["schema"] == Value::Bool(true)
    }

    /// The live plugin's role pool, else one opened for this call (provisioning rotates the password).
    async fn role_db(&self, pkg: &Package) -> Result<Arc<PluginDb>, InstallError> {
        if let Some(db) = self.rt(&pkg.plugin_id).and_then(|r| r.sh.db.clone()) {
            return Ok(db);
        }
        let host = self.host().map_err(|e| internal(e.to_string()))?;
        let refs: Vec<String> = pkg.manifest["database"]["coreRefs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        self.open_db(&host, &pkg.plugin_id, &refs, 1)
            .await
            .map_err(|f| internal(format!("{}: {}", f.reason, f.detail)))
    }

    pub async fn export(&self, id: &str) -> Result<Value, InstallError> {
        let pkg = self.find_installed(id).await?;
        let mut out = Map::new();
        if Self::has_schema(&pkg.manifest) {
            let db = self.role_db(&pkg).await?;
            let mut session = db.session().await.map_err(|e| internal(e.message))?;
            // One snapshot for every table.
            let tx = session
                .client()
                .build_transaction()
                .isolation_level(IsolationLevel::RepeatableRead)
                .read_only(true)
                .start()
                .await
                .map_err(internal)?;
            let s = schema(id);
            for t in tables(&tx, &s).await.map_err(internal)? {
                let pk = tx
                    .query(
                        "SELECT a.attname::text FROM pg_index i
                           CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                          WHERE i.indrelid = ($1::text)::regclass AND i.indisprimary ORDER BY k.ord",
                        &[&format!("{}.{}", quote(&s), quote(&t))],
                    )
                    .await
                    .map_err(internal)?;
                let order = if pk.is_empty() {
                    String::new()
                } else {
                    let cols: Vec<String> = pk
                        .iter()
                        .map(|r| format!("r.{}", quote(&r.get::<_, String>(0))))
                        .collect();
                    format!(" ORDER BY {}", cols.join(", "))
                };
                let rows = tx
                    .query(
                        &format!(
                            "SELECT to_jsonb(r) FROM {}.{} r{order}",
                            quote(&s),
                            quote(&t)
                        ),
                        &[],
                    )
                    .await
                    .map_err(internal)?;
                out.insert(
                    t,
                    Value::Array(rows.iter().map(|r| r.get::<_, Value>(0)).collect()),
                );
            }
            tx.commit().await.map_err(internal)?;
        }
        Ok(json!({
            "formatVersion": 1,
            "pluginId": id,
            "pluginVersion": pkg.version,
            "exportedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "settings": self.owned_settings(id).await.map_err(internal)?,
            "tables": out,
        }))
    }

    /// Rule 54: every check before any write; the rows in one transaction as the plugin's role.
    pub async fn import(&self, id: &str, doc: &Value) -> Result<Value, InstallError> {
        let ok = doc["formatVersion"] == json!(1)
            && doc["pluginId"].is_string()
            && doc["pluginVersion"].is_string()
            && doc["settings"]
                .as_object()
                .is_some_and(|s| s.values().all(|v| v.is_null() || v.is_string()))
            && doc["tables"]
                .as_object()
                .is_some_and(|t| t.values().all(Value::is_array));
        if !ok {
            return Err(malformed());
        }
        let doc_id = doc["pluginId"].as_str().unwrap_or_default();
        if doc_id != id {
            return Err(ie(
                StatusCode::BAD_REQUEST,
                "PLUGIN_EXPORT_ID_MISMATCH",
                format!("export is for \"{doc_id}\", not \"{id}\""),
            ));
        }
        let st = self
            .app()
            .ok_or_else(|| internal("no application state"))?
            .clone();
        // C112: no restore may replay under an import, nor a second import run beside it.
        let _claim = st
            .jobs
            .claim(&format!("plugin-import:{id}"))
            .ok_or_else(|| {
                ie(
                    StatusCode::CONFLICT,
                    "PLUGIN_BUSY",
                    format!("plugin \"{id}\" is busy: a restore or another import is running"),
                )
            })?;
        let _l = self.lock(id).await;
        let pkg = self.find_installed(id).await?;
        if pkg.status != "active" {
            return Err(ie(
                StatusCode::CONFLICT,
                "PLUGIN_NOT_READY",
                format!(
                    "plugin \"{id}\" has not completed activation — its schema may not be migrated yet"
                ),
            ));
        }
        let doc_version = doc["pluginVersion"].as_str().unwrap_or_default();
        if doc_version != pkg.version {
            return Err(ie(
                StatusCode::CONFLICT,
                "PLUGIN_EXPORT_VERSION_MISMATCH",
                format!(
                    "export is from version {doc_version}, installed version is {} — install {doc_version} before importing",
                    pkg.version
                ),
            ));
        }
        let has = Self::has_schema(&pkg.manifest);
        let tables_doc = doc["tables"].as_object().expect("checked");
        let settings = doc["settings"].as_object().expect("checked");
        if !has && !tables_doc.is_empty() {
            return Err(ie(
                StatusCode::CONFLICT,
                "PLUGIN_EXPORT_HAS_NO_SCHEMA",
                format!(
                    "export carries table rows but plugin \"{id}\" declares no schema to restore them into"
                ),
            ));
        }
        let ids = super::imports::installed_ids(&self.db)
            .await
            .map_err(internal)?;
        let owned = |k: &str| {
            fliks_domain::plugins::setting_owner(k, ids.iter().map(String::as_str)) == Some(id)
        };
        if let Some(k) = settings.keys().find(|k| !owned(k)) {
            return Err(ie(
                StatusCode::BAD_REQUEST,
                "PLUGIN_EXPORT_SETTING_OUT_OF_SCOPE",
                format!(
                    "setting {} is outside plugin \"{id}\"'s namespace",
                    Value::String(k.clone())
                ),
            ));
        }
        let mut counts = Map::new();
        let entries: Vec<(String, Option<String>)> = settings
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned)))
            .collect();
        let mut core_tx = st.db.begin().await.map_err(internal)?;
        for (k, v) in &entries {
            crate::settings::set_in(&mut core_tx, k, v.as_deref())
                .await
                .map_err(internal)?;
        }
        if has {
            let db = self.role_db(&pkg).await?;
            let mut session = db.session().await.map_err(|e| internal(e.message))?;
            let tx = session.client().transaction().await.map_err(internal)?;
            let s = schema(id);
            let known = tables(&tx, &s).await.map_err(internal)?;
            for t in &known {
                // Re-checked under the lock, so nothing lands between the check and the inserts.
                tx.batch_execute(&format!(
                    "LOCK TABLE {}.{} IN EXCLUSIVE MODE",
                    quote(&s),
                    quote(t)
                ))
                .await
                .map_err(internal)?;
                let any = tx
                    .query_opt(
                        &format!("SELECT 1 FROM {}.{} LIMIT 1", quote(&s), quote(t)),
                        &[],
                    )
                    .await
                    .map_err(internal)?;
                if any.is_some() {
                    return Err(ie(
                        StatusCode::CONFLICT,
                        "PLUGIN_SCHEMA_NOT_EMPTY",
                        format!(
                            "plugin \"{id}\" already has rows in its schema — uninstall and reinstall it before importing"
                        ),
                    ));
                }
            }
            for (t, rows) in tables_doc {
                if !known.contains(t) {
                    return Err(malformed());
                }
                let c = columns(&tx, &s, t).await.map_err(internal)?;
                for r in rows.as_array().expect("checked") {
                    let Some(r) = r.as_object() else {
                        return Err(malformed());
                    };
                    if r.keys().any(|k| !c.contains(k)) {
                        return Err(malformed());
                    }
                }
                counts.insert(t.clone(), json!(rows.as_array().map_or(0, Vec::len)));
            }
            let names: Vec<String> = tables_doc.keys().cloned().collect();
            for t in fk_order(&tx, &s, &names).await.map_err(internal)? {
                let target = format!("{}.{}", quote(&s), quote(&t));
                for r in tables_doc[&t].as_array().expect("checked") {
                    let r = r.as_object().expect("checked");
                    if r.is_empty() {
                        continue;
                    }
                    let list = r.keys().map(|k| quote(k)).collect::<Vec<_>>().join(", ");
                    tx.execute(
                        &format!(
                            "INSERT INTO {target} ({list}) OVERRIDING SYSTEM VALUE
                             SELECT {list} FROM jsonb_populate_record(NULL::{target}, $1)"
                        ),
                        &[&Value::Object(r.clone())],
                    )
                    .await
                    .map_err(internal)?;
                }
                let serials = tx
                    .query(
                        "SELECT column_name::text FROM information_schema.columns
                          WHERE table_schema = $1 AND table_name = $2
                            AND pg_get_serial_sequence(quote_ident($1) || '.' || quote_ident($2), column_name) IS NOT NULL",
                        &[&s, &t],
                    )
                    .await
                    .map_err(internal)?;
                for c in serials.iter().map(|r| r.get::<_, String>(0)) {
                    tx.execute(
                        &format!(
                            "SELECT setval(pg_get_serial_sequence(quote_ident($1) || '.' || quote_ident($2), $3),
                               (SELECT COALESCE(MAX({}), 0) + 1 FROM {target}), false)",
                            quote(&c)
                        ),
                        &[&s, &t, &c],
                    )
                    .await
                    .map_err(internal)?;
                }
            }
            tx.commit().await.map_err(internal)?;
        }
        // The rows commit first: the settings alone are cheap to rewrite, a half-restored schema is not.
        core_tx.commit().await.map_err(internal)?;
        let keys: Vec<String> = entries.iter().map(|(k, _)| k.clone()).collect();
        crate::settings::notify_changed(&st, &keys, Some(&format!("plugin-import:{id}"))).await;
        Ok(json!({"pluginId": id, "tablesRestored": counts, "settingsRestored": entries.len()}))
    }
}
