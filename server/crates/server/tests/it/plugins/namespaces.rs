//! `provider_namespaces`: claims by signer and what `deleteData` clears (`provider-plugins.md` 5.1).
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

#[sqlx::test]
async fn claims_follow_the_signer_rule(db: PgPool) {
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

#[sqlx::test]
async fn delete_data_clears_one_plugin_only(db: PgPool) {
    claim(&db, "org.x", None, &[ns("org.x:a")])
        .await
        .unwrap()
        .unwrap();
    claim(&db, "org.y", None, &[ns("org.y:a")])
        .await
        .unwrap()
        .unwrap();
    sql(
        &db,
        r#"INSERT INTO media (id, title, type) VALUES (1, 'a', 'movie');
           INSERT INTO media_external_ids VALUES (1, 'movie', 'org.x:a', '1'), (1, 'movie', 'org.y:a', '2'),
             (1, 'movie', 'tmdb', '3');
           INSERT INTO media_field_sources ("mediaId", field, provider, locked) VALUES
             (1, 'title', 'org.x:a', true), (1, 'overview', 'org.x:a', false), (1, 'year', 'org.y:a', false);
           INSERT INTO metadata_snapshots (provider, resource, kind, "externalId", body)
             VALUES ('org.x:a', 'work', 'movie', '1', '{}'), ('org.y:a', 'work', 'movie', '1', '{}');
           UPDATE media SET "preferredProvider" = 'org.x:a' WHERE id = 1;
           INSERT INTO requests ("mediaType", kind, provider, "externalId", title, status, "mediaId") VALUES
             ('movie', 'add', 'org.x:a', '1', 'open', 'pending', NULL),
             ('movie', 'add', 'org.x:a', '2', 'busy', 'processing', 1),
             ('movie', 'add', 'org.x:a', '3', 'done', 'available', 1)"#,
    )
    .await;
    delete_data(&db, "org.x").await.unwrap();
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM provider_namespaces").await,
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM media_external_ids WHERE provider = 'org.x:a'"
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
}

#[sqlx::test]
async fn the_shape_checks_refuse_malformed_plugin_namespaces(db: PgPool) {
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
