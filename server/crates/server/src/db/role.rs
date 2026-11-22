//! The application's own database role: what it needs, what is missing, and `fliks-server db-role`,
//! which gives a superuser install's objects to a non-superuser role (`system.md` rule 41).
use crate::config::Config;
use sqlx::{ConnectOptions, Connection, PgConnection, postgres::PgConnectOptions};
use std::time::{Duration, Instant};

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Default name of the application role in the shipped files.
pub const DEFAULT_APP_ROLE: &str = "fliks_app";

/// Longest wait for the admin connection: a fresh Postgres refuses connections while it initialises.
const ADMIN_CONNECT_WAIT: Duration = Duration::from_secs(60);

/// Predicate: the owner `o` of an object in schema `n` is neither the role (`@APP@`) nor a plugin's.
const OWES: &str = r"(o.rolname::text <> @APP@ AND NOT (n.nspname LIKE 'plugin\_%'
    AND (o.rolname LIKE 'fp\_%' OR o.rolname LIKE 'plugin\_%')))";

/// Rows `(ord, kind, name, q)`: one `ALTER ... OWNER TO @APP@` per object of `public` and the plugin
/// schemas that the core side still owns. Extension members follow their extension and are skipped.
const OBJECTS: &str = r"SELECT ord, kind, name, q FROM (
  SELECT 0 AS ord, 'schema' AS kind, n.nspname::text AS name,
         format('ALTER SCHEMA %I OWNER TO %I', n.nspname, @APP@) AS q
    FROM pg_namespace n JOIN pg_roles o ON o.oid = n.nspowner
   WHERE (n.nspname = 'public' OR n.nspname LIKE 'plugin\_%') AND @OWES@
  UNION ALL
  SELECT CASE c.relkind WHEN 'S' THEN 2 ELSE 1 END, 'relation', n.nspname || '.' || c.relname,
         format('ALTER %s %I.%I OWNER TO %I',
                CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                               WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
                n.nspname, c.relname, @APP@)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles o ON o.oid = c.relowner
   WHERE (n.nspname = 'public' OR n.nspname LIKE 'plugin\_%') AND @OWES@
     AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                       AND d.objid = c.oid AND d.deptype = 'e')
     AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                       AND d.objid = c.oid AND d.deptype IN ('a', 'i') AND d.refclassid = 'pg_class'::regclass))
  UNION ALL
  SELECT 3, 'routine', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         format('ALTER %s %I.%I(%s) OWNER TO %I', CASE p.prokind WHEN 'a' THEN 'AGGREGATE' ELSE 'ROUTINE' END,
                n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), @APP@)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles o ON o.oid = p.proowner
   WHERE (n.nspname = 'public' OR n.nspname LIKE 'plugin\_%') AND @OWES@
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                       AND d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 4, 'type', n.nspname || '.' || t.typname,
         format('ALTER %s %I.%I OWNER TO %I', CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END,
                n.nspname, t.typname, @APP@)
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_roles o ON o.oid = t.typowner
   WHERE (n.nspname = 'public' OR n.nspname LIKE 'plugin\_%') AND @OWES@
     AND (t.typtype IN ('d', 'e', 'r')
          OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class k WHERE k.oid = t.typrelid AND k.relkind = 'c')))
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass
                       AND d.objid = t.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 5, 'text search', n.nspname || '.' || c.cfgname,
         format('ALTER TEXT SEARCH CONFIGURATION %I.%I OWNER TO %I', n.nspname, c.cfgname, @APP@)
    FROM pg_ts_config c JOIN pg_namespace n ON n.oid = c.cfgnamespace JOIN pg_roles o ON o.oid = c.cfgowner
   WHERE (n.nspname = 'public' OR n.nspname LIKE 'plugin\_%') AND @OWES@
  UNION ALL
  SELECT 5, 'text search', n.nspname || '.' || c.dictname,
         format('ALTER TEXT SEARCH DICTIONARY %I.%I OWNER TO %I', n.nspname, c.dictname, @APP@)
    FROM pg_ts_dict c JOIN pg_namespace n ON n.oid = c.dictnamespace JOIN pg_roles o ON o.oid = c.dictowner
   WHERE (n.nspname = 'public' OR n.nspname LIKE 'plugin\_%') AND @OWES@
  UNION ALL
  SELECT 6, 'statistics', n.nspname || '.' || c.stxname,
         format('ALTER STATISTICS %I.%I OWNER TO %I', n.nspname, c.stxname, @APP@)
    FROM pg_statistic_ext c JOIN pg_namespace n ON n.oid = c.stxnamespace JOIN pg_roles o ON o.oid = c.stxowner
   WHERE (n.nspname = 'public' OR n.nspname LIKE 'plugin\_%') AND @OWES@
  UNION ALL
  SELECT 7, 'collation', n.nspname || '.' || c.collname,
         format('ALTER COLLATION %I.%I OWNER TO %I', n.nspname, c.collname, @APP@)
    FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace JOIN pg_roles o ON o.oid = c.collowner
   WHERE (n.nspname = 'public' OR n.nspname LIKE 'plugin\_%') AND @OWES@
) x ORDER BY ord, name";

