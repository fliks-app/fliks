//! Artists, composers and the credits that name them (`docs/spec/music.md` rules 12 and 19).
use sqlx::PgConnection;

const MB: &str = "musicbrainz";

/// A credit as the writers take it: tags and provider records alike.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Credited {
    pub name: String,
    pub mbid: Option<String>,
    pub sort_name: Option<String>,
    pub credited_name: Option<String>,
    pub join_phrase: Option<String>,
    pub instrument: Option<String>,
}

/// The person holding this MusicBrainz id (live or alias), else the one of this name, else a new one.
/// A person that holds another artist id is someone else, and so is one known only from films or series.
pub async fn person(
    c: &mut PgConnection,
    name: &str,
    mbid: Option<&str>,
    sort_name: Option<&str>,
) -> sqlx::Result<i32> {
    // Lookup and insert are one step: two writers never both create the artist.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('music:persons'))")
        .execute(&mut *c)
        .await?;
    let by_id = match mbid {
        Some(id) => super::aliases::person_of(&mut *c, id).await?,
        None => None,
    };
    let found = match by_id {
        Some(id) => Some(id),
        None => {
            sqlx::query_scalar(
                r#"SELECT p.id FROM persons p
                   WHERE name_key(p.name) = name_key($1)
                     AND (NOT EXISTS (SELECT 1 FROM media_credits c JOIN media m ON m.id = c."mediaId"
                                       WHERE c."personId" = p.id AND m.type IN ('movie', 'series'))
                          OR EXISTS (SELECT 1 FROM media_credits c JOIN media m ON m.id = c."mediaId"
                                      WHERE c."personId" = p.id AND m.type IN ('book', 'comic', 'album'))
                          OR EXISTS (SELECT 1 FROM item_credits c WHERE c."personId" = p.id))
                     AND NOT EXISTS (SELECT 1 FROM person_external_ids x
                                      WHERE x."personId" = p.id AND x.provider = $2 AND x.value <> COALESCE($3, ''))
                   ORDER BY p.id LIMIT 1"#,
            )
            .bind(name)
            .bind(MB)
            .bind(mbid)
            .fetch_optional(&mut *c)
            .await?
        }
    };
    let id = match found {
        Some(id) => {
            sqlx::query(
                r#"UPDATE persons SET "sortName" = $2 WHERE id = $1 AND "sortName" IS NULL AND $2::text IS NOT NULL"#,
            )
            .bind(id)
            .bind(sort_name)
            .execute(&mut *c)
            .await?;
            id
        }
        None => {
            sqlx::query_scalar(
                r#"INSERT INTO persons (name, "sortName") VALUES ($1, $2) RETURNING id"#,
            )
            .bind(name)
            .bind(sort_name)
            .fetch_one(&mut *c)
            .await?
        }
    };
    if let Some(id_value) = mbid {
        sqlx::query(
            r#"INSERT INTO person_external_ids ("personId", provider, value)
               SELECT $1, $2, $3
                WHERE NOT EXISTS (SELECT 1 FROM person_external_ids WHERE "personId" = $1 AND provider = $2)
                  AND NOT EXISTS (SELECT 1 FROM person_external_id_aliases WHERE provider = $2 AND value = $3
                                    AND "personId" <> $1)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(id)
        .bind(MB)
        .bind(id_value)
        .execute(&mut *c)
        .await?;
    }
    Ok(id)
}

/// Replaces the album artists of `media` (role `artist`, no edition); an empty list changes nothing.
pub async fn replace_album_artists(
    c: &mut PgConnection,
    media: i32,
    list: &[Credited],
) -> sqlx::Result<()> {
    if list.is_empty() {
        return Ok(());
    }
    crate::media::write::orphans::hold(c).await?;
    let mut persons: Vec<i32> = vec![];
    for a in list {
        let p = person(c, &a.name, a.mbid.as_deref(), a.sort_name.as_deref()).await?;
        if !persons.contains(&p) {
            persons.push(p);
        }
    }
    let positions: Vec<i32> = (0..persons.len() as i32).collect();
    sqlx::query(r#"DELETE FROM media_credits WHERE "mediaId" = $1 AND role = 'artist' AND "editionId" IS NULL"#)
        .bind(media)
        .execute(&mut *c)
        .await?;
    sqlx::query(
        r#"INSERT INTO media_credits ("mediaId", "editionId", "personId", role, position)
           SELECT $1, NULL, t.p, 'artist', t.o FROM UNNEST($2::int[], $3::int[]) AS t(p, o)"#,
    )
    .bind(media)
    .bind(&persons)
    .bind(&positions)
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// Replaces the credits of one `role` of a track; a person credited twice in a role keeps the first place.
pub async fn replace_track_credits(
    c: &mut PgConnection,
    item: i32,
    role: &str,
    list: &[Credited],
) -> sqlx::Result<()> {
    crate::media::write::orphans::hold(c).await?;
    let mut rows: Vec<(i32, &Credited)> = vec![];
    for a in list {
        let p = person(c, &a.name, a.mbid.as_deref(), a.sort_name.as_deref()).await?;
        if !rows.iter().any(|(q, _)| *q == p) {
            rows.push((p, a));
        }
    }
    sqlx::query(r#"DELETE FROM item_credits WHERE "itemId" = $1 AND role = $2"#)
        .bind(item)
        .bind(role)
        .execute(&mut *c)
        .await?;
    for (position, (person, a)) in rows.into_iter().enumerate() {
        sqlx::query(
            r#"INSERT INTO item_credits ("itemId", "personId", role, position, "creditedName", "joinPhrase", instrument)
               VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
        )
        .bind(item)
        .bind(person)
        .bind(role)
        .bind(position as i32)
        .bind(a.credited_name.as_deref())
        .bind(a.join_phrase.as_deref())
        .bind(a.instrument.as_deref().filter(|_| role == "performer"))
        .execute(&mut *c)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;
    use std::time::Duration;

    #[sqlx::test(migrations = false)]
    async fn two_writers_never_create_the_same_artist(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let write = |db: PgPool| async move {
            let mut tx = db.begin().await.unwrap();
            let id = person(&mut tx, "Ana", None, None).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            tx.commit().await.unwrap();
            id
        };
        let (a, b) = tokio::join!(write(db.clone()), write(db.clone()));
        assert_eq!(a, b);
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM persons WHERE name = 'Ana'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 1);
    }
}
