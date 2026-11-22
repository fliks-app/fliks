//! Provisioning of a plugin's role and schema: create, adopt, drop, and the foreign keys into the core.
use super::*;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use sqlx::postgres::PgConnectOptions;
use std::sync::LazyLock;

/// Key of the derived plugin passwords: one per process, never stored.
static PASSWORD_KEY: LazyLock<String> = LazyLock::new(|| crate::config::random_hex(32));

/// The login password of `role`: stable inside this process, distinct per role.
pub fn password(role: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(PASSWORD_KEY.as_bytes()).expect("hmac takes any key length");
    mac.update(role.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `ALTER ROLE`/`CREATE ROLE` clause carrying the SCRAM verifier, so no plaintext reaches the server logs.
fn password_clause(role: &str) -> String {
    format!(
        "PASSWORD '{}'",
        postgres_protocol::password::scram_sha_256(password(role).as_bytes())
    )
}

/// Connection options of the plugin's own login on the core database; the caller holds the per-id lock.
pub async fn login(core: &PgPool, plugin_id: &str) -> sqlx::Result<PgConnectOptions> {
    let role = role(&database_oid(core).await?, plugin_id);
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "ALTER ROLE {} {}",
        quote(&role),
        password_clause(&role)
    )))
    .execute(core)
    .await?;
    Ok((*core.connect_options())
        .clone()
        .username(&role)
        .password(&password(&role))
        .options([("search_path", schema(plugin_id))]))
}

/// Where plugin roles log in: the core database, as another role.
#[derive(Clone, Debug)]
pub struct PgTarget {
    pub host: String,
    pub port: u16,
    pub dbname: String,
}

/// `plugin_` + the id with `.` as `_` (ids never contain `_`, so it is injective).
pub fn schema(plugin_id: &str) -> String {
    format!("plugin_{}", plugin_id.replace('.', "_"))
}

/// `fp_<database oid as 8 hex>_<suffix>`, at most 63 bytes.
pub fn role(oid: &str, plugin_id: &str) -> String {
    format!("fp_{oid}_{}", plugin_id.replace('.', "_"))
}

/// This database's OID as the 8 lowercase hex digits of role names.
pub async fn database_oid(core: &PgPool) -> sqlx::Result<String> {
    sqlx::query_scalar(
        "SELECT lpad(to_hex(oid::bigint), 8, '0') FROM pg_database WHERE datname = current_database()",
    )
    .fetch_one(core)
    .await
}

pub fn quote(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

pub(super) fn legal_core_ref(name: &str) -> bool {
    name.len() <= 63
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c == '_')
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

pub(super) async fn role_exists(tx: &mut Tx, r: &str) -> sqlx::Result<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)")
        .bind(r)
        .fetch_one(&mut **tx)
        .await
}

/// `DROP ROLE` in a savepoint: a role another database still uses stays (`2BP01`).
pub(super) async fn drop_role_tolerant(tx: &mut Tx, r: &str) -> sqlx::Result<()> {
    sqlx::Executor::execute(&mut **tx, sqlx::raw_sql("SAVEPOINT fp_drop")).await?;
    match sqlx::Executor::execute(
        &mut **tx,
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP ROLE {}", quote(r)))),
    )
    .await
    {
        Ok(_) => sqlx::Executor::execute(&mut **tx, sqlx::raw_sql("RELEASE SAVEPOINT fp_drop"))
            .await
            .map(drop),
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("2BP01") => {
            sqlx::Executor::execute(&mut **tx, sqlx::raw_sql("ROLLBACK TO SAVEPOINT fp_drop"))
                .await
                .map(drop)
        }
        Err(e) => Err(e),
    }
}

/// Moves what `former` owns here to `to` and drops it unless another database uses it.
pub(super) async fn adopt(tx: &mut Tx, former: &str, to: &str) -> sqlx::Result<()> {
    let (f, t) = (quote(former), quote(to));
    sqlx::Executor::execute(
        &mut **tx,
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "REASSIGN OWNED BY {f} TO {t}; DROP OWNED BY {f}"
        ))),
    )
    .await?;
    drop_role_tolerant(tx, former).await
}

