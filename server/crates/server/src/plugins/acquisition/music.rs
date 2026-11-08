//! The music reads and writes of the import lists (`docs/spec/plugins.md`): a track wanted by its recording, a
//! playlist mirrored from item ids. The plugin never calls MusicBrainz itself: the host resolves for it.
use super::*;
use crate::media::external_ids;
use crate::plugins::imports::{db_err, host_err};
use crate::plugins::runtime::HostError;
use fliks_domain::external_id::{ExternalProvider, Namespace};
use fliks_domain::metadata::limiter::Priority;

const MAX_ITEMS: usize = 10_000;

/// `ids` plus the MusicBrainz release group that a Spotify, Deezer or ISRC id names, read through the provider's
/// `find-by`; unchanged when the list already holds a MusicBrainz id or no entry resolves.
pub(super) async fn with_group(
    st: &AppState,
    ids: &[t::ExternalId],
) -> Result<Vec<t::ExternalId>, HostError> {
    let mut out = ids.to_vec();
    if ids.iter().any(|i| i.provider == "musicbrainz") {
        return Ok(out);
    }
    let known = st.namespaces();
    for i in ids {
        let Some(ns) = known.parse(&i.provider).filter(|n| {
            matches!(
                n.core(),
                Some(ExternalProvider::Spotify | ExternalProvider::Deezer | ExternalProvider::Isrc)
            )
        }) else {
            continue;
        };
        let Some(value) = known.normalize(ns, &i.value) else {
            continue;
        };
        if !st.metadata.available(Namespace::MUSICBRAINZ) {
            return Err(host_err("unavailable", "the music provider is unavailable"));
        }
        let lang = st
            .metadata
            .lang
            .resolve(None)
            .await
            .map_err(|e| host_err("ERR", format!("{e:?}")))?;
        let found = st
            .metadata
            .of(Namespace::MUSICBRAINZ)
            .find_by(ns, &value, &lang, Priority::Background)
            .await
            .map_err(|e| host_err("unavailable", format!("{e:?}")))?;
        if let Some((group, MediaKind::Album)) = found {
            out.push(t::ExternalId {
                provider: "musicbrainz".into(),
                value: group,
            });
            break;
        }
    }
    Ok(out)
}

/// The item of `media` a recording names.
async fn item_of(
    db: &PgPool,
    media: Option<i32>,
    recording: &t::RecordingRef,
) -> sqlx::Result<Option<(i32, i32)>> {
    let (column, value) = match recording {
        t::RecordingRef::Isrc(v) => ("isrc", v.as_str()),
        t::RecordingRef::Mbid(v) => ("\"recordingMbid\"::text", v.as_str()),
    };
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT td."mediaId", td."itemId" FROM track_details td
             JOIN album_details ad ON ad."mediaId" = td."mediaId"
             JOIN items i ON i.id = td."itemId"
            WHERE td.{column} = $1 AND ($2::int IS NULL OR td."mediaId" = $2)
            ORDER BY (i."editionId" = ad."targetEditionId") DESC, td."itemId" LIMIT 1"#
    )))
    .bind(value)
    .bind(media)
    .fetch_optional(db)
    .await
}

