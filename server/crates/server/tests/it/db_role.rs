//! `fliks-server db-role`: the application role owns the core objects and can do everything core does.
//! Databases are made by the admin (the harness superuser) and owned by it, so the role holds only the grants.
use crate::fakes::skip;
use fliks_server::db::{self, role};
use fliks_server::plugins::db as plugin_db;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Connection, PgConnection, PgPool};

const PASSWORD: &str = "app-role-test-password";

struct Fixture {
    admin: PgConnectOptions,
    name: String,
    app: String,
}

impl Fixture {
    /// `owner`: the database owner (None: the admin). `migrated`: migrations run as the admin first.
    async fn create(tag: &str, owner: Option<&str>, migrated: bool) -> Option<Self> {
        let Ok(url) = std::env::var("S8_PG_ADMIN_URL") else {
            skip("S8_PG_ADMIN_URL unset");
            return None;
        };
        let admin: PgConnectOptions = url.parse().unwrap();
        let id = fliks_server::config::random_hex(4);
        let f = Fixture {
            admin,
            name: format!("dbrole_{tag}_{id}"),
            app: format!("dbrole_app_{tag}_{id}"),
        };
        let owner = owner.map_or(String::new(), |o| format!(" OWNER {o}"));
        f.exec(&format!(
            "CREATE DATABASE {}{owner} TEMPLATE template0",
            f.name
        ))
        .await;
        if migrated {
            let pool = f.pool(None).await;
            db::migrate(&pool).await.unwrap();
            pool.close().await;
        }
        Some(f)
    }

    fn options(&self, user: Option<(&str, &str)>) -> PgConnectOptions {
        let o = self.admin.clone().database(&self.name);
        match user {
            Some((u, p)) => o.username(u).password(p),
            None => o,
        }
    }

    async fn pool(&self, user: Option<(&str, &str)>) -> PgPool {
        PgPoolOptions::new()
            .max_connections(4)
            .connect_with(self.options(user))
            .await
            .unwrap()
    }

    async fn app_pool(&self) -> PgPool {
        self.pool(Some((&self.app, PASSWORD))).await
    }

    async fn exec(&self, sql: &str) {
        let mut c = PgConnection::connect_with(&self.admin).await.unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&mut c)
            .await
            .unwrap();
    }

    async fn transfer(&self) -> Result<(), String> {
        let mut c = PgConnection::connect_with(&self.options(None))
            .await
            .unwrap();
        role::transfer(&mut c, &self.app, PASSWORD)
            .await
            .map_err(|e| e.to_string())
    }

    async fn finish(self) {
        let mut c = PgConnection::connect_with(&self.admin).await.unwrap();
        for q in [
            format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.name),
            format!("DROP ROLE IF EXISTS {}", self.app),
        ] {
            sqlx::raw_sql(sqlx::AssertSqlSafe(q))
                .execute(&mut c)
                .await
                .unwrap();
        }
    }
}

