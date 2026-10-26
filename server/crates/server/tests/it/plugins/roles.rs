//! Role names scoped by the database OID, 4.x adoption, restore and template copies.
use super::harness::*;
use fliks_server::plugins::db;
use sqlx::{Connection, PgConnection};

async fn exists(pool: &sqlx::PgPool, role: &str) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)")
        .bind(role)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn owner(pool: &sqlx::PgPool, schema: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT pg_get_userbyid(nspowner)::text FROM pg_namespace WHERE nspname = $1",
    )
    .bind(schema)
    .fetch_optional(pool)
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn provision_adopt_and_deprovision() {
    let Some(s) = Scratch::create("roles").await else {
        return;
    };
    let oid = s.oid().await;
    let ours = db::role(&oid, "acme.tool");
    sqlx::raw_sql(
        r#"CREATE ROLE "plugin_acme_tool" LOGIN;
           CREATE SCHEMA "plugin_acme_tool" AUTHORIZATION "plugin_acme_tool";
           CREATE TABLE "plugin_acme_tool"."items" (id serial PRIMARY KEY, name text);
           ALTER TABLE "plugin_acme_tool"."items" OWNER TO "plugin_acme_tool";
           INSERT INTO "plugin_acme_tool"."items" (name) VALUES ('kept');"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();
    db::provision(&s.pool, "acme.tool", &["media".into()])
        .await
        .unwrap();
    assert_eq!(
        owner(&s.pool, "plugin_acme_tool").await.as_deref(),
        Some(ours.as_str())
    );
    assert!(
        !exists(&s.pool, "plugin_acme_tool").await,
        "the 4.x role is dropped"
    );
    let kept: String = sqlx::query_scalar(r#"SELECT name FROM "plugin_acme_tool"."items""#)
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(kept, "kept", "data stays in place");
    let table_owner: String = sqlx::query_scalar(
        "SELECT pg_get_userbyid(c.relowner)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'plugin_acme_tool' AND c.relname = 'items'",
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(table_owner, ours);
    db::provision(&s.pool, "acme.tool", &[]).await.unwrap();
    let bad = db::provision(&s.pool, "acme.tool", &["nope".into()])
        .await
        .unwrap_err();
    assert!(
        bad.message
            .contains("is not a public base table with an id column"),
        "{}",
        bad.message
    );
    db::deprovision(&s.pool, "acme.tool").await.unwrap();
    assert!(!exists(&s.pool, &ours).await);
    assert!(owner(&s.pool, "plugin_acme_tool").await.is_none());
    db::deprovision(&s.pool, "acme.tool").await.unwrap();
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn orphan_keeps_the_data_and_a_reprovision_reuses_it() {
    let Some(s) = Scratch::create("orphan").await else {
        return;
    };
    let ours = db::role(&s.oid().await, "acme.tool");
    db::provision(&s.pool, "acme.tool", &[]).await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"CREATE TABLE "plugin_acme_tool"."items" (id serial PRIMARY KEY);
           INSERT INTO "plugin_acme_tool"."items" DEFAULT VALUES;
           ALTER TABLE "plugin_acme_tool"."items" OWNER TO "{ours}";"#
    )))
    .execute(&s.pool)
    .await
    .unwrap();
    db::orphan(&s.pool, "acme.tool").await.unwrap();
    let login: bool = sqlx::query_scalar("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1")
        .bind(&ours)
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert!(!login, "an orphaned role cannot log in");
    let note: Option<String> = sqlx::query_scalar(
        "SELECT obj_description('plugin_acme_tool'::regnamespace, 'pg_namespace')",
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert!(note.is_some_and(|n| n.starts_with("orphaned")));
    db::provision(&s.pool, "acme.tool", &[]).await.unwrap();
    let rows: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM "plugin_acme_tool"."items""#)
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(rows, 1, "a reinstall finds the rows");
    let (login, note): (bool, Option<String>) = sqlx::query_as(
        "SELECT rolcanlogin, obj_description('plugin_acme_tool'::regnamespace, 'pg_namespace') FROM pg_roles WHERE rolname = $1",
    )
    .bind(&ours)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert!(
        login && note.is_none(),
        "reprovisioning reactivates the schema"
    );
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn template_copy_and_restore_take_their_own_names() {
    let Some(a) = Scratch::create("copya").await else {
        return;
    };
    db::provision(&a.pool, "acme.tool", &[]).await.unwrap();
    let a_role = db::role(&a.oid().await, "acme.tool");
    let admin = admin_url().unwrap();
    a.pool.close().await;
    let copy = format!("{}_copy", a.name);
    let mut c = PgConnection::connect(&admin).await.unwrap();
    // A template needs every session on its source gone (55006).
    for attempt in 0.. {
        match sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "CREATE DATABASE {copy} TEMPLATE {}",
            a.name
        )))
        .execute(&mut c)
        .await
        {
            Err(sqlx::Error::Database(e))
                if e.code().as_deref() == Some("55006") && attempt < 50 =>
            {
                // Whatever still holds the scratch source (autovacuum, a closing backend) goes.
                sqlx::query(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
                )
                .bind(&a.name)
                .execute(&mut c)
                .await
                .unwrap();
                tokio::time::sleep(std::time::Duration::from_millis(100)).await
            }
            r => {
                r.unwrap();
                break;
            }
        }
    }
    let url = format!("{}/{copy}", admin.rsplit_once('/').unwrap().0);
    let b = sqlx::PgPool::connect(&url).await.unwrap();
    let b_oid = db::database_oid(&b).await.unwrap();
    let b_role = db::role(&b_oid, "acme.tool");
    assert_ne!(a_role, b_role);
    assert_eq!(
        owner(&b, "plugin_acme_tool").await.as_deref(),
        Some(a_role.as_str()),
        "a copy carries the old owner"
    );
    db::provision(&b, "acme.tool", &[]).await.unwrap();
    assert_eq!(
        owner(&b, "plugin_acme_tool").await.as_deref(),
        Some(b_role.as_str())
    );
    assert!(
        exists(&b, &a_role).await,
        "the source database still uses its role"
    );
    // A restore names roles from another database: they are adopted, then dropped here.
    sqlx::raw_sql(r#"CREATE ROLE "fp_deadbeef_acme_tool" LOGIN; CREATE SCHEMA "plugin_acme_other" AUTHORIZATION "fp_deadbeef_acme_tool";"#)
        .execute(&b)
        .await
        .unwrap();
    db::drop_foreign_roles(&b, &["fp_deadbeef_acme_tool".into(), b_role.clone()])
        .await
        .unwrap();
    assert!(!exists(&b, "fp_deadbeef_acme_tool").await);
    assert!(exists(&b, &b_role).await, "this database's own role stays");
    b.close().await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE {copy} WITH (FORCE)"
    )))
    .execute(&mut c)
    .await
    .unwrap();
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "DROP ROLE IF EXISTS \"{b_role}\""
    )))
    .execute(&mut c)
    .await;
    let reopened = Scratch::reopen(a).await;
    reopened.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn provision_revokes_public_create() {
    let Some(s) = Scratch::create("pubcreate").await else {
        return;
    };
    let open = "SELECT has_schema_privilege('public', 'public', 'CREATE')";
    sqlx::raw_sql("GRANT CREATE ON SCHEMA public TO PUBLIC")
        .execute(&s.pool)
        .await
        .unwrap();
    db::provision(&s.pool, "acme.revoke", &[]).await.unwrap();
    let still: bool = sqlx::query_scalar(open).fetch_one(&s.pool).await.unwrap();
    assert!(!still, "PUBLIC lost CREATE on public");
    db::deprovision(&s.pool, "acme.revoke").await.unwrap();
    s.finish().await;
}
