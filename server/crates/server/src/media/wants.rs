//! The wished editions of a media (`docs/spec/items.md` rules 29-34).
use sqlx::PgExecutor;

/// `LEFT JOIN` of the media's video want as `w`; `alias` is the media table or its alias.
pub fn video_want_join(alias: &str) -> String {
    format!(r#"LEFT JOIN wants w ON w."mediaId" = {alias}.id AND w.family = 'video'"#)
}

/// Sets the quality profile of the media's video want.
pub async fn set_quality_profile(
    db: impl PgExecutor<'_>,
    media: i32,
    profile: Option<i32>,
) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE wants SET "qualityProfileId" = $2 WHERE "mediaId" = $1 AND family = 'video'"#,
        media,
        profile
    )
    .execute(db)
    .await
    .map(drop)
}
