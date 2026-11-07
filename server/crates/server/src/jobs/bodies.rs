//! The job bodies of `scheduler.md` rules 22-31: loops, progress events, activity rows and logs.
use crate::{
    events::{Hub, Num, SseEvent, Subject},
    ingest::rescan::rescan_files,
    markers::{self, ScanSeason},
    state::AppState,
    stream::{self, sprite},
    system::backup,
};
use chrono::{DateTime, NaiveDate, Utc};
use fliks_domain::{media::kind::MediaKind, metadata::limiter::Priority, refresh};
use fliks_engine_core::api::JobPriority;
use sqlx::{FromRow, PgPool};

type Outcome = Result<(), String>;

/// Runs the named job to its end; an `Err` is logged by the audit wrapper and ends the row `failed`.
pub async fn run(st: &AppState, name: &str) -> Outcome {
    match name {
        "Backup" => backup_job(st).await,
        "RefreshMetadata" => refresh_metadata(st).await,
        "RefreshMissingMetadata" => refresh_missing(st).await,
        "RescanAll" => rescan(st, name, sqlx::query_as(ALL_MEDIA)).await,
        "RescanMissingFiles" => {
            let select = sqlx::query_as(MISSING_FILES).bind(MediaKind::seasonal_names());
            rescan(st, name, select).await
        }
        "GenerateSprites" => sprites(st, name, true).await,
        "GenerateMissingSprites" => sprites(st, name, false).await,
        "DetectMarkers" => markers(st, name, false).await,
        "DetectMissingMarkers" => markers(st, name, true).await,
        "SubtitleSearch" => crate::subtitles::scheduler::search_missing(st).await,
        "SubtitleUpgrade" => crate::subtitles::scheduler::upgrade(st).await,
        "LiveTvSourceRefresh" => crate::livetv::jobs::refresh_sources(st).await,
        "LiveTvGuideRefresh" => crate::livetv::jobs::refresh_guides(st).await,
        "LiveTvGuidePrune" => crate::livetv::jobs::prune_guide(st).await,
        "MediaCleanup" => crate::cleanup::run(st).await,
        "FollowRefresh" => crate::wanted::refresh_follows(st).await,
        "RefreshPluginSources" => crate::plugins::sources::refresh_and_update(st).await,
        _ => Err(format!("unknown job {name}")),
    }
}

async fn backup_job(st: &AppState) -> Outcome {
    let dir = backup::dir();
    let made = backup::create(&st.cfg, &dir)
        .await
        .map_err(|e| e.to_string())?;
    let pruned = backup::prune(&dir, backup::KEEP)
        .await
        .map_err(|e| e.to_string())?;
    let mut line = format!("Backup: wrote {} ({} bytes)", made.filename, made.size);
    if pruned > 0 {
        line.push_str(&format!(", pruned {pruned} older backup(s)"));
    }
    tracing::info!("{line}");
    Ok(())
}

fn provider_available(st: &AppState, job: &str) -> bool {
    let set = MediaKind::ALL
        .into_iter()
        .any(|k| st.metadata.resolve(None, k).is_some());
    if !set {
        tracing::warn!("{job}: no metadata provider available");
    }
    set
}

#[derive(FromRow)]
struct MediaRow {
    id: i32,
    title: String,
    #[sqlx(try_from = "String")]
    kind: MediaKind,
    status: String,
    release_date: Option<NaiveDate>,
    year: Option<i32>,
    refreshed_at: Option<DateTime<Utc>>,
    poster: Option<String>,
    overview: Option<String>,
    identified: bool,
    no_seasons: bool,
}

impl MediaRow {
    fn subject(&self) -> Subject {
        Subject::media(self.id, &self.title, Some(self.kind))
    }
}

async fn identified_media(db: &PgPool) -> sqlx::Result<(Vec<MediaRow>, usize)> {
    let all: Vec<MediaRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT m.id, m.title, m."type" AS kind, m.status::text AS status, dates.release_date,
                  m.year, m."metadataRefreshedAt" AS refreshed_at, m."posterUrl" AS poster, m.overview,
                  EXISTS (SELECT 1 FROM media_external_ids x WHERE x."mediaId" = m.id) AS identified,
                  (m."type" = ANY($1) AND NOT EXISTS (SELECT 1 FROM item_groups s WHERE s."mediaId" = m.id)) AS no_seasons
           FROM media m {} ORDER BY m.id"#,
        crate::media::details::dates_join("m")
    )))
    .bind(MediaKind::seasonal_names())
    .fetch_all(db)
    .await?;
    let total = all.len();
    Ok((all.into_iter().filter(|m| m.identified).collect(), total))
}