/// The advisory lock functions: core serialises on predictable keys, so plugins must not hold them.
const ADVISORY_FUNCTIONS: &str = r"SELECT p.oid::regprocedure AS f FROM pg_proc p
   WHERE p.pronamespace = 'pg_catalog'::regnamespace
     AND p.proname ~ '^pg_(try_)?advisory_(xact_)?lock(_shared)?$'";

/// Plugin roles of this database, and the 4.x `plugin_<id>` roles a registration may adopt: the ones
/// whose schema of the same name is here (the role names are cluster-wide, other databases have theirs).
const PLUGIN_ROLES: &str = r"SELECT r.rolname FROM pg_roles r
   WHERE (r.rolname LIKE 'plugin\_%' AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = r.rolname))
      OR r.rolname LIKE 'fp\_' || (SELECT lpad(to_hex(oid::bigint), 8, '0') FROM pg_database
                                    WHERE datname = current_database()) || '\_%'";

fn objects(app: &str) -> String {
    OBJECTS.replace("@OWES@", OWES).replace("@APP@", app)
}

/// `value` as a SQL string literal.
fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// The role is created, granted its database and plugin roles, and loses nothing core needs: one
/// transaction, so it either holds or leaves no trace.
fn role_sql(app: &str, verifier: &str) -> String {
    let (ident, app, pw) = (
        format!("\"{}\"", app.replace('"', "\"\"")),
        literal(app),
        literal(verifier),
    );
    format!(
        r"DO $role$
DECLARE rec record; v int := current_setting('server_version_num')::int;
BEGIN
  IF v < 150000 THEN
    RAISE EXCEPTION 'PostgreSQL 15 or newer is required (this is %)', current_setting('server_version');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {app} AND rolsuper) THEN
    RAISE EXCEPTION 'role % is a superuser: the application role must not be one', {app};
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {app}) THEN
    ALTER ROLE {ident} LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {pw};
  ELSE
    CREATE ROLE {ident} LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {pw};
  END IF;
  -- A managed server's admin is not a superuser: it must be able to give objects to the role.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF v >= 160000 THEN GRANT {ident} TO CURRENT_USER WITH SET TRUE; ELSE GRANT {ident} TO CURRENT_USER; END IF;
  END IF;
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO {ident}', current_database());
  FOR rec IN {advisory} LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', rec.f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO {ident}', rec.f);
  END LOOP;
  FOR rec IN {plugin_roles} LOOP
    IF v >= 160000 THEN
      EXECUTE format('GRANT %I TO {ident} WITH ADMIN OPTION, INHERIT TRUE, SET TRUE', rec.rolname);
    ELSE
      EXECUTE format('GRANT %I TO {ident} WITH ADMIN OPTION', rec.rolname);
    END IF;
  END LOOP;
END $role$",
        advisory = ADVISORY_FUNCTIONS,
        plugin_roles = PLUGIN_ROLES,
    )
}

/// One `ALTER ... OWNER` per commit: a busy table fails after the lock timeout, what moved stays
/// moved (a superuser ignores ownership) and the next run finishes. `COMMIT` needs a statement of its own.
fn transfer_sql(app: &str) -> String {
    format!(
        r"DO $xfer$
DECLARE rec record;
BEGIN
  SET lock_timeout = '10s';
  FOR rec IN {objects} LOOP
    EXECUTE rec.q;
    COMMIT;
  END LOOP;
  RESET lock_timeout;
END $xfer$",
        objects = objects(&literal(app)),
    )
}

/// What `--print` writes and `transfer` runs: two statements, to run one by one outside a transaction.
pub fn script(app: &str, password: &str) -> String {
    let verifier = postgres_protocol::password::scram_sha_256(password.as_bytes());
    format!(
        "-- Run each statement on its own (psql -f, never -1): the second commits per object.\n{};\n\n{};\n",
        role_sql(app, &verifier),
        transfer_sql(app)
    )
}

