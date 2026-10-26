//! Queries on `watch_parties`, `watch_party_items` and `watch_party_invitees` (`docs/spec/watch-party.md`, Model).
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use fliks_domain::party::{CHAT_CAP, Item, Message, Policy};
use sqlx::PgPool;
use std::collections::HashMap;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Row {
    pub id: i32,
    pub name: String,
    pub owner_id: i32,
    pub media_id: Option<i32>,
    pub media_file_id: Option<i32>,
    pub episode_id: Option<i32>,
    pub playlist_id: Option<i32>,
    pub invite_token: String,
    #[sqlx(try_from = "String")]
    pub policy: Policy,
    pub reactions_enabled: bool,
    pub chat_enabled: bool,
    pub link_sharing: bool,
    pub scheduled_at: Option<DateTime<Utc>>,
    pub status: String,
    pub position: f64,
}

impl Row {
    /// The playing item, or the programme's head before the start; `None` while it is empty.
    pub fn item(&self) -> Option<Item> {
        Some(Item {
            media_id: self.media_id?,
            media_file_id: self.media_file_id,
            episode_id: self.episode_id,
        })
    }
}

/// The item columns of a row: the playing item once started, else the head of the programme.
const COLS: &str = r#"p.id, p.name, p."ownerId" AS owner_id,
    CASE WHEN p.status = 'scheduled' THEN h."mediaId" ELSE p."mediaId" END AS media_id,
    CASE WHEN p.status = 'scheduled' THEN h."mediaFileId" ELSE p."mediaFileId" END AS media_file_id,
    CASE WHEN p.status = 'scheduled' THEN h."episodeId" ELSE p."episodeId" END AS episode_id,
    p."playlistId" AS playlist_id, p."inviteToken" AS invite_token,
    p.policy, p."reactionsEnabled" AS reactions_enabled, p."chatEnabled" AS chat_enabled,
    p."linkSharing" AS link_sharing, p."scheduledAt" AS scheduled_at, p.status, p.position"#;

const FROM: &str = r#"watch_parties p LEFT JOIN LATERAL (
    SELECT "mediaId", "mediaFileId", "episodeId" FROM watch_party_items
    WHERE "partyId" = p.id ORDER BY position LIMIT 1) h ON true"#;

pub fn new_token() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("os rng");
    URL_SAFE_NO_PAD.encode(b)
}

pub struct New<'a> {
    pub name: &'a str,
    pub owner: i32,
    pub programme: &'a [Item],
    pub playlist_id: Option<i32>,
    pub policy: Policy,
    pub reactions_enabled: bool,
    pub chat_enabled: bool,
    pub link_sharing: bool,
    pub scheduled_at: DateTime<Utc>,
}

/// The owner's host switches on their latest party, for the next one's defaults.
pub async fn owner_switches(db: &PgPool, owner: i32) -> sqlx::Result<Option<(bool, bool, bool)>> {
    sqlx::query_as(
        r#"SELECT "reactionsEnabled", "chatEnabled", "linkSharing" FROM watch_parties
           WHERE "ownerId" = $1 ORDER BY "createdAt" DESC, id DESC LIMIT 1"#,
    )
    .bind(owner)
    .fetch_optional(db)
    .await
}