/// The track a recording names, wanted: its item and its album monitored. An album this call creates keeps
/// only that track monitored, one the library already had keeps its other tracks as they are.
pub async fn want_recording(
    st: &AppState,
    plugin_id: &str,
    recording: t::RecordingRef,
    library_id: Option<u32>,
) -> Result<t::WantedTrack, HostError> {
    let recording = match recording {
        t::RecordingRef::Isrc(v) => t::RecordingRef::Isrc(
            ExternalProvider::Isrc
                .normalize(&v)
                .ok_or_else(|| host_err("ERR_VALIDATION", "not an ISRC"))?,
        ),
        t::RecordingRef::Mbid(v) => t::RecordingRef::Mbid(
            ExternalProvider::MusicBrainz
                .normalize(&v)
                .ok_or_else(|| host_err("ERR_VALIDATION", "not a MusicBrainz id"))?,
        ),
    };
    let known = item_of(&st.db, None, &recording).await.map_err(db_err)?;
    let (media, item, fresh) = match known {
        Some((m, i)) => (m, i, false),
        None => match &recording {
            t::RecordingRef::Mbid(_) => {
                return Err(host_err(
                    "ERR_NOT_FOUND",
                    "no album of the library has that recording",
                ));
            }
            t::RecordingRef::Isrc(isrc) => {
                let ids = [t::ExternalId {
                    provider: "isrc".into(),
                    value: isrc.clone(),
                }];
                let ids = with_group(st, &ids).await?;
                let group = ids
                    .iter()
                    .find(|i| i.provider == "musicbrainz")
                    .ok_or_else(|| host_err("ERR_NOT_FOUND", "no album names that ISRC"))?;
                let existed = external_ids::find(
                    &st.db,
                    MediaKind::Album,
                    Namespace::MUSICBRAINZ,
                    &group.value,
                )
                .await
                .map_err(db_err)?
                .is_some();
                let media =
                    resolve_or_create(st, plugin_id, "album", &ids, library_id, None).await? as i32;
                let found = item_of(&st.db, Some(media), &recording)
                    .await
                    .map_err(db_err)?;
                let (_, item) = found.ok_or_else(|| {
                    host_err("ERR_NOT_FOUND", "the album has no track of that ISRC")
                })?;
                (media, item, !existed)
            }
        },
    };
    if fresh {
        sqlx::query(
            r#"UPDATE items SET monitored = false
                WHERE "mediaId" = $1 AND id <> $2
                  AND "editionId" = (SELECT "targetEditionId" FROM album_details WHERE "mediaId" = $1)"#,
        )
        .bind(media)
        .bind(item)
        .execute(&st.db)
        .await
        .map_err(db_err)?;
    }
    sqlx::query("UPDATE items SET monitored = true WHERE id = $1")
        .bind(item)
        .execute(&st.db)
        .await
        .map_err(db_err)?;
    sqlx::query("UPDATE media SET monitored = true WHERE id = $1 AND NOT monitored")
        .bind(media)
        .execute(&st.db)
        .await
        .map_err(db_err)?;
    Ok(t::WantedTrack {
        media_id: media as u32,
        item_id: item as u32,
    })
}