async fn refresh_metadata(st: &AppState) -> Outcome {
    const JOB: &str = "RefreshMetadata";
    if let Err(e) = crate::metadata::prune_snapshots(&st.db).await {
        tracing::warn!("{JOB}: snapshot cleanup failed: {e}");
    }
    if let Err(e) = crate::scene::refresh(st).await {
        tracing::warn!("{JOB}: scene mappings failed: {e}");
    }
    if !provider_available(st, JOB) {
        return Ok(());
    }
    let (identified, total) = identified_media(&st.db).await.map_err(|e| e.to_string())?;
    let unidentified = total - identified.len();
    let (now, tz) = (Utc::now(), super::cron::server_tz());
    let known = identified.len();
    let due: Vec<_> = identified
        .iter()
        .filter(|m| {
            refresh::is_due(
                &refresh::Row {
                    kind: m.kind,
                    status: &m.status,
                    release_date: m.release_date,
                    year: m.year,
                    refreshed_at: m.refreshed_at,
                },
                now,
                &tz,
            )
        })
        .collect();
    let skipped = known - due.len();
    tracing::info!(
        "{JOB}: starting refresh for {}/{total} media ({skipped} settled title(s) skipped, {unidentified} unidentified title(s) skipped)",
        due.len()
    );
    let updated = refresh_loop(st, JOB, &due, true).await?;
    tracing::info!(
        "{JOB}: updated {updated}/{} titles ({skipped} skipped)",
        due.len()
    );
    Ok(())
}

async fn refresh_missing(st: &AppState) -> Outcome {
    const JOB: &str = "RefreshMissingMetadata";
    if !provider_available(st, JOB) {
        return Ok(());
    }
    let months =
        refresh::stale_months(std::env::var("METADATA_STALE_AFTER_MONTHS").ok().as_deref());
    let before = refresh::stale_before(Utc::now(), months, &super::cron::server_tz());
    let (identified, total) = identified_media(&st.db).await.map_err(|e| e.to_string())?;
    let unidentified = total - identified.len();
    let candidates: Vec<_> = identified
        .iter()
        .filter(|m| {
            refresh::needs_refresh(
                m.poster.as_deref(),
                m.overview.as_deref(),
                m.no_seasons,
                m.refreshed_at,
                before,
            )
        })
        .collect();
    let updated = refresh_loop(st, JOB, &candidates, false).await?;
    tracing::info!(
        "{JOB}: refreshed {updated}/{} titles (from {total} total, {unidentified} unidentified title(s) skipped)",
        candidates.len()
    );
    Ok(())
}

/// Rules 23, 25: `chatty` adds RefreshMetadata's per-title log line.
async fn refresh_loop(
    st: &AppState,
    job: &str,
    rows: &[&MediaRow],
    chatty: bool,
) -> Result<u32, String> {
    let _row = ActivityRows::new(&st.hub, [job.to_owned()]);
    let served: Vec<&&MediaRow> = rows
        .iter()
        .filter(|m| st.metadata.resolve(None, m.kind).is_some())
        .collect();
    if served.len() < rows.len() {
        tracing::info!(
            "{job}: {} title(s) skipped, no metadata provider for their kind",
            rows.len() - served.len()
        );
    }
    let rows: Vec<&MediaRow> = served.into_iter().copied().collect();
    let total = rows.len();
    let mut updated = 0;
    for (i, m) in rows.iter().enumerate() {
        let subject = m.subject();
        progress(
            &st.hub,
            job,
            i,
            total,
            m.title.clone(),
            Some(subject.clone()),
        );
        running(&st.hub, job, job, Some(subject), i, total, None);
        if chatty {
            tracing::info!("{job}: refreshing \"{}\" ({}/{total})", m.title, i + 1);
        }
        let refreshed = match crate::ingest::load_media(&st.db, m.id).await {
            Ok(Some(full)) => {
                crate::media::write::refresh_any(st, &full, false, Priority::Background).await
            }
            Ok(None) => continue,
            Err(e) => Err(e.into()),
        };
        match refreshed {
            Ok(_) => updated += 1,
            Err(e) => tracing::warn!("{job}: failed for \"{}\": {e}", m.title),
        }
    }
    done(&st.hub, job, total);
    Ok(updated)
}

const ALL_MEDIA: &str = r#"SELECT id, title, "type" FROM media ORDER BY id"#;
const MISSING_FILES: &str = r#"SELECT m.id, m.title, m."type" FROM media m JOIN library_default_folders df ON df."libraryId" = m."libraryId"
    WHERE (
        (NOT EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id) AND COALESCE(m."folderName", '') <> '')
        OR (m."type" = ANY($1)
            AND EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id
                AND NOT EXISTS (SELECT 1 FROM item_parts p WHERE p."mediaFileId" = f.id))))
    ORDER BY m.id"#;

