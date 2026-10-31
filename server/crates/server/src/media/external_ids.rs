//! The ids a media has in outside systems (`docs/spec/external-ids.md`).
use fliks_domain::media::{external_id::ExternalProvider, kind::MediaKind};
use sqlx::{PgConnection, PgExecutor};

/// The media of `kind` holding `value` for `provider`.
pub async fn find(
    db: impl PgExecutor<'_>,
    kind: MediaKind,
    provider: ExternalProvider,
    value: &str,
) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar!(
        r#"SELECT "entityId" FROM external_ids
           WHERE entity = 'media' AND scope = $1 AND provider = $2 AND value = $3"#,
        kind.as_str(),
        provider.as_str(),
        value
    )
    .fetch_optional(db)
    .await
}

/// `find` for an integer id.
pub async fn find_numeric(
    db: impl PgExecutor<'_>,
    kind: MediaKind,
    provider: ExternalProvider,
    id: i32,
) -> sqlx::Result<Option<i32>> {
    find(db, kind, provider, &id.to_string()).await
}

/// Sets the media's id for `provider`; `false` when another media of the kind holds the value.
/// A value that is not an id of the provider is not stored.
pub async fn link(
    c: &mut PgConnection,
    media_id: i32,
    kind: MediaKind,
    provider: ExternalProvider,
    value: &str,
) -> sqlx::Result<bool> {
    let Some(value) = provider.normalize(value) else {
        return Ok(true);
    };
    let done = sqlx::query!(
        r#"INSERT INTO external_ids (entity, "entityId", scope, provider, value)
           SELECT 'media', $1::int4, $2::text, $3::text, $4::text
           WHERE NOT EXISTS (SELECT 1 FROM external_ids WHERE entity = 'media' AND scope = $2
                               AND provider = $3 AND value = $4 AND "entityId" <> $1)
           ON CONFLICT (entity, "entityId", provider)
           DO UPDATE SET scope = EXCLUDED.scope, value = EXCLUDED.value"#,
        media_id,
        kind.as_str(),
        provider.as_str(),
        value
    )
    .execute(c)
    .await?;
    Ok(done.rows_affected() > 0)
}

pub async fn unlink(
    c: &mut PgConnection,
    media_id: i32,
    provider: ExternalProvider,
) -> sqlx::Result<()> {
    sqlx::query!(
        r#"DELETE FROM external_ids WHERE entity = 'media' AND "entityId" = $1 AND provider = $2"#,
        media_id,
        provider.as_str()
    )
    .execute(c)
    .await?;
    Ok(())
}

/// `link`, or `unlink` when there is no id to set.
pub async fn set(
    c: &mut PgConnection,
    media_id: i32,
    kind: MediaKind,
    provider: ExternalProvider,
    value: Option<&str>,
) -> sqlx::Result<bool> {
    match value.and_then(|v| provider.normalize(v)) {
        Some(v) => link(c, media_id, kind, provider, &v).await,
        None => unlink(c, media_id, provider).await.map(|()| true),
    }
}

/// Moves the media's ids to the scope of its new kind.
pub async fn rescope(c: &mut PgConnection, media_id: i32, kind: MediaKind) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE external_ids SET scope = $2
           WHERE entity = 'media' AND "entityId" = $1 AND scope <> $2"#,
        media_id,
        kind.as_str()
    )
    .execute(c)
    .await?;
    Ok(())
}

/// The three ids the payloads carry, as providers report them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ids {
    pub tmdb: Option<i32>,
    pub tvdb: Option<i32>,
    pub imdb: Option<String>,
}

impl Ids {
    fn entries(&self) -> [(ExternalProvider, Option<String>); 3] {
        [
            (ExternalProvider::Tmdb, self.tmdb.map(|v| v.to_string())),
            (ExternalProvider::Tvdb, self.tvdb.map(|v| v.to_string())),
            (ExternalProvider::Imdb, self.imdb.clone()),
        ]
    }

    /// Links every id present and leaves the others; the providers whose id another media holds.
    pub async fn fill(
        &self,
        c: &mut PgConnection,
        media_id: i32,
        kind: MediaKind,
    ) -> sqlx::Result<Vec<ExternalProvider>> {
        let mut held = vec![];
        for (p, v) in self.entries() {
            if let Some(v) = v
                && !link(c, media_id, kind, p, &v).await?
            {
                held.push(p);
            }
        }
        Ok(held)
    }

