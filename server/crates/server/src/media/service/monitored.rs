//! Monitoring writes (rules 27, 32-33, 38-39): apply in a transaction, announce after the commit.
use crate::{events::DomainEvent, requests::MediaRef, state::AppState};
use sqlx::PgConnection;

/// What a monitored write really changed, announced once the transaction has committed.
pub struct MonitoredChange {
    monitored: bool,
    media: Vec<MediaRef>,
    seasons: Vec<(MediaRef, i32)>,
    /// Media whose derived flag flipped under a season write or a rescan: the event only, no hook.
    flipped: Vec<(i32, bool)>,
}

impl MonitoredChange {
    /// Rule 38/39 events and request hooks, for every media or season whose flag flipped.
    pub async fn announce(self, st: &AppState) {
        let lifecycle = crate::requests::Lifecycle::of(st);
        for m in self.media {
            st.hub.emit_domain(DomainEvent::MediaMonitoredChanged {
                media_id: i64::from(m.id),
                monitored: self.monitored,
            });
            lifecycle.on_media_monitor_change(m, !self.monitored).await;
        }
        for (id, monitored) in self.flipped {
            st.hub.emit_domain(DomainEvent::MediaMonitoredChanged {
                media_id: i64::from(id),
                monitored,
            });
        }
        for (m, number) in self.seasons {
            st.hub
                .emit_domain(DomainEvent::MediaSeasonMonitoredChanged {
                    media_id: i64::from(m.id),
                    season_number: i64::from(number),
                    monitored: self.monitored,
                });
            lifecycle
                .on_season_monitor_change(m, number, !self.monitored, self.monitored)
                .await;
        }
    }
}

