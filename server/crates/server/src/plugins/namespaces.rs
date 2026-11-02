//! `provider_namespaces`: who owns a plugin namespace, and what goes with it (`provider-plugins.md` 5.1).
use serde_json::Value;
use sqlx::PgPool;

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

/// Records the namespaces on first activation; later ones refresh label, pattern and case.
/// `Err(name)` when another signer holds `name` (nothing is written).
pub async fn claim(
    db: &PgPool,
    plugin_id: &str,
    signer: Option<&str>,
    list: &[Declared<'_>],
) -> sqlx::Result<Result<(), String>> {
    let mut tx = db.begin().await?;
    for n in list {
        let held: Option<String> = sqlx::query_scalar(
            r#"INSERT INTO provider_namespaces (name, "pluginId", "signerKeyId", "idPattern", "case", label)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (name) DO UPDATE
                 SET "idPattern" = EXCLUDED."idPattern", "case" = EXCLUDED."case", label = EXCLUDED.label
                 WHERE provider_namespaces."signerKeyId" IS NOT DISTINCT FROM EXCLUDED."signerKeyId"
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
    Ok(Ok(()))
}

/// `DELETE /api/plugins/:id?deleteData=true`: the plugin's namespaces and every id, snapshot and
/// source under them, in one transaction. An unfinished request on such an id fails with
/// `provider-removed`; a finished one keeps its row.
pub async fn delete_data(db: &PgPool, plugin_id: &str) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    let names: Vec<String> =
        sqlx::query_scalar(r#"SELECT name FROM provider_namespaces WHERE "pluginId" = $1"#)
            .bind(plugin_id)
            .fetch_all(&mut *tx)
            .await?;
    if names.is_empty() {
        return tx.commit().await;
    }
    sqlx::query(
        r#"UPDATE requests SET status = 'failed', "declinedReason" = 'provider-removed'
           WHERE provider = ANY($1) AND status IN ('pending', 'approved', 'processing')"#,
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
        r#"UPDATE seasons SET "preferredProvider" = NULL WHERE "preferredProvider" = ANY($1)"#,
        "DELETE FROM provider_namespaces WHERE name = ANY($1)",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(q))
            .bind(&names)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}
