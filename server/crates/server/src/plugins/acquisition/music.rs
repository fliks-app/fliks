//! The music reads and writes of the import lists (`docs/spec/plugins.md`): a track wanted by its recording, a
//! playlist mirrored from item ids. The plugin never calls MusicBrainz itself: the host resolves for it.
use super::*;
use crate::media::external_ids;
use crate::metadata::music::target;
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

/// The item of `media` a recording names; `owned` keeps only the tracks that have a file.
async fn item_of(
    db: &PgPool,
    media: Option<i32>,
    recording: &t::RecordingRef,
    owned: bool,
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
              AND (NOT $3 OR EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = td."itemId"))
            ORDER BY (i."editionId" = ad."targetEditionId") DESC, td."itemId" LIMIT 1"#
    )))
    .bind(value)
    .bind(media)
    .bind(owned)
    .fetch_optional(db)
    .await
}

fn normalized(recording: t::RecordingRef) -> Result<t::RecordingRef, HostError> {
    Ok(match recording {
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
    })
}

/// The track of a recording that a library holds a file for, found without creating or monitoring anything.
pub async fn find_recording(
    st: &AppState,
    recording: t::RecordingRef,
) -> Result<Option<t::WantedTrack>, HostError> {
    let recording = normalized(recording)?;
    Ok(item_of(&st.db, None, &recording, true)
        .await
        .map_err(db_err)?
        .map(|(media, item)| t::WantedTrack {
            media_id: media as u32,
            item_id: item as u32,
        }))
}

/// Refuses a group the metadata profile of the library it would be created in rejects.
async fn check_profile(st: &AppState, group: &str, library: Option<u32>) -> Result<(), HostError> {
    let library = library
        .map(i32::try_from)
        .transpose()
        .map_err(|_| host_err("ERR_VALIDATION", "libraryId is out of range"))?;
    let all = crate::media::write::all_library_ids(&st.db)
        .await
        .map_err(db_err)?;
    let target = crate::media::write::resolve_target_in(st, &all, MediaKind::Album, library, None)
        .await
        .map_err(|e| host_err("ERR_VALIDATION", e.text()))?;
    let lang = crate::metadata::library_language(st, target.id)
        .await
        .map_err(|e| host_err("ERR", e.text()))?;
    let fetched = crate::metadata::music::fetch(
        st,
        Namespace::MUSICBRAINZ,
        group,
        &lang,
        Priority::Background,
    )
    .await
    .map_err(|e| host_err("unavailable", e.text()))?;
    let profile = crate::libraries::metadata_profile(&st.db, target.id)
        .await
        .map_err(db_err)?;
    let secondary: Vec<String> = fetched
        .album
        .secondary_types
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    if profile.allows_group(fetched.album.primary_type, &secondary) {
        return Ok(());
    }
    Err(host_err(
        "ERR_NOT_FOUND",
        "the album is outside the library's metadata profile",
    ))
}

async fn has_target(db: &PgPool, media: i32) -> Result<bool, HostError> {
    sqlx::query_scalar(
        r#"SELECT COALESCE((SELECT "targetEditionId" IS NOT NULL FROM album_details WHERE "mediaId" = $1), false)"#,
    )
    .bind(media)
    .fetch_one(db)
    .await
    .map_err(db_err)
}

/// The item of `recording` on the album just resolved. An album with no target edition (its provider call
/// failed) is asked again once; if it still has none the call is retryable, and an album this call made, or
/// one nobody monitored, goes back to unmonitored.
async fn held_track(
    st: &AppState,
    media: i32,
    recording: &t::RecordingRef,
    existed: bool,
) -> Result<i32, HostError> {
    if let Some((_, item)) = item_of(&st.db, Some(media), recording, false)
        .await
        .map_err(db_err)?
    {
        return Ok(item);
    }
    if has_target(&st.db, media).await? {
        return Err(host_err(
            "ERR_NOT_FOUND",
            "the album has no track of that ISRC",
        ));
    }
    let was: bool = sqlx::query_scalar("SELECT monitored FROM media WHERE id = $1")
        .bind(media)
        .fetch_one(&st.db)
        .await
        .map_err(db_err)?;
    sqlx::query("UPDATE media SET monitored = true WHERE id = $1")
        .bind(media)
        .execute(&st.db)
        .await
        .map_err(db_err)?;
    if let Err(e) = target::ensure(st, media, Priority::Background).await {
        tracing::warn!("album #{media}: no target edition yet: {}", e.text());
    }
    if let Some((_, item)) = item_of(&st.db, Some(media), recording, false)
        .await
        .map_err(db_err)?
    {
        return Ok(item);
    }
    if !existed || !was {
        sqlx::query("UPDATE media SET monitored = false WHERE id = $1")
            .bind(media)
            .execute(&st.db)
            .await
            .map_err(db_err)?;
    }
    if has_target(&st.db, media).await? {
        return Err(host_err(
            "ERR_NOT_FOUND",
            "the album has no track of that ISRC",
        ));
    }
    Err(host_err(
        "unavailable",
        "the album's releases are not available yet",
    ))
}

