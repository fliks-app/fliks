//! The request lifecycle (`requests.md` rules 32-42): what happens to requests when the media side moves.
use super::{db, services};
use crate::{
    events::{Bus, DomainEvent, SseEvent},
    http::AppError,
    profiles,
    state::AppState,
};
use fliks_domain::media::kind::MediaKind;
use serde_json::json;
use sqlx::PgConnection;
use tokio::sync::broadcast::error::RecvError;

type Res<T> = Result<T, AppError>;

/// The media row a hook reads; the rest is read from the database.
#[derive(Debug, Clone)]
pub struct MediaRef {
    pub id: i32,
    pub media_type: MediaKind,
    pub tmdb_id: Option<i32>,
    pub monitored: bool,
}

/// Handed to the media write side, which calls the hooks as plain calls (rule 42).
#[derive(Clone)]
pub struct Lifecycle {
    st: AppState,
}

fn warn(hook: &str, r: Res<()>) {
    if let Err(e) = r {
        tracing::warn!("request lifecycle {hook} failed: {e:?}");
    }
}

impl Lifecycle {
    pub fn of(st: &AppState) -> Self {
        Self { st: st.clone() }
    }

    /// After the media row is committed, before the import returns.
    pub async fn on_media_imported(&self, media: MediaRef, added_by: Option<i32>) {
        warn(
            "on_media_imported",
            self.media_imported(&media, added_by).await,
        );
    }

    /// Inside the media delete's transaction, before the row goes.
    pub async fn on_media_removed(
        &self,
        tx: &mut PgConnection,
        media: &MediaRef,
    ) -> Result<(), sqlx::Error> {
        db::resolve_removed(tx, media.id).await
    }

    pub async fn on_media_monitor_change(&self, media: MediaRef, was_monitored: bool) {
        if was_monitored && !media.monitored {
            warn(
                "on_media_monitor_change",
                self.retire_linked(media.id, "Media was unmonitored").await,
            );
        }
    }

    pub async fn on_season_monitor_change(
        &self,
        media: MediaRef,
        season: i32,
        was: bool,
        now: bool,
    ) {
        if was && !now {
            warn(
                "on_season_monitor_change",
                self.season_unmonitored(media.id, i64::from(season)).await,
            );
        }
    }

    async fn media_imported(&self, media: &MediaRef, added_by: Option<i32>) -> Res<()> {
        let Some(tmdb_id) = media.tmdb_id else {
            return Ok(());
        };
        let open = db::in_flight_by_title(&self.st.db, tmdb_id, media.media_type).await?;
        let Some(row) = db::media_by_id(&self.st.db, media.id).await? else {
            return Ok(());
        };
        let have = (row.quality_profile_id, row.language_profile_id);
        let mut touched = false;
        for r in open {
            let want = (r.quality_profile_id, r.language_profile_id);
            if !profiles::envelope_covers(&self.st.db, have, want).await? {
                continue;
            }
            db::adopt(&self.st.db, r.id, media.id, added_by.filter(|u| *u != 0)).await?;
            let seasons = r.scope().filter(|_| media.media_type.has_seasons());
            db::monitor_scope(&self.st.db, media.id, seasons).await?;
            touched = true;
        }
        if touched {
            self.st
                .hub
                .emit_domain(DomainEvent::MediaAcquisitionRequested {
                    media_ids: vec![i64::from(media.id)],
                    reason: "media-imported".into(),
                });
        }
        Ok(())
    }

    /// `acquisition.grabbed`: approved requests of the media start processing (rule 37).
    pub async fn mark_in_progress(&self, media_id: i32, season: Option<i32>) -> Res<()> {
        for r in db::linked(&self.st.db, media_id, None, &["approved"]).await? {
            if let Some(s) = season
                && r.scope()
                    .is_some_and(|scope| !scope.contains(&i64::from(s)))
            {
                continue;
            }
            if db::set_status(&self.st.db, r.id, "processing", &["approved"]).await? {
                services::notify(
                    &self.st,
                    "request.processing",
                    obj(json!({"title": r.title, "mediaType": r.media_type})),
                );
            }
        }
        Ok(())
    }

    /// `import.complete`: requests whose scope is now on disk become available (rule 41).
    pub async fn on_import_complete(&self, media_id: i32) -> Res<()> {
        let active = db::linked(&self.st.db, media_id, None, &["approved", "processing"]).await?;
        if active.is_empty() {
            return Ok(());
        }
        let Some(media) = db::media_by_id(&self.st.db, media_id).await? else {
            return Ok(());
        };
        let (eps, files) = match media.media_type {
            MediaKind::Movie => (vec![], db::file_count(&self.st.db, media_id).await?),
            MediaKind::Series => (db::episodes(&self.st.db, media_id).await?, 0),
        };
        for r in active {
            let covered = match media.media_type {
                MediaKind::Movie => files > 0,
                MediaKind::Series => scope_covered(r.scope(), &eps),
            };
            if !covered {
                continue;
            }
            if db::set_status(&self.st.db, r.id, "available", &["approved", "processing"]).await? {
                services::notify(
                    &self.st,
                    "request.available",
                    obj(json!({"title": r.title, "mediaType": r.media_type})),
                );
            }
        }
        Ok(())
    }

