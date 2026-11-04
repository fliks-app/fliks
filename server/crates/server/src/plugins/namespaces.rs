//! `provider_namespaces`: who owns a plugin namespace, and what goes with it (`provider-plugins.md` 5.1).
use crate::sync::RwLockExt;
use fliks_domain::external_id::{Namespace, Namespaces};
use futures_util::TryStreamExt;
use serde_json::Value;
use sqlx::PgPool;
use std::sync::{Arc, RwLock};

/// The plugin namespaces this process knows, as `provider_namespaces` holds them; a reader takes a
/// snapshot, the rare writer copies it.
#[derive(Default)]
pub struct Known(RwLock<Arc<Namespaces>>);

impl Known {
    pub fn get(&self) -> Arc<Namespaces> {
        self.0.read_clean().clone()
    }

    pub fn edit<R>(&self, f: impl FnOnce(&mut Namespaces) -> R) -> R {
        f(Arc::make_mut(&mut self.0.write_clean()))
    }
}

/// A namespace a manifest declares, as stored.
pub struct Declared<'a> {
    pub name: &'a str,
    pub label: &'a str,
    pub id_pattern: &'a str,
    pub case: &'a str,
}

/// The plugin namespaces of a `provider` block, shape already validated.
pub fn declared(block: &Value) -> Vec<Declared<'_>> {
    block["namespaces"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| n.get("idPattern").is_some())
        .filter_map(|n| {
            Some(Declared {
                name: n["name"].as_str()?,
                label: n["label"].as_str()?,
                id_pattern: n["idPattern"].as_str()?,
                case: n["case"].as_str().unwrap_or("preserve"),
            })
        })
        .collect()
}

