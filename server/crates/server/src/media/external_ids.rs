//! The ids a media has in outside systems (`docs/spec/external-ids.md`).
use fliks_domain::{external_id::ExternalProvider, media::kind::MediaKind};
use sqlx::{PgConnection, PgExecutor};

/// Provider names as the queries bind them.
pub const TMDB: &str = ExternalProvider::Tmdb.as_str();
pub const TVDB: &str = ExternalProvider::Tvdb.as_str();
pub const IMDB: &str = ExternalProvider::Imdb.as_str();

/// The join giving a query the `ids.tmdb`, `ids.tvdb` and `ids.imdb` of media `alias`, for queries
/// built at run time (the checked ones inline the same text with bound provider names).
pub fn ids_join(alias: &str) -> String {
    format!(
        r#"LEFT JOIN LATERAL (SELECT max(value) FILTER (WHERE provider = '{TMDB}')::int AS tmdb,
             max(value) FILTER (WHERE provider = '{TVDB}')::int AS tvdb,
             max(value) FILTER (WHERE provider = '{IMDB}') AS imdb
           FROM media_external_ids WHERE "mediaId" = {alias}.id) ids ON true"#
    )
}

/// The media of `kind` holding `value` for `provider`; the lowest id when the provider is not unique.
pub async fn find(
    db: impl PgExecutor<'_>,
    kind: MediaKind,
    provider: ExternalProvider,
    value: &str,
) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar!(
        r#"SELECT "mediaId" FROM media_external_ids
           WHERE kind = $1 AND provider = $2 AND value = $3 ORDER BY "mediaId" LIMIT 1"#,
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

/// What a write of one id came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Link {
    Linked,
    /// A unique provider's id is held by another media of the kind: nothing was written.
    Taken,
    /// The media does not exist (any more): the foreign key refused the row.
    Gone,
}

fn is_foreign_key_violation(e: &sqlx::Error) -> bool {
    e.as_database_error().and_then(|d| d.code()).as_deref() == Some("23503")
}

/// Sets the media's id for `provider`. A value that is not an id of the provider is not stored.
/// `Gone` aborts a transaction, so a caller inside one must know the media exists.
pub async fn link(
    c: &mut PgConnection,
    media_id: i32,
    kind: MediaKind,
    provider: ExternalProvider,
    value: &str,
) -> sqlx::Result<Link> {
    let Some(value) = provider.normalize(value) else {
        return Ok(Link::Linked);
    };
    let done = sqlx::query!(
        r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value)
           SELECT $1::int4, $2::text, $3::text, $4::text
           WHERE NOT ($5 AND EXISTS (SELECT 1 FROM media_external_ids
                                     WHERE kind = $2 AND provider = $3 AND value = $4 AND "mediaId" <> $1))
           ON CONFLICT ("mediaId", provider) DO UPDATE SET value = EXCLUDED.value"#,
        media_id,
        kind.as_str(),
        provider.as_str(),
        value,
        provider.is_unique()
    )
    .execute(c)
    .await;
    match done {
        Ok(r) if r.rows_affected() > 0 => Ok(Link::Linked),
        Ok(_) => Ok(Link::Taken),
        Err(e) if is_foreign_key_violation(&e) => Ok(Link::Gone),
        Err(e) => Err(e),
    }
}

pub async fn unlink(
    c: &mut PgConnection,
    media_id: i32,
    provider: ExternalProvider,
) -> sqlx::Result<()> {
    sqlx::query!(
        r#"DELETE FROM media_external_ids WHERE "mediaId" = $1 AND provider = $2"#,
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
) -> sqlx::Result<Link> {
    match value.and_then(|v| provider.normalize(v)) {
        Some(v) => link(c, media_id, kind, provider, &v).await,
        None => unlink(c, media_id, provider).await.map(|()| Link::Linked),
    }
}

/// The three ids the payloads carry, as providers report them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ids {
    pub tmdb: Option<i32>,
    pub tvdb: Option<i32>,
    pub imdb: Option<String>,
}

/// What writing several ids came to.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Written {
    /// The unique providers whose id another media of the kind holds.
    pub taken: Vec<ExternalProvider>,
    /// The media no longer exists; the remaining ids were not written.
    pub gone: bool,
}

impl Ids {
    pub fn entries(&self) -> [(ExternalProvider, Option<String>); 3] {
        [
            (ExternalProvider::Tmdb, self.tmdb.map(|v| v.to_string())),
            (ExternalProvider::Tvdb, self.tvdb.map(|v| v.to_string())),
            (ExternalProvider::Imdb, self.imdb.clone()),
        ]
    }

    /// Links every id present and leaves the others.
    pub async fn fill(
        &self,
        c: &mut PgConnection,
        media_id: i32,
        kind: MediaKind,
    ) -> sqlx::Result<Written> {
        let mut out = Written::default();
        for (p, v) in self.entries() {
            let Some(v) = v else { continue };
            match link(c, media_id, kind, p, &v).await? {
                Link::Linked => {}
                Link::Taken => out.taken.push(p),
                Link::Gone => {
                    out.gone = true;
                    break;
                }
            }
        }
        Ok(out)
    }

