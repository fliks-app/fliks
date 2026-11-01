//! The reads and writes playback-info makes outside the media tables: markers and the saved position.
use crate::playback::find_state;
use fliks_engine_core::api::Chapter;
use serde::Serialize;
use sqlx::PgPool;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// `{intro?, outro?}` of an item; the keys of an absent side are omitted.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Markers {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intro: Option<Range>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outro: Option<Range>,
}

/// `None` when the item has neither; recap markers are never read here.
pub async fn markers(db: &PgPool, item: i32) -> sqlx::Result<Option<Markers>> {
    let rows = sqlx::query!(
        r#"SELECT kind, "startSeconds" AS start, "endSeconds" AS "end"
           FROM item_markers WHERE "itemId" = $1 AND kind IN ('intro', 'outro')"#,
        item
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

/// The chapters of `file` as a part of `item`, in file order.
pub async fn chapters(db: &PgPool, item: i32, file: i32) -> sqlx::Result<Vec<Chapter>> {
    sqlx::query!(
        r#"SELECT "startSeconds" AS start, "endSeconds" AS "end", title FROM item_markers
           WHERE "itemId" = $1 AND "mediaFileId" = $2 AND kind = 'chapter'
           ORDER BY "startSeconds", id"#,
        item,
        file
    )
    .fetch_all(db)
    .await
    .map(|rows| {
        rows.into_iter()
            .map(|r| Chapter {
                start_seconds: r.start,
                end_seconds: r.end,
                title: r.title,
            })
            .collect()
    })
}

/// The saved position worth resuming: more than 10 s in and not finished.
pub async fn resume_position(db: &PgPool, user: i32, item: i32) -> sqlx::Result<Option<f64>> {
    Ok(find_state(db, user, item)
        .await?
        .filter(|r| !r.completed && r.position_seconds > 10.0)
        .map(|r| r.position_seconds))
}

/// Ensures the progress row exists, links it to `file` and bumps `lastPlayedAt`; never sets `playedAt`.
pub async fn mark_started(db: &PgPool, user: i32, item: i32, file: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"INSERT INTO playback_states ("userId", "itemId", "mediaFileId",
               "positionSeconds", "durationSeconds", completed, "lastPlayedAt")
           VALUES ($1, $2, $3, 0, 0, false, now())
           ON CONFLICT ("userId", "itemId")
           DO UPDATE SET "mediaFileId" = $3, "lastPlayedAt" = now(), "updatedAt" = now()"#,
        user,
        item,
        file
    )
    .execute(db)
    .await
    .map(drop)
}