/// The party the host already has for this item, else a new one (`true`). A "now" creation matches
/// an open party (live, or scheduled and already due at `now`); a scheduled one matches the same
/// start. Transaction-scoped advisory lock on host+item: the match is a time window, no unique
/// index fits.
pub async fn insert(
    db: &PgPool,
    n: &New<'_>,
    invitees: &[i32],
    immediate: bool,
) -> sqlx::Result<(Row, bool)> {
    let mut tx = db.begin().await?;
    let item = n.programme.first();
    let existing = match item {
        Some(item) => {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
                .bind(format!(
                    "party:{}:{}:{:?}:{:?}:{:?}",
                    n.owner, item.media_id, item.media_file_id, item.episode_id, n.playlist_id
                ))
                .execute(&mut *tx)
                .await?;
            // Read after the lock: a create queued behind another must see the party it just made.
            let now = Utc::now();
            sqlx::query_as::<_, Row>(&format!(
                r#"SELECT * FROM (SELECT {COLS} FROM {FROM}) r
           WHERE r.owner_id = $1 AND r.media_id = $2 AND r.media_file_id IS NOT DISTINCT FROM $3
             AND r.episode_id IS NOT DISTINCT FROM $4 AND r.playlist_id IS NOT DISTINCT FROM $5
             AND CASE WHEN $6 THEN r.status = 'live' OR (r.status = 'scheduled' AND r.scheduled_at <= $7)
                      ELSE r.status = 'scheduled' AND r.scheduled_at = $8 END
           ORDER BY r.id LIMIT 1"#
            ))
            .bind(n.owner)
            .bind(item.media_id)
            .bind(item.media_file_id)
            .bind(item.episode_id)
            .bind(n.playlist_id)
            .bind(immediate)
            .bind(now)
            .bind(n.scheduled_at)
            .fetch_optional(&mut *tx)
            .await?
        }
        None => None,
    };
    if let Some(row) = existing {
        return Ok((row, false));
    }
    let scheduled_at = if immediate {
        Utc::now()
    } else {
        n.scheduled_at
    };
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO watch_parties (name, "ownerId", "playlistId", "inviteToken", policy,
               "reactionsEnabled", "chatEnabled", "linkSharing", "scheduledAt", status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'scheduled')
           RETURNING id"#,
    )
    .bind(n.name)
    .bind(n.owner)
    .bind(n.playlist_id)
    .bind(new_token())
    .bind(n.policy.as_str())
    .bind(n.reactions_enabled)
    .bind(n.chat_enabled)
    .bind(n.link_sharing)
    .bind(scheduled_at)
    .fetch_one(&mut *tx)
    .await?;
    insert_items(&mut tx, id, n.programme).await?;
    add_invitees_in(&mut tx, id, invitees).await?;
    let row = sqlx::query_as(&format!("SELECT {COLS} FROM {FROM} WHERE p.id = $1"))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((row, true))
}

async fn insert_items(tx: &mut sqlx::PgConnection, party: i32, items: &[Item]) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO watch_party_items ("partyId", position, "mediaId", "mediaFileId", "episodeId")
           SELECT $1, (n - 1)::int, m, f, e
           FROM unnest($2::int[], $3::int[], $4::int[]) WITH ORDINALITY AS t(m, f, e, n)"#,
    )
    .bind(party)
    .bind(items.iter().map(|i| i.media_id).collect::<Vec<_>>())
    .bind(items.iter().map(|i| i.media_file_id).collect::<Vec<_>>())
    .bind(items.iter().map(|i| i.episode_id).collect::<Vec<_>>())
    .execute(tx)
    .await?;
    Ok(())
}

/// Replaces the programme in one transaction.
pub async fn set_programme(db: &PgPool, party: i32, items: &[Item]) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query(r#"DELETE FROM watch_party_items WHERE "partyId" = $1"#)
        .bind(party)
        .execute(&mut *tx)
        .await?;
    insert_items(&mut tx, party, items).await?;
    tx.commit().await
}

async fn add_invitees_in(
    tx: &mut sqlx::PgConnection,
    party: i32,
    users: &[i32],
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO watch_party_invitees ("partyId", "userId")
           SELECT $1, u FROM unnest($2::int[]) AS u ON CONFLICT DO NOTHING"#,
    )
    .bind(party)
    .bind(users)
    .execute(tx)
    .await?;
    Ok(())
}

/// The users newly invited: a link joiner or a kicked user is upgraded, an already invited one skipped.
pub async fn add_invitees(db: &PgPool, party: i32, users: &[i32]) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(
        r#"INSERT INTO watch_party_invitees ("partyId", "userId")
           SELECT $1, u FROM unnest($2::int[]) AS u
           ON CONFLICT ("partyId", "userId") DO UPDATE SET "source" = 'invite'
           WHERE watch_party_invitees."source" IN ('link', 'kicked') RETURNING "userId""#,
    )
    .bind(party)
    .bind(users)
    .fetch_all(db)
    .await
}

