//! The acquisition queue and history (`plugins.md` rules 69-75): what providers report, what readers see.
use super::imports::{db_err, host_err};
use super::runtime::{HostError, fliks::plugin::types as t};
use super::units;
use crate::events::event::{Download, DownloadState};
use crate::events::{Num, SseEvent};
use crate::state::AppState;
use fliks_domain::media::{family::Family, kind::MediaKind};
use serde_json::json;
use sqlx::{FromRow, PgPool};
use std::collections::{BTreeSet, HashMap, HashSet};

const MAX_ENTRIES: usize = 2000;
const MAX_TEXT: usize = 500;
const MAX_REF: usize = 256;
const MAX_PATCH: usize = 100;

/// The states in which a transfer counts as in flight (`import_failed` waits for an action).
pub(super) const IN_FLIGHT: [&str; 5] = ["queued", "active", "stalled", "paused", "importing"];

#[derive(Debug, Clone, PartialEq, FromRow)]
struct Fields {
    #[sqlx(rename = "mediaId")]
    media: i32,
    season: Option<i32>,
    episode: Option<i32>,
    #[sqlx(rename = "sourceId")]
    source_id: String,
    #[sqlx(rename = "sourceName")]
    source_name: String,
    title: String,
    quality: String,
    method: String,
    #[sqlx(rename = "infoUrl")]
    info_url: Option<String>,
    state: String,
    progress: f64,
    size: Option<i64>,
    #[sqlx(rename = "bytesPerSecond")]
    bytes_per_second: Option<f64>,
    eta: Option<f64>,
    error: Option<String>,
}

impl Fields {
    fn terminal(&self) -> bool {
        matches!(self.state.as_str(), "imported" | "failed")
    }
}

#[derive(FromRow)]
struct Open {
    id: i32,
    r#ref: String,
    #[sqlx(flatten)]
    f: Fields,
}

#[derive(Debug)]
struct Entry {
    r#ref: String,
    /// Resolved against the media's kind at reconcile.
    unit: Option<t::UnitRef>,
    f: Fields,
}

fn state_name(s: t::QueueState) -> &'static str {
    match s {
        t::QueueState::Queued => "queued",
        t::QueueState::Active => "active",
        t::QueueState::Stalled => "stalled",
        t::QueueState::Paused => "paused",
        t::QueueState::Importing => "importing",
        t::QueueState::ImportFailed => "import_failed",
        t::QueueState::Imported => "imported",
        t::QueueState::Failed => "failed",
    }
}

fn method_name(m: t::GrabMethod) -> &'static str {
    match m {
        t::GrabMethod::Manual => "manual",
        t::GrabMethod::Auto => "auto",
        t::GrabMethod::Rss => "rss",
    }
}