type MediaQuery<'q> =
    sqlx::query::QueryAs<'q, sqlx::Postgres, (i32, String, String), sqlx::postgres::PgArguments>;

async fn rescan(st: &AppState, job: &str, select: MediaQuery<'_>) -> Outcome {
    let media = select
        .fetch_all(&st.db)
        .await
        .and_then(|rows| {
            rows.into_iter()
                .map(|(id, title, kind)| Ok((id, title, crate::db::kind(&kind)?)))
                .collect::<sqlx::Result<Vec<_>>>()
        })
        .map_err(|e| e.to_string())?;
    let total = media.len();
    tracing::info!("{job}: started — {total} media to scan");
    let child = |id: i32| format!("{job}:{id}");
    let hub = &st.hub;
    for (id, title, kind) in &media {
        hub.activity().upsert_pending(
            &child(*id),
            job,
            Some(Subject::media(*id, title, Some(*kind))),
            Some(job.into()),
        );
    }
    let _rows = ActivityRows::new(
        hub,
        std::iter::once(job.to_owned()).chain(media.iter().map(|m| child(m.0))),
    );
    let (mut changes, mut skipped) = (0, 0);
    for (i, (id, title, kind)) in media.iter().enumerate() {
        let subject = Subject::media(*id, title, Some(*kind));
        progress(hub, job, i, total, title.clone(), Some(subject.clone()));
        running(hub, job, job, None, i, total, None);
        hub.activity()
            .upsert_running(&child(*id), job, Some(subject), None, None, None);
        let guard = st.ingest.media.lock(*id).await;
        let scanned = rescan_files(st, &guard, *id, false).await;
        drop(guard);
        match scanned {
            Ok(r) => changes += r.added + r.removed + r.updated,
            Err(e) => {
                skipped += 1;
                tracing::warn!("{job}: skipped \"{title}\": {e}");
            }
        }
        hub.activity().remove(&child(*id));
    }
    done(hub, job, total);
    tracing::info!(
        "{job}: scanned {}/{total} media, {changes} change(s), {skipped} skipped",
        total - skipped
    );
    if skipped > 0 {
        tracing::warn!("{job}: {skipped} media failed (see WARN lines above per title)");
    }
    Ok(())
}

/// Files go two at a time (rule 28).
const SPRITE_BATCH: usize = 2;

async fn sprites(st: &AppState, job: &str, force: bool) -> Outcome {
    let ids: Vec<i32> = sqlx::query_scalar("SELECT id FROM media_files ORDER BY id")
        .fetch_all(&st.db)
        .await
        .map_err(|e| e.to_string())?;
    let subjects = crate::events::subject::for_files(&st.db, &ids)
        .await
        .map_err(|e| e.to_string())?;
    let hub = &st.hub;
    let child = |id: i32| format!("GenerateSprite:{id}");
    for id in &ids {
        hub.activity().upsert_pending(
            &child(*id),
            "GenerateSprite",
            subjects.get(id).cloned(),
            Some(job.into()),
        );
    }
    let _rows = ActivityRows::new(
        hub,
        std::iter::once(job.to_owned()).chain(ids.iter().map(|i| child(*i))),
    );
    let total = ids.len();
    let subjects = &subjects;
    let mut generated = 0;
    for (n, batch) in ids.chunks(SPRITE_BATCH).enumerate() {
        let first = subjects.get(&batch[0]);
        let message = first.map_or_else(|| job.to_owned(), Subject::format);
        progress(hub, job, n * SPRITE_BATCH, total, message, first.cloned());
        running(hub, job, job, None, n * SPRITE_BATCH, total, None);
        let one = |id: Option<i32>| async move {
            let Some(id) = id else { return false };
            let made = sprite_of(st, id, subjects.get(&id), force, job).await;
            hub.activity().remove(&child(id));
            made
        };
        let (a, b) = tokio::join!(one(batch.first().copied()), one(batch.get(1).copied()));
        generated += u32::from(a) + u32::from(b);
    }
    tracing::info!("{job}: generated {generated}/{total} sprites");
    Ok(())
}