/// The playlist `name` of `user`, created when missing, holding exactly `items` in that order; an id that is
/// no item is skipped. Answers the playlist id.
pub async fn playlist_sync(
    st: &AppState,
    user: u32,
    name: &str,
    items: &[u32],
) -> Result<u32, HostError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 255 {
        return Err(host_err(
            "ERR_VALIDATION",
            "a playlist name is 1 to 255 characters",
        ));
    }
    if items.len() > MAX_ITEMS {
        return Err(host_err(
            "ERR_VALIDATION",
            format!("at most {MAX_ITEMS} items"),
        ));
    }
    let user =
        i32::try_from(user).map_err(|_| host_err("ERR_VALIDATION", "user-id is out of range"))?;
    let mut seen = std::collections::HashSet::new();
    let ids: Vec<i32> = items
        .iter()
        .filter_map(|i| i32::try_from(*i).ok())
        .filter(|i| seen.insert(*i))
        .collect();
    let mut tx = st.db.begin().await.map_err(db_err)?;
    let enabled: Option<bool> = sqlx::query_scalar("SELECT enabled FROM users WHERE id = $1")
        .bind(user)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_err)?;
    if enabled != Some(true) {
        return Err(host_err("ERR_NOT_FOUND", format!("User #{user} not found")));
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("playlist-sync:{user}:{name}"))
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    let held: Option<i32> = sqlx::query_scalar(
        r#"SELECT id FROM playlists WHERE "ownerId" = $1 AND name = $2 ORDER BY id LIMIT 1"#,
    )
    .bind(user)
    .bind(name)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_err)?;
    let playlist = match held {
        Some(id) => id,
        None => sqlx::query_scalar(
            r#"INSERT INTO playlists (name, "ownerId") VALUES ($1, $2) RETURNING id"#,
        )
        .bind(name)
        .bind(user)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?,
    };
    sqlx::query(
        r#"DELETE FROM playlist_items WHERE "playlistId" = $1 AND NOT ("itemId" = ANY($2))"#,
    )
    .bind(playlist)
    .bind(&ids)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    sqlx::query(
        r#"INSERT INTO playlist_items ("playlistId", "itemId", "addedById", position)
           SELECT $1, t.i, $2, t.n::int - 1 FROM unnest($3::int[]) WITH ORDINALITY AS t(i, n)
            WHERE EXISTS (SELECT 1 FROM items WHERE id = t.i)
           ON CONFLICT ("playlistId", "itemId") DO UPDATE SET position = EXCLUDED.position"#,
    )
    .bind(playlist)
    .bind(user)
    .bind(&ids)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    sqlx::query(r#"UPDATE playlists SET "updatedAt" = now() WHERE id = $1"#)
        .bind(playlist)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(playlist as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(db: &PgPool) -> AppState {
        AppState::new(
            db.clone(),
            crate::config::Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        )
    }

    async fn items(db: &PgPool) -> Vec<i32> {
        crate::db::migrate(db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'M', '["album"]');
               INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
               INSERT INTO media (id, title, type, "libraryId", "folderName", monitored)
                 VALUES (1, 'Salt Meadows', 'album', 1, 'a/b', false);
               INSERT INTO editions ("mediaId", family) VALUES (1, 'audio');
               INSERT INTO items ("mediaId", "editionId", monitored, title)
                 SELECT 1, e.id, false, 'T' || n FROM editions e, generate_series(1, 3) n;
               INSERT INTO track_details ("itemId", "mediaId", position, "recordingMbid")
                 SELECT i.id, 1, 1, ('00000000-0000-0000-0000-00000000000' || (i.id % 10))::uuid FROM items i;
               INSERT INTO album_details ("mediaId", "targetEditionId") SELECT 1, id FROM editions"#,
        )
        .execute(db)
        .await
        .unwrap();
        sqlx::query_scalar("SELECT id FROM items ORDER BY id")
            .fetch_all(db)
            .await
            .unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn a_known_recording_wants_its_track_and_album(db: PgPool) {
        let ids = items(&db).await;
        let st = state(&db);
        let rec = format!("00000000-0000-0000-0000-00000000000{}", ids[1] % 10);
        let w = want_recording(&st, "p", t::RecordingRef::Mbid(rec.clone()), None)
            .await
            .unwrap();
        assert_eq!((w.media_id, w.item_id), (1, ids[1] as u32));
        let monitored: Vec<bool> = sqlx::query_scalar("SELECT monitored FROM items ORDER BY id")
            .fetch_all(&db)
            .await
            .unwrap();
        assert_eq!(monitored, [false, true, false]);
        assert!(
            sqlx::query_scalar::<_, bool>("SELECT monitored FROM media WHERE id = 1")
                .fetch_one(&db)
                .await
                .unwrap()
        );
        let unknown = want_recording(
            &st,
            "p",
            t::RecordingRef::Mbid("99999999-9999-9999-9999-999999999999".into()),
            None,
        )
        .await;
        assert_eq!(unknown.unwrap_err().code, "ERR_NOT_FOUND");
        let bad = want_recording(&st, "p", t::RecordingRef::Isrc("nope".into()), None).await;
        assert_eq!(bad.unwrap_err().code, "ERR_VALIDATION");
    }

    #[sqlx::test(migrations = false)]
    async fn a_playlist_mirrors_the_items_in_order(db: PgPool) {
        let ids = items(&db).await;
        let user: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, enabled) VALUES ('u', true) RETURNING id"#,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let st = state(&db);
        let order = |v: &[i32]| v.iter().map(|i| *i as u32).collect::<Vec<_>>();
        let first = playlist_sync(&st, user as u32, "Mix", &order(&[ids[2], ids[0], 999_999]))
            .await
            .unwrap();
        let read = || async {
            sqlx::query_scalar::<_, i32>(
                r#"SELECT "itemId" FROM playlist_items WHERE "playlistId" = $1 ORDER BY position"#,
            )
            .bind(first as i32)
            .fetch_all(&db)
            .await
            .unwrap()
        };
        assert_eq!(read().await, [ids[2], ids[0]]);
        let again = playlist_sync(&st, user as u32, "Mix", &order(&[ids[1], ids[0]]))
            .await
            .unwrap();
        assert_eq!(again, first, "the playlist of that name is reused");
        assert_eq!(read().await, [ids[1], ids[0]]);
        let none = playlist_sync(&st, 9999, "Mix", &[]).await;
        assert_eq!(none.unwrap_err().code, "ERR_NOT_FOUND");
    }
}