async fn count(pool: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Objects of `public` (not extension members) owned by `owner`.
async fn owned_by(pool: &PgPool, owner: &str) -> i64 {
    count(
        pool,
        &format!(
            "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = '{owner}')
                  + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = '{owner}'
                        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid
                                          AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'))
                  + (SELECT count(*) FROM pg_namespace WHERE pg_get_userbyid(nspowner) = '{owner}'
                      AND (nspname = 'public' OR nspname LIKE 'plugin\\_%'))"
        ),
    )
    .await
}

/// A database built the way every install before this one was: everything owned by the superuser,
/// with the odd leftovers a restore or an old plugin leaves.
fn legacy(old: &str) -> String {
    format!(
        "
CREATE ROLE {old};
CREATE SCHEMA {old} AUTHORIZATION {old};
CREATE TABLE {old}.t (id int);
ALTER TABLE {old}.t OWNER TO {old};
CREATE SCHEMA plugin_leftover;
CREATE FUNCTION plugin_leftover.f() RETURNS int LANGUAGE sql AS 'SELECT 1';
CREATE TYPE plugin_leftover.e AS ENUM ('a');
CREATE DOMAIN public.dr_dom AS int;
CREATE TYPE public.dr_range AS RANGE (subtype = int);
CREATE TYPE public.dr_comp AS (a int);
CREATE VIEW public.dr_view AS SELECT 1 AS one;
CREATE MATERIALIZED VIEW public.dr_mat AS SELECT 1 AS one;
CREATE SEQUENCE public.dr_seq;
CREATE TEXT SEARCH CONFIGURATION public.dr_cfg (COPY = simple);
CREATE STATISTICS public.dr_stat ON id, kind FROM public.libraries;
CREATE COLLATION public.dr_coll (provider = libc, locale = 'C');
CREATE FUNCTION public.dr_fn(int) RETURNS int LANGUAGE sql AS 'SELECT $1';
CREATE PROCEDURE public.dr_proc() LANGUAGE sql AS 'SELECT 1';
CREATE AGGREGATE public.dr_agg(int) (sfunc = int4pl, stype = int4);
"
    )
}

#[tokio::test]
async fn takes_a_superuser_database_over_and_stays_idempotent() {
    let Some(f) = Fixture::create("legacy", None, true).await else {
        return;
    };
    let id = f.app.rsplit('_').next().unwrap().to_owned();
    let old = format!("plugin_legacy_{id}");
    f.exec_in(&legacy(&old)).await;
    let admin = f.pool(None).await;
    assert!(
        owned_by(&admin, f.admin.get_username()).await > 100,
        "a superuser database to start from"
    );

    f.transfer().await.unwrap();
    let app = f.app_pool().await;
    let s = role::status(&app).await.unwrap();
    assert!(s.ready(), "gaps: {:?}", s.gaps());
    assert_eq!(owned_by(&admin, f.admin.get_username()).await, 0);
    assert_eq!(owned_by(&admin, &old).await, 0);
    let before = snapshot(&admin).await;

    // A second run changes nothing, and a pool opened before it keeps working.
    f.transfer().await.unwrap();
    assert_eq!(snapshot(&admin).await, before);
    assert_eq!(count(&app, "SELECT 1").await, 1);

    // The role does what core does after the switch: DDL, a trusted extension, a text search setup.
    sqlx::raw_sql(
        "CREATE TABLE dr_t (id int); ALTER TABLE dr_t ADD COLUMN v text; CREATE INDEX ON dr_t (v);
         CREATE EXTENSION IF NOT EXISTS unaccent;
         CREATE TEXT SEARCH CONFIGURATION dr_cfg2 (COPY = simple);
         ALTER TEXT SEARCH CONFIGURATION dr_cfg2 ALTER MAPPING FOR word WITH unaccent, simple;
         DROP TABLE dr_t",
    )
    .execute(&app)
    .await
    .unwrap();

    // 4.x adoption of a role the application did not create, then a never-seen plugin and its removal.
    plugin_db::provision(&app, &format!("legacy.{id}"), &[])
        .await
        .unwrap();
    plugin_db::provision(&app, "fresh.y", &[]).await.unwrap();
    plugin_db::provision(&app, "fresh.y", &[]).await.unwrap();
    plugin_db::deprovision(&app, "fresh.y").await.unwrap();
    plugin_db::deprovision(&app, &format!("legacy.{id}"))
        .await
        .unwrap();

    app.close().await;
    admin.close().await;
    f.finish().await;
}

#[tokio::test]
async fn migrates_a_fresh_database_as_the_role() {
    let Some(f) = Fixture::create("fresh", None, false).await else {
        return;
    };
    f.transfer().await.unwrap();
    let app = f.app_pool().await;
    db::migrate(&app).await.unwrap();
    let s = role::status(&app).await.unwrap();
    assert!(s.ready(), "gaps: {:?}", s.gaps());
    let admin = f.pool(None).await;
    assert_eq!(owned_by(&admin, f.admin.get_username()).await, 0);
    app.close().await;
    admin.close().await;
    f.finish().await;
}

#[tokio::test]
async fn refuses_a_superuser_as_the_application_role() {
    let Some(f) = Fixture::create("super", None, false).await else {
        return;
    };
    let admin = f.admin.get_username().to_owned();
    let mut c = PgConnection::connect_with(&f.options(None)).await.unwrap();
    let e = role::transfer(&mut c, &admin, PASSWORD).await.unwrap_err();
    assert!(e.to_string().contains("superuser"), "{e}");
    f.finish().await;
}

#[tokio::test]
async fn a_busy_table_fails_the_transfer_and_the_rerun_finishes_it() {
    let Some(f) = Fixture::create("busy", None, true).await else {
        return;
    };
    let admin = f.pool(None).await;
    let mut holder = admin.begin().await.unwrap();
    sqlx::raw_sql("LOCK TABLE media IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *holder)
        .await
        .unwrap();
    let e = f.transfer().await.unwrap_err();
    assert!(e.contains("lock timeout"), "{e}");
    holder.rollback().await.unwrap();

    f.transfer().await.unwrap();
    let app = f.app_pool().await;
    let s = role::status(&app).await.unwrap();
    assert!(s.ready(), "gaps: {:?}", s.gaps());
    app.close().await;
    admin.close().await;
    f.finish().await;
}

/// A managed server's admin is not a superuser: the printed script is what its DBA runs.
#[tokio::test]
async fn the_printed_script_works_for_a_non_superuser_admin() {
    let Some(probe) = Fixture::create("probe", None, false).await else {
        return;
    };
    let dba = format!("dbrole_dba_{}", fliks_server::config::random_hex(4));
    probe
        .exec(&format!(
            "CREATE ROLE {dba} LOGIN CREATEROLE PASSWORD 'dba-pw'"
        ))
        .await;
    probe.finish().await;
    let Some(f) = Fixture::create("dba", Some(&dba), false).await else {
        return;
    };
    let as_dba = f.pool(Some((&dba, "dba-pw"))).await;
    db::migrate(&as_dba).await.unwrap();
    for stmt in role::script(&f.app, PASSWORD)
        .split(";\n\n")
        .map(|s| s.trim_end().trim_end_matches(';'))
    {
        sqlx::raw_sql(sqlx::AssertSqlSafe(stmt))
            .execute(&as_dba)
            .await
            .unwrap();
    }
    let app = f.app_pool().await;
    let s = role::status(&app).await.unwrap();
    // pg_catalog belongs to the bootstrap superuser: only it can revoke the advisory lock functions.
    assert_eq!(s.gaps(), ["advisory_locks"]);
    assert_eq!(owned_by(&as_dba, &dba).await, 0);
    app.close().await;
    as_dba.close().await;
    f.exec(&format!("DROP DATABASE {} WITH (FORCE)", f.name))
        .await;
    f.exec(&format!("DROP ROLE {dba}")).await;
    f.finish().await;
}

/// Every owner and name in `public` and the plugin schemas: unchanged by a second run.
async fn snapshot(pool: &PgPool) -> String {
    sqlx::query_scalar(
        "SELECT coalesce(string_agg(k || ':' || o, ',' ORDER BY k), '') FROM (
           SELECT 'r.' || n.nspname || '.' || c.relname AS k, pg_get_userbyid(c.relowner)::text AS o
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' OR n.nspname LIKE 'plugin\\_%'
           UNION ALL
           SELECT 'p.' || p.oid, pg_get_userbyid(p.proowner)::text FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' OR n.nspname LIKE 'plugin\\_%'
         ) x",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

impl Fixture {
    async fn exec_in(&self, sql: &str) {
        let mut c = PgConnection::connect_with(&self.options(None))
            .await
            .unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&mut c)
            .await
            .unwrap();
    }
}