/// Rule 27: sets `monitored` on the media and, in a few statements whatever the size, on their seasons and
/// episodes (no season hook for the children). A series' own flag follows its seasons (rule 31): `true` monitors
/// every season but the specials, `false` every one, and both set the new-seasons policy. The prior state is read
/// in one query that locks the media before any season (the lock order of every series writer).
pub async fn apply_media_monitored(
    c: &mut PgConnection,
    ids: &[i32],
    monitored: bool,
) -> Result<MonitoredChange, sqlx::Error> {
    let before = sqlx::query!(
        r#"SELECT m.id, m.type AS "media_type!", m.monitored AS was FROM media m
           WHERE m.id = ANY($1) ORDER BY m.id FOR NO KEY UPDATE"#,
        ids
    )
    .fetch_all(&mut *c)
    .await?;
    let series: Vec<i32> = before
        .iter()
        .filter(|r| r.media_type == "series")
        .map(|r| r.id)
        .collect();
    let others: Vec<i32> = before
        .iter()
        .filter(|r| r.media_type != "series")
        .map(|r| r.id)
        .collect();
    let media = before
        .iter()
        .filter(|r| r.was != monitored)
        .map(|r| {
            Ok(MediaRef {
                id: r.id,
                media_type: crate::db::kind(&r.media_type)?,
                monitored,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    let changed: Vec<i32> = media.iter().map(|m| m.id).collect();
    sqlx::query!(
        "UPDATE media SET monitored = $1 WHERE id = ANY($2) AND NOT (id = ANY($3))",
        monitored,
        &changed,
        &series
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE item_groups SET monitored = $1
           WHERE ("mediaId" = ANY($2) OR "mediaId" = ANY($3) AND ($1 = false OR "number" > 0))
             AND monitored IS DISTINCT FROM $1"#,
        monitored,
        &others,
        &series
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE items SET monitored = $1
           WHERE "groupId" IN (SELECT id FROM item_groups
             WHERE "mediaId" = ANY($2) OR "mediaId" = ANY($3) AND ($1 = false OR "number" > 0))"#,
        monitored,
        &others,
        &series
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE media SET "monitorNewSeasons" = $1 WHERE id = ANY($2) AND "monitorNewSeasons" IS DISTINCT FROM $1"#,
        monitored,
        &series
    )
    .execute(&mut *c)
    .await?;
    if monitored {
        crate::metadata::music::want::monitor_all(&mut *c, &changed).await?;
    }
    Ok(MonitoredChange {
        monitored,
        media,
        seasons: vec![],
        flipped: vec![],
    })
}

/// Rules 32-33: sets `monitored` on a season and every episode of it. A flip of the series' derived flag is
/// announced as an event only: the season hook already settles the requests.
pub async fn apply_season_monitored(
    c: &mut PgConnection,
    season_id: i32,
    monitored: bool,
) -> Result<MonitoredChange, sqlx::Error> {
    let media = sqlx::query_scalar!(
        r#"SELECT "mediaId" FROM item_groups WHERE id = $1"#,
        season_id
    )
    .fetch_optional(&mut *c)
    .await?;
    let media_before = match media {
        Some(m) => sqlx::query!(
            r#"SELECT type AS "media_type!", monitored FROM media WHERE id = $1 FOR NO KEY UPDATE"#,
            m
        )
        .fetch_optional(&mut *c)
        .await?
        .map(|r| (m, r.media_type, r.monitored)),
        None => None,
    };
    let was = sqlx::query!(
        r#"SELECT "number" AS number, monitored AS was FROM item_groups WHERE id = $1"#,
        season_id
    )
    .fetch_optional(&mut *c)
    .await?;
    sqlx::query!(
        "UPDATE item_groups SET monitored = $2 WHERE id = $1 AND monitored IS DISTINCT FROM $2",
        season_id,
        monitored
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE items SET monitored = $1 WHERE "groupId" = $2"#,
        monitored,
        season_id
    )
    .execute(&mut *c)
    .await?;
    let mut seasons = vec![];
    let mut flipped = vec![];
    if let (Some((id, kind, before)), Some(w)) = (media_before, was) {
        let after = sqlx::query_scalar!("SELECT monitored FROM media WHERE id = $1", id)
            .fetch_one(&mut *c)
            .await?;
        if after != before {
            flipped.push((id, after));
        }
        if w.was != monitored {
            seasons.push((
                MediaRef {
                    id,
                    media_type: crate::db::kind(&kind)?,
                    monitored: after,
                },
                w.number,
            ));
        }
    }
    Ok(MonitoredChange {
        monitored,
        media: vec![],
        seasons,
        flipped,
    })
}

/// The single owner of media monitoring outside a larger write: apply, commit, announce.
pub async fn set_media_monitored(
    st: &AppState,
    ids: &[i32],
    monitored: bool,
) -> Result<(), sqlx::Error> {
    let mut tx = st.db.begin().await?;
    let change = apply_media_monitored(&mut tx, ids, monitored).await?;
    tx.commit().await?;
    change.announce(st).await;
    Ok(())
}

pub async fn set_season_monitored(
    st: &AppState,
    season_id: i32,
    monitored: bool,
) -> Result<(), sqlx::Error> {
    let mut tx = st.db.begin().await?;
    let change = apply_season_monitored(&mut tx, season_id, monitored).await?;
    tx.commit().await?;
    change.announce(st).await;
    Ok(())
}

/// The media's `monitored` flag, read around a write that can flip a series' derived value; `None` once the media is gone.
pub async fn media_flag(db: impl sqlx::PgExecutor<'_>, id: i32) -> sqlx::Result<Option<bool>> {
    sqlx::query_scalar!("SELECT monitored FROM media WHERE id = $1", id)
        .fetch_optional(db)
        .await
}

/// Emits `media.monitored.changed` when the flag read before a refresh or rescan differs from the current one.
pub async fn announce_flip(st: &AppState, id: i32, before: Option<bool>) -> sqlx::Result<()> {
    if let (Some(before), Some(after)) = (before, media_flag(&st.db, id).await?)
        && after != before
    {
        st.hub.emit_domain(DomainEvent::MediaMonitoredChanged {
            media_id: i64::from(id),
            monitored: after,
        });
    }
    Ok(())
}
