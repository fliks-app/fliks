//! The job bodies of `scheduler.md` rules 22-31: loops, progress events, activity rows and logs.
use super::names;
use crate::{
    events::{Hub, Num, SseEvent, Subject},
    ingest::rescan::rescan_files,
    markers::{self, ScanSeason},
    metadata::Provider,
    state::AppState,
    stream::{self, sprite},
    system::backup,
};
use chrono::{DateTime, NaiveDate, Utc};
use fliks_domain::refresh;
use fliks_engine_core::api::JobPriority;
use sqlx::{FromRow, PgPool};
use std::collections::HashMap;

type Outcome = Result<(), String>;

/// Runs the named job to its end; an `Err` is logged by the audit wrapper and ends the row `failed`.
pub async fn run(st: &AppState, name: &str) -> Outcome {
    match name {
        "Backup" => backup_job(st).await,
        "RefreshMetadata" => refresh_metadata(st).await,
        "RefreshMissingMetadata" => refresh_missing(st).await,
        "RescanAll" => rescan(st, name, ALL_MEDIA).await,
        "RescanMissingFiles" => rescan(st, name, MISSING_FILES).await,
        "GenerateSprites" => sprites(st, name, true).await,
        "GenerateMissingSprites" => sprites(st, name, false).await,
        "DetectMarkers" => markers(st, name, false).await,
        "DetectMissingMarkers" => markers(st, name, true).await,
        _ if names::BRIDGED.contains(&name) || !names::is_core(name) => bridged(st, name).await,
        _ => Err(format!("unknown job {name}")),
    }
}

