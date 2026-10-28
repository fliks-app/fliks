//! `POST /api/media/:id/rescan` and `/analyze` (rules 59-61): detached work, answered at once.
use super::{already_running, gate, subject};
use crate::{
    events::{DomainEvent, SseEvent},
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson, from_value},
    },
    ingest::{load_media, post_import, rescan},
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use fliks_domain::acl::Action;
use serde_json::{Value, json};

#[utoipa::path(post, path = "/api/media/{id}/rescan", responses((status = 201)))]
pub async fn rescan(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let id = gate(&st, &a, Action::Update, id).await?;
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    let user = a.user.id;
    tracing::info!("Rescan requested for media #{id} \"{}\"", media.title);
    st.hub.emit_to_user(
        user,
        SseEvent::RescanStarted {
            media_id: i64::from(id),
            title: media.title.clone(),
        },
    );
    let key = format!("Rescan:{id}");
    let subj = subject(id, &media.title, &media.media_type);
    if !st
        .hub
        .activity()
        .claim(&key, "Rescan", Some(subj), None, None, None)
    {
        return Err(already_running());
    }
    let st2 = st.clone();
    tokio::spawn(async move {
        let guard = st2.ingest.media.lock(id).await;
        let r = rescan::rescan_files(&st2, &guard, id).await;
        drop(guard);
        st2.hub.activity().remove(&key);
        let title = media.title.clone();
        match r {
            Ok(c) => {
                st2.hub.emit_to_user(
                    user,
                    SseEvent::RescanCompleted {
                        media_id: i64::from(id),
                        title,
                        added: c.added,
                        removed: c.removed,
                        updated: c.updated,
                        subtitle_removed_missing: Some(c.subtitle_removed_missing),
                        subtitle_removed_duplicates: Some(c.subtitle_removed_duplicates),
                    },
                );
                if let Some(lib) = media.library_id {
                    st2.hub.emit_domain(DomainEvent::LibraryScanCompleted {
                        library_id: i64::from(lib),
                        added: c.added,
                        updated: c.updated,
                    });
                }
                if c.added > 0 {
                    st2.ingest.settle.schedule(&st2, id);
                }
                post_import::scan_sources(&st2, id).await;
            }
            Err(e) => {
                tracing::error!("Rescan of media #{id} failed: {e:?}");
                st2.hub.emit_to_user(
                    user,
                    SseEvent::RescanFailed {
                        media_id: i64::from(id),
                        title,
                        error: e.text(),
                    },
                );
            }
        }
    });
    Ok((StatusCode::CREATED, Json(json!({"ok": true}))))
}

/// No claim, no event: two analyses of one media both run (rule 60).
#[utoipa::path(post, path = "/api/media/{id}/analyze", responses((status = 201)))]
pub async fn analyze(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let id = gate(&st, &a, Action::Update, id).await?;
    let opts: rescan::Analyze = from_value(v)?;
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    tracing::info!("Analyze requested for media #{id} \"{}\"", media.title);
    let st2 = st.clone();
    tokio::spawn(async move {
        if let Err(e) = rescan::analyze(&st2, id, opts).await {
            tracing::error!("Analyze of media #{id} failed: {e:?}");
        }
    });
    Ok((StatusCode::CREATED, Json(json!({"ok": true}))))
}