/// `PostImportService.generateSprite`: a failure is a warning and counts as not generated.
async fn sprite_of(
    st: &AppState,
    id: i32,
    subject: Option<&Subject>,
    force: bool,
    job: &str,
) -> bool {
    let file = match stream::resolve_file(st, None, i64::from(id)).await {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("Sprite failed for file #{id}: {e:?}");
            return false;
        }
    };
    let title = file.media_title.clone().unwrap_or_default();
    let subject = subject.cloned().unwrap_or_else(|| {
        Subject::media(file.media_id.unwrap_or_default(), &title, file.media_type)
    });
    let priority = if force {
        JobPriority::Normal
    } else {
        JobPriority::Low
    };
    sprite::generate(
        st,
        sprite::SpriteJob {
            file_id: id,
            path: &file.absolute,
            info: file.info.as_ref(),
            title: &title,
            subject,
            force,
            priority,
            parent_id: Some(job.into()),
        },
    )
    .await
    .is_some()
}

async fn markers(st: &AppState, job: &str, only_missing: bool) -> Outcome {
    let seasons = markers::list_seasons_for_scan(st, only_missing, None)
        .await
        .map_err(|e| e.to_string())?;
    let total = seasons.len();
    tracing::info!("{job}: started — {total} season(s) to scan");
    let child = |s: &ScanSeason| format!("IntroDetection:{}", s.id);
    let subject = |s: &ScanSeason| Subject {
        season_number: Some(i64::from(s.season_number)),
        ..Subject::media(s.media_id, &s.media_title, Some(s.kind))
    };
    for s in &seasons {
        st.hub.activity().upsert_pending(
            &child(s),
            "IntroDetection",
            Some(subject(s)),
            Some(job.into()),
        );
    }
    let _rows = ActivityRows::new(
        &st.hub,
        std::iter::once(job.to_owned()).chain(seasons.iter().map(child)),
    );
    let (mut detected, mut skipped) = (0, 0);
    for (i, s) in seasons.iter().enumerate() {
        let subject = subject(s);
        progress(
            &st.hub,
            job,
            i,
            total,
            subject.format(),
            Some(subject.clone()),
        );
        running(&st.hub, job, job, None, i, total, None);
        match markers::run_detection_inline(st, s.id, Some(subject)).await {
            Ok((intros, outros)) => detected += intros + outros,
            Err(e) => {
                skipped += 1;
                tracing::warn!(
                    "{job}: skipped \"{}\" S{}: {e}",
                    s.media_title,
                    s.season_number
                );
            }
        }
    }
    done(&st.hub, job, total);
    tracing::info!(
        "{job}: done — {detected} marker(s) saved across {}/{total} season(s)",
        total - skipped
    );
    Ok(())
}

fn progress(
    hub: &Hub,
    command: &str,
    current: usize,
    total: usize,
    message: String,
    subject: Option<Subject>,
) {
    hub.emit(SseEvent::TaskProgress {
        command: command.into(),
        current: Num(current as f64),
        total: Num(total as f64),
        message,
        subject,
    });
}

/// The closing 100 % frame, only when there was work.
fn done(hub: &Hub, command: &str, total: usize) {
    if total > 0 {
        progress(hub, command, total, total, command.into(), None);
    }
}

fn running(
    hub: &Hub,
    id: &str,
    ty: &str,
    subject: Option<Subject>,
    i: usize,
    total: usize,
    parent: Option<String>,
) {
    hub.activity().upsert_running(
        id,
        ty,
        subject,
        Some(Num(i as f64)),
        Some(Num(total as f64)),
        parent,
    );
}

/// Removes its rows when the job ends, however it ends (the `finally` of the TS loops).
pub(crate) struct ActivityRows {
    hub: Hub,
    ids: Vec<String>,
}

impl ActivityRows {
    pub(crate) fn new(hub: &Hub, ids: impl IntoIterator<Item = String>) -> Self {
        Self {
            hub: hub.clone(),
            ids: ids.into_iter().collect(),
        }
    }
}

impl Drop for ActivityRows {
    fn drop(&mut self) {
        self.ids
            .iter()
            .for_each(|id| self.hub.activity().remove(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[sqlx::test(migrations = false)]
    async fn a_plugin_id_alone_makes_a_media_identified(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO media (id, title, "type") VALUES (1, 'a', 'movie'), (2, 'b', 'movie');
               INSERT INTO provider_namespaces (name, "pluginId", "idPattern", "case", label)
                 VALUES ('org.live:a', 'org.live', '^[0-9]+$', 'preserve', 'A');
               INSERT INTO media_external_ids ("mediaId", kind, provider, value)
                 VALUES (1, 'movie', 'org.live:a', '7');"#,
        )
        .execute(&db)
        .await
        .unwrap();
        let (rows, total) = identified_media(&db).await.unwrap();
        assert_eq!(
            (rows.iter().map(|m| m.id).collect::<Vec<_>>(), total),
            (vec![1], 2)
        );
    }
}
