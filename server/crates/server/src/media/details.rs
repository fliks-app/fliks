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
    if !keep_on_null {
        let cleared: Vec<&str> = dates
            .iter()
            .filter(|(_, d)| d.is_none())
            .map(|(k, _)| k.as_str())
            .collect();
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
}
