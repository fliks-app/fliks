//! Queries on `watch_parties` and `watch_party_invitees` (`docs/spec/watch-party.md`, Model).
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use fliks_domain::party::Item;
use sqlx::PgPool;
use std::collections::HashMap;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Row {
    pub id: i32,
    pub name: String,
    pub owner_id: i32,
    pub media_id: i32,
    pub media_file_id: Option<i32>,
    pub episode_id: Option<i32>,
    pub playlist_id: Option<i32>,
    pub invite_token: String,
    pub policy: String,
    pub reactions_enabled: bool,
    pub chat_enabled: bool,
    pub link_sharing: bool,
    pub scheduled_at: Option<DateTime<Utc>>,
    pub status: String,
    pub position: f64,
}

impl Row {
    pub fn item(&self) -> Item {
        Item {
            media_id: self.media_id,
            media_file_id: self.media_file_id,
            episode_id: self.episode_id,
        }
    }
}

const COLS: &str = r#"id, name, "ownerId" AS owner_id, "mediaId" AS media_id,
    "mediaFileId" AS media_file_id, "episodeId" AS episode_id, "playlistId" AS playlist_id, "inviteToken" AS invite_token,
    policy, "reactionsEnabled" AS reactions_enabled, "chatEnabled" AS chat_enabled,
    "linkSharing" AS link_sharing, "scheduledAt" AS scheduled_at, status, position"#;

pub fn new_token() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("os rng");
    URL_SAFE_NO_PAD.encode(b)
}

pub struct New<'a> {
    pub name: &'a str,
    pub owner: i32,
    pub item: &'a Item,
    pub playlist_id: Option<i32>,
    pub policy: &'a str,
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

pub async fn insert(db: &PgPool, n: &New<'_>, invitees: &[i32]) -> sqlx::Result<Row> {
    let mut tx = db.begin().await?;
    let row = sqlx::query_as::<_, Row>(&format!(
        r#"INSERT INTO watch_parties (name, "ownerId", "mediaId", "mediaFileId", "episodeId",
               "playlistId", "inviteToken", policy, "reactionsEnabled", "chatEnabled", "linkSharing",
               "scheduledAt", status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'scheduled')
           RETURNING {COLS}"#
    ))
    .bind(n.name)
    .bind(n.owner)
    .bind(n.item.media_id)
    .bind(n.item.media_file_id)
    .bind(n.item.episode_id)
    .bind(n.playlist_id)
    .bind(new_token())
    .bind(n.policy)
    .bind(n.reactions_enabled)
    .bind(n.chat_enabled)
    .bind(n.link_sharing)
    .bind(n.scheduled_at)
    .fetch_one(&mut *tx)
    .await?;
    add_invitees_in(&mut tx, row.id, invitees).await?;
    tx.commit().await?;
    Ok(row)
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

/// The users newly invited: a link joiner is upgraded, an already invited user is skipped.
pub async fn add_invitees(db: &PgPool, party: i32, users: &[i32]) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(
        r#"INSERT INTO watch_party_invitees ("partyId", "userId")
           SELECT $1, u FROM unnest($2::int[]) AS u
           ON CONFLICT ("partyId", "userId") DO UPDATE SET "source" = 'invite'
           WHERE watch_party_invitees."source" = 'link' RETURNING "userId""#,
    )
    .bind(party)
    .bind(users)
    .fetch_all(db)
    .await
}

pub async fn get(db: &PgPool, id: i32) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM watch_parties WHERE id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn by_token(db: &PgPool, token: &str) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(&format!(
        r#"SELECT {COLS} FROM watch_parties WHERE "inviteToken" = $1"#
    ))
    .bind(token)
    .fetch_optional(db)
    .await
}

/// Every row of the party, invitees and link joiners: `(userId, source)`.
pub async fn guests(db: &PgPool, party: i32) -> sqlx::Result<Vec<(i32, String)>> {
    sqlx::query_as(
        r#"SELECT "userId", "source" FROM watch_party_invitees WHERE "partyId" = $1 ORDER BY "userId""#,
    )
    .bind(party)
    .fetch_all(db)
    .await
}