#[derive(Debug)]
pub struct ProvisionError {
    pub message: String,
    /// Postgres could not be reached.
    pub unavailable: bool,
}

impl ProvisionError {
    fn new(message: String) -> Self {
        Self {
            message,
            unavailable: false,
        }
    }
}

impl From<sqlx::Error> for ProvisionError {
    fn from(e: sqlx::Error) -> Self {
        let unavailable = match &e {
            sqlx::Error::Io(_) | sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed => true,
            // lock_not_available, deadlock_detected: another transaction holds the table; a retry may pass.
            sqlx::Error::Database(d) => matches!(d.code().as_deref(), Some("55P03" | "40P01")),
            _ => false,
        };
        let message = match &e {
            sqlx::Error::Database(d) => d.message().to_owned(),
            other => other.to_string(),
        };
        Self {
            message,
            unavailable,
        }
    }
}

pub(super) async fn public_create_open(tx: &mut Tx) -> sqlx::Result<bool> {
    sqlx::query_scalar("SELECT has_schema_privilege('public', 'public', 'CREATE')")
        .fetch_one(&mut **tx)
        .await
}

/// Rule 19 (3) and the SQL section: role, adoption, schema, ownership, grants; one transaction.
/// Returns the role's derived password.
pub async fn provision(
    core: &PgPool,
    plugin_id: &str,
    core_refs: &[String],
) -> Result<String, ProvisionError> {
    let mut seen = std::collections::BTreeSet::new();
    for r in core_refs {
        if !legal_core_ref(r) {
            return Err(ProvisionError::new(format!(
                "coreRef {} is not a legal table name",
                serde_json::Value::String(r.clone())
            )));
        }
        if !seen.insert(r.clone()) {
            return Err(ProvisionError::new(format!(
                "coreRef {} is declared more than once",
                serde_json::Value::String(r.clone())
            )));
        }
    }
    let oid = database_oid(core).await?;
    let (schema, role) = (schema(plugin_id), role(&oid, plugin_id));
    let suffix = plugin_id.replace('.', "_");
    let (qs, qr) = (quote(&schema), quote(&role));
    let mut tx = core.begin().await?;
    for t in core_refs {
        let kind: Option<String> = sqlx::query_scalar(
            "SELECT t.table_type::text FROM information_schema.columns c
               JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
              WHERE c.table_schema = 'public' AND c.table_name = $1 AND c.column_name = 'id'",
        )
        .bind(t)
        .fetch_optional(&mut *tx)
        .await?;
        if kind.as_deref() != Some("BASE TABLE") {
            return Err(ProvisionError::new(format!(
                "coreRef {} is not a public base table with an id column",
                serde_json::Value::String(t.clone())
            )));
        }
    }
    if public_create_open(&mut tx).await? {
        sqlx::Executor::execute(
            &mut *tx,
            sqlx::raw_sql("REVOKE CREATE ON SCHEMA public FROM PUBLIC"),
        )
        .await?;
        // A REVOKE by a non-owner only warns, so the outcome is read back.
        if public_create_open(&mut tx).await? {
            return Err(ProvisionError::new(
                "PUBLIC holds CREATE on schema public (the default before Postgres 15) and this role \
                 may not revoke it: run REVOKE CREATE ON SCHEMA public FROM PUBLIC as its owner"
                    .into(),
            ));
        }
    }
    let password = password(&role);
    let clause = password_clause(&role);
    let exists = role_exists(&mut tx, &role).await?;
    if !exists {
        sqlx::Executor::execute(
            &mut *tx,
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                "CREATE ROLE {qr} LOGIN {clause}"
            ))),
        )
        .await?;
    }
    let mut former = vec![];
    let legacy = format!("plugin_{suffix}");
    let exists = role_exists(&mut tx, &legacy).await?;
    if exists {
        former.push(legacy);
    }
    let owner: Option<String> = sqlx::query_scalar(
        "SELECT pg_get_userbyid(nspowner)::text FROM pg_namespace WHERE nspname = $1",
    )
    .bind(&schema)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(o) = &owner
        && o != &role
        && o.strip_prefix("fp_")
            .and_then(|r| r.split_once('_'))
            .is_some_and(|(hex, rest)| {
                hex.len() == 8 && hex.bytes().all(|b| b.is_ascii_hexdigit()) && rest == suffix
            })
        && !former.contains(o)
    {
        former.push(o.clone());
    }
    for f in former.clone() {
        adopt(&mut tx, &f, &role).await?;
    }
    sqlx::Executor::execute(
        &mut *tx,
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "CREATE SCHEMA IF NOT EXISTS {qs} AUTHORIZATION {qr}"
        ))),
    )
    .await?;
    let (owner, me): (String, String) = sqlx::query_as(
        "SELECT pg_get_userbyid(nspowner)::text, current_user::text FROM pg_namespace WHERE nspname = $1",
    )
    .bind(&schema)
    .fetch_one(&mut *tx)
    .await?;
    if owner == me {
        sqlx::Executor::execute(
            &mut *tx,
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                "ALTER SCHEMA {qs} OWNER TO {qr}"
            ))),
        )
        .await?;
    } else if owner != role {
        return Err(ProvisionError::new(format!(
            "schema \"{schema}\" already exists, owned by \"{owner}\""
        )));
    }
    let rels: Vec<String> = sqlx::query_scalar(
        "SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
            AND pg_get_userbyid(c.relowner) = current_user
          ORDER BY c.relkind = 'S', c.relname",
    )
    .bind(&schema)
    .fetch_all(&mut *tx)
    .await?;
    for r in rels {
        sqlx::Executor::execute(
            &mut *tx,
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                "ALTER TABLE {qs}.{} OWNER TO {qr}",
                quote(&r)
            ))),
        )
        .await?;
    }
    own_routines_and_types(&mut tx, &schema, &qs, &qr).await?;
    // Core joins the role: a non-superuser core needs it for `CREATE SCHEMA ... AUTHORIZATION` and `ALTER ... OWNER`.
    let mut sql = format!(
        "ALTER ROLE {qr} LOGIN {clause};
         GRANT USAGE ON SCHEMA public TO {qr};
         REVOKE SELECT, REFERENCES ON ALL TABLES IN SCHEMA public FROM {qr};
         GRANT {qr} TO CURRENT_USER;
         COMMENT ON SCHEMA {qs} IS NULL;"
    );
    for t in core_refs {
        sql.push_str(&format!(
            "GRANT SELECT (id) ON public.{} TO {qr};",
            quote(t)
        ));
    }
    sqlx::Executor::execute(&mut *tx, sqlx::raw_sql(sqlx::AssertSqlSafe(sql))).await?;
    revoke_advisory_locks(&mut tx, &role).await?;
    drop_core_fks(&mut tx, &schema, &qs).await?;
    tx.commit().await?;
    Ok(password)
}