fn valid_role_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && !name.starts_with(|c: char| c.is_ascii_digit())
}

/// What the connected role has and lacks, read from the catalogs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Status {
    pub superuser: bool,
    pub version: i32,
    pub createrole: bool,
    pub create_database: bool,
    pub owns_public: bool,
    /// Objects of `public` and the plugin schemas owned by a role that is neither this one nor a plugin's.
    pub foreign_objects: i64,
    /// Plugins can take advisory locks, or this role cannot.
    pub advisory_open: bool,
    /// Plugin roles this role is not a member of.
    pub unmanaged_roles: i64,
}

impl Status {
    /// Health's `dbGaps` codes: what a non-superuser role is missing. Empty for a superuser.
    pub fn gaps(&self) -> Vec<&'static str> {
        if self.superuser {
            return vec![];
        }
        [
            (!self.createrole, "create_role"),
            (!self.create_database, "create_database"),
            (!self.owns_public, "public_owner"),
            (self.foreign_objects > 0, "foreign_objects"),
            (self.advisory_open, "advisory_locks"),
            (self.unmanaged_roles > 0, "plugin_roles"),
        ]
        .into_iter()
        .filter_map(|(gap, code)| gap.then_some(code))
        .collect()
    }

    /// A non-superuser role on a Postgres where `CREATEROLE` still reaches the host (15).
    pub fn limited(&self) -> bool {
        !self.superuser && self.version < 160_000
    }

    /// A non-superuser role with nothing missing.
    pub fn ready(&self) -> bool {
        !self.superuser && self.gaps().is_empty()
    }
}

pub async fn status<'c>(e: impl sqlx::PgExecutor<'c>) -> sqlx::Result<Status> {
    let sql = format!(
        r"SELECT r.rolsuper, current_setting('server_version_num')::int, r.rolcreaterole,
       has_database_privilege(current_user, current_database(), 'CREATE'),
       coalesce((SELECT nspowner = r.oid FROM pg_namespace WHERE nspname = 'public'), false),
       (SELECT count(*) FROM ({objects}) o WHERE o.name <> 'public'),
       coalesce((SELECT bool_or(p.proacl IS NULL
                                OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                                            WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                                OR NOT has_function_privilege(current_user, p.oid, 'EXECUTE'))
                   FROM pg_proc p WHERE p.pronamespace = 'pg_catalog'::regnamespace
                    AND p.proname ~ '^pg_(try_)?advisory_(xact_)?lock(_shared)?$'), false),
       (SELECT count(*) FROM ({plugin_roles}) pr
         WHERE NOT pg_has_role(current_user, pr.rolname, 'MEMBER'))
  FROM pg_roles r WHERE r.rolname = current_user",
        objects = objects("current_user::text"),
        plugin_roles = PLUGIN_ROLES,
    );
    let row: (bool, i32, bool, bool, bool, i64, bool, i64) =
        sqlx::query_as(sqlx::AssertSqlSafe(sql))
            .fetch_one(e)
            .await?;
    Ok(Status {
        superuser: row.0,
        version: row.1,
        createrole: row.2,
        create_database: row.3,
        owns_public: row.4,
        foreign_objects: row.5,
        advisory_open: row.6,
        unmanaged_roles: row.7,
    })
}

/// Boot line: a superuser is noted, a non-superuser role with gaps is warned about, never refused.
pub fn log(s: &Status) {
    if s.superuser {
        tracing::info!(
            "the application connects as a PostgreSQL superuser; `fliks-server db-role` gives it a role of its own"
        );
        return;
    }
    let gaps = s.gaps();
    if !gaps.is_empty() {
        tracing::warn!(
            "the database role is missing: {}; run `fliks-server db-role` as the database admin",
            gaps.join(", ")
        );
    }
    if s.limited() {
        tracing::warn!(
            "PostgreSQL {} lets a role with CREATEROLE reach the host: use 16 or newer for the role's isolation",
            s.version / 10_000
        );
    }
}