pub async fn guest_ids(db: &PgPool, party: i32) -> sqlx::Result<Vec<i32>> {
    Ok(guests(db, party).await?.into_iter().map(|g| g.0).collect())
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

pub async fn remove_guest(db: &PgPool, party: i32, user: i32) -> sqlx::Result<()> {
    sqlx::query(r#"DELETE FROM watch_party_invitees WHERE "partyId" = $1 AND "userId" = $2"#)
        .bind(party)
        .bind(user)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn is_invitee(db: &PgPool, party: i32, user: i32) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM watch_party_invitees WHERE "partyId" = $1 AND "userId" = $2)"#,
    )
    .bind(party)
    .bind(user)
    .fetch_one(db)
    .await
}

/// `live` first, then `scheduledAt` ascending.
pub async fn listed(db: &PgPool, user: i32) -> sqlx::Result<Vec<Row>> {
    sqlx::query_as(&format!(
        r#"SELECT {COLS} FROM watch_parties p
           WHERE status IN ('scheduled', 'live')
             AND ("ownerId" = $1 OR EXISTS (SELECT 1 FROM watch_party_invitees i
                                            WHERE i."partyId" = p.id AND i."userId" = $1))
           ORDER BY (status = 'live') DESC, "scheduledAt" ASC NULLS LAST, id"#
    ))
    .bind(user)
    .fetch_all(db)
    .await
}

pub async fn live_rows(db: &PgPool) -> sqlx::Result<Vec<Row>> {
    sqlx::query_as(&format!(
        "SELECT {COLS} FROM watch_parties WHERE status = 'live'"
    ))
    .fetch_all(db)
    .await
}

pub async fn scheduled_rows(db: &PgPool) -> sqlx::Result<Vec<Row>> {
    sqlx::query_as(&format!(
        r#"SELECT {COLS} FROM watch_parties WHERE status = 'scheduled' AND "scheduledAt" IS NOT NULL"#
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
    policy: &str,
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
    .bind(policy)
    .bind(switches.0)
    .bind(switches.1)
    .bind(switches.2)
    .bind(scheduled_at)
    .bind(token)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn set_live(db: &PgPool, id: i32) -> sqlx::Result<()> {
    sqlx::query(r#"UPDATE watch_parties SET status = 'live', "startedAt" = now() WHERE id = $1"#)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
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
pub struct ItemInfo {
    pub title: String,
    pub poster_url: Option<String>,
    pub fanart_url: Option<String>,
    pub additional_fanart_urls: Vec<String>,
}

/// Media title (with `S01E02` for an episode) and artwork; `None` when the media is gone.
pub async fn item_info(
    db: &PgPool,
    media: i32,
    episode: Option<i32>,
) -> sqlx::Result<Option<ItemInfo>> {
    type Row = (String, Option<String>, Option<String>, Option<Vec<String>>);
    let Some((title, poster_url, fanart_url, additional)) = sqlx::query_as::<_, Row>(
        r#"SELECT title, "posterUrl", "fanartUrl", "additionalFanartUrls" FROM media WHERE id = $1"#,
    )
    .bind(media)
    .fetch_optional(db)
    .await?
    else {
        return Ok(None);
    };
    let label: Option<(i32, i32)> = match episode {
        Some(e) => {
            sqlx::query_as(
                r#"SELECT s."seasonNumber", e."episodeNumber" FROM episodes e
                   JOIN seasons s ON s.id = e."seasonId" WHERE e.id = $1"#,
            )
            .bind(e)
            .fetch_optional(db)
            .await?
        }
        None => None,
    };
    let title = match label {
        Some((s, e)) => format!("{title} S{s:02}E{e:02}"),
        None => title,
    };
    Ok(Some(ItemInfo {
        title,
        poster_url,
        fanart_url,
        additional_fanart_urls: additional.unwrap_or_default(),
    }))
}

/// True when the file and the episode (if given) belong to the media.
pub async fn item_valid(db: &PgPool, item: &Item) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        r#"SELECT ($2::int IS NULL OR EXISTS (SELECT 1 FROM media_files WHERE id = $2 AND "mediaId" = $1))
               AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM episodes e JOIN seasons s ON s.id = e."seasonId"
                                               WHERE e.id = $3 AND s."mediaId" = $1))"#,
    )
    .bind(item.media_id)
    .bind(item.media_file_id)
    .bind(item.episode_id)
    .fetch_one(db)
    .await
}

/// Name of the playlist a party follows.
pub async fn playlist_name(db: &PgPool, playlist: i32) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar("SELECT name FROM playlists WHERE id = $1")
        .bind(playlist)
        .fetch_optional(db)
        .await
}

/// A playlist row as a party item; `playable` when the media has a file for it.
pub struct QueueRow {
    pub item: Item,
    pub playable: bool,
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