    /// Rule 43: `on_import_complete` over every media with an open request, for events that never arrived.
    pub async fn reconcile(&self) {
        let ids = match db::media_with_open_adds(&self.st.db).await {
            Ok(ids) => ids,
            Err(e) => return tracing::warn!("request reconcile failed: {e}"),
        };
        for id in ids {
            if let Err(e) = self.on_import_complete(id).await {
                tracing::warn!("request reconcile failed for media#{id}: {e:?}");
            }
        }
    }

    /// Retires the ADD requests linked to the media (rules 38, 40).
    async fn retire_linked(&self, media_id: i32, reason: &str) -> Res<()> {
        let mut c = self.st.db.acquire().await?;
        Ok(db::retire_linked(&mut c, media_id, reason).await?)
    }

    /// Rule 39: a request scoped to the season is declined (`removed` once available), a wider one loses it;
    /// a whole-series request keeps the other monitored seasons so this one can be requested again.
    async fn season_unmonitored(&self, media_id: i32, season: i64) -> Res<()> {
        let statuses = [db::IN_FLIGHT.as_slice(), &["available"]].concat();
        let mut whole: Option<Vec<i64>> = None;
        for r in db::linked(&self.st.db, media_id, None, &statuses).await? {
            let scope = match r.scope() {
                Some(s) => s.to_vec(),
                None if r.media_type.has_seasons() => {
                    if whole.is_none() {
                        whole = Some(db::monitored_seasons(&self.st.db, media_id, season).await?);
                    }
                    whole.clone().unwrap_or_default()
                }
                None => continue,
            };
            if !scope.contains(&season) {
                continue;
            }
            let rest: Vec<i64> = scope.into_iter().filter(|n| *n != season).collect();
            if rest.is_empty() && r.status == "available" {
                db::remove_unlink(&self.st.db, r.id).await?;
            } else if rest.is_empty() {
                let reason = format!("Season {season} was unmonitored");
                db::decline_unlink(&self.st.db, r.id, &reason).await?;
            } else {
                db::trim_seasons(&self.st.db, r.id, &rest).await?;
            }
        }
        Ok(())
    }
}

fn obj(v: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    match v {
        serde_json::Value::Object(o) => o,
        _ => Default::default(),
    }
}

/// `isRequestScopeCovered` for a series: every monitored episode of the monitored scoped seasons is on
/// disk; a scope with nothing to check is not covered.
pub(super) fn scope_covered(scope: Option<&[i64]>, eps: &[db::Ep]) -> bool {
    let mut seasons: Vec<i32> = eps.iter().map(|e| e.season_number).collect();
    seasons.dedup();
    let mut checked = false;
    for s in seasons {
        if scope.is_some_and(|sc| !sc.contains(&i64::from(s))) {
            continue;
        }
        let in_season: Vec<&db::Ep> = eps.iter().filter(|e| e.season_number == s).collect();
        if !in_season.iter().any(|e| e.season_monitored) {
            continue;
        }
        let monitored: Vec<&&db::Ep> = in_season.iter().filter(|e| e.monitored).collect();
        if monitored.is_empty() {
            continue;
        }
        checked = true;
        let disk = fliks_domain::media::episodes_on_disk(
            in_season
                .iter()
                .map(|e| (e.number, e.end_number, e.has_file)),
        );
        if !monitored.iter().all(|e| disk.contains(&e.number)) {
            return false;
        }
    }
    checked
}

/// One reconcile at startup, then hourly (rule 43); the cron timer dies with the runtime.
pub fn spawn_reconcile(st: &AppState) {
    let lc = Lifecycle::of(st);
    let first = lc.clone();
    tokio::spawn(async move { first.reconcile().await });
    crate::jobs::spawn_cron(
        "0 * * * *",
        crate::jobs::server_tz(),
        chrono::Utc::now,
        move || {
            let lc = lc.clone();
            tokio::spawn(async move { lc.reconcile().await });
        },
    );
}

/// The two event subscriptions of rule 34, at-most-once: `import.complete` and `acquisition.grabbed`.
pub fn spawn(st: &AppState) {
    let lc = Lifecycle::of(st);
    let mut rx = st.hub.subscribe();
    tokio::spawn(async move {
        loop {
            let ev = match rx.recv().await {
                Ok(ev) => ev,
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!("request lifecycle lagged {n} events");
                    continue;
                }
                Err(RecvError::Closed) => return,
            };
            let lc = lc.clone();
            match &*ev {
                Bus::Sse(SseEvent::ImportComplete { media_id, .. }) => {
                    let Ok(id) = i32::try_from(*media_id) else {
                        continue;
                    };
                    tokio::spawn(async move {
                        if let Err(e) = lc.on_import_complete(id).await {
                            tracing::warn!("onImportComplete failed for media#{id}: {e:?}");
                        }
                    });
                }
                Bus::Domain(DomainEvent::AcquisitionGrabbed {
                    media_id,
                    season_number,
                    ..
                }) => {
                    let Ok(id) = i32::try_from(*media_id) else {
                        continue;
                    };
                    let season = season_number.and_then(|s| i32::try_from(s).ok());
                    tokio::spawn(async move {
                        if let Err(e) = lc.mark_in_progress(id, season).await {
                            tracing::warn!("markInProgress failed for media#{id}: {e:?}");
                        }
                    });
                }
                _ => {}
            }
        }
    });
}