    /// Makes these ids the media's own: an absent one is removed.
    pub async fn replace(
        &self,
        c: &mut PgConnection,
        media_id: i32,
        kind: MediaKind,
    ) -> sqlx::Result<Written> {
        let mut out = Written::default();
        for (p, v) in self.entries() {
            match set(c, media_id, kind, p, v.as_deref()).await? {
                Link::Linked => {}
                Link::Taken => out.taken.push(p),
                Link::Gone => {
                    out.gone = true;
                    break;
                }
            }
        }
        Ok(out)
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

    #[test]
    fn the_join_names_the_registry_providers() {
        let j = ids_join("m");
        for p in ExternalProvider::ALL {
            assert!(j.contains(&format!("'{p}'")), "{p}");
        }
    }

    #[sqlx::test(migrations = false)]
    async fn a_tmdb_id_is_unique_per_kind_the_others_are_not(db: sqlx::PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let mut c = db.acquire().await.unwrap();
        let (movie, other, show) = (
            media(&db, MediaKind::Movie).await,
            media(&db, MediaKind::Movie).await,
            media(&db, MediaKind::Series).await,
        );
        let (tmdb, tvdb) = (ExternalProvider::Tmdb, ExternalProvider::Tvdb);
        let link =
            async |c: &mut PgConnection, m, k, p, v: &str| link(c, m, k, p, v).await.unwrap();
        assert_eq!(
            link(&mut c, movie, MediaKind::Movie, tmdb, "603").await,
            Link::Linked
        );
        assert_eq!(
            link(&mut c, other, MediaKind::Movie, tmdb, "603").await,
            Link::Taken
        );
        assert_eq!(
            link(&mut c, show, MediaKind::Series, tmdb, "603").await,
            Link::Linked
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

        assert_eq!(
            link(&mut c, movie, MediaKind::Movie, tvdb, "7").await,
            Link::Linked
        );
        assert_eq!(
            link(&mut c, other, MediaKind::Movie, tvdb, "7").await,
            Link::Linked
        );
        assert_eq!(
            find_numeric(&mut *c, MediaKind::Movie, tvdb, 7)
                .await
                .unwrap(),
            Some(movie)
        );

        assert_eq!(
            link(&mut c, movie, MediaKind::Movie, tmdb, "604").await,
            Link::Linked
        );
        assert_eq!(
            find_numeric(&mut *c, MediaKind::Movie, tmdb, 603)
                .await
                .unwrap(),
            None
        );

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
        assert_eq!(
            link(&mut c, movie, MediaKind::Movie, tmdb, "604").await,
            Link::Gone
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_type_change_moves_the_ids_and_can_clash(db: sqlx::PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let mut c = db.acquire().await.unwrap();
        let (movie, show) = (
            media(&db, MediaKind::Movie).await,
            media(&db, MediaKind::Series).await,
        );
        let tmdb = ExternalProvider::Tmdb;
        link(&mut c, movie, MediaKind::Movie, tmdb, "5")
            .await
            .unwrap();
        link(&mut c, show, MediaKind::Series, tmdb, "5")
            .await
            .unwrap();
        let retype = sqlx::query("UPDATE media SET type = 'series' WHERE id = $1")
            .bind(movie)
            .execute(&mut *c)
            .await;
        assert!(retype.is_err());
        unlink(&mut c, show, tmdb).await.unwrap();
        sqlx::query("UPDATE media SET type = 'series' WHERE id = $1")
            .bind(movie)
            .execute(&mut *c)
            .await
            .unwrap();
        assert_eq!(
            find_numeric(&mut *c, MediaKind::Series, tmdb, 5)
                .await
                .unwrap(),
            Some(movie)
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
        assert_eq!(
            all.fill(&mut c, m, MediaKind::Series).await.unwrap(),
            Written::default()
        );
        let only_imdb = Ids {
            imdb: Some("tt4".into()),
            ..Ids::default()
        };
        only_imdb.fill(&mut c, m, MediaKind::Series).await.unwrap();
        let read = |p: &str| {
            sqlx::query_scalar::<_, String>(
                r#"SELECT value FROM media_external_ids WHERE "mediaId" = $1 AND provider = $2"#,
            )
            .bind(m)
            .bind(p.to_owned())
        };
        assert_eq!(read("tmdb").fetch_one(&db).await.unwrap(), "1");
        assert_eq!(read("imdb").fetch_one(&db).await.unwrap(), "tt4");
        only_imdb
            .replace(&mut c, m, MediaKind::Series)
            .await
            .unwrap();
        assert!(read("tmdb").fetch_optional(&db).await.unwrap().is_none());
        sqlx::query("DELETE FROM media WHERE id = $1")
            .bind(m)
            .execute(&mut *c)
            .await
            .unwrap();
        assert!(all.fill(&mut c, m, MediaKind::Series).await.unwrap().gone);
    }
}