pub async fn get(db: &PgPool, id: i32) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {FROM} WHERE p.id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn by_token(db: &PgPool, token: &str) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(&format!(
        r#"SELECT {COLS} FROM {FROM} WHERE p."inviteToken" = $1"#
    ))
    .bind(token)
    .fetch_optional(db)
    .await
}

/// Every guest of the party, invitees and link joiners (a kicked user is not one): `(userId,
/// username, source)`.
pub async fn guests(db: &PgPool, party: i32) -> sqlx::Result<Vec<(i32, String, String)>> {
    sqlx::query_as(
        r#"SELECT i."userId", u.username, i."source" FROM watch_party_invitees i
           JOIN users u ON u.id = i."userId"
           WHERE i."partyId" = $1 AND i."source" <> 'kicked' ORDER BY i."userId""#,
    )
    .bind(party)
    .fetch_all(db)
    .await
}

pub async fn guest_ids(db: &PgPool, party: i32) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(
        r#"SELECT "userId" FROM watch_party_invitees
           WHERE "partyId" = $1 AND "source" <> 'kicked' ORDER BY "userId""#,
    )
    .bind(party)
    .fetch_all(db)
    .await
}

/// Remembers a user who joined through the link; an existing row keeps its source.
pub async fn add_link_guest(db: &PgPool, party: i32, user: i32) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO watch_party_invitees ("partyId", "userId", "source") VALUES ($1, $2, 'link')
           ON CONFLICT DO NOTHING"#,
    )
    .bind(party)
    .bind(user)
    .execute(db)
    .await?;
    Ok(())
}

/// A kick replaces whatever row the user had: they stop being a guest and the token stops working
/// for them until it is regenerated.
pub async fn kick_guest(db: &PgPool, party: i32, user: i32) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO watch_party_invitees ("partyId", "userId", "source") VALUES ($1, $2, 'kicked')
           ON CONFLICT ("partyId", "userId") DO UPDATE SET "source" = 'kicked'"#,
    )
    .bind(party)
    .bind(user)
    .execute(db)
    .await?;
    Ok(())
}

/// Removes every user who joined through the link, except `keep` (the live host); they are
/// returned so the caller can drop them from the live party.
pub async fn drop_link_guests(db: &PgPool, party: i32, keep: i32) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(
        r#"DELETE FROM watch_party_invitees
           WHERE "partyId" = $1 AND "source" = 'link' AND "userId" <> $2 RETURNING "userId""#,
    )
    .bind(party)
    .bind(keep)
    .fetch_all(db)
    .await
}

/// Removes the user's own invitation; false when they have none.
pub async fn drop_invitation(db: &PgPool, party: i32, user: i32) -> sqlx::Result<bool> {
    let r = sqlx::query(
        r#"DELETE FROM watch_party_invitees
           WHERE "partyId" = $1 AND "userId" = $2 AND "source" = 'invite'"#,
    )
    .bind(party)
    .bind(user)
    .execute(db)
    .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn clear_kicked(db: &PgPool, party: i32) -> sqlx::Result<()> {
    sqlx::query(r#"DELETE FROM watch_party_invitees WHERE "partyId" = $1 AND "source" = 'kicked'"#)
        .bind(party)
        .execute(db)
        .await?;
    Ok(())
}

async fn has_source(db: &PgPool, party: i32, user: i32, kicked: bool) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM watch_party_invitees
                          WHERE "partyId" = $1 AND "userId" = $2 AND ("source" = 'kicked') = $3)"#,
    )
    .bind(party)
    .bind(user)
    .bind(kicked)
    .fetch_one(db)
    .await
}

pub async fn is_invitee(db: &PgPool, party: i32, user: i32) -> sqlx::Result<bool> {
    has_source(db, party, user, false).await
}

