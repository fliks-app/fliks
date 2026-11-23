//! `GET /api/home/featured`: the hero carousel picks, recommendations first, recent additions after.
use super::recommend;
use crate::{
    http::kinds::Kinds,
    media::{hydrate, list, params::Recent},
};
use serde_json::{Value, json};
use sqlx::PgPool;

/// Up to `limit` available items with a fanart: recommended ones, then the newest unwatched
/// and undismissed additions of `libs`.
pub async fn featured(
    db: &PgPool,
    user: i32,
    libs: &[i32],
    kinds: &Kinds,
    limit: usize,
    see_paths: bool,
) -> sqlx::Result<Vec<Value>> {
    let mut picks: Vec<(i32, Option<String>)> =
        recommend::recommendations(db, user, libs, kinds, None)
            .await?
            .into_iter()
            .filter(|r| {
                r.media.available && r.media.fanart_url.as_deref().is_some_and(|u| !u.is_empty())
            })
            .take(limit)
            .map(|r| (r.media.id as i32, Some(r.because_title)))
            .collect();
    let missing = limit - picks.len();
    if missing > 0 {
        let recent = Recent {
            library_id: None,
            limit: missing as i64,
            mode: "file".into(),
            exclude_watched: true,
            requested_by_me: false,
            fanart_only: true,
            exclude_dismissed: true,
            exclude: picks.iter().map(|(id, _)| *id).collect(),
        };
        let ids = list::recent_ids(db, &recent, libs, kinds, user).await?;
        picks.extend(ids.into_iter().map(|id| (id, None)));
    }
    let ids: Vec<i32> = picks.iter().map(|(id, _)| *id).collect();
    let media = hydrate::items_view(db, &ids, see_paths, true).await?;
    Ok(media
        .into_iter()
        .zip(picks)
        .map(|(media, (_, because))| {
            let reason = if because.is_some() {
                "recommended"
            } else {
                "recent"
            };
            json!({"media": media, "reason": reason, "becauseTitle": because})
        })
        .collect())
}