/// Gives the objects of the connected database to `app`, as the admin on `conn`.
pub async fn transfer(conn: &mut PgConnection, app: &str, password: &str) -> Result<(), BoxError> {
    if !valid_role_name(app) {
        return Err(
            format!("{app:?} is not a usable role name (letters, digits, underscore)").into(),
        );
    }
    let verifier = postgres_protocol::password::scram_sha_256(password.as_bytes());
    sqlx::raw_sql(sqlx::AssertSqlSafe(role_sql(app, &verifier)))
        .execute(&mut *conn)
        .await?;
    sqlx::raw_sql(sqlx::AssertSqlSafe(transfer_sql(app)))
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn connect_admin(opts: &PgConnectOptions) -> Result<PgConnection, BoxError> {
    let start = Instant::now();
    loop {
        match opts.connect().await {
            Ok(c) => return Ok(c),
            // A fresh Postgres refuses connections, or answers "starting up", for a while.
            Err(e) if retriable(&e) && start.elapsed() < ADMIN_CONNECT_WAIT => {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Err(e) => return Err(format!("cannot connect as the database admin: {e}").into()),
        }
    }
}

fn retriable(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Io(_) => true,
        sqlx::Error::Database(d) => d.code().as_deref() == Some("57P03"),
        _ => false,
    }
}

/// `fliks-server db-role [--print]` (`system.md` rule 41).
pub async fn run(cfg: &Config, print: bool) -> Result<(), BoxError> {
    let app = cfg.db.get_username().to_owned();
    let password = std::env::var("DB_PASSWORD").unwrap_or_default();
    if !valid_role_name(&app) {
        return Err(format!("DB_USERNAME {app:?} is not a usable role name").into());
    }
    if password.is_empty() || password == "fliks" {
        return Err("set DB_PASSWORD to a password of its own for the application role".into());
    }
    if print {
        print!("{}", script(&app, &password));
        return Ok(());
    }
    let admin = std::env::var("DB_ADMIN_USERNAME").unwrap_or_default();
    let admin_password = std::env::var("DB_ADMIN_PASSWORD").unwrap_or_default();
    if admin.is_empty() {
        return Err("set DB_ADMIN_USERNAME and DB_ADMIN_PASSWORD (the database superuser)".into());
    }
    if admin == app {
        return Err("DB_USERNAME must differ from DB_ADMIN_USERNAME".into());
    }
    if password == admin_password {
        return Err("DB_PASSWORD must differ from DB_ADMIN_PASSWORD".into());
    }
    if let Ok(mut c) = cfg.db.connect().await {
        let s = status(&mut c).await;
        let _ = c.close().await;
        if s.is_ok_and(|s| s.ready()) {
            tracing::info!("the database role {app} is already in place");
            return Ok(());
        }
    }
    let mut c = connect_admin(&cfg.db.clone().username(&admin).password(&admin_password)).await?;
    let superuser: bool =
        sqlx::query_scalar("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
            .fetch_one(&mut c)
            .await?;
    if !superuser {
        return Err(format!(
            "{admin} is not a superuser: run `fliks-server db-role --print` and give the SQL to the database administrator"
        )
        .into());
    }
    transfer(&mut c, &app, &password).await?;
    let _ = c.close().await;
    let mut c = cfg
        .db
        .connect()
        .await
        .map_err(|e| format!("{app} cannot log in: {e}"))?;
    let s = status(&mut c).await?;
    let _ = c.close().await;
    if !s.ready() {
        return Err(format!("the role is still missing: {}", s.gaps().join(", ")).into());
    }
    tracing::info!("the database role {app} is in place");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_carries_a_verifier_and_never_the_password() {
        let s = script("fliks_app", "s3cret-pw");
        assert!(s.contains("SCRAM-SHA-256$"));
        assert!(!s.contains("s3cret-pw"));
        assert!(s.contains("ALTER ROLE \"fliks_app\""));
        assert_eq!(s.matches("DO $").count(), 2);
    }

    #[test]
    fn role_names_are_plain_identifiers() {
        assert!(valid_role_name("fliks_app"));
        assert!(!valid_role_name("a\"b"));
        assert!(!valid_role_name("a$b"));
        assert!(!valid_role_name(""));
    }

    #[test]
    fn gaps_name_what_is_missing() {
        let ok = Status {
            version: 180_000,
            createrole: true,
            create_database: true,
            owns_public: true,
            ..Default::default()
        };
        assert!(ok.ready() && ok.gaps().is_empty());
        let bad = Status {
            createrole: false,
            owns_public: false,
            foreign_objects: 2,
            advisory_open: true,
            ..ok.clone()
        };
        assert_eq!(
            bad.gaps(),
            [
                "create_role",
                "public_owner",
                "foreign_objects",
                "advisory_locks"
            ]
        );
        let su = Status {
            superuser: true,
            ..bad
        };
        assert!(su.gaps().is_empty() && !su.ready() && !su.limited());
        assert!(
            Status {
                version: 150_000,
                ..ok
            }
            .limited()
        );
    }
}