pub async fn is_kicked(db: &PgPool, party: i32, user: i32) -> sqlx::Result<bool> {
    has_source(db, party, user, true).await
}

/// `live` first, then `scheduledAt` ascending.
pub async fn listed(db: &PgPool, user: i32) -> sqlx::Result<Vec<Row>> {
    sqlx::query_as(&format!(
        r#"SELECT {COLS} FROM {FROM}
           WHERE p.status IN ('scheduled', 'live')
             AND (p."ownerId" = $1 OR EXISTS (SELECT 1 FROM watch_party_invitees i
                                            WHERE i."partyId" = p.id AND i."userId" = $1
                                              AND i."source" <> 'kicked'))
           ORDER BY (p.status = 'live') DESC, p."scheduledAt" ASC NULLS LAST, p.id"#
    ))
    .bind(user)
    .fetch_all(db)
    .await
}

pub async fn live_rows(db: &PgPool) -> sqlx::Result<Vec<Row>> {
    sqlx::query_as(&format!(
        "SELECT {COLS} FROM {FROM} WHERE p.status = 'live'"
    ))
    .fetch_all(db)
    .await
}

pub async fn scheduled_rows(db: &PgPool) -> sqlx::Result<Vec<Row>> {
    sqlx::query_as(&format!(
        r#"SELECT {COLS} FROM {FROM} WHERE p.status = 'scheduled' AND p."scheduledAt" IS NOT NULL"#
    ))
    .fetch_all(db)
    .await
}

/// The `app_settings` value of `key`, if any.
pub async fn setting(db: &PgPool, key: &str) -> sqlx::Result<Option<String>> {
    let v: Option<Option<String>> =
        sqlx::query_scalar(r#"SELECT "value" FROM app_settings WHERE "key" = $1"#)
            .bind(key)
            .fetch_optional(db)
            .await?;
    Ok(v.flatten())
}

pub async fn update_settings(
    db: &PgPool,
    id: i32,
    name: &str,
    policy: Policy,
    switches: (bool, bool, bool),
    scheduled_at: Option<DateTime<Utc>>,
    token: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE watch_parties SET name = $2, policy = $3, "reactionsEnabled" = $4,
               "chatEnabled" = $5, "linkSharing" = $6, "scheduledAt" = $7, "inviteToken" = $8
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(name)
    .bind(policy.as_str())
    .bind(switches.0)
    .bind(switches.1)
    .bind(switches.2)
    .bind(scheduled_at)
    .bind(token)
    .execute(db)
    .await?;
    Ok(())
}

/// Goes live on the head of the programme, which becomes the playing item and is returned. `None`
/// when the party is not `scheduled` or its programme is empty: nothing changed.
pub async fn set_live(db: &PgPool, id: i32) -> sqlx::Result<Option<Item>> {
    let row: Option<(i32, Option<i32>, Option<i32>)> = sqlx::query_as(
        r#"UPDATE watch_parties p SET status = 'live', "startedAt" = now(),
               "mediaId" = h."mediaId", "mediaFileId" = h."mediaFileId", "episodeId" = h."episodeId"
           FROM (SELECT "mediaId", "mediaFileId", "episodeId" FROM watch_party_items
                 WHERE "partyId" = $1 ORDER BY position LIMIT 1) h
           WHERE p.id = $1 AND p.status = 'scheduled'
           RETURNING h."mediaId", h."mediaFileId", h."episodeId""#,
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(media_id, media_file_id, episode_id)| Item {
        media_id,
        media_file_id,
        episode_id,
    }))
}

