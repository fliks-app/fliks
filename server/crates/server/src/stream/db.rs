//! The reads and writes playback-info makes outside the media tables: markers and the saved position.
use crate::playback::find_state;
use fliks_engine_core::api::{Chapter, DeviceProfile};
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

/// The chapters of `file` as a part of `item`, in probe order.
pub async fn chapters(db: &PgPool, item: i32, file: i32) -> sqlx::Result<Vec<Chapter>> {
    sqlx::query!(
        r#"SELECT "startSeconds" AS start, "endSeconds" AS "end", title FROM item_markers
           WHERE "itemId" = $1 AND "mediaFileId" = $2 AND kind = 'chapter'
           ORDER BY id"#,
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

/// The chapters of an item's parts on its timeline: each part's chapters shifted by its offset.
pub async fn item_chapters(
    db: &PgPool,
    item: i32,
    spans: &[(i32, f64)],
) -> sqlx::Result<Vec<Chapter>> {
    let files: Vec<i32> = spans.iter().map(|(f, _)| *f).collect();
    let rows = sqlx::query!(
        r#"SELECT "mediaFileId" AS "file!", "startSeconds" AS start, "endSeconds" AS "end", title
           FROM item_markers WHERE "itemId" = $1 AND "mediaFileId" = ANY($2) AND kind = 'chapter'
           ORDER BY id"#,
        item,
        &files
    )
    .fetch_all(db)
    .await?;
    let mut chapters: Vec<Chapter> = rows
        .into_iter()
        .map(|r| {
            let at = spans
                .iter()
                .find(|(f, _)| *f == r.file)
                .map_or(0.0, |(_, o)| *o);
            Chapter {
                start_seconds: at + r.start,
                end_seconds: at + r.end,
                title: r.title,
            }
        })
        .collect();
    chapters.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    Ok(chapters)
}

/// Whether the item's edition is video: only then a file's own timeline is the item's.
pub async fn is_video(db: &PgPool, item: i32) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM items i JOIN editions e ON e.id = i."editionId"
                          WHERE i.id = $1 AND e.family = 'video')"#,
    )
    .bind(item)
    .fetch_one(db)
    .await
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

/// One row per device label + platform: what the optimizer needs to pick a codec every device decodes.
pub async fn record_client_codecs(db: &PgPool, d: &DeviceProfile) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO client_codecs ("deviceLabel", "platform", "directPlayProfiles", "codecConditions",
               "supportsHdr", "supportsDolbyVision")
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT ("deviceLabel", "platform") DO UPDATE SET
               "directPlayProfiles" = EXCLUDED."directPlayProfiles",
               "codecConditions" = EXCLUDED."codecConditions",
               "supportsHdr" = EXCLUDED."supportsHdr",
               "supportsDolbyVision" = EXCLUDED."supportsDolbyVision",
               "lastSeenAt" = now()"#,
    )
    .bind(d.device_name.as_deref().unwrap_or_default())
    .bind(d.system_name.as_deref().unwrap_or_default())
    .bind(sqlx::types::Json(&d.direct_play_profiles))
    .bind(d.codec_conditions.as_ref().map(sqlx::types::Json))
    .bind(d.supports_hdr)
    .bind(d.supports_dolby_vision)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod client_codecs_tests {
    use super::*;

    #[sqlx::test(migrations = false)]
    async fn a_device_is_one_row_refreshed_on_each_decide(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let profile = |hdr| DeviceProfile {
            device_name: Some("Living room".into()),
            system_name: Some("tvOS".into()),
            supports_hdr: Some(hdr),
            ..serde_json::from_value(serde_json::json!({"directPlayProfiles": []})).unwrap()
        };
        record_client_codecs(&db, &profile(false)).await.unwrap();
        record_client_codecs(&db, &profile(true)).await.unwrap();
        let rows: Vec<(Option<bool>,)> =
            sqlx::query_as(r#"SELECT "supportsHdr" FROM client_codecs"#)
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(rows, vec![(Some(true),)]);
    }
}
