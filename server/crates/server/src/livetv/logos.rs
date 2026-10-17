//! The logo pass of a sync (`livetv-sources.md` rules 42 and 44): provider urls become cached local ones.
use crate::{images::paths::Target, state::AppState};
use std::sync::Arc;
use tokio::sync::Semaphore;

const WORKERS: usize = 4;

/// Enabled channels with a stream of the source whose logo is still a provider url; a dead one is retried at every sync.
pub async fn cache_source(st: &AppState, source_id: i32) {
    let rows: sqlx::Result<Vec<(i32, String)>> = sqlx::query_as(
        r#"SELECT c.id, c."logoPath" FROM livetv_channels c
           WHERE c.enabled AND c."logoPath" ~* '^https?://'
             AND EXISTS (SELECT 1 FROM livetv_channel_streams s WHERE s."channelId" = c.id AND s."sourceId" = $1)"#,
    )
    .bind(source_id)
    .fetch_all(&st.db)
    .await;
    let rows = match rows {
        Ok(r) => r,
        Err(e) => return tracing::warn!("Live TV logo pass of source #{source_id} failed: {e}"),
    };
    let gate = Arc::new(Semaphore::new(WORKERS));
    let mut tasks = tokio::task::JoinSet::new();
    for (id, url) in rows {
        let (st, gate) = (st.clone(), gate.clone());
        tasks.spawn(async move {
            let _slot = gate.acquire_owned().await;
            cache_one(&st, id, &url).await;
        });
    }
    while tasks.join_next().await.is_some() {}
}

async fn cache_one(st: &AppState, id: i32, url: &str) {
    let Some(path) = st.images.download_and_store(url, &Target::livetv(id)).await else {
        return;
    };
    if let Err(e) = sqlx::query(r#"UPDATE livetv_channels SET "logoPath" = $2 WHERE id = $1"#)
        .bind(id)
        .bind(&path)
        .execute(&st.db)
        .await
    {
        tracing::warn!("Live TV logo of channel #{id} not saved: {e}");
    }
}
