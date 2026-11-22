//! Auto-resolve (`problems.md` rules 8-11): a report whose pinned file was replaced is marked fixed.
use super::{
    db::{ACTIVE, ROW_COLS, Row},
    flow::{Event, announce},
};
use crate::{events::DomainEvent, state::AppState};
use std::sync::Arc;

/// Resolves the active reports of `media` (every media for `None`) whose replacement arrived: the
/// pinned file is gone and a file of the scope was added since, or it was rewritten with another size.
/// A report whose item is gone with a season or episode scope stays for a manager.
pub async fn auto_resolve(st: &AppState, media: Option<i32>) -> sqlx::Result<()> {
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"UPDATE media_issues i SET status = 'resolved', "autoResolved" = true, "resolvedAt" = now()
           FROM media m
           WHERE m.id = i."mediaId" AND i.status = ANY($1) AND i."fileSize" IS NOT NULL
             AND ($2::int IS NULL OR i."mediaId" = $2)
             AND NOT (i."itemId" IS NULL AND (i."seasonNumber" IS NOT NULL OR i."episodeNumber" IS NOT NULL))
             AND ((i."mediaFileId" IS NULL AND EXISTS (
                     SELECT 1 FROM media_files f
                     WHERE f."mediaId" = i."mediaId" AND f."createdAt" > i."createdAt"
                       AND (i."itemId" IS NULL OR EXISTS (SELECT 1 FROM item_parts p
                                                          WHERE p."itemId" = i."itemId" AND p."mediaFileId" = f.id))))
                  OR EXISTS (SELECT 1 FROM media_files f WHERE f.id = i."mediaFileId" AND f.size <> i."fileSize"))
           RETURNING {ROW_COLS}"#
    )))
    .bind(&ACTIVE[..])
    .bind(media)
    .fetch_all(&st.db)
    .await?;
    for row in &rows {
        announce(st, row, Event::Resolved);
    }
    Ok(())
}

async fn run(st: AppState, media: Option<i32>) {
    if let Err(e) = auto_resolve(&st, media).await {
        tracing::warn!("problem auto-resolve failed: {e}");
    }
}

/// The reconcile of the hourly request tick (rule 11): catches the imports and deletions no event reported.
pub fn reconcile(st: &AppState) {
    tokio::spawn(run(st.clone(), None));
}

/// Subscribes to `media.files.imported`; a lagged feed runs the reconcile.
pub fn spawn(st: &AppState) {
    let (on, lag) = (st.clone(), st.clone());
    let on_event = move |ev: &Arc<DomainEvent>| {
        if let DomainEvent::MediaFilesImported { media_id, .. } = &**ev
            && let Ok(media) = i32::try_from(*media_id)
        {
            tokio::spawn(run(on.clone(), Some(media)));
        }
    };
    tokio::spawn(crate::events::listen(
        "problem auto-resolve",
        st.hub.subscribe_domain(),
        on_event,
        move || reconcile(&lag),
    ));
}
