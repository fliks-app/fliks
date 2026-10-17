//! Plugin export and import (`plugins.md` rules 53-54, C102, C103).
use super::Plugins;
use super::db::schema;
use super::install::{InstallError, ie};
use axum::http::StatusCode;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn quote(i: &str) -> String {
    format!("\"{}\"", i.replace('"', "\"\""))
}

fn internal(e: sqlx::Error) -> InstallError {
    ie(
        StatusCode::INTERNAL_SERVER_ERROR,
        "PLUGIN_DB_PROVISION_FAILED",
        e.to_string(),
    )
}

fn malformed() -> InstallError {
    ie(
        StatusCode::BAD_REQUEST,
        "PLUGIN_EXPORT_MALFORMED",
        "not a recognisable plugin export document",
    )
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

    /// Base tables of the plugin schema, the `_`-prefixed bookkeeping excluded.
    async fn tables(&self, id: &str) -> sqlx::Result<Vec<String>> {
        let all: Vec<String> = sqlx::query_scalar(
            "SELECT table_name::text FROM information_schema.tables
              WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
        )
        .bind(schema(id))
        .fetch_all(&self.db)
        .await?;
        Ok(all.into_iter().filter(|t| !t.starts_with('_')).collect())
    }

    fn has_schema(m: &Value) -> bool {
        m["kind"] == "process" && m["database"]["schema"] == Value::Bool(true)
    }

    pub async fn export(&self, id: &str) -> Result<Value, InstallError> {
        let pkg = self.find_installed(id).await?;
        let mut tables = Map::new();
        if Self::has_schema(&pkg.manifest) {
            for t in self.tables(id).await.map_err(internal)? {
                let pk: Vec<String> = sqlx::query_scalar(
                    "SELECT a.attname::text FROM pg_index i
                       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                      WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary ORDER BY a.attnum",
                )
                .bind(quote(&schema(id)))
                .bind(quote(&t))
                .fetch_all(&self.db)
                .await
                .map_err(internal)?;
                let order = if pk.is_empty() {
                    String::new()
                } else {
                    format!(
                        " ORDER BY {}",
                        pk.iter()
                            .map(|c| format!("r.{}", quote(c)))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                };
                let rows: Vec<Value> = sqlx::query_scalar(&format!(
                    "SELECT to_jsonb(r) FROM {}.{} r{order}",
                    quote(&schema(id)),
                    quote(&t)
                ))
                .fetch_all(&self.db)
                .await
                .map_err(internal)?;
                tables.insert(t, Value::Array(rows));
            }
        }
        Ok(json!({
            "formatVersion": 1,
            "pluginId": id,
            "pluginVersion": pkg.version,
            "exportedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "settings": self.owned_settings(id).await.map_err(internal)?,
            "tables": tables,
        }))
    }

    async fn columns(&self, id: &str, table: &str) -> sqlx::Result<BTreeSet<String>> {
        let c: Vec<String> = sqlx::query_scalar(
            "SELECT column_name::text FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2",
        )
        .bind(schema(id))
        .bind(table)
        .fetch_all(&self.db)
        .await?;
        Ok(c.into_iter().collect())
    }

    /// Parents first by the schema's own foreign keys; a cycle keeps the document's order.
    async fn fk_order(&self, id: &str, names: &[String]) -> sqlx::Result<Vec<String>> {
        let edges: Vec<(String, String)> = sqlx::query_as(
            "SELECT cl.relname::text, fcl.relname::text FROM pg_constraint con
               JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
               JOIN pg_class fcl ON fcl.oid = con.confrelid JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
              WHERE con.contype = 'f' AND ns.nspname = $1 AND fns.nspname = $1",
        )
        .bind(schema(id))
        .fetch_all(&self.db)
        .await?;
        let mut deps: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
        for (child, parent) in &edges {
            if names.contains(child) && names.contains(parent) {
                deps.entry(child.as_str())
                    .or_default()
                    .insert(parent.as_str());
            }
        }
        let mut out: Vec<String> = vec![];
        let mut left: Vec<&String> = names.iter().collect();
        while !left.is_empty() {
            let pos = left.iter().position(|n| {
                deps.get(n.as_str())
                    .is_none_or(|ps| ps.iter().all(|p| out.iter().any(|o| o == p)))
            });
            match pos {
                Some(i) => out.push(left.remove(i).clone()),
                None => {
                    out.extend(left.into_iter().cloned());
                    break;
                }
            }
        }
        Ok(out)
    }

    /// Rule 54: every check before any write; one transaction for the tables.
    pub async fn import(&self, id: &str, doc: &Value) -> Result<Value, InstallError> {
        let o = doc.as_object().ok_or_else(malformed)?;
        let ok = doc["formatVersion"] == json!(1)
            && doc["pluginId"].is_string()
            && doc["pluginVersion"].is_string()
            && doc["settings"]
                .as_object()
                .is_some_and(|s| s.values().all(|v| v.is_null() || v.is_string()))
            && doc["tables"]
                .as_object()
                .is_some_and(|t| t.values().all(Value::is_array));
        if !ok || o.is_empty() {
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
        let tables = doc["tables"].as_object().expect("checked");
        let settings = doc["settings"].as_object().expect("checked");
        if has {
            for t in self.tables(id).await.map_err(internal)? {
                let any: Option<i32> = sqlx::query_scalar(&format!(
                    "SELECT 1 FROM {}.{} LIMIT 1",
                    quote(&schema(id)),
                    quote(&t)
                ))
                .fetch_optional(&self.db)
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
        } else if !tables.is_empty() {
            return Err(ie(
                StatusCode::CONFLICT,
                "PLUGIN_EXPORT_HAS_NO_SCHEMA",
                format!(
                    "export carries table rows but plugin \"{id}\" declares no schema to restore them into"
                ),
            ));
        }
        let prefix = format!("plugin.{id}.");
        if let Some(k) = settings.keys().find(|k| !k.starts_with(&prefix)) {
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
        if has {
            let known: BTreeSet<String> = self
                .tables(id)
                .await
                .map_err(internal)?
                .into_iter()
                .collect();
            let mut cols = BTreeMap::new();
            for (t, rows) in tables {
                if !known.contains(t) {
                    return Err(malformed());
                }
                let c = self.columns(id, t).await.map_err(internal)?;
                for r in rows.as_array().expect("checked") {
                    let Some(r) = r.as_object() else {
                        return Err(malformed());
                    };
                    if r.keys().any(|k| !c.contains(k)) {
                        return Err(malformed());
                    }
                }
                cols.insert(t.clone(), c);
                counts.insert(t.clone(), json!(rows.as_array().map_or(0, Vec::len)));
            }
            let names: Vec<String> = tables.keys().cloned().collect();
            let order = self.fk_order(id, &names).await.map_err(internal)?;
            let mut tx = self.db.begin().await.map_err(internal)?;
            let s = quote(&schema(id));
            for t in &order {
                for r in tables[t].as_array().expect("checked") {
                    let r = r.as_object().expect("checked");
                    if r.is_empty() {
                        continue;
                    }
                    let list = r.keys().map(|k| quote(k)).collect::<Vec<_>>().join(", ");
                    sqlx::query(&format!(
                        "INSERT INTO {s}.{t} ({list}) SELECT {list} FROM jsonb_populate_record(NULL::{s}.{t}, $1)",
                        t = quote(t)
                    ))
                    .bind(Value::Object(r.clone()))
                    .execute(&mut *tx)
                    .await
                    .map_err(internal)?;
                }
                let serials: Vec<String> = sqlx::query_scalar(
                    "SELECT column_name::text FROM information_schema.columns
                      WHERE table_schema = $1 AND table_name = $2
                        AND pg_get_serial_sequence(quote_ident($1) || '.' || quote_ident($2), column_name) IS NOT NULL",
                )
                .bind(schema(id))
                .bind(t)
                .fetch_all(&mut *tx)
                .await
                .map_err(internal)?;
                for c in serials {
                    sqlx::query(&format!(
                        "SELECT setval(pg_get_serial_sequence(quote_ident($1) || '.' || quote_ident($2), $3),
                           (SELECT COALESCE(MAX({}), 0) + 1 FROM {s}.{}), false)",
                        quote(&c),
                        quote(t)
                    ))
                    .bind(schema(id))
                    .bind(t)
                    .bind(&c)
                    .execute(&mut *tx)
                    .await
                    .map_err(internal)?;
                }
            }
            tx.commit().await.map_err(internal)?;
        }
        let entries: Vec<(String, Option<String>)> = settings
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned)))
            .collect();
        if let Some(st) = self.app() {
            crate::settings::write(st, &entries, Some(&format!("plugin-import:{id}")))
                .await
                .map_err(internal)?;
        }
        Ok(json!({"pluginId": id, "tablesRestored": counts, "settingsRestored": entries.len()}))
    }
}
