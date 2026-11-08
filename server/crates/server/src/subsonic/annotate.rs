//! `star`, `unstar`, `setRating` and `scrobble` (`opensubsonic.md` rules 25-26).
use super::{
    Caller, Params, catalog,
    ids::Id,
    render::{Answer, SubError},
};
use crate::state::AppState;
use chrono::{DateTime, Utc};

fn not_supported() -> SubError {
    SubError::new(0, "Not supported")
}

/// The ids of a call as tracks and albums; every one must be visible, else nothing is touched.
async fn targets(
    st: &AppState,
    c: &Caller,
    raw: &[&str],
) -> Result<(Vec<(i32, i32)>, Vec<i32>), SubError> {
    let (mut tracks, mut albums) = (vec![], vec![]);
    for s in raw {
        match Id::parse(s).ok_or_else(SubError::not_found)? {
            Id::Track(n) => tracks.push(n),
            Id::Album(n) => albums.push(n),
            Id::Artist(_) => return Err(not_supported()),
            Id::Playlist(_) => return Err(SubError::not_found()),
        }
    }
    tracks.sort_unstable();
    tracks.dedup();
    albums.sort_unstable();
    albums.dedup();
    let seen = catalog::visible_tracks(&st.db, &c.libraries, &tracks).await?;
    let seen_albums = catalog::visible_albums(&st.db, &c.libraries, &albums).await?;
    if seen.len() != tracks.len() || seen_albums.len() != albums.len() {
        return Err(SubError::not_found());
    }
    Ok((seen, albums))
}

pub async fn star(st: &AppState, c: &Caller, p: &Params, on: bool) -> Answer {
    let mut raw: Vec<&str> = p.all("id");
    raw.extend(p.all("albumId"));
    raw.extend(p.all("artistId"));
    if raw.is_empty() {
        return Err(SubError::missing("id"));
    }
    let (tracks, albums) = targets(st, c, &raw).await?;
    let mut tx = st.db.begin().await?;
    let user = c.user();
    for (item, media) in &tracks {
        if on {
            sqlx::query(
                r#"INSERT INTO likes ("userId", "mediaId", "itemId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING"#,
            )
            .bind(user)
            .bind(media)
            .bind(item)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query(r#"DELETE FROM likes WHERE "userId" = $1 AND "itemId" = $2"#)
                .bind(user)
                .bind(item)
                .execute(&mut *tx)
                .await?;
        }
    }
    for media in &albums {
        let sql = if on {
            r#"INSERT INTO likes ("userId", "mediaId") VALUES ($1, $2) ON CONFLICT DO NOTHING"#
        } else {
            r#"DELETE FROM likes WHERE "userId" = $1 AND "mediaId" = $2 AND "itemId" IS NULL AND "groupId" IS NULL"#
        };
        sqlx::query(sql)
            .bind(user)
            .bind(media)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Default::default())
}

pub async fn set_rating(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let id = p.required("id")?;
    let rating = p
        .required("rating")?
        .trim()
        .parse::<i16>()
        .ok()
        .filter(|r| (0..=5).contains(r));
    let rating = rating.ok_or_else(|| SubError::new(0, "rating must be between 0 and 5"))?;
    let Id::Track(item) = Id::parse(id).ok_or_else(SubError::not_found)? else {
        return Err(match Id::parse(id) {
            Some(Id::Album(_) | Id::Artist(_)) => not_supported(),
            _ => SubError::not_found(),
        });
    };
    if catalog::visible_tracks(&st.db, &c.libraries, &[item])
        .await?
        .is_empty()
    {
        return Err(SubError::not_found());
    }
    if rating == 0 {
        sqlx::query(r#"DELETE FROM item_ratings WHERE "userId" = $1 AND "itemId" = $2"#)
            .bind(c.user())
            .bind(item)
            .execute(&st.db)
            .await?;
    } else {
        sqlx::query(
            r#"INSERT INTO item_ratings ("userId", "itemId", rating) VALUES ($1, $2, $3)
               ON CONFLICT ("userId", "itemId") DO UPDATE SET rating = EXCLUDED.rating"#,
        )
        .bind(c.user())
        .bind(item)
        .bind(rating)
        .execute(&st.db)
        .await?;
    }
    Ok(Default::default())
}

pub async fn scrobble(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let raw = p.all("id");
    if raw.is_empty() {
        return Err(SubError::missing("id"));
    }
    let mut items = vec![];
    for s in &raw {
        match Id::parse(s) {
            Some(Id::Track(n)) => items.push(n),
            _ => return Err(SubError::not_found()),
        }
    }
    let seen = catalog::visible_tracks(&st.db, &c.libraries, &items).await?;
    if items.iter().any(|i| !seen.iter().any(|(s, _)| s == i)) {
        return Err(SubError::not_found());
    }
    if p.get("submission") == Some("false") {
        return Ok(Default::default());
    }
    let times = p.all("time");
    for (i, item) in items.iter().enumerate() {
        let at = times
            .get(i)
            .and_then(|t| t.trim().parse::<i64>().ok())
            .and_then(DateTime::<Utc>::from_timestamp_millis)
            .unwrap_or_else(Utc::now);
        sqlx::query(
            r#"INSERT INTO playback_history ("userId", "itemId", "playedAt")
               SELECT $1, $2, $3 WHERE NOT EXISTS (
                 SELECT 1 FROM playback_history WHERE "userId" = $1 AND "itemId" = $2 AND "playedAt" = $3)"#,
        )
        .bind(c.user())
        .bind(item)
        .bind(at)
        .execute(&st.db)
        .await?;
    }
    Ok(Default::default())
}
