//! The reads and writes playback-info makes outside the media tables: markers and the saved position.
use serde::Serialize;
use sqlx::PgPool;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// `{intro?, outro?}` of an episode; the keys of an absent side are omitted.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Markers {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intro: Option<Range>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outro: Option<Range>,
}

/// `None` when the episode has neither; recap markers are never read here.
pub async fn markers(db: &PgPool, episode_id: i32) -> sqlx::Result<Option<Markers>> {
    let rows = sqlx::query!(
        r#"SELECT "type" AS kind, "startSeconds" AS start, "endSeconds" AS "end"
           FROM episode_markers WHERE "episodeId" = $1 AND "type" IN ('intro', 'outro')"#,
        episode_id
    )
    .fetch_all(db)
    .await?;
    let mut m = Markers::default();
    for r in rows {
        let range = Range {
            start_seconds: r.start,
            end_seconds: r.end,
        };
        match r.kind.as_str() {
            "intro" => m.intro = Some(range),
            _ => m.outro = Some(range),
        }
    }
    Ok((m.intro.is_some() || m.outro.is_some()).then_some(m))
}

/// The saved position worth resuming: more than 10 s in and not finished.
pub async fn resume_position(
    db: &PgPool,
    user: i32,
    media: i32,
    episode: Option<i32>,
) -> sqlx::Result<Option<f64>> {
    let row = sqlx::query!(
        r#"SELECT "positionSeconds" AS position, completed FROM playback_states
           WHERE "userId" = $1 AND "mediaId" = $2
             AND ("episodeId" = $3 OR ($3::int IS NULL AND "episodeId" IS NULL))
           LIMIT 1"#,
        user,
        media,
        episode
    )
    .fetch_optional(db)
    .await?;
    Ok(row
        .filter(|r| !r.completed && r.position > 10.0)
        .map(|r| r.position))
}

/// Ensures the history row exists and bumps `lastPlayedAt`; never sets `playedAt`.
pub async fn mark_started(
    db: &PgPool,
    user: i32,
    media: i32,
    file: i32,
    episode: Option<i32>,
) -> sqlx::Result<()> {
    let found = sqlx::query_scalar!(
        r#"SELECT id FROM playback_states
           WHERE "userId" = $1 AND "mediaId" = $2
             AND ("episodeId" = $3 OR ($3::int IS NULL AND "episodeId" IS NULL))
           LIMIT 1"#,
        user,
        media,
        episode
    )
    .fetch_optional(db)
    .await?;
    match found {
        Some(id) => {
            sqlx::query!(
                r#"UPDATE playback_states SET "lastPlayedAt" = now(), "updatedAt" = now() WHERE id = $1"#,
                id
            )
            .execute(db)
            .await?;
        }
        None => {
            sqlx::query!(
                r#"INSERT INTO playback_states ("userId", "mediaId", "mediaFileId", "episodeId",
                       "positionSeconds", "durationSeconds", completed, "lastPlayedAt")
                   VALUES ($1, $2, $3, $4, 0, 0, false, now())"#,
                user,
                media,
                file,
                episode
            )
            .execute(db)
            .await?;
        }
    }
    Ok(())
}
