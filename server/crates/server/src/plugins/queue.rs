//! The acquisition queue and history (`plugins.md` rules 69-75): what providers report, what readers see.
use super::imports::{db_err, host_err};
use super::runtime::{HostError, fliks::plugin::types as t};
use super::units;
use crate::events::event::{Download, DownloadState};
use crate::events::{Num, SseEvent};
use crate::state::AppState;
use serde_json::json;
use sqlx::{FromRow, PgPool};
use std::collections::{BTreeSet, HashMap, HashSet};

const MAX_ENTRIES: usize = 2000;
const MAX_TEXT: usize = 500;
const MAX_REF: usize = 256;

/// The states in which a transfer counts as in flight (`import_failed` waits for an action).
const IN_FLIGHT: [&str; 5] = ["queued", "active", "stalled", "paused", "importing"];

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

#[derive(Debug, PartialEq)]
struct Entry {
    r#ref: String,
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

fn text(what: &str, v: String, max: usize) -> Result<String, HostError> {
    if v.is_empty() || v.chars().count() > max {
        return Err(host_err(
            "ERR_VALIDATION",
            format!("{what} must be 1-{max} characters"),
        ));
    }
    Ok(v)
}

fn finite(v: Option<f64>) -> Option<f64> {
    v.filter(|n| n.is_finite() && *n >= 0.0)
}

fn validate(entries: Vec<t::QueueEntry>) -> Result<Vec<Entry>, HostError> {
    if entries.len() > MAX_ENTRIES {
        return Err(host_err(
            "ERR_VALIDATION",
            format!("at most {MAX_ENTRIES} entries"),
        ));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        let (season, episode) = units::video(e.unit.as_ref())?;
        let r#ref = text("ref", e.ref_, MAX_REF)?;
        if !seen.insert(r#ref.clone()) {
            return Err(host_err(
                "ERR_VALIDATION",
                format!("duplicate ref \"{}\"", r#ref),
            ));
        }
        let state = state_name(e.state);
        out.push(Entry {
            r#ref,
            f: Fields {
                media: e.media_id as i32,
                season: season.map(|n| n as i32),
                episode: episode.map(|n| n as i32),
                source_id: text("source-id", e.source_id, MAX_TEXT)?,
                source_name: text("source-name", e.source_name, MAX_TEXT)?,
                title: text("title", e.title, MAX_TEXT)?,
                quality: text("quality", e.quality, MAX_TEXT)?,
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
        });
    }
    Ok(out)
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
             "finishedAt" = CASE WHEN $17 THEN now() END
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

async fn reconcile(db: &PgPool, plugin: &str, entries: Vec<Entry>) -> Result<Changes, sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("acquisition_queue:{plugin}"))
        .execute(&mut *tx)
        .await?;
    let media: Vec<i32> = entries.iter().map(|e| e.f.media).collect();
    let known: HashSet<i32> = sqlx::query_scalar("SELECT id FROM media WHERE id = ANY($1)")
        .bind(&media)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect();
    let rows: Vec<Open> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT id, "ref", {COLUMNS} FROM acquisition_queue WHERE "pluginId" = $1 AND "finishedAt" IS NULL"#
    )))
    .bind(plugin)
    .fetch_all(&mut *tx)
    .await?;
    let mut open: HashMap<String, (i32, Fields)> =
        rows.into_iter().map(|o| (o.r#ref, (o.id, o.f))).collect();
    let mut changes = Changes::default();
    for e in entries.iter().filter(|e| known.contains(&e.f.media)) {
        match open.remove(&e.r#ref) {
            Some((id, old)) => {
                if old == e.f {
                    continue;
                }
                update(&mut tx, id, &e.f).await?;
                changes.touch(old.media, false);
                changes.touch(e.f.media, old.state != e.f.state);
            }
            None if !e.f.terminal() => {
                insert(&mut tx, plugin, e).await?;
                changes.touch(e.f.media, true);
            }
            None => {
                let seen: bool = sqlx::query_scalar(
                    r#"SELECT EXISTS (SELECT 1 FROM acquisition_queue
                         WHERE "pluginId" = $1 AND "ref" = $2 AND state = $3 AND "finishedAt" IS NOT NULL)"#,
                )
                .bind(plugin)
                .bind(&e.r#ref)
                .bind(&e.f.state)
                .fetch_one(&mut *tx)
                .await?;
                if !seen {
                    insert(&mut tx, plugin, e).await?;
                    changes.touch(e.f.media, true);
                }
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
    Ok(changes)
}

/// `queue.set`: the caller's full snapshot (rule 70).
pub async fn set(
    st: &AppState,
    plugin: &str,
    entries: Vec<t::QueueEntry>,
) -> Result<(), HostError> {
    let entries = validate(entries)?;
    let mut changes = reconcile(&st.db, plugin, entries).await.map_err(db_err)?;
    // A placeholder holds until its plugin's next snapshot (rule 72).
    for media in super::events::progress_gates().retire(plugin) {
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

async fn announce(st: &AppState, plugin: &str, changes: Changes) {
    if !changes.any {
        return;
    }
    for media in &changes.media {
        super::events::push_progress(st, *media, super::events::progress_gates().union(*media))
            .await;
    }
    st.hub
        .emit_raw("acquisition.queue", json!({"pluginId": plugin}), None);
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
               WHERE "mediaId" = $1 AND "finishedAt" IS NULL AND state = ANY($2) ORDER BY id"#,
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

    #[test]
    fn an_entry_is_normalised() {
        let v = validate(vec![entry("a")]).unwrap();
        let f = &v[0].f;
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
            assert_eq!(validate(vec![e]).unwrap()[0].f.info_url, None, "{bad}");
        }
    }

    #[test]
    fn a_bad_list_is_refused() {
        assert!(validate(vec![entry("a"), entry("a")]).is_err());
        assert!(validate(vec![entry("")]).is_err());
        let mut e = entry("a");
        e.title = "x".repeat(501);
        assert!(validate(vec![e]).is_err());
        let mut e = entry("a");
        e.unit = Some(t::UnitRef {
            group: Some(1),
            number: Some(1.5),
            end_number: None,
            label: None,
            absolute: None,
        });
        assert!(validate(vec![e]).is_err());
        assert!(validate((0..2001).map(|i| entry(&i.to_string())).collect()).is_err());
    }
}
