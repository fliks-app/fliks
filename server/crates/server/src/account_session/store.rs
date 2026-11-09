//! `account_sessions` and the opt-in columns of `users`.
use super::{Owner, QueueState, Row, State};
use chrono::{DateTime, Utc};
use fliks_domain::media::kind::MediaKind;
use sqlx::PgPool;

/// `session.md` rule 1: the option is on and the kind is selected (null selects every kind).
pub async fn in_scope(db: &PgPool, account: i32, kind: MediaKind) -> bool {
    let r = sqlx::query!(
        r#"SELECT "sessionSync" AS sync, "sessionKinds" AS kinds FROM users WHERE id = $1"#,
        account
    )
    .fetch_optional(db)
    .await;
    match r {
        Ok(Some(u)) => {
            u.sync
                && u.kinds
                    .is_none_or(|k| k.iter().any(|k| k.as_str() == kind.as_str()))
        }
        Ok(None) => false,
        Err(e) => {
            tracing::warn!(account, "account session scope not read: {e}");
            false
        }
    }
}

pub async fn upsert(db: &PgPool, r: &Row) -> Result<(), sqlx::Error> {
    let queue = r
        .queue
        .as_ref()
        .map(|q| serde_json::to_value(q).expect("queue is plain data"));
    sqlx::query!(
        r#"INSERT INTO account_sessions
             ("userId", "sessionId", epoch, "itemId", "mediaFileId", kind, state, "positionSeconds",
              "durationSeconds", "ownerTargetId", "ownerDeviceName", "ownerFormFactor", queue, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT ("userId") DO UPDATE SET
             "sessionId" = EXCLUDED."sessionId", epoch = EXCLUDED.epoch, "itemId" = EXCLUDED."itemId",
             "mediaFileId" = EXCLUDED."mediaFileId", kind = EXCLUDED.kind, state = EXCLUDED.state,
             "positionSeconds" = EXCLUDED."positionSeconds", "durationSeconds" = EXCLUDED."durationSeconds",
             "ownerTargetId" = EXCLUDED."ownerTargetId", "ownerDeviceName" = EXCLUDED."ownerDeviceName",
             "ownerFormFactor" = EXCLUDED."ownerFormFactor", queue = EXCLUDED.queue,
             "updatedAt" = EXCLUDED."updatedAt""#,
        r.user_id,
        r.session_id,
        r.epoch,
        r.item_id,
        r.media_file_id,
        r.kind.as_str(),
        r.state.as_str(),
        r.position,
        r.duration,
        r.owner.target_id,
        r.owner.device_name,
        r.owner.form_factor,
        queue,
        r.updated_at
    )
    .execute(db)
    .await?;
    Ok(())
}

pub async fn delete(db: &PgPool, user: i32) -> Result<(), sqlx::Error> {
    sqlx::query!(r#"DELETE FROM account_sessions WHERE "userId" = $1"#, user)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn park_all(db: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"UPDATE account_sessions SET state = 'parked', "updatedAt" = now() WHERE state <> 'parked'"#
    )
    .execute(db)
    .await?;
    Ok(())
}

pub async fn delete_expired(db: &PgPool, before: DateTime<Utc>) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"DELETE FROM account_sessions WHERE state = 'parked' AND "updatedAt" < $1"#,
        before
    )
    .execute(db)
    .await?;
    Ok(())
}

/// A row whose kind, state or queue the code no longer reads is skipped, not an error.
pub async fn all(db: &PgPool) -> Result<Vec<Row>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT "userId" AS user_id, "sessionId" AS session_id, epoch, "itemId" AS item_id,
                  "mediaFileId" AS media_file_id, kind, state, "positionSeconds" AS position,
                  "durationSeconds" AS duration, "ownerTargetId" AS target_id,
                  "ownerDeviceName" AS device_name, "ownerFormFactor" AS form_factor, queue,
                  "updatedAt" AS updated_at
             FROM account_sessions"#
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            Some(Row {
                user_id: r.user_id,
                session_id: r.session_id,
                epoch: r.epoch,
                item_id: r.item_id,
                media_file_id: r.media_file_id,
                kind: MediaKind::parse(&r.kind)?,
                state: State::parse(&r.state)?,
                position: r.position,
                duration: r.duration,
                owner: Owner {
                    target_id: r.target_id,
                    device_name: r.device_name,
                    form_factor: r.form_factor,
                },
                queue: r
                    .queue
                    .and_then(|q| serde_json::from_value::<QueueState>(q).ok()),
                updated_at: r.updated_at,
            })
        })
        .collect())
}

/// What the item shows of itself: media title, episode or track label, poster.
pub struct Shown {
    /// The routing pair of the item: its media, and itself when it sits in a group (episode, disc).
    pub media_id: i32,
    pub episode_id: Option<i32>,
    pub family: Option<String>,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub poster_url: Option<String>,
}

pub async fn shown(db: &PgPool, item: i32) -> Result<Option<Shown>, sqlx::Error> {
    let r = sqlx::query!(
        r#"SELECT m.title AS "media_title!", m."posterUrl" AS poster_url, m."type"::text AS "kind!",
                  i.title AS item_title, i.number AS item_number, g.number AS "season: i32",
                  i."mediaId" AS media_id, i."groupId" AS group_id, e.family AS "family?"
             FROM items i
             JOIN media m ON m.id = i."mediaId"
             LEFT JOIN editions e ON e.id = i."editionId"
             LEFT JOIN item_groups g ON g.id = i."groupId"
            WHERE i.id = $1"#,
        item
    )
    .fetch_optional(db)
    .await?;
    Ok(r.map(|r| {
        let titled = r.item_title.filter(|t| !t.is_empty());
        let subtitle = match (r.kind.as_str(), r.season, r.item_number) {
            ("series", Some(s), Some(n)) => Some(match titled {
                Some(t) => format!("S{s:02}E{n:02}: {t}"),
                None => format!("S{s:02}E{n:02}"),
            }),
            _ => titled.filter(|t| *t != r.media_title),
        };
        Shown {
            media_id: r.media_id,
            episode_id: r.group_id.map(|_| item),
            family: r.family,
            title: Some(r.media_title),
            subtitle,
            poster_url: r.poster_url,
        }
    }))
}

/// The kind of the media `item` belongs to.
pub async fn kind_of(db: &PgPool, item: i32) -> Result<Option<MediaKind>, sqlx::Error> {
    let t = sqlx::query_scalar!(
        r#"SELECT m."type"::text AS "kind!" FROM items i JOIN media m ON m.id = i."mediaId" WHERE i.id = $1"#,
        item
    )
    .fetch_optional(db)
    .await?;
    Ok(t.and_then(|t| MediaKind::parse(&t)))
}
