//! `provider_namespaces`: claims by signer and what `deleteData` clears (`provider-plugins.md` 5.1).
use fliks_domain::external_id::Namespace;
use fliks_server::plugins::namespaces::{Declared, check_install, claim, delete_data};
use sqlx::PgPool;

fn ns(name: &str) -> Declared<'_> {
    Declared {
        name,
        label: "L",
        id_pattern: "^.+$",
        case: "preserve",
    }
}

async fn sql(db: &PgPool, q: &str) {
    sqlx::raw_sql(sqlx::AssertSqlSafe(q))
        .execute(db)
        .await
        .unwrap();
}

async fn count(db: &PgPool, q: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(q))
        .fetch_one(db)
        .await
        .unwrap()
}

#[sqlx::test(migrations = false)]
async fn claims_follow_the_signer_rule(db: PgPool) {
    fliks_server::db::migrate(&db).await.unwrap();
    assert_eq!(
        claim(&db, "org.x", None, &[ns("org.x:a")]).await.unwrap(),
        Ok(())
    );
    assert_eq!(
        claim(&db, "org.x", None, &[ns("org.x:a")]).await.unwrap(),
        Ok(())
    );
    // a signed package takes over an unsigned row
    assert_eq!(
        claim(&db, "org.x", Some("k1"), &[ns("org.x:a")])
            .await
            .unwrap(),
        Ok(())
    );
    // an unsigned or another key may not, and nothing of the batch is written
    for s in [None, Some("k2")] {
        let r = claim(&db, "org.x", s, &[ns("org.x:b"), ns("org.x:a")]).await;
        assert_eq!(r.unwrap(), Err("org.x:a".into()));
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM provider_namespaces WHERE name = 'org.x:b'"
            )
            .await,
            0
        );
        assert_eq!(
            check_install(&db, s, &[ns("org.x:a")]).await.unwrap(),
            Err("org.x:a".into())
        );
    }
    assert_eq!(
        check_install(&db, Some("k1"), &[ns("org.x:a")])
            .await
            .unwrap(),
        Ok(())
    );
}

#[sqlx::test(migrations = false)]
async fn delete_data_clears_one_plugin_only(db: PgPool) {
    fliks_server::db::migrate(&db).await.unwrap();
    claim(&db, "org.dx", None, &[ns("org.dx:a")])
        .await
        .unwrap()
        .unwrap();
    claim(&db, "org.dy", None, &[ns("org.dy:a")])
        .await
        .unwrap()
        .unwrap();
    sql(
        &db,
        r#"INSERT INTO media (id, title, type) VALUES (1, 'a', 'movie');
           INSERT INTO media_external_ids VALUES (1, 'movie', 'org.dx:a', '1'), (1, 'movie', 'org.dy:a', '2'),
             (1, 'movie', 'tmdb', '3');
           INSERT INTO media_field_sources ("mediaId", field, provider, locked) VALUES
             (1, 'title', 'org.dx:a', true), (1, 'overview', 'org.dx:a', false), (1, 'year', 'org.dy:a', false);
           INSERT INTO metadata_snapshots (provider, resource, kind, "externalId", body)
             VALUES ('org.dx:a', 'work', 'movie', '1', '{}'), ('org.dy:a', 'work', 'movie', '1', '{}');
           UPDATE media SET "preferredProvider" = 'org.dx:a' WHERE id = 1;
           INSERT INTO requests ("mediaType", kind, provider, "externalId", title, status, "mediaId") VALUES
             ('movie', 'add', 'org.dx:a', '1', 'open', 'pending', NULL),
             ('movie', 'add', 'org.dx:a', '2', 'busy', 'processing', 1),
             ('movie', 'add', 'org.dx:a', '3', 'done', 'available', 1)"#,
    )
    .await;
    delete_data(&db, "org.dx").await.unwrap();
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM provider_namespaces").await,
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM media_external_ids WHERE provider = 'org.dx:a'"
        )
        .await,
        0
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM media_external_ids").await,
        2
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM metadata_snapshots").await,
        1
    );
    // the locked source stays with no provider, the unlocked one goes
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM media_field_sources").await,
        2
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM media_field_sources WHERE field = 'title' AND provider IS NULL AND locked").await,
        1
    );
    assert_eq!(
        count(
            &db,
            r#"SELECT COUNT(*) FROM media WHERE "preferredProvider" IS NOT NULL"#
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM requests WHERE status = 'failed' AND title = 'open'"
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM requests WHERE status IN ('processing', 'available')"
        )
        .await,
        2
    );
    // the process forgets the deleted namespace and keeps the other
    assert_eq!(Namespace::parse("org.dx:a"), None);
    assert!(Namespace::parse("org.dy:a").is_some());
}

#[sqlx::test(migrations = false)]
async fn a_changed_pattern_counts_the_stored_ids_it_no_longer_accepts(db: PgPool) {
    use fliks_server::plugins::namespaces::stale;
    fliks_server::db::migrate(&db).await.unwrap();
    claim(&db, "org.sp", None, &[ns("org.sp:a")])
        .await
        .unwrap()
        .unwrap();
    sql(
        &db,
        r#"INSERT INTO media (id, title, type) VALUES (1, 'a', 'movie');
           INSERT INTO media_external_ids VALUES (1, 'movie', 'org.sp:a', 'abc')"#,
    )
    .await;
    let n = Namespace::parse("org.sp:a").unwrap();
    assert_eq!(stale(&db, n).await.unwrap(), 0);
    let numeric = Declared {
        id_pattern: "^[0-9]+$",
        ..ns("org.sp:a")
    };
    claim(&db, "org.sp", None, &[numeric])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stale(&db, n).await.unwrap(), 1, "abc fails the new pattern");
}

#[sqlx::test(migrations = false)]
async fn the_shape_checks_refuse_malformed_plugin_namespaces(db: PgPool) {
    fliks_server::db::migrate(&db).await.unwrap();
    for bad in [
        r#"INSERT INTO requests ("mediaType", kind, provider, "externalId", title) VALUES ('book', 'add', 'org.x:A', '1', 't')"#,
        r#"INSERT INTO requests ("mediaType", kind, provider, "externalId", title) VALUES ('book', 'add', 'org.x:a', '', 't')"#,
    ] {
        assert!(
            sqlx::raw_sql(sqlx::AssertSqlSafe(bad))
                .execute(&db)
                .await
                .is_err(),
            "{bad}"
        );
    }
}
