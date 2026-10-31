//! Replay cache for `download.progress` (rules 25-27): one whole snapshot per media, not persisted.
use super::event::{Download, SseEvent};
use fliks_domain::media::kind::MediaKind;
use std::time::{Duration, Instant};

/// A media not restated for three publisher ticks has lost its publisher.
const STALE_AFTER: Duration = Duration::from_secs(3 * 60);

struct Entry {
    media_type: MediaKind,
    downloads: Vec<Download>,
    recipients: Vec<i32>,
    at: Instant,
}

#[derive(Default)]
/// Insertion-ordered like the Map it ports; a handful of medias at most.
pub struct Replay(Vec<(i64, Entry)>);

impl Replay {
    /// An empty snapshot retires the media; otherwise the entry is replaced, never merged.
    pub fn record(
        &mut self,
        recipients: &[i32],
        media_id: i64,
        media_type: MediaKind,
        downloads: &[Download],
        now: Instant,
    ) {
        if downloads.is_empty() {
            self.0.retain(|(id, _)| *id != media_id);
            return;
        }
        let entry = Entry {
            media_type,
            downloads: downloads.to_vec(),
            recipients: recipients.to_vec(),
            at: now,
        };
        match self.0.iter_mut().find(|(id, _)| *id == media_id) {
            Some(slot) => slot.1 = entry,
            None => self.0.push((media_id, entry)),
        }
    }

    /// A download with no episode is a pack and survives a single-episode clear.
    pub fn clear(&mut self, media_id: i64, season: Option<i64>, episode: Option<i64>) {
        let Some((_, entry)) = self.0.iter_mut().find(|(id, _)| *id == media_id) else {
            return;
        };
        let Some(season) = season else {
            self.0.retain(|(id, _)| *id != media_id);
            return;
        };
        entry.downloads.retain(|d| {
            d.season_number != Some(season) || episode.is_some_and(|e| d.episode_number != Some(e))
        });
        if entry.downloads.is_empty() {
            self.0.retain(|(id, _)| *id != media_id);
        }
    }

    /// The downloads last stated for a media, if any.
    pub fn current(&self, media_id: i64) -> Option<&[Download]> {
        self.0
            .iter()
            .find(|(id, _)| *id == media_id)
            .map(|(_, e)| e.downloads.as_slice())
    }

    /// Sweeps every stale entry, whoever connects, then returns the user's snapshots.
    pub fn snapshot_for(&mut self, user: i32, now: Instant) -> Vec<SseEvent> {
        self.0
            .retain(|(_, e)| now.duration_since(e.at) <= STALE_AFTER);
        self.0
            .iter()
            .filter(|(_, e)| e.recipients.contains(&user))
            .map(|(id, e)| SseEvent::DownloadProgress {
                media_id: *id,
                media_type: e.media_type,
                downloads: e.downloads.clone(),
            })
            .collect()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.0.len()
    }
}

#[cfg(test)]
mod tests {
    use super::super::event::DownloadState;
    use super::*;

    fn dl(season: Option<i64>, episode: Option<i64>) -> Download {
        Download {
            r#ref: format!("{season:?}{episode:?}"),
            season_number: season,
            episode_number: episode,
            progress: 0.5.into(),
            dlspeed: 1.into(),
            eta: 1.into(),
            state: DownloadState::Active,
        }
    }

    fn media(r: &mut Replay, recipients: &[i32], id: i64, d: &[Download], at: Instant) {
        r.record(recipients, id, MediaKind::Series, d, at);
    }

    #[test]
    fn a_snapshot_replaces_and_an_empty_one_retires() {
        let (mut r, t) = (Replay::default(), Instant::now());
        media(&mut r, &[1], 7, &[dl(Some(1), None)], t);
        media(&mut r, &[1], 7, &[dl(Some(2), None)], t);
        assert_eq!(r.current(7).unwrap()[0].season_number, Some(2));
        media(&mut r, &[1], 7, &[], t);
        assert!(r.current(7).is_none());
    }

    #[test]
    fn clear_follows_the_season_and_episode_rules() {
        let (mut r, t) = (Replay::default(), Instant::now());
        let all = [
            dl(Some(1), Some(1)),
            dl(Some(1), Some(2)),
            dl(Some(1), None),
            dl(Some(2), None),
        ];
        media(&mut r, &[1], 7, &all, t);
        r.clear(8, None, None);
        r.clear(7, Some(1), Some(1));
        assert_eq!(r.current(7).unwrap().len(), 3);
        r.clear(7, Some(1), None);
        assert_eq!(r.current(7).unwrap(), &all[3..]);
        r.clear(7, Some(2), Some(5));
        assert_eq!(r.current(7).unwrap().len(), 1);
        r.clear(7, None, None);
        assert_eq!(r.len(), 0);
        media(&mut r, &[1], 7, &all[..1], t);
        r.clear(7, Some(1), None);
        assert_eq!(r.len(), 0);
    }

    #[test]
    fn replay_is_per_recipient_and_a_stale_entry_is_swept_for_everyone() {
        let (mut r, t) = (Replay::default(), Instant::now());
        media(&mut r, &[1], 7, &[dl(None, None)], t);
        media(
            &mut r,
            &[2],
            8,
            &[dl(None, None)],
            t + Duration::from_secs(100),
        );
        assert_eq!(r.snapshot_for(1, t + Duration::from_secs(10)).len(), 1);
        assert!(r.snapshot_for(9, t).is_empty());
        let later = t + Duration::from_secs(181);
        assert!(r.snapshot_for(2, later).len() == 1 && r.len() == 1);
        assert!(r.snapshot_for(1, later).is_empty());
    }
}