/// Registry jobs and the core bodies Nest still holds (rules 18, 30, 31).
async fn bridged(st: &AppState, name: &str) -> Outcome {
    match st.bridge.run_job(name).await {
        Ok((s, _)) if s.as_u16() == 204 => Ok(()),
        Ok((s, m)) => Err(m.unwrap_or_else(|| format!("jobs/run answered {s}"))),
        Err(e) => Err(e.to_string()),
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

fn tmdb_configured(st: &AppState, job: &str) -> bool {
    let set = st.metadata.available(Provider::Tmdb);
    if !set {
        tracing::warn!("{job}: TMDB_API_KEY not configured");
    }
    set
}

#[derive(FromRow)]
struct MediaRow {
    id: i32,
    title: String,
    kind: String,
    status: String,
    release_date: Option<NaiveDate>,
    year: Option<i32>,
    refreshed_at: Option<DateTime<Utc>>,
    poster: Option<String>,
    overview: Option<String>,
    tmdb: Option<i32>,
    tvdb: Option<i32>,
    imdb: Option<String>,
    no_seasons: bool,
}

impl MediaRow {
    fn identified(&self) -> bool {
        refresh::identified(self.tmdb, self.tvdb, self.imdb.as_deref())
    }

    fn subject(&self) -> Subject {
        media_subject(self.id, &self.title, &self.kind)
    }
}

async fn identified_media(db: &PgPool) -> sqlx::Result<(Vec<MediaRow>, usize)> {
    let all: Vec<MediaRow> = sqlx::query_as(
        r#"SELECT m.id, m.title, m."type"::text AS kind, m.status::text AS status, m."releaseDate" AS release_date,
                  m.year, m."metadataRefreshedAt" AS refreshed_at, m."posterUrl" AS poster, m.overview,
                  m."tmdbId" AS tmdb, m."tvdbId" AS tvdb, m."imdbId" AS imdb,
                  (m."type"::text = 'series' AND NOT EXISTS (SELECT 1 FROM seasons s WHERE s."mediaId" = m.id)) AS no_seasons
           FROM media m ORDER BY m.id"#,
    )
    .fetch_all(db)
    .await?;
    let total = all.len();
    Ok((
        all.into_iter().filter(MediaRow::identified).collect(),
        total,
    ))
}

async fn refresh_metadata(st: &AppState) -> Outcome {
    const JOB: &str = "RefreshMetadata";
    if !tmdb_configured(st, JOB) {
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
                    is_series: m.kind == "series",
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
    if !tmdb_configured(st, JOB) {
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
        match crate::media::write::refresh_metadata(st, m.id, false).await {
            Ok(_) => updated += 1,
            Err(e) => tracing::warn!("{job}: failed for \"{}\": {e}", m.title),
        }
    }
    done(&st.hub, job, total);
    Ok(updated)
}

const ALL_MEDIA: &str = r#"SELECT id, title, "type"::text FROM media ORDER BY id"#;
const MISSING_FILES: &str = r#"SELECT m.id, m.title, m."type"::text FROM media m JOIN libraries l ON l.id = m."libraryId"
    WHERE l.path IS NOT NULL AND l.path <> '' AND (
        (NOT EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id) AND COALESCE(m."folderName", '') <> '')
        OR (m."type"::text = 'series'
            AND EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id AND f."episodeId" IS NULL)))
    ORDER BY m.id"#;

async fn rescan(st: &AppState, job: &str, select: &str) -> Outcome {
    let media: Vec<(i32, String, String)> = sqlx::query_as(select)
        .fetch_all(&st.db)
        .await
        .map_err(|e| e.to_string())?;
    let total = media.len();
    tracing::info!("{job}: started — {total} media to scan");
    let child = |id: i32| format!("{job}:{id}");
    let hub = &st.hub;
    for (id, title, kind) in &media {
        hub.activity().upsert_pending(
            &child(*id),
            job,
            Some(media_subject(*id, title, kind)),
            Some(job.into()),
        );
    }
    let _rows = ActivityRows::new(
        hub,
        std::iter::once(job.to_owned()).chain(media.iter().map(|m| child(m.0))),
    );
    let (mut changes, mut skipped) = (0, 0);
    for (i, (id, title, kind)) in media.iter().enumerate() {
        let subject = media_subject(*id, title, kind);
        progress(hub, job, i, total, title.clone(), Some(subject.clone()));
        running(hub, job, job, None, i, total, None);
        hub.activity()
            .upsert_running(&child(*id), job, Some(subject), None, None, None);
        let guard = st.ingest.media.lock(*id).await;
        let scanned = rescan_files(st, &guard, *id).await;
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
    let subjects = file_subjects(&st.db, &ids)
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
        let message = first.map_or_else(|| job.to_owned(), format_subject);
        progress(hub, job, n * SPRITE_BATCH, total, message, first.cloned());
        running(hub, job, job, None, n * SPRITE_BATCH, total, None);
        let one = |id: Option<i32>| async move {
            let Some(id) = id else { return false };
            let made = sprite_of(st, id, subjects.get(&id), force).await;
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
async fn sprite_of(st: &AppState, id: i32, subject: Option<&Subject>, force: bool) -> bool {
    let file = match stream::resolve_file(st, None, i64::from(id)).await {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("Sprite failed for file #{id}: {e:?}");
            return false;
        }
    };
    let title = file.media_title.clone().unwrap_or_default();
    let subject = subject.cloned().unwrap_or_else(|| Subject {
        title: title.clone(),
        ..media_subject(
            file.media_id.unwrap_or_default(),
            &title,
            file.media_type.as_deref().unwrap_or_default(),
        )
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
        },
    )
    .await
    .is_some()
}

/// `buildMediaProgressSubject` for every file, scalar columns only and in chunks of 1 000 ids.
async fn file_subjects(db: &PgPool, ids: &[i32]) -> sqlx::Result<HashMap<i32, Subject>> {
    type Row = (
        i32,
        i32,
        String,
        String,
        Option<i32>,
        Option<i32>,
        Option<String>,
        Option<i32>,
    );
    let mut out = HashMap::new();
    for chunk in ids.chunks(1000) {
        let rows: Vec<Row> = sqlx::query_as(
            r#"SELECT f.id, m.id, m."type"::text, m.title, e.id, e."episodeNumber", e.title, s."seasonNumber"
               FROM media_files f JOIN media m ON m.id = f."mediaId"
               LEFT JOIN episodes e ON e.id = f."episodeId" LEFT JOIN seasons s ON s.id = e."seasonId"
               WHERE f.id = ANY($1)"#,
        )
        .bind(chunk)
        .fetch_all(db)
        .await?;
        for (file, media, kind, title, ep, number, ep_title, season) in rows {
            let mut subject = media_subject(media, &title, &kind);
            if let Some(season) = season {
                subject.season_number = Some(i64::from(season));
                if let Some(number) = number {
                    subject.episode_number = Some(i64::from(number));
                    subject.episode_title = ep_title;
                    subject.episode_id = ep.map(i64::from);
                }
            }
            out.insert(file, subject);
        }
    }
    Ok(out)
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
        ..media_subject(s.media_id, &s.media_title, "series")
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
            format_subject(&subject),
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

/// `buildMediaProgressSubject(media)`.
fn media_subject(id: i32, title: &str, kind: &str) -> Subject {
    Subject {
        title: title.to_owned(),
        media_id: Some(i64::from(id)),
        media_type: Some(kind.to_owned()),
        season_number: None,
        episode_number: None,
        episode_title: None,
        episode_id: None,
    }
}

/// `formatMediaProgressSubject`.
fn format_subject(s: &Subject) -> String {
    let Some(season) = s.season_number else {
        return s.title.clone();
    };
    let Some(ep) = s.episode_number else {
        return format!("{} S{season:02}", s.title);
    };
    match s.episode_title.as_deref().filter(|t| !t.is_empty()) {
        Some(t) => format!("{} S{season:02}E{ep:02}: {t}", s.title),
        None => format!("{} S{season:02}E{ep:02}", s.title),
    }
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
struct ActivityRows {
    hub: Hub,
    ids: Vec<String>,
}

impl ActivityRows {
    fn new(hub: &Hub, ids: impl IntoIterator<Item = String>) -> Self {
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

    #[test]
    fn subject_text_matches_the_ts_formatter() {
        let mut s = media_subject(1, "Show", "series");
        assert_eq!(format_subject(&s), "Show");
        s.season_number = Some(1);
        assert_eq!(format_subject(&s), "Show S01");
        s.episode_number = Some(12);
        assert_eq!(format_subject(&s), "Show S01E12");
        s.episode_title = Some("Pilot".into());
        assert_eq!(format_subject(&s), "Show S01E12: Pilot");
    }
}
