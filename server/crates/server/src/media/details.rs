//! What a media carries beyond its shared columns (`docs/spec/media-details.md`).
use fliks_domain::media::release::ReleaseKind;
use sqlx::PgConnection;

/// The join giving a query `dates.release_date`, `dates.cinema_date`, `dates.digital_date` and
/// `dates.physical_date` of media `alias`, for queries built at run time (the checked ones inline it).
pub fn dates_join(alias: &str) -> String {
    let cols = ReleaseKind::ALL.map(|k| {
        let k = k.as_str();
        format!("max(date) FILTER (WHERE kind = '{k}') AS {k}_date")
    });
    format!(
        r#"LEFT JOIN LATERAL (SELECT {} FROM media_release_dates WHERE "mediaId" = {alias}.id) dates ON true"#,
        cols.join(", ")
    )
}

/// Upserts the given dates (text Postgres reads as a date); a `None` deletes its row unless `keep_on_null`.
/// Answers whether a row changed.
pub async fn set_release_dates(
    c: &mut PgConnection,
    media: i32,
    dates: &[(ReleaseKind, Option<String>)],
    keep_on_null: bool,
) -> sqlx::Result<bool> {
    let given: Vec<&str> = dates
        .iter()
        .filter(|(_, d)| d.is_some())
        .map(|(k, _)| k.as_str())
        .collect();
    let values: Vec<&str> = dates.iter().filter_map(|(_, d)| d.as_deref()).collect();
    let mut changed = sqlx::query!(
        r#"INSERT INTO media_release_dates ("mediaId", kind, date)
           SELECT m.id, t.kind, t.date::timestamptz::date FROM media m, UNNEST($2::text[], $3::text[]) AS t(kind, date)
           WHERE m.id = $1
           ON CONFLICT ("mediaId", kind) DO UPDATE SET date = EXCLUDED.date
           WHERE media_release_dates.date IS DISTINCT FROM EXCLUDED.date"#,
        media,
        &given as &[&str],
        &values as &[&str]
    )
    .execute(&mut *c)
    .await?
    .rows_affected()
        > 0;
    let cleared: Vec<&str> = dates
        .iter()
        .filter(|(_, d)| d.is_none())
        .map(|(k, _)| k.as_str())
        .collect();
    if !keep_on_null && !cleared.is_empty() {
        changed |= sqlx::query!(
            r#"DELETE FROM media_release_dates WHERE "mediaId" = $1 AND kind = ANY($2)"#,
            media,
            &cleared as &[&str]
        )
        .execute(&mut *c)
        .await?
        .rows_affected()
            > 0;
    }
    Ok(changed)
}

