//! What host imports emit on a plugin's behalf (`plugins.md` rule 33).
use super::runtime::{HostError, fliks::plugin::types as t};
use super::units;
use crate::events::event::{Download, DownloadState};
use crate::events::{DomainEvent, Num, SseEvent};
use crate::state::AppState;
use crate::sync::MutexExt;
use fliks_domain::media::{family::Family, kind::MediaKind};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

/// One `download.progress` to the media's viewers (`downloads` plus the queue's open rows); nothing when there are none.
pub async fn push_progress(st: &AppState, media_id: i32, mut downloads: Vec<Download>) {
    let recipients = viewers(st, Some(media_id)).await;
    if recipients.is_empty() {
        return;
    }
    let Some((_, media_type)) = media_row(st, media_id).await else {
        return;
    };
    downloads.extend(super::queue::downloads(&st.db, media_id).await);
    st.hub.emit_to_users(
        &recipients,
        SseEvent::DownloadProgress {
            media_id: media_id.into(),
            media_type,
            downloads,
        },
    );
}

/// A placeholder outlives its grab by at most this long when no `queue.set` entry covers it.
const PLACEHOLDER_TTL: Duration = Duration::from_secs(600);

struct Held {
    d: Download,
    at: Instant,
}

impl Held {
    fn live(&self, now: Instant) -> bool {
        now.duration_since(self.at) < PLACEHOLDER_TTL
    }
}

/// A placeholder's unit overlaps an entry's when neither names a different season or episode.
fn overlaps(d: &Download, season: Option<i32>, episode: Option<i32>) -> bool {
    let same =
        |a: Option<i64>, b: Option<i32>| a.is_none_or(|a| b.is_none_or(|b| a == i64::from(b)));
    same(d.season_number, season) && same(d.episode_number, episode)
}

/// The `acquisition.grabbed` placeholders (`plugins.md` rule 72): a transfer is in flight from the grab until
/// a `queue.set` entry of its plugin covers it, or its time is up.
#[derive(Default)]
pub struct Progress(Mutex<HashMap<i32, BTreeMap<String, Vec<Held>>>>);

