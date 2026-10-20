//! Plugin export and import (`plugins.md` rules 53-54, C102, C103), under `SET LOCAL ROLE` of the
//! plugin's role: its triggers, defaults and policies are plugin code and stay in the rule-35 sandbox.
use super::Plugins;
use super::db::{database_oid, role, schema};
use super::install::{InstallError, ie};
use axum::{body::Body, body::Bytes, http::StatusCode};
use futures_util::{TryStreamExt, stream};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use std::collections::{BTreeMap, BTreeSet};

fn quote(i: &str) -> String {
    format!("\"{}\"", i.replace('"', "\"\""))
}

fn internal(e: impl std::fmt::Display) -> InstallError {
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

/// Base tables of the plugin schema, the `_`-prefixed bookkeeping excluded.
async fn tables(c: &mut PgConnection, s: &str) -> sqlx::Result<Vec<String>> {
    let all: Vec<String> = sqlx::query_scalar(
        "SELECT table_name::text FROM information_schema.tables
          WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
    )
    .bind(s)
    .fetch_all(&mut *c)
    .await?;
    Ok(all.into_iter().filter(|t| !t.starts_with('_')).collect())
}

/// Writable columns: generated ones are skipped, the dropped ones never listed.
async fn columns(c: &mut PgConnection, s: &str, t: &str) -> sqlx::Result<BTreeSet<String>> {
    let cols: Vec<String> = sqlx::query_scalar(
        "SELECT a.attname::text FROM pg_attribute a
          WHERE a.attrelid = ($1::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attgenerated = ''",
    )
    .bind(format!("{}.{}", quote(s), quote(t)))
    .fetch_all(&mut *c)
    .await?;
    Ok(cols.into_iter().collect())
}

/// Parents first by the schema's own foreign keys; on a cycle the first remaining table goes next.
async fn fk_order(c: &mut PgConnection, s: &str, names: &[String]) -> sqlx::Result<Vec<String>> {
    let edges: Vec<(String, String)> = sqlx::query_as(
        "SELECT cl.relname::text, fcl.relname::text FROM pg_constraint con
           JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
           JOIN pg_class fcl ON fcl.oid = con.confrelid JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
          WHERE con.contype = 'f' AND ns.nspname = $1 AND fns.nspname = $1",
    )
    .bind(s)
    .fetch_all(&mut *c)
    .await?;
    let mut deps: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (child, parent) in edges {
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

const CHUNK: usize = 64 * 1024;

type Out = tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>;

fn body(rx: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>) -> Body {
    Body::from_stream(stream::unfold(rx, |mut rx| async {
        rx.recv().await.map(|v| (v, rx))
    }))
}

/// The `tables` object of an export, a chunk at a time; `Err` when the client is gone.
async fn write_tables(
    tx: &mut PgConnection,
    s: &str,
    names: &[String],
    head: String,
    out: &Out,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut buf = head.into_bytes();
    for (i, t) in names.iter().enumerate() {
        let pk: Vec<String> = sqlx::query_scalar(
            "SELECT a.attname::text FROM pg_index i
               CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
              WHERE i.indrelid = ($1::text)::regclass AND i.indisprimary ORDER BY k.ord",
        )
        .bind(format!("{}.{}", quote(s), quote(t)))
        .fetch_all(&mut *tx)
        .await?;
        let order = if pk.is_empty() {
            String::new()
        } else {
            let cols: Vec<String> = pk.iter().map(|c| format!("r.{}", quote(c))).collect();
            format!(" ORDER BY {}", cols.join(", "))
        };
        buf.extend_from_slice(format!("{}{}:[", if i > 0 { "," } else { "" }, json!(t)).as_bytes());
        let sql = format!("SELECT to_jsonb(r) FROM {}.{} r{order}", quote(s), quote(t));
        let mut rows = sqlx::query_scalar::<_, Value>(&sql).fetch(&mut *tx);
        let mut first = true;
        while let Some(row) = rows.try_next().await? {
            if !first {
                buf.push(b',');
            }
            first = false;
            serde_json::to_writer(&mut buf, &row)?;
            if buf.len() >= CHUNK {
                out.send(Ok(Bytes::from(std::mem::take(&mut buf)))).await?;
            }
        }
        buf.push(b']');
    }
    buf.extend_from_slice(b"}}");
    out.send(Ok(Bytes::from(buf))).await?;
    Ok(())
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

    /// From here to the end of the transaction every statement runs as the plugin's role.
    async fn as_plugin(&self, c: &mut PgConnection, id: &str) -> Result<(), InstallError> {
        let oid = database_oid(&self.db).await.map_err(internal)?;
        sqlx::query(&format!("SET LOCAL ROLE {}", quote(&role(&oid, id))))
            .execute(c)
            .await
            .map_err(internal)
            .map(drop)
    }

    /// The export document as a stream: rows go out as they are read, one snapshot for every table.
    /// The plugin lock and the snapshot are held until the client has read it all.
    pub async fn export(&self, id: &str) -> Result<Body, InstallError> {
        let lock = self.lock(id).await;
        let pkg = self.find_installed(id).await?;
        let head = format!(
            r#"{{"exportedAt":{},"formatVersion":1,"pluginId":{},"pluginVersion":{},"settings":{},"tables":{{"#,
            json!(fliks_domain::js::iso(chrono::Utc::now())),
            json!(id),
            json!(pkg.version),
            Value::Object(self.owned_settings(id).await.map_err(internal)?),
        );
        let (out, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
        if !Self::has_schema(&pkg.manifest) {
            let _ = out.try_send(Ok(Bytes::from(format!("{head}}}}}"))));
            return Ok(body(rx));
        }
        let mut tx = self.db.begin().await.map_err(internal)?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        self.as_plugin(&mut tx, id).await?;
        let s = schema(id);
        let mut names = tables(&mut tx, &s).await.map_err(internal)?;
        names.sort();
        tokio::spawn(async move {
            let _lock = lock;
            if let Err(e) = write_tables(&mut tx, &s, &names, head, &out).await {
                let _ = out.send(Err(std::io::Error::other(e.to_string()))).await;
            }
        });
        Ok(body(rx))
    }

    /// Rule 54: every check before any write; settings and rows in one core transaction.
    pub async fn import(&self, id: &str, doc: &Value) -> Result<Value, InstallError> {
        check_document(id, doc)?;
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
        check_installed(id, doc, &pkg)?;
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
        check_setting_scope(id, settings, &ids)?;
        let mut counts = Map::new();
        let entries: Vec<(String, Option<String>)> = settings
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned)))
            .collect();
        let mut tx = st.db.begin().await.map_err(internal)?;
        for (k, v) in &entries {
            crate::settings::set_in(&mut tx, k, v.as_deref())
                .await
                .map_err(internal)?;
        }
        if has {
            counts = self.restore_tables(&mut tx, id, tables_doc).await?;
        }
        tx.commit().await.map_err(internal)?;
        let keys: Vec<String> = entries.iter().map(|(k, _)| k.clone()).collect();
        crate::settings::notify_changed(&st, &keys, Some(&format!("plugin-import:{id}"))).await;
        Ok(json!({"pluginId": id, "tablesRestored": counts, "settingsRestored": entries.len()}))
    }

    /// Every table of the document into the empty schema, in foreign-key order; returns the row counts.
    async fn restore_tables(
        &self,
        tx: &mut PgConnection,
        id: &str,
        tables_doc: &Map<String, Value>,
    ) -> Result<Map<String, Value>, InstallError> {
        let mut counts = Map::new();
        // Deferred triggers fire at commit with the role still set, so the sandbox holds there too.
        self.as_plugin(tx, id).await?;
        let s = schema(id);
        let known = tables(tx, &s).await.map_err(internal)?;
        for t in &known {
            // Re-checked under the lock, so nothing lands between the check and the inserts.
            sqlx::query(&format!(
                "LOCK TABLE {}.{} IN EXCLUSIVE MODE",
                quote(&s),
                quote(t)
            ))
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
            let any: Option<i32> =
                sqlx::query_scalar(&format!("SELECT 1 FROM {}.{} LIMIT 1", quote(&s), quote(t)))
                    .fetch_optional(&mut *tx)
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
            let c = columns(tx, &s, t).await.map_err(internal)?;
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
        for t in fk_order(tx, &s, &names).await.map_err(internal)? {
            let target = format!("{}.{}", quote(&s), quote(&t));
            for r in tables_doc[&t].as_array().expect("checked") {
                let r = r.as_object().expect("checked");
                if r.is_empty() {
                    continue;
                }
                let list = r.keys().map(|k| quote(k)).collect::<Vec<_>>().join(", ");
                sqlx::query(&format!(
                    "INSERT INTO {target} ({list}) OVERRIDING SYSTEM VALUE
                     SELECT {list} FROM jsonb_populate_record(NULL::{target}, $1)"
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
            .bind(&s)
            .bind(&t)
            .fetch_all(&mut *tx)
            .await
            .map_err(internal)?;
            for c in serials {
                sqlx::query(&format!(
                    "SELECT setval(pg_get_serial_sequence(quote_ident($1) || '.' || quote_ident($2), $3),
                       (SELECT COALESCE(MAX({}), 0) + 1 FROM {target}), false)",
                    quote(&c)
                ))
                .bind(&s)
                .bind(&t)
                .bind(&c)
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
            }
        }
        Ok(counts)
    }
}

fn check_document(id: &str, doc: &Value) -> Result<(), InstallError> {
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
    Ok(())
}

fn check_installed(
    id: &str,
    doc: &Value,
    pkg: &crate::plugins::Package,
) -> Result<(), InstallError> {
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
    Ok(())
}

fn check_setting_scope(
    id: &str,
    settings: &Map<String, Value>,
    ids: &[String],
) -> Result<(), InstallError> {
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
    Ok(())
}