/// Deletes the details row of a media, whichever table holds it.
pub async fn drop_details(c: &mut PgConnection, media: i32) -> sqlx::Result<()> {
    sqlx::query!(r#"DELETE FROM movie_details WHERE "mediaId" = $1"#, media)
        .execute(&mut *c)
        .await?;
    sqlx::query!(r#"DELETE FROM series_details WHERE "mediaId" = $1"#, media)
        .execute(&mut *c)
        .await?;
    Ok(())
}

/// Puts the media in the TMDB collection `(id, name)`, creating it, and out of any other; `None` only removes.
pub async fn set_tmdb_collection(
    c: &mut PgConnection,
    media: i32,
    collection: Option<(i32, &str)>,
) -> sqlx::Result<()> {
    let keep = match collection {
        None => None,
        Some((tmdb, name)) => {
            let value = tmdb.to_string();
            sqlx::query!(
                "SELECT pg_advisory_xact_lock(hashtext('collections:tmdb:' || $1::text))",
                value
            )
            .execute(&mut *c)
            .await?;
            let found = sqlx::query_scalar!(
                r#"SELECT "collectionId" FROM collection_external_ids WHERE provider = 'tmdb' AND value = $1"#,
                value
            )
            .fetch_optional(&mut *c)
            .await?;
            let id = match found {
                Some(id) => {
                    sqlx::query!(
                        "UPDATE collections SET name = $2 WHERE id = $1 AND name IS DISTINCT FROM $2",
                        id,
                        name
                    )
                    .execute(&mut *c)
                    .await?;
                    id
                }
                None => {
                    let id = sqlx::query_scalar!(
                        "INSERT INTO collections (name) VALUES ($1) RETURNING id",
                        name
                    )
                    .fetch_one(&mut *c)
                    .await?;
                    sqlx::query!(
                        r#"INSERT INTO collection_external_ids ("collectionId", provider, value) VALUES ($1, 'tmdb', $2)"#,
                        id,
                        value
                    )
                    .execute(&mut *c)
                    .await?;
                    id
                }
            };
            sqlx::query!(
                r#"INSERT INTO collection_entries ("collectionId", "mediaId") VALUES ($1, $2) ON CONFLICT DO NOTHING"#,
                id,
                media
            )
            .execute(&mut *c)
            .await?;
            Some(id)
        }
    };
    sqlx::query!(
        r#"WITH left_ AS (
             DELETE FROM collection_entries e
              WHERE e."mediaId" = $1 AND e."collectionId" IS DISTINCT FROM $2
                AND EXISTS (SELECT 1 FROM collection_external_ids x
                             WHERE x."collectionId" = e."collectionId" AND x.provider = 'tmdb')
              RETURNING e."collectionId")
           DELETE FROM collections c WHERE c.id IN (SELECT "collectionId" FROM left_)
             AND NOT EXISTS (SELECT 1 FROM collection_entries e
                              WHERE e."collectionId" = c.id AND e."mediaId" <> $1)"#,
        media,
        keep
    )
    .execute(&mut *c)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;

    async fn kinds(db: &PgPool, media: i32) -> Vec<String> {
        sqlx::query_scalar(
            r#"SELECT kind FROM media_release_dates WHERE "mediaId" = $1 ORDER BY kind"#,
        )
        .bind(media)
        .fetch_all(db)
        .await
        .unwrap()
    }

    #[test]
    fn the_join_names_every_release_kind() {
        let j = dates_join("m");
        for k in ReleaseKind::ALL {
            let k = k.as_str();
            assert!(j.contains(&format!("'{k}') AS {k}_date")), "{k}");
        }
    }

    #[sqlx::test(migrations = false)]
    async fn dates_are_upserted_cleared_or_kept(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let media: i32 = sqlx::query_scalar(
            r#"INSERT INTO media (title, type) VALUES ('t', 'movie') RETURNING id"#,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let mut c = db.acquire().await.unwrap();
        let set = async |c: &mut PgConnection, d: &[(ReleaseKind, Option<&str>)], keep| {
            let d: Vec<_> = d.iter().map(|(k, v)| (*k, v.map(str::to_owned))).collect();
            set_release_dates(c, media, &d, keep).await.unwrap()
        };
        let both = [
            (ReleaseKind::Release, Some("2020-01-01")),
            (ReleaseKind::Cinema, Some("2020-02-01T23:00:00Z")),
        ];
        assert!(set(&mut c, &both, false).await);
        assert!(
            !set(&mut c, &both[..1], false).await,
            "an unchanged date writes nothing"
        );
        assert_eq!(kinds(&db, media).await, ["cinema", "release"]);

        let change = [
            (ReleaseKind::Release, None),
            (ReleaseKind::Digital, Some("2021-03-04")),
        ];
        assert!(set(&mut c, &change, true).await);
        assert_eq!(
            kinds(&db, media).await,
            ["cinema", "digital", "release"],
            "a null keeps the stored date"
        );

        assert!(set(&mut c, &change, false).await);
        assert_eq!(
            kinds(&db, media).await,
            ["cinema", "digital"],
            "a null clears it"
        );

        sqlx::query("DELETE FROM media").execute(&db).await.unwrap();
        assert!(
            !set(&mut c, &both, false).await,
            "a vanished media writes nothing"
        );
    }

    async fn movie(db: &PgPool, title: &str) -> i32 {
        sqlx::query_scalar(r#"INSERT INTO media (title, type) VALUES ($1, 'movie') RETURNING id"#)
            .bind(title)
            .fetch_one(db)
            .await
            .unwrap()
    }

    async fn membership(db: &PgPool) -> Vec<(i32, String, String)> {
        sqlx::query_as(
            r#"SELECT e."mediaId", c.name, x.value FROM collection_entries e
               JOIN collections c ON c.id = e."collectionId"
               JOIN collection_external_ids x ON x."collectionId" = c.id ORDER BY 1"#,
        )
        .fetch_all(db)
        .await
        .unwrap()
    }

    async fn collection_count(db: &PgPool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM collections")
            .fetch_one(db)
            .await
            .unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn a_collection_is_found_renamed_left_and_collected(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let (a, b) = (movie(&db, "a").await, movie(&db, "b").await);
        let mut c = db.acquire().await.unwrap();
        set_tmdb_collection(&mut c, a, Some((7, "One")))
            .await
            .unwrap();
        set_tmdb_collection(&mut c, b, Some((7, "Renamed")))
            .await
            .unwrap();
        let want = |name: &str| {
            vec![
                (a, name.to_owned(), "7".to_owned()),
                (b, name.to_owned(), "7".to_owned()),
            ]
        };
        assert_eq!(
            membership(&db).await,
            want("Renamed"),
            "one collection, named by the last write"
        );
        assert_eq!(collection_count(&db).await, 1);

        set_tmdb_collection(&mut c, a, Some((8, "Other")))
            .await
            .unwrap();
        assert_eq!(
            membership(&db).await,
            [
                (a, "Other".to_owned(), "8".to_owned()),
                (b, "Renamed".to_owned(), "7".to_owned())
            ]
        );
        set_tmdb_collection(&mut c, b, None).await.unwrap();
        assert_eq!(
            membership(&db).await,
            [(a, "Other".to_owned(), "8".to_owned())],
            "a collection left empty is deleted"
        );
        assert_eq!(collection_count(&db).await, 1);
        set_tmdb_collection(&mut c, a, None).await.unwrap();
        assert_eq!(collection_count(&db).await, 0);
    }

    #[sqlx::test(migrations = false)]
    async fn two_writers_of_one_new_collection_make_one(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let (a, b) = (movie(&db, "a").await, movie(&db, "b").await);
        let write = async |media: i32| {
            let mut tx = db.begin().await.unwrap();
            set_tmdb_collection(&mut tx, media, Some((9, "Same")))
                .await
                .unwrap();
            tx.commit().await.unwrap();
        };
        tokio::join!(write(a), write(b));
        assert_eq!(collection_count(&db).await, 1);
        assert_eq!(membership(&db).await.len(), 2);
    }

    #[sqlx::test(migrations = false)]
    async fn dropping_details_clears_both_tables(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let a = movie(&db, "a").await;
        sqlx::query(r#"INSERT INTO movie_details ("mediaId") VALUES ($1)"#)
            .bind(a)
            .execute(&db)
            .await
            .unwrap();
        let mut c = db.acquire().await.unwrap();
        drop_details(&mut c, a).await.unwrap();
        let n: Option<serde_json::Value> = sqlx::query_scalar("SELECT media_details_json($1)")
            .bind(a)
            .fetch_one(&db)
            .await
            .unwrap();
        assert!(n.is_none());
    }
}