impl Progress {
    /// The plugins other than `caller` holding a placeholder that covers `(season, episode)` of the media.
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
        let now = Instant::now();
        self.0
            .lock_clean()
            .get(&media)
            .into_iter()
            .flatten()
            .filter(|(plugin, set)| {
                plugin.as_str() != caller && set.iter().any(|h| h.live(now) && covers(&h.d))
            })
            .map(|(plugin, _)| plugin.clone())
            .collect()
    }

    /// The media holding a placeholder.
    pub fn media_ids(&self) -> Vec<i32> {
        self.0.lock_clean().keys().copied().collect()
    }

    /// The media's placeholders.
    pub fn union(&self, media: i32) -> Vec<Download> {
        let now = Instant::now();
        self.0
            .lock_clean()
            .get(&media)
            .map(|m| {
                m.values()
                    .flatten()
                    .filter(|h| h.live(now))
                    .map(|h| h.d.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Drops the placeholders `keep` refuses; the media they were held on.
    fn drop_where(&self, mut keep: impl FnMut(&str, i32, &Held) -> bool) -> Vec<i32> {
        let mut g = self.0.lock_clean();
        let mut touched = BTreeSet::new();
        g.retain(|media, plugins| {
            plugins.retain(|plugin, set| {
                let before = set.len();
                set.retain(|h| keep(plugin, *media, h));
                if set.len() != before {
                    touched.insert(*media);
                }
                !set.is_empty()
            });
            !plugins.is_empty()
        });
        touched.into_iter().collect()
    }

    /// Drops the plugin's placeholders; the media they held.
    pub fn retire(&self, plugin: &str) -> Vec<i32> {
        self.drop_where(|p, _, _| p != plugin)
    }

    /// Drops the plugin's placeholders that an entry of its snapshot covers; the media they held.
    pub fn retire_covered(
        &self,
        plugin: &str,
        covered: &[(i32, Option<i32>, Option<i32>)],
    ) -> Vec<i32> {
        self.drop_where(|p, media, h| {
            p != plugin
                || !covered
                    .iter()
                    .any(|(m, s, e)| *m == media && overlaps(&h.d, *s, *e))
        })
    }

    /// Drops the placeholders whose time is up as of `now`; the media they held.
    fn expire(&self, now: Instant) -> Vec<i32> {
        self.drop_where(|_, _, h| h.live(now))
    }

    fn hold(&self, plugin: &str, media: i32, d: Download, at: Instant) {
        self.0
            .lock_clean()
            .entry(media)
            .or_default()
            .entry(plugin.to_owned())
            .or_default()
            .push(Held { d, at });
    }

    /// The plugin's placeholders plus one, pushed at once (`acquisition.grabbed`); the push after its time is up.
    async fn placeholder(&self, st: &AppState, plugin: &str, media_id: i32, d: Download) {
        self.hold(plugin, media_id, d, Instant::now());
        push_progress(st, media_id, self.union(media_id)).await;
        let st = st.clone();
        tokio::spawn(async move {
            tokio::time::sleep(PLACEHOLDER_TTL).await;
            let gates = progress_gates();
            for id in gates.expire(Instant::now()) {
                push_progress(&st, id, gates.union(id)).await;
            }
        });
    }

    /// The plugin stopped: its placeholders go and every media it held gets the set that remains.
    pub async fn forget(&self, st: &AppState, plugin: &str) {
        for id in self.retire(plugin) {
            push_progress(st, id, self.union(id)).await;
        }
    }
}

/// The other plugins with a download in flight that covers `unit` of the media (`plugins.md` rule 67): the queue's
/// open rows and the in-memory sets.
pub async fn in_flight(
    st: &AppState,
    plugin: &str,
    media_id: i32,
    unit: Option<&t::UnitRef>,
) -> Result<Vec<String>, HostError> {
    let (season, episode) = units::video(unit)?;
    let mut ids: BTreeSet<String> = progress_gates()
        .in_flight(media_id, plugin, season, episode)
        .into_iter()
        .collect();
    ids.extend(
        super::queue::in_flight(&st.db, plugin, media_id, season, episode)
            .await
            .map_err(super::imports::db_err)?,
    );
    Ok(ids.into_iter().collect())
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

    fn put(p: &Progress, plugin: &str, media: i32, set: Vec<Download>) {
        for d in set {
            p.hold(plugin, media, d, Instant::now());
        }
    }

    fn dl_at(season: Option<i64>, episode: Option<i64>) -> Download {
        Download {
            season_number: season,
            episode_number: episode,
            ..dl("x")
        }
    }

    #[test]
    fn placeholders_are_per_plugin_and_retire_with_their_plugin() {
        let p = Progress::default();
        put(&p, "b", 1, vec![dl("b1")]);
        put(&p, "a", 1, vec![dl("a1"), dl("a2")]);
        let refs = |m| -> Vec<String> { p.union(m).into_iter().map(|d| d.r#ref).collect() };
        assert_eq!(refs(1), ["a1", "a2", "b1"]);
        assert_eq!(p.retire("a"), [1]);
        assert_eq!(refs(1), ["b1"]);
        assert!(p.retire("a").is_empty());
        p.retire("b");
        assert!(refs(1).is_empty() && p.0.lock_clean().is_empty());
    }

    #[test]
    fn in_flight_skips_the_caller_and_matches_units() {
        let p = Progress::default();
        put(&p, "a", 1, vec![dl_at(Some(2), Some(3))]);
        put(&p, "b", 1, vec![dl_at(Some(2), None)]);
        put(&p, "c", 1, vec![dl_at(Some(5), Some(1))]);
        let f = |caller: &str, s: Option<u32>, e: Option<u32>| p.in_flight(1, caller, s, e);
        assert_eq!(
            f("a", None, None),
            ["b", "c"],
            "no unit: any download, caller excluded"
        );
        assert_eq!(
            f("z", Some(2), Some(3)),
            ["a", "b"],
            "a pack covers its episode"
        );
        assert_eq!(
            f("z", Some(2), Some(4)),
            ["b"],
            "another episode of the season"
        );
        assert_eq!(
            f("z", Some(2), None),
            ["a", "b"],
            "a group meets the season's downloads"
        );
        assert_eq!(f("z", Some(5), Some(1)), ["c"]);
        assert!(p.in_flight(2, "z", None, None).is_empty());
        put(&p, "d", 1, vec![dl_at(None, None)]);
        assert_eq!(
            f("z", Some(9), Some(9)),
            ["d"],
            "a whole-media download covers all"
        );
    }

    #[test]
    fn a_snapshot_retires_only_the_placeholders_its_entries_cover() {
        let p = Progress::default();
        put(&p, "a", 1, vec![dl_at(Some(1), Some(2))]);
        put(&p, "a", 2, vec![dl_at(None, None)]);
        // A snapshot taken before the grab names neither media: nothing goes.
        assert!(p.retire_covered("a", &[(3, None, None)]).is_empty());
        assert!(p.retire_covered("a", &[(1, Some(2), Some(2))]).is_empty());
        // Another plugin's entry never retires it.
        assert!(p.retire_covered("b", &[(1, Some(1), Some(2))]).is_empty());
        assert_eq!(
            p.retire_covered("a", &[(1, Some(1), None)]),
            [1],
            "a pack covers its episode"
        );
        assert_eq!(p.union(1).len() + p.union(2).len(), 1);
        assert_eq!(
            p.retire_covered("a", &[(2, Some(4), Some(5))]),
            [2],
            "a whole-media hold meets any unit"
        );
        assert!(p.0.lock_clean().is_empty());
    }

    #[test]
    fn a_placeholder_nothing_covers_expires() {
        let p = Progress::default();
        put(&p, "a", 1, vec![dl("a1")]);
        let later = Instant::now() + PLACEHOLDER_TTL;
        assert!(p.expire(Instant::now()).is_empty());
        assert_eq!(p.expire(later), [1]);
        assert!(p.union(1).is_empty() && p.in_flight(1, "z", None, None).is_empty());
    }
}