/// The track a recording names, wanted: its item and its album monitored. An album this call creates keeps
/// only that track monitored, one the library already had keeps its other tracks as they are.
pub async fn want_recording(
    st: &AppState,
    plugin_id: &str,
    recording: t::RecordingRef,
    library_id: Option<u32>,
) -> Result<t::WantedTrack, HostError> {
    let recording = normalized(recording)?;
    let known = item_of(&st.db, None, &recording, false)
        .await
        .map_err(db_err)?;
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
                if !existed {
                    check_profile(st, &group.value, library_id).await?;
                }
                let media =
                    resolve_or_create(st, plugin_id, "album", &ids, library_id, None).await? as i32;
                let found = held_track(st, media, &recording, existed).await?;
                (media, found, !existed)
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

/// The playlist `name` of `user` that `plugin` created, made when missing, holding the items of `items` the
/// owner can read, in that order; the rows other users added stay. An id that is no readable item is skipped.
pub async fn playlist_sync(
    st: &AppState,
    plugin: &str,
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
    let readable = crate::requests::services::libraries_of(st, user)
        .await
        .map_err(db_err)?;
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
        .bind(format!("playlist-sync:{plugin}:{user}:{name}"))
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    let held: Option<(i32, bool)> = sqlx::query_as(
        r#"SELECT id, rules IS NOT NULL FROM playlists
            WHERE "ownerId" = $1 AND "pluginId" = $2 AND name = $3 FOR UPDATE"#,
    )
    .bind(user)
    .bind(plugin)
    .bind(name)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_err)?;
    let playlist = match held {
        Some((_, true)) => {
            return Err(host_err(
                "ERR_CONFLICT",
                "the playlist became a smart playlist",
            ));
        }
        Some((id, false)) => id,
        None => sqlx::query_scalar(
            r#"INSERT INTO playlists (name, "ownerId", "pluginId") VALUES ($1, $2, $3) RETURNING id"#,
        )
        .bind(name)
        .bind(user)
        .bind(plugin)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?,
    };
    let ids: Vec<i32> = sqlx::query_scalar(
        r#"SELECT t.i FROM unnest($1::int[]) WITH ORDINALITY AS t(i, n)
            WHERE EXISTS (SELECT 1 FROM items i JOIN media m ON m.id = i."mediaId"
                           LEFT JOIN editions e ON e.id = i."editionId"
                          WHERE i.id = t.i AND m."libraryId" = ANY($2)
                            AND COALESCE(e."libraryId", m."libraryId") = ANY($2))
            ORDER BY t.n"#,
    )
    .bind(&ids)
    .bind(&readable)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    sqlx::query(
        r#"DELETE FROM playlist_items
            WHERE "playlistId" = $1 AND "addedById" IS NOT DISTINCT FROM $2 AND NOT ("itemId" = ANY($3))"#,
    )
    .bind(playlist)
    .bind(user)
    .bind(&ids)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    sqlx::query(
        r#"INSERT INTO playlist_items ("playlistId", "itemId", "addedById", position)
           SELECT $1, t.i, $2, t.n::int - 1 FROM unnest($3::int[]) WITH ORDINALITY AS t(i, n)
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

    async fn user(db: &PgPool, name: &str, library: bool) -> i32 {
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, enabled) VALUES ($1, true) RETURNING id"#,
        )
        .bind(name)
        .fetch_one(db)
        .await
        .unwrap();
        if library {
            sqlx::query(
                r#"INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, $1)"#,
            )
            .bind(id)
            .execute(db)
            .await
            .unwrap();
        }
        id
    }

    async fn rows(db: &PgPool, playlist: u32) -> Vec<i32> {
        sqlx::query_scalar(
            r#"SELECT "itemId" FROM playlist_items WHERE "playlistId" = $1 ORDER BY position, id"#,
        )
        .bind(playlist as i32)
        .fetch_all(db)
        .await
        .unwrap()
    }

    fn order(v: &[i32]) -> Vec<u32> {
        v.iter().map(|i| *i as u32).collect()
    }

    #[sqlx::test(migrations = false)]
    async fn a_playlist_mirrors_the_readable_items_in_order(db: PgPool) {
        let ids = items(&db).await;
        let u = user(&db, "u", true).await;
        let st = state(&db);
        let first = playlist_sync(
            &st,
            "p",
            u as u32,
            "Mix",
            &order(&[ids[2], ids[0], 999_999]),
        )
        .await
        .unwrap();
        assert_eq!(rows(&db, first).await, [ids[2], ids[0]]);
        let again = playlist_sync(&st, "p", u as u32, "Mix", &order(&[ids[1], ids[0]]))
            .await
            .unwrap();
        assert_eq!(
            again, first,
            "the playlist of that plugin and name is reused"
        );
        assert_eq!(rows(&db, first).await, [ids[1], ids[0]]);
        let none = playlist_sync(&st, "p", 9999, "Mix", &[]).await;
        assert_eq!(none.unwrap_err().code, "ERR_NOT_FOUND");
        let blind = user(&db, "blind", false).await;
        let hidden = playlist_sync(&st, "p", blind as u32, "Mix", &order(&ids))
            .await
            .unwrap();
        assert!(
            rows(&db, hidden).await.is_empty(),
            "no track of an unreadable library"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_sync_never_touches_a_playlist_it_did_not_create(db: PgPool) {
        let ids = items(&db).await;
        let u = user(&db, "u", true).await;
        let guest = user(&db, "guest", true).await;
        let st = state(&db);
        let own: i32 = sqlx::query_scalar(
            r#"INSERT INTO playlists (name, "ownerId") VALUES ('Mix', $1) RETURNING id"#,
        )
        .bind(u)
        .fetch_one(&db)
        .await
        .unwrap();
        sqlx::query(r#"INSERT INTO playlist_items ("playlistId", "itemId", "addedById", position) VALUES ($1, $2, $3, 0)"#)
            .bind(own)
            .bind(ids[2])
            .bind(u)
            .execute(&db)
            .await
            .unwrap();
        let mirrored = playlist_sync(&st, "p", u as u32, "Mix", &order(&[ids[0]]))
            .await
            .unwrap();
        assert_ne!(
            mirrored as i32, own,
            "a user's playlist of that name is left alone"
        );
        assert_eq!(rows(&db, own as u32).await, [ids[2]]);
        let other = playlist_sync(&st, "q", u as u32, "Mix", &order(&[ids[1]]))
            .await
            .unwrap();
        assert_ne!(other, mirrored, "another plugin gets its own");
        assert_eq!(rows(&db, mirrored).await, [ids[0]]);
        // A collaborator's row stays; the owner's rows follow the list.
        sqlx::query(r#"INSERT INTO playlist_items ("playlistId", "itemId", "addedById", position) VALUES ($1, $2, $3, 5)"#)
            .bind(mirrored as i32)
            .bind(ids[2])
            .bind(guest)
            .execute(&db)
            .await
            .unwrap();
        playlist_sync(&st, "p", u as u32, "Mix", &order(&[ids[1]]))
            .await
            .unwrap();
        assert_eq!(rows(&db, mirrored).await, [ids[1], ids[2]]);
        // A playlist turned smart is refused, a list that changes owner gets a new playlist.
        sqlx::query(r#"UPDATE playlists SET rules = '{}' WHERE id = $1"#)
            .bind(mirrored as i32)
            .execute(&db)
            .await
            .unwrap();
        let smart = playlist_sync(&st, "p", u as u32, "Mix", &[]).await;
        assert_eq!(smart.unwrap_err().code, "ERR_CONFLICT");
        let moved = playlist_sync(&st, "q", guest as u32, "Mix", &order(&[ids[1]]))
            .await
            .unwrap();
        assert_ne!(moved, other);
        assert_eq!(rows(&db, other).await, [ids[1]], "the old owner keeps hers");
    }
}