    /// Makes these ids the media's own: an absent one is removed.
    pub async fn replace(
        &self,
        c: &mut PgConnection,
        media_id: i32,
        kind: MediaKind,
    ) -> sqlx::Result<Vec<ExternalProvider>> {
        let mut held = vec![];
        for (p, v) in self.entries() {
            if !set(c, media_id, kind, p, v.as_deref()).await? {
                held.push(p);
            }
        }
        Ok(held)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn media(db: &sqlx::PgPool, kind: MediaKind) -> i32 {
        sqlx::query_scalar(r#"INSERT INTO media (title, type) VALUES ('t', $1) RETURNING id"#)
            .bind(kind.as_str())
            .fetch_one(db)
            .await
            .unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn an_id_is_unique_per_kind_and_goes_with_its_media(db: sqlx::PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let mut c = db.acquire().await.unwrap();
        let (movie, other, show) = (
            media(&db, MediaKind::Movie).await,
            media(&db, MediaKind::Movie).await,
            media(&db, MediaKind::Series).await,
        );
        let tmdb = ExternalProvider::Tmdb;
        assert!(
            link(&mut c, movie, MediaKind::Movie, tmdb, "603")
                .await
                .unwrap()
        );
        assert!(
            !link(&mut c, other, MediaKind::Movie, tmdb, "603")
                .await
                .unwrap()
        );
        assert!(
            link(&mut c, show, MediaKind::Series, tmdb, "603")
                .await
                .unwrap()
        );
        assert_eq!(
            find_numeric(&mut *c, MediaKind::Movie, tmdb, 603)
                .await
                .unwrap(),
            Some(movie)
        );
        assert_eq!(
            find_numeric(&mut *c, MediaKind::Series, tmdb, 603)
                .await
                .unwrap(),
            Some(show)
        );

        assert!(
            link(&mut c, movie, MediaKind::Movie, tmdb, "604")
                .await
                .unwrap()
        );
        assert_eq!(
            find_numeric(&mut *c, MediaKind::Movie, tmdb, 603)
                .await
                .unwrap(),
            None
        );

        // The series' 603 would clash with the movie's once their kinds are equal.
        assert!(
            link(&mut c, other, MediaKind::Movie, tmdb, "603")
                .await
                .unwrap()
        );
        assert!(rescope(&mut c, show, MediaKind::Movie).await.is_err());

        sqlx::query("DELETE FROM media WHERE id = $1")
            .bind(movie)
            .execute(&mut *c)
            .await
            .unwrap();
        assert_eq!(
            find_numeric(&mut *c, MediaKind::Movie, tmdb, 604)
                .await
                .unwrap(),
            None
        );
    }

    #[sqlx::test(migrations = false)]
    async fn replace_clears_absent_ids_and_fill_keeps_them(db: sqlx::PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let mut c = db.acquire().await.unwrap();
        let m = media(&db, MediaKind::Series).await;
        let all = Ids {
            tmdb: Some(1),
            tvdb: Some(2),
            imdb: Some("tt3".into()),
        };
        assert!(
            all.fill(&mut c, m, MediaKind::Series)
                .await
                .unwrap()
                .is_empty()
        );
        let only_imdb = Ids {
            imdb: Some("tt4".into()),
            ..Ids::default()
        };
        only_imdb.fill(&mut c, m, MediaKind::Series).await.unwrap();
        let read = |p: &str| {
            sqlx::query_scalar::<_, Option<String>>("SELECT external_id('media', $1, $2)")
                .bind(m)
                .bind(p.to_owned())
        };
        assert_eq!(
            read("tmdb").fetch_one(&db).await.unwrap().as_deref(),
            Some("1")
        );
        assert_eq!(
            read("imdb").fetch_one(&db).await.unwrap().as_deref(),
            Some("tt4")
        );
        only_imdb
            .replace(&mut c, m, MediaKind::Series)
            .await
            .unwrap();
        assert_eq!(read("tmdb").fetch_one(&db).await.unwrap(), None);
    }
}
