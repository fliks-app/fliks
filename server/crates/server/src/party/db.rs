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
    pub invite_token: String,
    pub policy: String,
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
    "mediaFileId" AS media_file_id, "episodeId" AS episode_id, "inviteToken" AS invite_token,
    policy, "scheduledAt" AS scheduled_at, status, position"#;

pub fn new_token() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("os rng");
    URL_SAFE_NO_PAD.encode(b)
}

pub struct New<'a> {
    pub name: &'a str,
    pub owner: i32,
    pub item: &'a Item,
    pub policy: &'a str,
    pub scheduled_at: Option<DateTime<Utc>>,
    pub live: bool,
}

pub async fn insert(db: &PgPool, n: &New<'_>, invitees: &[i32]) -> sqlx::Result<Row> {
    let mut tx = db.begin().await?;
    let row = sqlx::query_as::<_, Row>(&format!(
        r#"INSERT INTO watch_parties (name, "ownerId", "mediaId", "mediaFileId", "episodeId",
               "inviteToken", policy, "scheduledAt", status, "startedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10 THEN now() END)
           RETURNING {COLS}"#
    ))
    .bind(n.name)
    .bind(n.owner)
    .bind(n.item.media_id)
    .bind(n.item.media_file_id)
    .bind(n.item.episode_id)
    .bind(new_token())
    .bind(n.policy)
    .bind(n.scheduled_at)
    .bind(if n.live { "live" } else { "scheduled" })
    .bind(n.live)
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

/// The users newly invited (already invited ones are skipped).
pub async fn add_invitees(db: &PgPool, party: i32, users: &[i32]) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(
        r#"INSERT INTO watch_party_invitees ("partyId", "userId")
           SELECT $1, u FROM unnest($2::int[]) AS u ON CONFLICT DO NOTHING RETURNING "userId""#,
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

pub async fn invitees(db: &PgPool, party: i32) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(
        r#"SELECT "userId" FROM watch_party_invitees WHERE "partyId" = $1 ORDER BY "userId""#,
    )
    .bind(party)
    .fetch_all(db)
    .await
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

pub async fn update_settings(
    db: &PgPool,
    id: i32,
    name: &str,
    policy: &str,
    scheduled_at: Option<DateTime<Utc>>,
    token: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE watch_parties SET name = $2, policy = $3, "scheduledAt" = $4, "inviteToken" = $5
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(name)
    .bind(policy)
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

/// Media title (with `S01E02` for an episode) and poster; `None` when the media is gone.
pub async fn item_info(
    db: &PgPool,
    media: i32,
    episode: Option<i32>,
) -> sqlx::Result<Option<(String, Option<String>)>> {
    let Some((title, poster)) = sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT title, "posterUrl" FROM media WHERE id = $1"#,
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
    Ok(Some((title, poster)))
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