pub async fn set_ended(db: &PgPool, id: i32) -> sqlx::Result<()> {
    sqlx::query(r#"UPDATE watch_parties SET status = 'ended', "endedAt" = now() WHERE id = $1 AND status <> 'ended'"#)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn persist(db: &PgPool, id: i32, position: f64, item: &Item) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE watch_parties SET position = $2, "mediaId" = $3, "mediaFileId" = $4, "episodeId" = $5
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(position)
    .bind(item.media_id)
    .bind(item.media_file_id)
    .bind(item.episode_id)
    .execute(db)
    .await?;
    Ok(())
}

/// Appends a chat message; a repeat of the same id is ignored.
pub async fn save_message(db: &PgPool, party: i32, m: &Message) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO watch_party_messages ("partyId", id, "userId", username, text, system, "sentAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING"#,
    )
    .bind(party)
    .bind(m.id as i64)
    .bind(m.user_id)
    .bind(&m.username)
    .bind(&m.text)
    .bind(m.system.as_ref().map(|s| serde_json::to_value(s).expect("typed")))
    .bind(DateTime::from_timestamp_millis(m.sent_at_ms).unwrap_or_default())
    .execute(db)
    .await?;
    Ok(())
}

/// Drops the chat of a party that ended: nothing reads it again.
pub async fn clear_chat(db: &PgPool, party: i32) -> sqlx::Result<()> {
    sqlx::query(r#"DELETE FROM watch_party_messages WHERE "partyId" = $1"#)
        .bind(party)
        .execute(db)
        .await?;
    Ok(())
}

/// The last `CHAT_CAP` messages, oldest first.
pub async fn load_chat(db: &PgPool, party: i32) -> sqlx::Result<Vec<Message>> {
    type R = (
        i64,
        Option<i32>,
        Option<String>,
        String,
        Option<serde_json::Value>,
        DateTime<Utc>,
    );
    let rows: Vec<R> = sqlx::query_as(
        r#"SELECT id, "userId", username, text, system, "sentAt" FROM watch_party_messages
           WHERE "partyId" = $1 ORDER BY id DESC LIMIT $2"#,
    )
    .bind(party)
    .bind(CHAT_CAP as i64)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .rev()
        .map(|(id, user_id, username, text, system, at)| Message {
            id: id as u64,
            user_id,
            username,
            text,
            system: system.and_then(|v| serde_json::from_value(v).ok()),
            sent_at_ms: at.timestamp_millis(),
        })
        .collect())
}

pub async fn usernames(db: &PgPool, ids: &[i32]) -> sqlx::Result<HashMap<i32, String>> {
    let rows: Vec<(i32, String)> =
        sqlx::query_as("SELECT id, username FROM users WHERE id = ANY($1)")
            .bind(ids)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().collect())
}

/// The subset of `users` the owner follows with an accepted follow.
pub async fn followed(db: &PgPool, owner: i32, users: &[i32]) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(
        r#"SELECT "followingId" FROM user_follows
           WHERE "followerId" = $1 AND "followingId" = ANY($2) AND status = 'accepted'"#,
    )
    .bind(owner)
    .bind(users)
    .fetch_all(db)
    .await
}

/// What a party shows of its media; the fanart fields are the media DTO's, picked from by the client.
#[derive(Clone)]
pub struct ItemInfo {
    pub title: String,
    pub poster_url: Option<String>,
    pub fanart_url: Option<String>,
    pub additional_fanart_urls: Vec<String>,
}

/// Media title (with `S01E02` for an episode) and artwork of every `(media, episode)` key, in one
/// query; a media that is gone is missing from the map.
pub async fn item_infos(
    db: &PgPool,
    keys: &[(i32, Option<i32>)],
) -> sqlx::Result<HashMap<(i32, Option<i32>), ItemInfo>> {
    type Row = (
        i32,
        Option<i32>,
        String,
        Option<String>,
        Option<String>,
        Option<Vec<String>>,
        Option<i32>,
        Option<i32>,
    );
    let (media, episode): (Vec<i32>, Vec<Option<i32>>) = keys.iter().copied().unzip();
    let rows: Vec<Row> = sqlx::query_as(
        r#"SELECT q.media, q.episode, m.title, m."posterUrl", m."fanartUrl", m."additionalFanartUrls",
                  s."seasonNumber", e."episodeNumber"
           FROM unnest($1::int[], $2::int[]) AS q(media, episode)
           JOIN media m ON m.id = q.media
           LEFT JOIN episodes e ON e.id = q.episode
           LEFT JOIN seasons s ON s.id = e."seasonId""#,
    )
    .bind(media)
    .bind(episode)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(media, episode, title, poster, fanart, additional, season, number)| {
                let title = match (season, number) {
                    (Some(s), Some(e)) => format!("{title} S{s:02}E{e:02}"),
                    _ => title,
                };
                (
                    (media, episode),
                    ItemInfo {
                        title,
                        poster_url: poster,
                        fanart_url: fanart,
                        additional_fanart_urls: additional.unwrap_or_default(),
                    },
                )
            },
        )
        .collect())
}

