//! Provisioning of a plugin's role and schema: create, adopt, drop, and the foreign keys into the core.
use super::*;

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

pub(super) fn quote(ident: &str) -> String {
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
    match sqlx::Executor::execute(&mut **tx, sqlx::raw_sql(&format!("DROP ROLE {}", quote(r))))
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
        sqlx::raw_sql(&format!("REASSIGN OWNED BY {f} TO {t}; DROP OWNED BY {f}")),
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
        let unavailable = matches!(
            e,
            sqlx::Error::Io(_) | sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed
        );
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
/// Returns the freshly rotated password.
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
    let password = crate::config::random_hex(24);
    let exists = role_exists(&mut tx, &role).await?;
    if !exists {
        sqlx::Executor::execute(
            &mut *tx,
            sqlx::raw_sql(&format!("CREATE ROLE {qr} LOGIN PASSWORD '{password}'")),
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
        sqlx::raw_sql(&format!(
            "CREATE SCHEMA IF NOT EXISTS {qs} AUTHORIZATION {qr}"
        )),
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
            sqlx::raw_sql(&format!("ALTER SCHEMA {qs} OWNER TO {qr}")),
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
            sqlx::raw_sql(&format!("ALTER TABLE {qs}.{} OWNER TO {qr}", quote(&r))),
        )
        .await?;
    }
    // Core joins the role so export and import can `SET LOCAL ROLE` to it (rule 54).
    let mut sql = format!(
        "ALTER ROLE {qr} LOGIN PASSWORD '{password}';
         GRANT USAGE ON SCHEMA public TO {qr};
         REVOKE REFERENCES ON ALL TABLES IN SCHEMA public FROM {qr};
         GRANT {qr} TO CURRENT_USER;
         COMMENT ON SCHEMA {qs} IS NULL;"
    );
    for t in core_refs {
        sql.push_str(&format!(
            "GRANT REFERENCES (id) ON public.{} TO {qr};",
            quote(t)
        ));
    }
    sqlx::Executor::execute(&mut *tx, sqlx::raw_sql(&sql)).await?;
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
                sqlx::raw_sql(&format!("DROP OWNED BY {}", quote(&r))),
            )
            .await?;
        }
    }
    sqlx::Executor::execute(
        &mut *tx,
        sqlx::raw_sql(&format!(
            "DROP SCHEMA IF EXISTS {} CASCADE",
            quote(&schema(plugin_id))
        )),
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
    tx.commit().await
}

/// Uninstall without `deleteData`: the schema and its rows stay, the role stops logging in.
pub async fn orphan(core: &PgPool, plugin_id: &str) -> sqlx::Result<()> {
    let oid = database_oid(core).await?;
    let mut tx = core.begin().await?;
    let r = role(&oid, plugin_id);
    let exists = role_exists(&mut tx, &r).await?;
    if exists {
        sqlx::Executor::execute(
            &mut *tx,
            sqlx::raw_sql(&format!("ALTER ROLE {} NOLOGIN", quote(&r))),
        )
        .await?;
        sqlx::Executor::execute(
            &mut *tx,
            sqlx::raw_sql(&format!(
                "COMMENT ON SCHEMA {} IS 'orphaned: plugin uninstalled, data kept'",
                quote(&schema(plugin_id))
            )),
        )
        .await?;
    }
    tx.commit().await
}

/// After a restore (rule 44): every role the dump named that is not one of this database's.
pub async fn drop_foreign_roles(core: &PgPool, roles: &[String]) -> sqlx::Result<()> {
    let ours = format!("fp_{}_", database_oid(core).await?);
    let mut tx = core.begin().await?;
    let foreign: Vec<String> = roles
        .iter()
        .filter(|r| !r.starts_with(&ours))
        .cloned()
        .collect();
    for r in foreign {
        let exists = role_exists(&mut tx, &r).await?;
        if exists {
            sqlx::Executor::execute(
                &mut *tx,
                sqlx::raw_sql(&format!("DROP OWNED BY {}", quote(&r))),
            )
            .await?;
            drop_role_tolerant(&mut tx, &r).await?;
        }
    }
    tx.commit().await
}

/// The advisory of rule 35: foreign keys into `public` without `ON DELETE CASCADE/SET NULL`.
pub async fn unsafe_core_fks(
    core: &PgPool,
    plugin_id: &str,
) -> sqlx::Result<Vec<(String, String, String)>> {
    sqlx::query_as(
        "SELECT con.conname::text, cl.relname::text, fcl.relname::text
           FROM pg_constraint con
           JOIN pg_class cl ON cl.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cl.relnamespace
           JOIN pg_class fcl ON fcl.oid = con.confrelid
           JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
          WHERE con.contype = 'f' AND ns.nspname = $1 AND fns.nspname = 'public'
            AND con.confdeltype NOT IN ('c', 'n')
          ORDER BY con.conname",
    )
    .bind(schema(plugin_id))
    .fetch_all(core)
    .await
}