/// Uninstall (rule 20): our role, a never-adopted 4.x role, the schema; tolerant of none.
pub async fn deprovision(core: &PgPool, plugin_id: &str) -> sqlx::Result<()> {
    let oid = database_oid(core).await?;
    let mut tx = core.begin().await?;
    for r in [
        role(&oid, plugin_id),
        format!("plugin_{}", plugin_id.replace('.', "_")),
    ] {
        let exists = role_exists(&mut tx, &r).await?;
        if exists {
            sqlx::Executor::execute(
                &mut *tx,
                sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP OWNED BY {}", quote(&r)))),
            )
            .await?;
        }
    }
    sqlx::Executor::execute(
        &mut *tx,
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "DROP SCHEMA IF EXISTS {} CASCADE",
            quote(&schema(plugin_id))
        ))),
    )
    .await?;
    for r in [
        role(&oid, plugin_id),
        format!("plugin_{}", plugin_id.replace('.', "_")),
    ] {
        let exists = role_exists(&mut tx, &r).await?;
        if exists {
            drop_role_tolerant(&mut tx, &r).await?;
        }
    }
    sqlx::query(r#"DELETE FROM plugin_kept_data WHERE "pluginId" = $1"#)
        .bind(plugin_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

/// What a reinstall finds of an earlier uninstall that kept the data.
#[derive(Debug, PartialEq)]
pub enum Kept {
    Nothing,
    /// The signer key id recorded at the uninstall (`None`: the package was unsigned).
    Signer(Option<String>),
    /// An orphaned schema from before signers were recorded.
    Unrecorded,
}

pub async fn kept(core: &PgPool, plugin_id: &str) -> sqlx::Result<Kept> {
    let row: Option<Option<String>> =
        sqlx::query_scalar(r#"SELECT "signerKeyId" FROM plugin_kept_data WHERE "pluginId" = $1"#)
            .bind(plugin_id)
            .fetch_optional(core)
            .await?;
    if let Some(k) = row {
        return Ok(Kept::Signer(k));
    }
    let orphaned: bool = sqlx::query_scalar(
        "SELECT coalesce((SELECT obj_description(oid, 'pg_namespace') LIKE 'orphaned:%'
                            FROM pg_namespace WHERE nspname = $1), false)",
    )
    .bind(schema(plugin_id))
    .fetch_one(core)
    .await?;
    Ok(if orphaned {
        Kept::Unrecorded
    } else {
        Kept::Nothing
    })
}

/// A reinstall adopts the kept schema only from the signer that left it (an official package may
/// adopt unsigned data); unrecorded orphans need an official package.
pub fn may_adopt(kept: &Kept, signer: Option<&str>) -> bool {
    match kept {
        Kept::Nothing => true,
        Kept::Signer(Some(k)) => signer == Some(k.as_str()),
        Kept::Signer(None) => true,
        Kept::Unrecorded => signer.is_some(),
    }
}

/// Uninstall without `deleteData`: the schema and its rows stay, the role stops logging in.
pub async fn orphan(core: &PgPool, plugin_id: &str, signer: Option<&str>) -> sqlx::Result<()> {
    let oid = database_oid(core).await?;
    let mut tx = core.begin().await?;
    let r = role(&oid, plugin_id);
    let exists = role_exists(&mut tx, &r).await?;
    if exists {
        sqlx::Executor::execute(
            &mut *tx,
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                "ALTER ROLE {} NOLOGIN",
                quote(&r)
            ))),
        )
        .await?;
        sqlx::Executor::execute(
            &mut *tx,
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                "COMMENT ON SCHEMA {} IS 'orphaned: plugin uninstalled, data kept'",
                quote(&schema(plugin_id))
            ))),
        )
        .await?;
        sqlx::query(
            r#"INSERT INTO plugin_kept_data ("pluginId", "signerKeyId") VALUES ($1, $2)
               ON CONFLICT ("pluginId") DO UPDATE SET "signerKeyId" = EXCLUDED."signerKeyId""#,
        )
        .bind(plugin_id)
        .bind(signer)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// Core serialises on predictable advisory keys, so a lock a plugin holds would stall it: plugins take none.