/// Whether a package signed by `signer` may hold the namespaces `list`: free, its own, or an unsigned
/// one (a signed package takes it over, as `may_adopt` does for kept data). `Err(name)` otherwise.
pub async fn check_install(
    db: &PgPool,
    signer: Option<&str>,
    list: &[Declared<'_>],
) -> sqlx::Result<Result<(), String>> {
    let names: Vec<&str> = list.iter().map(|n| n.name).collect();
    let held: Option<String> = sqlx::query_scalar(
        r#"SELECT name FROM provider_namespaces
           WHERE name = ANY($1) AND "signerKeyId" IS NOT NULL AND "signerKeyId" IS DISTINCT FROM $2
           LIMIT 1"#,
    )
    .bind(&names)
    .bind(signer)
    .fetch_optional(db)
    .await?;
    Ok(held.map_or(Ok(()), Err))
}

/// Records the namespaces once the plugin answered `hello`, refreshing label, pattern and case;
/// `Err(name)` when another signer holds `name` (nothing is written).
pub async fn claim(
    db: &PgPool,
    known: &Known,
    plugin_id: &str,
    signer: Option<&str>,
    list: &[Declared<'_>],
) -> sqlx::Result<Result<(), String>> {
    let mut tx = db.begin().await?;
    let mut changed = vec![];
    for n in list {
        let old: Option<(String, String)> = sqlx::query_as(
            r#"SELECT "idPattern", "case" FROM provider_namespaces WHERE name = $1"#,
        )
        .bind(n.name)
        .fetch_optional(&mut *tx)
        .await?;
        if old.is_some_and(|(pattern, case)| pattern != n.id_pattern || case != n.case) {
            changed.push(n.name);
        }
        let held: Option<String> = sqlx::query_scalar(
            r#"INSERT INTO provider_namespaces (name, "pluginId", "signerKeyId", "idPattern", "case", label)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (name) DO UPDATE
                 SET "idPattern" = EXCLUDED."idPattern", "case" = EXCLUDED."case", label = EXCLUDED.label,
                     "signerKeyId" = EXCLUDED."signerKeyId"
                 WHERE provider_namespaces."signerKeyId" IS NOT DISTINCT FROM EXCLUDED."signerKeyId"
                    OR provider_namespaces."signerKeyId" IS NULL
               RETURNING name"#,
        )
        .bind(n.name)
        .bind(plugin_id)
        .bind(signer)
        .bind(n.id_pattern)
        .bind(n.case)
        .bind(n.label)
        .fetch_optional(&mut *tx)
        .await?;
        if held.is_none() {
            return Ok(Err(n.name.to_owned()));
        }
    }
    tx.commit().await?;
    known.edit(|k| {
        for n in list {
            if k.declare(n.name, n.label, n.id_pattern, n.case).is_none() {
                tracing::error!(
                    "provider namespace \"{}\" was stored but the core refuses it",
                    n.name
                );
            }
        }
    });
    let known = known.get();
    for name in changed {
        let Some(ns) = known.parse(name) else {
            continue;
        };
        match stale(db, &known, ns).await {
            Ok(0) => {}
            Ok(n) => tracing::warn!(
                "provider namespace \"{name}\": {n} stored id(s) no longer match its idPattern"
            ),
            Err(e) => tracing::warn!("provider namespace \"{name}\": stored ids not counted: {e}"),
        }
    }
    Ok(Ok(()))
}

/// How many stored ids under `ns` its rule no longer accepts as they are.
pub async fn stale(db: &PgPool, known: &Namespaces, ns: Namespace) -> sqlx::Result<usize> {
    let mut rows = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT value, count(*) FROM (
             SELECT value FROM media_external_ids WHERE provider = $1
             UNION ALL SELECT value FROM edition_external_ids WHERE provider = $1
             UNION ALL SELECT value FROM person_external_ids WHERE provider = $1
             UNION ALL SELECT value FROM collection_external_ids WHERE provider = $1) v
           GROUP BY value"#,
    )
    .bind(ns.as_str())
    .fetch(db);
    let mut n = 0;
    while let Some((v, c)) = rows.try_next().await? {
        if known.normalize(ns, &v).as_deref() != Some(v.as_str()) {
            n += c as usize;
        }
    }
    Ok(n)
}

/// Declares every stored namespace (kept ones included) so stored ids and settings parse at boot.
pub async fn load(db: &PgPool, known: &Known) -> sqlx::Result<()> {
    let rows: Vec<(String, String, String, String)> =
        sqlx::query_as(r#"SELECT name, label, "idPattern", "case" FROM provider_namespaces"#)
            .fetch_all(db)
            .await?;
    known.edit(|k| {
        for (name, label, pattern, case) in rows {
            if k.declare(&name, &label, &pattern, &case).is_none() {
                tracing::warn!("provider namespace \"{name}\" has a pattern the core refuses");
            }
        }
    });
    Ok(())
}

/// `DELETE /api/plugins/:id?deleteData=true`: the plugin's namespaces and every id, snapshot and
/// source under them, in one transaction; the process forgets them once it commits.
pub async fn delete_data(db: &PgPool, known: &Known, plugin_id: &str) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    let names: Vec<String> = sqlx::query_scalar(
        r#"SELECT name FROM provider_namespaces WHERE "pluginId" = $1 FOR UPDATE"#,
    )
    .bind(plugin_id)
    .fetch_all(&mut *tx)
    .await?;
    if names.is_empty() {
        return tx.commit().await;
    }
    sqlx::query(
        r#"UPDATE requests SET status = 'failed', "declinedReason" = 'provider-removed'
           WHERE provider = ANY($1) AND "mediaId" IS NULL
             AND status IN ('pending', 'approved', 'processing')"#,
    )
    .bind(&names)
    .execute(&mut *tx)
    .await?;
    for q in [
        "DELETE FROM media_external_ids WHERE provider = ANY($1)",
        "DELETE FROM edition_external_ids WHERE provider = ANY($1)",
        "DELETE FROM person_external_ids WHERE provider = ANY($1)",
        "DELETE FROM collection_external_ids WHERE provider = ANY($1)",
        "DELETE FROM metadata_snapshots WHERE provider = ANY($1)",
        "UPDATE media_field_sources SET provider = NULL WHERE provider = ANY($1) AND locked",
        "DELETE FROM media_field_sources WHERE provider = ANY($1)",
        "UPDATE edition_field_sources SET provider = NULL WHERE provider = ANY($1) AND locked",
        "DELETE FROM edition_field_sources WHERE provider = ANY($1)",
        "DELETE FROM discovered_works WHERE provider = ANY($1)",
        r#"UPDATE libraries SET "preferredProvider" = NULL WHERE "preferredProvider" = ANY($1)"#,
        r#"UPDATE media SET "preferredProvider" = NULL WHERE "preferredProvider" = ANY($1)"#,
        r#"UPDATE item_groups SET "preferredProvider" = NULL WHERE "preferredProvider" = ANY($1)"#,
        "DELETE FROM provider_namespaces WHERE name = ANY($1)",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(q))
            .bind(&names)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    known.edit(|k| names.iter().for_each(|n| k.forget(n)));
    Ok(())
}