/// The library of each of the media, for access checks done in memory.
pub async fn media_libraries(db: &PgPool, media: &[i32]) -> sqlx::Result<HashMap<i32, i32>> {
    let rows: Vec<(i32, Option<i32>)> =
        sqlx::query_as(r#"SELECT id, "libraryId" FROM media WHERE id = ANY($1)"#)
            .bind(media)
            .fetch_all(db)
            .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, lib)| lib.map(|l| (id, l)))
        .collect())
}

/// True when the file and the episode (if given) belong to the media, and something plays for it; a
/// series needs its episode.
pub async fn item_valid(db: &PgPool, item: &Item) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        r#"SELECT ($2::int IS NULL OR EXISTS (SELECT 1 FROM media_files WHERE id = $2 AND "mediaId" = $1))
               AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM episodes e JOIN seasons s ON s.id = e."seasonId"
                                               WHERE e.id = $3 AND s."mediaId" = $1))
               AND ($3::int IS NOT NULL OR NOT EXISTS (SELECT 1 FROM media WHERE id = $1 AND type = 'series'))
               AND EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = $1
                           AND ($3::int IS NULL OR f."episodeId" = $3))"#,
    )
    .bind(item.media_id)
    .bind(item.media_file_id)
    .bind(item.episode_id)
    .fetch_one(db)
    .await
}

/// Names of the playlists the parties follow.
pub async fn playlist_names(db: &PgPool, ids: &[i32]) -> sqlx::Result<HashMap<i32, String>> {
    let rows: Vec<(i32, String)> =
        sqlx::query_as("SELECT id, name FROM playlists WHERE id = ANY($1)")
            .bind(ids)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().collect())
}

/// A programme or playlist row as a party item; `playable` when the media has a file for it.
pub struct QueueRow {
    pub item: Item,
    pub playable: bool,
}

/// The programme in its order.
pub async fn programme_rows(db: &PgPool, party: i32) -> sqlx::Result<Vec<QueueRow>> {
    let rows: Vec<(i32, Option<i32>, Option<i32>, bool)> = sqlx::query_as(
        r#"SELECT i."mediaId", i."mediaFileId", i."episodeId",
                  EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = i."mediaId"
                          AND (i."episodeId" IS NULL OR f."episodeId" = i."episodeId"))
           FROM watch_party_items i WHERE i."partyId" = $1 ORDER BY i.position"#,
    )
    .bind(party)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(media_id, media_file_id, episode_id, playable)| QueueRow {
            item: Item {
                media_id,
                media_file_id,
                episode_id,
            },
            playable,
        })
        .collect())
}

/// The playlist's rows in its order (`playlists.md` rule 13).
pub async fn playlist_rows(db: &PgPool, playlist: i32) -> sqlx::Result<Vec<QueueRow>> {
    let rows: Vec<(i32, Option<i32>, bool)> = sqlx::query_as(
        r#"SELECT pi."mediaId", pi."episodeId",
                  EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = pi."mediaId"
                          AND (pi."episodeId" IS NULL OR f."episodeId" = pi."episodeId"))
           FROM playlist_items pi WHERE pi."playlistId" = $1 ORDER BY pi.position, pi.id"#,
    )
    .bind(playlist)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(media_id, episode_id, playable)| QueueRow {
            item: Item {
                media_id,
                media_file_id: None,
                episode_id,
            },
            playable,
        })
        .collect())
}
