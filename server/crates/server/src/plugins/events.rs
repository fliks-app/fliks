//! What host imports emit on a plugin's behalf (`plugins.md` rule 33).
use super::runtime::{HostError, fliks::plugin::types as t};
use super::units;
use crate::events::event::{Download, DownloadState};
use crate::events::{DomainEvent, Num, SseEvent};
use crate::state::AppState;
use crate::sync::MutexExt;
use fliks_domain::media::{family::Family, kind::MediaKind};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
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

async fn media_row(st: &AppState, id: i32) -> Option<(String, MediaKind)> {
    let (title, kind): (String, String) =
        sqlx::query_as(r#"SELECT title, type FROM media WHERE id = $1"#)
            .bind(id)
            .fetch_optional(&st.db)
            .await
            .ok()
            .flatten()?;
    Some((title, MediaKind::parse(&kind)?))
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

fn download_of(d: &t::DownloadProgress) -> Result<Download, HostError> {
    let (season, episode) = units::video(d.unit.as_ref())?;
    Ok(Download {
        r#ref: d.ref_.clone(),
        season_number: season.map(i64::from),
        episode_number: episode.map(i64::from),
        progress: Num(d.progress),
        dlspeed: Num(d.bytes_per_second.unwrap_or(0.0)),
        eta: Num(d.eta_seconds.unwrap_or(0.0)),
        state: state_of(d.state),
    })
}

/// One `download.progress` to the media's viewers; nothing when there are none.
pub async fn push_progress(st: &AppState, media_id: i32, downloads: Vec<Download>) {
    let recipients = viewers(st, Some(media_id)).await;
    if recipients.is_empty() {
        return;
    }
    let Some((_, media_type)) = media_row(st, media_id).await else {
        return;
    };
    st.hub.emit_to_users(
        &recipients,
        SseEvent::DownloadProgress {
            media_id: media_id.into(),
            media_type,
            downloads,
        },
    );
}

struct Gate {
    last: Instant,
    dirty: bool,
    armed: bool,
}

#[derive(Default)]
struct Inner {
    gates: HashMap<i32, Gate>,
    /// Each plugin's set per media (`plugins.md` rule 65); a media's emission is their union.
    sets: HashMap<i32, BTreeMap<String, Vec<Download>>>,
}

impl Inner {
    fn store(&mut self, plugin: &str, media: i32, set: Vec<Download>) {
        let by_plugin = self.sets.entry(media).or_default();
        if set.is_empty() {
            by_plugin.remove(plugin);
        } else {
            by_plugin.insert(plugin.to_owned(), set);
        }
        if by_plugin.is_empty() {
            self.sets.remove(&media);
        }
    }

    /// The plugins other than `caller` holding a download that covers `(season, episode)` of the media.
    fn in_flight(
        &self,
        media: i32,
        caller: &str,
        season: Option<u32>,
        episode: Option<u32>,
    ) -> Vec<String> {
        // ponytail: a Download has no family, so one family in flight blocks every family of a book or album.
        let covers = |d: &Download| match (season, episode) {
            (None, _) => true,
            (Some(s), None) => d.season_number.is_none_or(|n| n == i64::from(s)),
            (Some(s), Some(e)) => {
                d.season_number.is_none_or(|n| n == i64::from(s))
                    && d.episode_number.is_none_or(|n| n == i64::from(e))
            }
        };
        self.sets
            .get(&media)
            .into_iter()
            .flatten()
            .filter(|(plugin, set)| plugin.as_str() != caller && set.iter().any(covers))
            .map(|(plugin, _)| plugin.clone())
            .collect()
    }

    fn union(&self, media: i32) -> Vec<Download> {
        self.sets
            .get(&media)
            .map(|m| m.values().flatten().cloned().collect())
            .unwrap_or_default()
    }
}

/// `progress.set`: per (media, plugin) sets, one emission per media per second, the newest wins.
#[derive(Default)]
pub struct Progress(Mutex<Inner>);

impl Progress {
    pub async fn set(
        &'static self,
        st: &AppState,
        plugin: &str,
        media_id: i32,
        downloads: &[t::DownloadProgress],
    ) -> Result<(), HostError> {
        let set: Vec<Download> = downloads
            .iter()
            .map(download_of)
            .collect::<Result<_, _>>()?;
        let now = Instant::now();
        let (wait, now_set) = {
            let mut g = self.0.lock_clean();
            g.store(plugin, media_id, set);
            let union = g.union(media_id);
            match g.gates.get_mut(&media_id) {
                Some(gate) if now - gate.last < PROGRESS_MIN => {
                    gate.dirty = true;
                    if gate.armed {
                        return Ok(());
                    }
                    gate.armed = true;
                    (Some(PROGRESS_MIN - (now - gate.last)), union)
                }
                _ => {
                    g.gates.insert(
                        media_id,
                        Gate {
                            last: now,
                            dirty: false,
                            armed: false,
                        },
                    );
                    (None, union)
                }
            }
        };
        let Some(wait) = wait else {
            push_progress(st, media_id, now_set).await;
            return Ok(());
        };
        let st = st.clone();
        tokio::spawn(async move { self.flush(st, media_id, wait).await });
        Ok(())
    }

    async fn flush(&'static self, st: AppState, media_id: i32, wait: Duration) {
        tokio::time::sleep(wait).await;
        let pending = {
            let mut g = self.0.lock_clean();
            let Some(gate) = g.gates.get_mut(&media_id) else {
                return;
            };
            gate.armed = false;
            if gate.dirty {
                gate.dirty = false;
                gate.last = Instant::now();
                g.union(media_id)
            } else {
                g.gates.remove(&media_id);
                return;
            }
        };
        push_progress(&st, media_id, pending).await;
    }

    /// The other plugins with a download in flight that covers `unit` of the media (`plugins.md` rule 67).
    pub fn in_flight(
        &self,
        plugin: &str,
        media_id: i32,
        unit: Option<&t::UnitRef>,
    ) -> Result<Vec<String>, HostError> {
        let (season, episode) = units::video(unit)?;
        Ok(self
            .0
            .lock_clean()
            .in_flight(media_id, plugin, season, episode))
    }

    /// The plugin's set plus a placeholder, pushed at once (`acquisition.grabbed`).
    async fn placeholder(&self, st: &AppState, plugin: &str, media_id: i32, d: Download) {
        let union = {
            let mut g = self.0.lock_clean();
            let mut set = g
                .sets
                .get(&media_id)
                .and_then(|m| m.get(plugin))
                .cloned()
                .unwrap_or_default();
            set.push(d);
            g.store(plugin, media_id, set);
            g.union(media_id)
        };
        push_progress(st, media_id, union).await;
    }

    /// The plugin stopped: its sets go and every media it held gets the union that remains.
    pub async fn forget(&self, st: &AppState, plugin: &str) {
        let left: Vec<(i32, Vec<Download>)> = {
            let mut g = self.0.lock_clean();
            let held: Vec<i32> = g
                .sets
                .iter()
                .filter(|(_, m)| m.contains_key(plugin))
                .map(|(id, _)| *id)
                .collect();
            for id in &held {
                g.store(plugin, *id, vec![]);
            }
            held.into_iter().map(|id| (id, g.union(id))).collect()
        };
        for (id, set) in left {
            push_progress(st, id, set).await;
        }
    }
}

pub fn progress_gates() -> &'static Progress {
    static P: std::sync::OnceLock<Progress> = std::sync::OnceLock::new();
    P.get_or_init(Progress::default)
}

/// The season and episode of an event's unit; a book has no unit and a comic's issue is no episode.
fn event_unit(
    family: t::Family,
    unit: Option<&t::UnitRef>,
) -> Result<(Option<u32>, Option<u32>), HostError> {
    match Family::from(family) {
        Family::Video => units::video(unit),
        Family::Image => Ok((None, None)),
        other if unit.is_some() => Err(super::imports::host_err(
            "ERR_VALIDATION",
            format!("a \"{other}\" event has no unit"),
        )),
        _ => Ok((None, None)),
    }
}

/// An existing media must be wished in the event's family.
async fn check_family(st: &AppState, media_id: u32, family: t::Family) -> Result<(), HostError> {
    let family = Family::from(family);
    match media_row(st, media_id as i32).await {
        Some((_, kind)) if !kind.families().contains(&family) => Err(super::imports::host_err(
            "ERR_VALIDATION",
            format!("a {kind} is not wished in family \"{family}\""),
        )),
        _ => Ok(()),
    }
}

/// Rule 33, in order; an event naming a family or unit the host cannot serve refuses the whole call.
pub async fn publish(
    st: &AppState,
    plugin: &str,
    events: Vec<t::AcquisitionEvent>,
) -> Result<(), HostError> {
    for e in &events {
        match e {
            t::AcquisitionEvent::Grabbed(g) => {
                event_unit(g.family, g.unit.as_ref())?;
                check_family(st, g.media_id, g.family).await?;
            }
            t::AcquisitionEvent::Imported(i) => {
                event_unit(i.family, i.unit.as_ref())?;
                check_family(st, i.media_id, i.family).await?;
            }
            _ => {}
        }
    }
    for e in events {
        match e {
            t::AcquisitionEvent::Grabbed(g) => {
                let (season, episode) = event_unit(g.family, g.unit.as_ref())?;
                let (season, episode) = (season.map(i64::from), episode.map(i64::from));
                st.hub.emit_domain(DomainEvent::AcquisitionGrabbed {
                    media_id: g.media_id.into(),
                    family: g.family.into(),
                    season_number: season,
                    episode_number: episode,
                });
                let placeholder = Download {
                    r#ref: match Family::from(g.family) {
                        Family::Video => format!(
                            "pending:{}:{}",
                            season.map(|s| s.to_string()).unwrap_or_default(),
                            episode.map(|s| s.to_string()).unwrap_or_default()
                        ),
                        other => format!("pending:{other}"),
                    },
                    season_number: season,
                    episode_number: episode,
                    progress: Num(0.0),
                    dlspeed: Num(0.0),
                    eta: Num(0.0),
                    state: DownloadState::Queued,
                };
                progress_gates()
                    .placeholder(st, plugin, g.media_id as i32, placeholder)
                    .await;
            }
            t::AcquisitionEvent::Imported(i) => {
                let id = i.media_id as i32;
                let (season, episode) = event_unit(i.family, i.unit.as_ref())?;
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
                        season_number: season.map(i64::from),
                        episode_number: episode.map(i64::from),
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
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn dl(r#ref: &str) -> Download {
        Download {
            r#ref: r#ref.into(),
            season_number: None,
            episode_number: None,
            progress: Num(0.5),
            dlspeed: Num(0.0),
            eta: Num(0.0),
            state: DownloadState::Active,
        }
    }

    fn refs(i: &Inner, media: i32) -> Vec<String> {
        i.union(media).into_iter().map(|d| d.r#ref).collect()
    }

    #[test]
    fn two_plugins_keep_their_own_set_and_the_union_is_in_plugin_order() {
        let mut i = Inner::default();
        i.store("b", 1, vec![dl("b1")]);
        i.store("a", 1, vec![dl("a1"), dl("a2")]);
        assert_eq!(refs(&i, 1), ["a1", "a2", "b1"]);
        i.store("a", 1, vec![dl("a3")]);
        assert_eq!(refs(&i, 1), ["a3", "b1"], "a replaces only its own set");
        i.store("b", 1, vec![]);
        assert_eq!(refs(&i, 1), ["a3"]);
        i.store("a", 1, vec![]);
        assert!(refs(&i, 1).is_empty() && i.sets.is_empty());
    }

    fn dl_at(season: Option<i64>, episode: Option<i64>) -> Download {
        Download {
            season_number: season,
            episode_number: episode,
            ..dl("x")
        }
    }

    #[test]
    fn in_flight_skips_the_caller_and_matches_units() {
        let mut i = Inner::default();
        i.store("a", 1, vec![dl_at(Some(2), Some(3))]);
        i.store("b", 1, vec![dl_at(Some(2), None)]);
        i.store("c", 1, vec![dl_at(Some(5), Some(1))]);
        fn f(i: &Inner, caller: &str, s: Option<u32>, e: Option<u32>) -> Vec<String> {
            i.in_flight(1, caller, s, e)
        }
        assert_eq!(
            f(&i, "a", None, None),
            ["b", "c"],
            "no unit: any download, caller excluded"
        );
        assert_eq!(
            f(&i, "z", Some(2), Some(3)),
            ["a", "b"],
            "a pack covers its episode"
        );
        assert_eq!(
            f(&i, "z", Some(2), Some(4)),
            ["b"],
            "another episode of the season"
        );
        assert_eq!(
            f(&i, "z", Some(2), None),
            ["a", "b"],
            "a group meets the season's downloads"
        );
        assert_eq!(f(&i, "z", Some(5), Some(1)), ["c"]);
        assert!(i.in_flight(2, "z", None, None).is_empty());
        i.store("d", 1, vec![dl_at(None, None)]);
        assert_eq!(
            f(&i, "z", Some(9), Some(9)),
            ["d"],
            "a whole-media download covers all"
        );
        i.store("d", 1, vec![]);
        assert!(
            f(&i, "z", Some(9), Some(9)).is_empty(),
            "an empty set clears"
        );
    }

    #[test]
    fn concurrent_sets_of_two_plugins_never_overwrite_each_other() {
        let p = Arc::new(Progress::default());
        let run = |plugin: &'static str| {
            let p = p.clone();
            std::thread::spawn(move || {
                for n in 0..500 {
                    p.0.lock_clean()
                        .store(plugin, 1, vec![dl(&format!("{plugin}{n}"))]);
                }
            })
        };
        let (a, b) = (run("a"), run("b"));
        a.join().unwrap();
        b.join().unwrap();
        assert_eq!(refs(&p.0.lock_clean(), 1), ["a499", "b499"]);
    }
}