/// Only the owner of `pg_catalog` can revoke, so a core that is not a superuser warns once and goes on.
async fn revoke_advisory_locks(tx: &mut Tx, role: &str) -> sqlx::Result<()> {
    const OPEN: &str = r"SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'pg_catalog'::regnamespace
           AND p.proname ~ '^pg_(try_)?advisory_(xact_)?lock(_shared)?$'
           AND has_function_privilege($1, p.oid, 'EXECUTE')";
    static WARNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if sqlx::query_scalar::<_, i64>(OPEN)
        .bind(role)
        .fetch_one(&mut **tx)
        .await?
        == 0
    {
        return Ok(());
    }
    sqlx::raw_sql(
        r"DO $$ DECLARE f regprocedure; BEGIN
            FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
                      WHERE p.pronamespace = 'pg_catalog'::regnamespace
                        AND p.proname ~ '^pg_(try_)?advisory_(xact_)?lock(_shared)?$'
            LOOP EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f); END LOOP;
          END $$",
    )
    .execute(&mut **tx)
    .await?;
    let open = sqlx::query_scalar::<_, i64>(OPEN)
        .bind(role)
        .fetch_one(&mut **tx)
        .await?;
    if open > 0 && !WARNED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        tracing::warn!(
            "plugins can still take advisory locks: REVOKE EXECUTE ON the pg_advisory_*lock functions \
             FROM PUBLIC needs a superuser"
        );
    }
    Ok(())
}

