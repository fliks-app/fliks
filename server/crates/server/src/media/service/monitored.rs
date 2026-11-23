//! Monitoring writes (rules 27, 32-33, 38-39): apply in a transaction, announce after the commit.
use crate::{events::DomainEvent, requests::MediaRef, state::AppState};
use sqlx::PgConnection;

/// What a monitored write really changed, announced once the transaction has committed.
pub struct MonitoredChange {
    monitored: bool,
    media: Vec<MediaRef>,
    seasons: Vec<(MediaRef, i32)>,
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

/// Rule 27: sets `monitored` on the media and, in two statements whatever the size, on their seasons and
/// episodes (no season hook for the children). The prior state is read in one query.
pub async fn apply_media_monitored(
    c: &mut PgConnection,
    ids: &[i32],
    monitored: bool,
) -> Result<MonitoredChange, sqlx::Error> {
    let media = sqlx::query!(
        r#"SELECT m.id, m.type AS "media_type!" FROM media m
           WHERE m.id = ANY($1) AND m.monitored IS DISTINCT FROM $2"#,
        ids,
        monitored
    )
    .fetch_all(&mut *c)
    .await?
    .into_iter()
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
        "UPDATE media SET monitored = $1 WHERE id = ANY($2)",
        monitored,
        &changed
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE item_groups SET monitored = $1 WHERE "mediaId" = ANY($2)"#,
        monitored,
        ids
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE items SET monitored = $1
           WHERE "groupId" IN (SELECT id FROM item_groups WHERE "mediaId" = ANY($2))"#,
        monitored,
        ids
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
    })
}

/// Rules 32-33: sets `monitored` on a season and every episode of it.
pub async fn apply_season_monitored(
    c: &mut PgConnection,
    season_id: i32,
    monitored: bool,
) -> Result<MonitoredChange, sqlx::Error> {
    let was = sqlx::query!(
        r#"SELECT s."number" AS number, s.monitored AS was, m.id AS "media_id?",
             m.type AS media_type
           FROM item_groups s LEFT JOIN media m ON m.id = s."mediaId"
           WHERE s.id = $1"#,
        season_id
    )
    .fetch_optional(&mut *c)
    .await?;
    let was_kind = match was.as_ref().and_then(|w| w.media_type.as_deref()) {
        Some(t) => Some(crate::db::kind(t)?),
        None => None,
    };
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
    let seasons = was
        .filter(|w| w.was != monitored)
        .and_then(|w| {
            Some((
                MediaRef {
                    id: w.media_id?,
                    media_type: was_kind?,
                    monitored: true,
                },
                w.number,
            ))
        })
        .into_iter()
        .collect();
    Ok(MonitoredChange {
        monitored,
        media: vec![],
        seasons,
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
