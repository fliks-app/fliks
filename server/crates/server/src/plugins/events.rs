//! What host imports emit on a plugin's behalf (`plugins.md` rule 33).
use super::runtime::fliks::plugin::types as t;
use crate::events::event::{Download, DownloadState, MediaKind};
use crate::events::{DomainEvent, Num, SseEvent};
use crate::state::AppState;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const PROGRESS_MIN: Duration = Duration::from_secs(1);

/// Enabled users who can open the media's page (`viewersForMedia`); admins-equivalent when none.
pub async fn viewers(st: &AppState, media_id: Option<i32>) -> Vec<i32> {
    match media_id {
        Some(id) => crate::subtitles::events::viewers_for_media(st, id).await,
        None => admins(st).await,
    }
}

async fn admins(st: &AppState) -> Vec<i32> {
    sqlx::query_scalar(r#"SELECT id FROM users WHERE "isAdmin" AND enabled ORDER BY id"#)
        .fetch_all(&st.db)
        .await
        .unwrap_or_default()
}

/// The media's requesters, else the admins (`recipientsForMedia`).
pub async fn recipients(st: &AppState, media_id: Option<i32>) -> Vec<i32> {
    if let Some(id) = media_id {
        let ids: Vec<i32> = sqlx::query_scalar(
            r#"SELECT DISTINCT "userId" FROM requests WHERE "mediaId" = $1 AND "userId" IS NOT NULL ORDER BY 1"#,
        )
        .bind(id)
        .fetch_all(&st.db)
        .await
        .unwrap_or_default();
        if !ids.is_empty() {
            return ids;
        }
    }
    admins(st).await
}

async fn media_row(st: &AppState, id: i32) -> Option<(String, String)> {
    sqlx::query_as(r#"SELECT title, type::text FROM media WHERE id = $1"#)
        .bind(id)
        .fetch_optional(&st.db)
        .await
        .ok()
        .flatten()
}

fn state_of(s: t::DownloadState) -> DownloadState {
    match s {
        t::DownloadState::Queued => DownloadState::Queued,
        t::DownloadState::Active => DownloadState::Active,
        t::DownloadState::Stalled => DownloadState::Stalled,
        t::DownloadState::Paused => DownloadState::Paused,
        t::DownloadState::Importing => DownloadState::Importing,
    }
}

fn download_of(d: &t::DownloadProgress) -> Download {
    Download {
        r#ref: d.ref_.clone(),
        season_number: d.season_number.map(i64::from),
        episode_number: d.episode_number.map(i64::from),
        progress: Num(d.progress),
        dlspeed: Num(d.bytes_per_second.unwrap_or(0.0)),
        eta: Num(d.eta_seconds.unwrap_or(0.0)),
        state: state_of(d.state),
    }
}

/// One `download.progress` to the media's viewers; nothing when there are none.
pub async fn push_progress(st: &AppState, media_id: i32, downloads: Vec<Download>) {
    let recipients = viewers(st, Some(media_id)).await;
    if recipients.is_empty() {
        return;
    }
    let kind = media_row(st, media_id).await.map(|(_, k)| k);
    st.hub.emit_to_users(
        &recipients,
        SseEvent::DownloadProgress {
            media_id: media_id.into(),
            media_type: if kind.as_deref() == Some("movie") {
                MediaKind::Movie
            } else {
                MediaKind::Series
            },
            downloads,
        },
    );
}

struct Gate {
    last: Instant,
    pending: Option<Vec<Download>>,
    armed: bool,
}

/// `progress.set`: one emission per media per second, the newest of a window wins.
#[derive(Default)]
pub struct Progress(Mutex<HashMap<i32, Gate>>);

impl Progress {
    pub async fn set(
        &'static self,
        st: &AppState,
        media_id: i32,
        downloads: &[t::DownloadProgress],
    ) {
        let set: Vec<Download> = downloads.iter().map(download_of).collect();
        let now = Instant::now();
        let wait = {
            let mut g = self.0.lock().unwrap();
            match g.get_mut(&media_id) {
                Some(gate) if now - gate.last < PROGRESS_MIN => {
                    gate.pending = Some(set.clone());
                    if gate.armed {
                        return;
                    }
                    gate.armed = true;
                    Some(PROGRESS_MIN - (now - gate.last))
                }
                _ => {
                    g.insert(
                        media_id,
                        Gate {
                            last: now,
                            pending: None,
                            armed: false,
                        },
                    );
                    None
                }
            }
        };
        let Some(wait) = wait else {
            return push_progress(st, media_id, set).await;
        };
        let st = st.clone();
        tokio::spawn(async move { self.flush(st, media_id, wait).await });
    }

    async fn flush(&'static self, st: AppState, media_id: i32, wait: Duration) {
        tokio::time::sleep(wait).await;
        let pending = {
            let mut g = self.0.lock().unwrap();
            let Some(gate) = g.get_mut(&media_id) else {
                return;
            };
            gate.armed = false;
            match gate.pending.take() {
                Some(p) => {
                    gate.last = Instant::now();
                    p
                }
                None => {
                    g.remove(&media_id);
                    return;
                }
            }
        };
        push_progress(&st, media_id, pending).await;
    }
}

pub fn progress_gates() -> &'static Progress {
    static P: std::sync::OnceLock<Progress> = std::sync::OnceLock::new();
    P.get_or_init(Progress::default)
}

/// Rule 33, in order.
pub async fn publish(st: &AppState, events: Vec<t::AcquisitionEvent>) {
    for e in events {
        match e {
            t::AcquisitionEvent::Grabbed(g) => {
                let (season, episode) = (
                    g.season_number.map(i64::from),
                    g.episode_number.map(i64::from),
                );
                st.hub.emit_domain(DomainEvent::AcquisitionGrabbed {
                    media_id: g.media_id.into(),
                    season_number: season,
                    episode_number: episode,
                });
                let mut set = st.hub.progress_current(g.media_id.into());
                set.push(Download {
                    r#ref: format!(
                        "pending:{}:{}",
                        g.season_number.map(|s| s.to_string()).unwrap_or_default(),
                        g.episode_number.map(|s| s.to_string()).unwrap_or_default()
                    ),
                    season_number: season,
                    episode_number: episode,
                    progress: Num(0.0),
                    dlspeed: Num(0.0),
                    eta: Num(0.0),
                    state: DownloadState::Queued,
                });
                push_progress(st, g.media_id as i32, set).await;
            }
            t::AcquisitionEvent::Imported(i) => {
                let id = i.media_id as i32;
                let title = media_row(st, id).await.map(|(t, _)| t).unwrap_or_default();
                let notify = st.clone();
                let payload =
                    json!({"title": title, "quality": i.quality, "sourceTitle": i.source_title});
                tokio::spawn(async move {
                    crate::subtitles::events::notify(&notify, "download.complete", payload).await
                });
                let to = viewers(st, Some(id)).await;
                st.hub.emit_to_users(
                    &to,
                    SseEvent::ImportComplete {
                        media_id: id.into(),
                        title,
                        season_number: i.season_number.map(i64::from),
                        episode_number: i.episode_number.map(i64::from),
                    },
                );
                st.hub.emit(SseEvent::QueueUpdated {});
                crate::media_servers::dispatch_detached(st, "download.complete");
            }
            t::AcquisitionEvent::Failed(f) => {
                let id = f.media_id as i32;
                let to = recipients(st, Some(id)).await;
                st.hub.emit_to_users(
                    &to,
                    SseEvent::ImportFailed {
                        media_id: id.into(),
                        title: f.title,
                        error: f.reason,
                    },
                );
                st.hub.emit(SseEvent::QueueUpdated {});
            }
            t::AcquisitionEvent::QueueChanged => st.hub.emit(SseEvent::QueueUpdated {}),
            t::AcquisitionEvent::StalledRemoved(s) => {
                let to = recipients(st, s.media_id.map(|m| m as i32)).await;
                st.hub
                    .emit_to_users(&to, SseEvent::StalledRemoved { title: s.title });
                st.hub.emit(SseEvent::QueueUpdated {});
            }
        }
    }
}

/// `events.emitOwn`: the `plugin.<id>.` prefix is forced.
pub async fn emit_own(st: &AppState, id: &str, kind: &str, payload: Value, audience: t::Audience) {
    let ty = format!("plugin.{id}.{kind}");
    match audience {
        t::Audience::Everyone => st.hub.emit_raw(&ty, payload, None),
        t::Audience::User(u) => st.hub.emit_raw(&ty, payload, Some(&[u as i32])),
        t::Audience::Media(m) => {
            let to = recipients(st, Some(m as i32)).await;
            st.hub.emit_raw(&ty, payload, Some(&to));
        }
    }
}