/// Routines and types a `--no-owner` restore left to the core role go to the plugin's role.
async fn own_routines_and_types(tx: &mut Tx, schema: &str, qs: &str, qr: &str) -> sqlx::Result<()> {
    // A table's row type follows its table; a multirange follows its range.
    let types: Vec<(String, String)> = sqlx::query_as(
        "SELECT quote_ident(t.typname), t.typtype::text FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
           LEFT JOIN pg_class c ON c.oid = t.typrelid
          WHERE n.nspname = $1 AND t.typtype IN ('c', 'd', 'e', 'r')
            AND (t.typrelid = 0 OR c.relkind = 'c')
            AND pg_get_userbyid(t.typowner) = current_user
          ORDER BY t.typname",
    )
    .bind(schema)
    .fetch_all(&mut **tx)
    .await?;
    for (name, kind) in types {
        let what = if kind == "d" { "DOMAIN" } else { "TYPE" };
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "ALTER {what} {qs}.{name} OWNER TO {qr}"
        )))
        .execute(&mut **tx)
        .await?;
    }
    let routines: Vec<String> = sqlx::query_scalar(
        "SELECT quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND pg_get_userbyid(p.proowner) = current_user
          ORDER BY p.oid",
    )
    .bind(schema)
    .fetch_all(&mut **tx)
    .await?;
    for r in routines {
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "ALTER ROUTINE {qs}.{r} OWNER TO {qr}"
        )))
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// A foreign key from the plugin schema into `public` would run its cascade, and the plugin's AFTER and
/// deferred triggers, as the core login on a core delete: drop it, or fail naming it.
async fn drop_core_fks(tx: &mut Tx, schema: &str, qs: &str) -> Result<(), ProvisionError> {
    let fks: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT con.conname::text, cl.relname::text, fcl.relname::text
           FROM pg_constraint con
           JOIN pg_class cl ON cl.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cl.relnamespace
           JOIN pg_class fcl ON fcl.oid = con.confrelid
           JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
          WHERE con.contype = 'f' AND con.conparentid = 0 AND ns.nspname = $1 AND fns.nspname = 'public'
          ORDER BY con.conname",
    )
    .bind(schema)
    .fetch_all(&mut **tx)
    .await?;
    if fks.is_empty() {
        return Ok(());
    }
    // The drop locks the core table: wait briefly, then fail retryably instead of stalling its users.
    sqlx::Executor::execute(&mut **tx, sqlx::raw_sql("SET LOCAL lock_timeout = '5s'")).await?;
    for (con, table, target) in fks {
        let sql = format!(
            "ALTER TABLE {qs}.{} DROP CONSTRAINT {}",
            quote(&table),
            quote(&con)
        );
        sqlx::Executor::execute(&mut **tx, sqlx::raw_sql(sqlx::AssertSqlSafe(sql)))
            .await
            .map_err(|e| {
                let mut e = ProvisionError::from(e);
                e.message = format!(
                    "foreign key \"{con}\" on \"{table}\" references public.\"{target}\" and could not be dropped: {}",
                    e.message
                );
                e
            })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_are_stable_per_role_and_distinct_across_roles() {
        let a = password("fp_00000001_a");
        assert_eq!(a, password("fp_00000001_a"));
        assert_ne!(a, password("fp_00000001_b"));
        assert_eq!(a.len(), 64);
    }
}