fn http_url(u: &str) -> Option<String> {
    let url = url::Url::parse(u).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

fn text(what: &str, v: String, max: usize) -> Result<String, String> {
    if v.is_empty() || v.chars().count() > max {
        return Err(format!("{what} must be 1-{max} characters"));
    }
    Ok(v)
}

fn finite(v: Option<f64>) -> Option<f64> {
    v.filter(|n| n.is_finite() && *n >= 0.0)
}

fn check(e: t::QueueEntry) -> Result<Entry, String> {
    let r#ref = text("ref", e.ref_, MAX_REF)?;
    let state = state_name(e.state);
    if e.quality.chars().count() > MAX_TEXT {
        return Err(format!("quality must be at most {MAX_TEXT} characters"));
    }
    Ok(Entry {
        r#ref,
        unit: e.unit,
        f: Fields {
            media: e.media_id as i32,
            season: None,
            episode: None,
            source_id: text("source-id", e.source_id, MAX_TEXT)?,
            source_name: text("source-name", e.source_name, MAX_TEXT)?,
            title: text("title", e.title, MAX_TEXT)?,
            quality: e.quality,
            method: method_name(e.method).to_owned(),
            info_url: e.info_url.as_deref().and_then(http_url),
            state: state.to_owned(),
            progress: if e.progress.is_finite() {
                e.progress.clamp(0.0, 1.0)
            } else {
                0.0
            },
            size: e.size_bytes.map(|n| i64::try_from(n).unwrap_or(i64::MAX)),
            bytes_per_second: finite(e.bytes_per_second),
            eta: finite(e.eta_seconds),
            error: e.error.filter(|s| !s.is_empty()),
        },
    })
}

/// An entry refused on its own: its ref (as sent) and why.
type Rejected = (String, String);

/// The valid entries and the refused ones; only an oversized list refuses the call.
fn validate(entries: Vec<t::QueueEntry>) -> Result<(Vec<Entry>, Vec<Rejected>), HostError> {
    if entries.len() > MAX_ENTRIES {
        return Err(host_err(
            "ERR_VALIDATION",
            format!("at most {MAX_ENTRIES} entries"),
        ));
    }
    let mut seen = HashSet::new();
    let (mut ok, mut bad) = (Vec::with_capacity(entries.len()), vec![]);
    for e in entries {
        let name = e.ref_.clone();
        match check(e) {
            Ok(v) if seen.insert(v.r#ref.clone()) => ok.push(v),
            Ok(v) => bad.push((v.r#ref, "duplicate ref".to_owned())),
            Err(why) => bad.push((name, why)),
        }
    }
    Ok((ok, bad))
}

const COLUMNS: &str = r#"
  "mediaId", season, episode, "sourceId", "sourceName", title, quality, method, "infoUrl",
  state, progress, size, "bytesPerSecond", eta, error"#;

/// What one snapshot changed: the media whose rows moved, and whether a state or the membership did.
#[derive(Default)]
struct Changes {
    media: BTreeSet<i32>,
    structural: bool,
    any: bool,
    /// Rows that took new fields, for a client to patch in place.
    updated: Vec<i32>,
}

impl Changes {
    fn touch(&mut self, media: i32, structural: bool) {
        self.media.insert(media);
        self.structural |= structural;
        self.any = true;
    }
}

async fn insert(tx: &mut sqlx::PgConnection, plugin: &str, e: &Entry) -> Result<(), sqlx::Error> {
    let f = &e.f;
    sqlx::query(
        r#"INSERT INTO acquisition_queue ("pluginId", "ref", "mediaId", season, episode, "sourceId", "sourceName",
             title, quality, method, "infoUrl", state, progress, size, "bytesPerSecond", eta, error, "finishedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
             CASE WHEN $18 THEN now() END)"#,
    )
    .bind(plugin)
    .bind(&e.r#ref)
    .bind(f.media)
    .bind(f.season)
    .bind(f.episode)
    .bind(&f.source_id)
    .bind(&f.source_name)
    .bind(&f.title)
    .bind(&f.quality)
    .bind(&f.method)
    .bind(&f.info_url)
    .bind(&f.state)
    .bind(f.progress)
    .bind(f.size)
    .bind(f.bytes_per_second)
    .bind(f.eta)
    .bind(&f.error)
    .bind(f.terminal())
    .execute(tx)
    .await?;
    Ok(())
}

async fn update(tx: &mut sqlx::PgConnection, id: i32, f: &Fields) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE acquisition_queue SET "mediaId" = $2, season = $3, episode = $4, "sourceId" = $5,
             "sourceName" = $6, title = $7, quality = $8, method = $9, "infoUrl" = $10, state = $11,
             progress = $12, size = $13, "bytesPerSecond" = $14, eta = $15, error = $16,
             "finishedAt" = CASE WHEN $17 THEN now() END,
             "deletedAt" = CASE WHEN $17 THEN "deletedAt" END
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(f.media)
    .bind(f.season)
    .bind(f.episode)
    .bind(&f.source_id)
    .bind(&f.source_name)
    .bind(&f.title)
    .bind(&f.quality)
    .bind(&f.method)
    .bind(&f.info_url)
    .bind(&f.state)
    .bind(f.progress)
    .bind(f.size)
    .bind(f.bytes_per_second)
    .bind(f.eta)
    .bind(&f.error)
    .bind(f.terminal())
    .execute(tx)
    .await?;
    Ok(())
}

/// What one snapshot did: the rows it moved and the units its entries cover.
struct Applied {
    changes: Changes,
    /// `(media, season, episode)` of every entry applied, for the placeholders it retires.
    covered: Vec<(i32, Option<i32>, Option<i32>)>,
}

/// The season and episode of an entry: a video's unit is whole numbers, any other kind has none.
fn resolve(video: bool, e: &Entry) -> Result<(Option<i32>, Option<i32>), String> {
    if !video {
        return Ok((None, None));
    }
    let (s, n) = units::video(e.unit.as_ref()).map_err(|h| h.message)?;
    Ok((s.map(|n| n as i32), n.map(|n| n as i32)))
}

/// The latest closed row of a transfer: its id, state.
async fn last_closed(
    tx: &mut sqlx::PgConnection,
    plugin: &str,
    r#ref: &str,
) -> Result<Option<(i32, String)>, sqlx::Error> {
    sqlx::query_as(
        r#"SELECT id, state FROM acquisition_queue
           WHERE "pluginId" = $1 AND "ref" = $2 AND "finishedAt" IS NOT NULL ORDER BY id DESC LIMIT 1"#,
    )
    .bind(plugin)
    .bind(r#ref)
    .fetch_optional(tx)
    .await
}

async fn reconcile(
    db: &PgPool,
    plugin: &str,
    entries: Vec<Entry>,
    keep: &HashSet<String>,
) -> Result<Applied, sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("acquisition_queue:{plugin}"))
        .execute(&mut *tx)
        .await?;
    let media: Vec<i32> = entries.iter().map(|e| e.f.media).collect();
    let known: HashMap<i32, bool> =
        sqlx::query_as::<_, (i32, String)>("SELECT id, type FROM media WHERE id = ANY($1)")
            .bind(&media)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(|(id, kind)| {
                let video =
                    MediaKind::parse(&kind).is_some_and(|k| k.families().contains(&Family::Video));
                (id, video)
            })
            .collect();
    let rows: Vec<Open> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT id, "ref", {COLUMNS} FROM acquisition_queue WHERE "pluginId" = $1 AND "finishedAt" IS NULL"#
    )))
    .bind(plugin)
    .fetch_all(&mut *tx)
    .await?;
    let mut open: HashMap<String, (i32, Fields)> =
        rows.into_iter().map(|o| (o.r#ref, (o.id, o.f))).collect();
    // A refused entry leaves its open row as it is: only a missing one closes.
    for r in keep {
        open.remove(r);
    }
    let mut applied = Applied {
        changes: Changes::default(),
        covered: vec![],
    };
    let changes = &mut applied.changes;
    for mut e in entries {
        let Some(&video) = known.get(&e.f.media) else {
            continue;
        };
        match resolve(video, &e) {
            Ok((s, n)) => (e.f.season, e.f.episode) = (s, n),
            Err(why) => {
                tracing::warn!(
                    "queue.set of \"{plugin}\": entry \"{}\" refused: {why}",
                    e.r#ref
                );
                open.remove(&e.r#ref);
                continue;
            }
        }
        applied.covered.push((e.f.media, e.f.season, e.f.episode));
        match open.remove(&e.r#ref) {
            Some((id, old)) => {
                if old == e.f {
                    continue;
                }
                update(&mut tx, id, &e.f).await?;
                changes.updated.push(id);
                changes.touch(old.media, false);
                changes.touch(e.f.media, old.state != e.f.state);
            }
            None => {
                let last = last_closed(&mut tx, plugin, &e.r#ref).await?;
                let removed = last
                    .as_ref()
                    .filter(|(_, s)| s == "removed")
                    .map(|(id, _)| *id);
                if e.f.terminal() {
                    let seen: bool = sqlx::query_scalar(
                        r#"SELECT EXISTS (SELECT 1 FROM acquisition_queue
                             WHERE "pluginId" = $1 AND "ref" = $2 AND state = $3 AND "finishedAt" IS NOT NULL)"#,
                    )
                    .bind(plugin)
                    .bind(&e.r#ref)
                    .bind(&e.f.state)
                    .fetch_one(&mut *tx)
                    .await?;
                    if seen {
                        continue;
                    }
                }
                match removed {
                    Some(id) => update(&mut tx, id, &e.f).await?,
                    None => insert(&mut tx, plugin, &e).await?,
                }
                changes.touch(e.f.media, true);
            }
        }
    }
    for (id, old) in open.values() {
        sqlx::query(
            r#"UPDATE acquisition_queue SET state = 'removed', "finishedAt" = now() WHERE id = $1"#,
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        changes.touch(old.media, true);
    }
    tx.commit().await?;
    Ok(applied)
}

/// `queue.set`: the caller's full snapshot (rule 70).
pub async fn set(
    st: &AppState,
    plugin: &str,
    entries: Vec<t::QueueEntry>,
) -> Result<(), HostError> {
    let (entries, rejected) = validate(entries)?;
    for (r#ref, why) in &rejected {
        tracing::warn!("queue.set of \"{plugin}\": entry \"{ref}\" refused: {why}");
    }
    let keep: HashSet<String> = rejected.into_iter().map(|(r, _)| r).collect();
    let applied = reconcile(&st.db, plugin, entries, &keep)
        .await
        .map_err(db_err)?;
    let mut changes = applied.changes;
    // A placeholder holds until an entry covers it (rule 72).
    for media in super::events::progress_gates().retire_covered(plugin, &applied.covered) {
        changes.touch(media, false);
    }
    announce(st, plugin, changes).await;
    Ok(())
}

/// The plugin stopped: its open rows close as removed (rule 71).
pub async fn close_plugin(st: &AppState, plugin: &str) {
    let rows: Result<Vec<i32>, _> = sqlx::query_scalar(
        r#"UPDATE acquisition_queue SET state = 'removed', "finishedAt" = now()
           WHERE "pluginId" = $1 AND "finishedAt" IS NULL RETURNING "mediaId""#,
    )
    .bind(plugin)
    .fetch_all(&st.db)
    .await;
    match rows {
        Ok(media) if !media.is_empty() => {
            let mut changes = Changes::default();
            for m in media {
                changes.touch(m, true);
            }
            announce(st, plugin, changes).await;
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("closing the queue of plugin \"{plugin}\" failed: {e}"),
    }
}

/// Enabled users who can read the queue: `media.grab`, admins and `manage:all`.
async fn audience(st: &AppState) -> Vec<i32> {
    sqlx::query_scalar(
        r#"SELECT u.id FROM users u LEFT JOIN roles r ON r.id = u."roleId"
           WHERE u.enabled AND (u."isAdmin" OR r.permissions LIKE '%"manage:all"%'
             OR r.permissions LIKE '%"media.grab"%') ORDER BY u.id"#,
    )
    .fetch_all(&st.db)
    .await
    .unwrap_or_else(|e| {
        tracing::error!(error = %e, "queue event audience");
        vec![]
    })
}

async fn announce(st: &AppState, plugin: &str, changes: Changes) {
    if !changes.any {
        return;
    }
    for media in &changes.media {
        super::events::push_progress(st, *media, super::events::progress_gates().union(*media))
            .await;
    }
    let users = audience(st).await;
    if !users.is_empty() {
        // Rows to patch only when nothing joined or left the list and few changed; else the page reloads.
        let rows = if changes.structural || changes.updated.len() > MAX_PATCH {
            None
        } else {
            Some(super::queue_routes::rows_by_id(&st.db, &changes.updated).await)
        };
        st.hub.emit_raw(
            "acquisition.queue",
            json!({"pluginId": plugin, "rows": rows}),
            Some(&users),
        );
    }
    if changes.structural {
        st.hub.emit(SseEvent::QueueUpdated {});
    }
}

/// The plugins other than `caller` with an in-flight transfer covering `(season, episode)` of the media.
pub async fn in_flight(
    db: &PgPool,
    caller: &str,
    media: i32,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT DISTINCT "pluginId" FROM acquisition_queue
           WHERE "mediaId" = $1 AND "finishedAt" IS NULL AND state = ANY($2) AND "pluginId" <> $3
             AND ($4::int IS NULL OR (season IS NULL OR season = $4)
                  AND ($5::int IS NULL OR episode IS NULL OR episode = $5))
           ORDER BY 1"#,
    )
    .bind(media)
    .bind(IN_FLIGHT.map(String::from).to_vec())
    .bind(caller)
    .bind(season.map(|n| n as i32))
    .bind(episode.map(|n| n as i32))
    .fetch_all(db)
    .await
}

fn download_state(s: &str) -> Option<DownloadState> {
    Some(match s {
        "queued" => DownloadState::Queued,
        "active" => DownloadState::Active,
        "stalled" => DownloadState::Stalled,
        "paused" => DownloadState::Paused,
        "importing" => DownloadState::Importing,
        _ => return None,
    })
}

/// `(ref, season, episode, progress, speed, eta, state)` of an open row.
type Progress7 = (
    String,
    Option<i32>,
    Option<i32>,
    f64,
    Option<f64>,
    Option<f64>,
    String,
);

/// The in-flight transfers of a media as a `download.progress` set.
pub async fn downloads(db: &PgPool, media: i32) -> Vec<Download> {
    let rows: Vec<Progress7> =
        sqlx::query_as(
            r#"SELECT "ref", season, episode, progress, "bytesPerSecond", eta, state FROM acquisition_queue
               WHERE "mediaId" = $1 AND "finishedAt" IS NULL AND state = ANY($2) ORDER BY "pluginId", id"#,
        )
        .bind(media)
        .bind(IN_FLIGHT.map(String::from).to_vec())
        .fetch_all(db)
        .await
        .unwrap_or_default();
    rows.into_iter()
        .filter_map(|(r#ref, season, episode, progress, speed, eta, state)| {
            Some(Download {
                r#ref,
                season_number: season.map(i64::from),
                episode_number: episode.map(i64::from),
                progress: Num(progress),
                dlspeed: Num(speed.unwrap_or(0.0)),
                eta: Num(eta.unwrap_or(0.0)),
                state: download_state(&state)?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(r: &str) -> t::QueueEntry {
        t::QueueEntry {
            ref_: r.into(),
            media_id: 1,
            unit: None,
            source_id: "s".into(),
            source_name: "S".into(),
            title: "Release".into(),
            quality: "WEBDL-1080p".into(),
            method: t::GrabMethod::Auto,
            info_url: Some("https://example.test/x".into()),
            state: t::QueueState::Active,
            progress: 2.0,
            size_bytes: Some(10),
            bytes_per_second: Some(-1.0),
            eta_seconds: Some(5.0),
            error: Some(String::new()),
        }
    }

    fn one(e: t::QueueEntry) -> Entry {
        let (mut ok, bad) = validate(vec![e]).unwrap();
        assert!(bad.is_empty(), "{bad:?}");
        ok.remove(0)
    }

    #[test]
    fn an_entry_is_normalised() {
        let v = one(entry("a"));
        let f = &v.f;
        assert_eq!(
            (f.progress, f.bytes_per_second, f.eta),
            (1.0, None, Some(5.0))
        );
        assert_eq!((f.error.as_deref(), f.state.as_str()), (None, "active"));
        assert_eq!(f.info_url.as_deref(), Some("https://example.test/x"));
    }

    #[test]
    fn only_http_info_urls_survive() {
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "ftp://h/x",
            "nope",
        ] {
            let mut e = entry("a");
            e.info_url = Some(bad.into());
            assert_eq!(one(e).f.info_url, None, "{bad}");
        }
    }

    #[test]
    fn a_bad_entry_is_refused_alone_and_the_rest_stays() {
        let mut no_title = entry("b");
        no_title.title.clear();
        let mut long = entry("c");
        long.title = "x".repeat(501);
        let (ok, bad) = validate(vec![
            entry("a"),
            entry(""),
            no_title,
            long,
            entry("a"),
            entry("d"),
        ])
        .unwrap();
        let refs = |v: &[Entry]| v.iter().map(|e| e.r#ref.clone()).collect::<Vec<_>>();
        assert_eq!(refs(&ok), ["a", "d"]);
        let names: Vec<_> = bad.iter().map(|(r, _)| r.as_str()).collect();
        assert_eq!(names, ["", "b", "c", "a"]);
        assert!(validate((0..2001).map(|i| entry(&i.to_string())).collect()).is_err());
    }

    #[test]
    fn an_empty_quality_is_kept_empty() {
        let mut e = entry("a");
        e.quality.clear();
        assert_eq!(one(e).f.quality, "");
    }

    #[test]
    fn only_a_video_unit_needs_its_group() {
        let unit = |group, number| t::UnitRef {
            group,
            number: Some(number),
            end_number: None,
            label: None,
            absolute: None,
        };
        let mut e = one(entry("a"));
        e.unit = Some(unit(None, 3.0));
        assert!(
            resolve(true, &e).is_err(),
            "a video episode needs its season"
        );
        assert_eq!(
            resolve(false, &e).unwrap(),
            (None, None),
            "a comic issue has none"
        );
        e.unit = Some(unit(None, 1.5));
        assert_eq!(
            resolve(false, &e).unwrap(),
            (None, None),
            "nor a fractional issue"
        );
        e.unit = Some(unit(Some(2), 3.0));
        assert_eq!(resolve(true, &e).unwrap(), (Some(2), Some(3)));
    }
}
