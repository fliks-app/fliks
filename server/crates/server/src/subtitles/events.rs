//! `subtitle.*` events go to the media's viewers (F49) and their notifications and Emby refreshes.
use crate::{events::SseEvent, state::AppState};
use serde_json::{Map, Value};

/// Enabled users who can see the media's library, plus those who see every library.
pub async fn viewers_for_media(st: &AppState, media_id: i32) -> Vec<i32> {
    let r = sqlx::query_scalar::<_, i32>(
        r#"SELECT u.id FROM users u LEFT JOIN roles r ON r.id = u."roleId"
           WHERE u.enabled AND (u."isAdmin" OR r.permissions LIKE '%"manage:all"%'
             OR EXISTS (SELECT 1 FROM library_user_access a JOIN media m ON m."libraryId" = a."libraryId"
                        WHERE a."userId" = u.id AND m.id = $1))
           ORDER BY u.id"#,
    )
    .bind(media_id)
    .fetch_all(&st.db)
    .await;
    r.unwrap_or_else(|e| {
        tracing::error!(error = %e, "subtitle event audience");
        vec![]
    })
}

pub async fn emit(st: &AppState, media_id: i32, ev: SseEvent) {
    let ids = viewers_for_media(st, media_id).await;
    if !ids.is_empty() {
        st.hub.emit_to_users(&ids, ev);
    }
}

pub async fn list_changed(st: &AppState, media_id: i32) {
    emit(
        st,
        media_id,
        SseEvent::SubtitleListChanged {
            media_id: media_id.into(),
        },
    )
    .await;
}

/// `NotificationsService.dispatch`: never raises.
pub async fn notify(st: &AppState, event: &str, payload: Value) {
    let Value::Object(map) = payload else { return };
    let map: Map<String, Value> = map;
    if let Err(e) = crate::notifications::dispatch(&st.db, event, &map).await {
        tracing::warn!(event, error = %e, "notification dispatch");
    }
}
