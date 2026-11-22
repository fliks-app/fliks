//! The tags of one audio file as the music ingest reads them (`docs/spec/music.md`, section Tags). Pure.
use fliks_domain::{
    external_id::ExternalProvider,
    music::{provider::VARIOUS_ARTISTS, split::split},
};
use fliks_engine_core::api::{MediaInfo, MediaTags};
use serde_json::Value;

/// The separators a library re-splits its multi-valued tags on.
#[derive(Debug, Clone)]
pub struct Separators {
    pub artists: Vec<String>,
    pub genres: Vec<String>,
}

impl Default for Separators {
    fn default() -> Self {
        use fliks_domain::music::split::{ARTIST_SEPARATORS, GENRE_SEPARATORS, separators};
        Self {
            artists: separators(None, &ARTIST_SEPARATORS),
            genres: separators(None, &GENRE_SEPARATORS),
        }
    }
}

/// A credited artist: the name and, when the tags carry one for it, its MusicBrainz id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Named {
    pub name: String,
    pub mbid: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TrackTags {
    pub title: Option<String>,
    pub album: Option<String>,
    pub artists: Vec<Named>,
    pub album_artists: Vec<Named>,
    pub composers: Vec<String>,
    pub conductor: Option<String>,
    pub performers: Vec<(String, Option<String>)>,
    pub genres: Vec<String>,
    pub year: Option<i32>,
    pub original_date: Option<String>,
    pub disc: Option<i32>,
    pub disc_total: Option<i32>,
    pub disc_title: Option<String>,
    pub track: Option<i32>,
    pub recording: Option<String>,
    pub release_track: Option<String>,
    pub release: Option<String>,
    pub release_group: Option<String>,
    pub work_id: Option<String>,
    pub work: Option<String>,
    pub movement: Option<String>,
    pub movement_number: Option<i32>,
    pub isrc: Option<String>,
    pub release_type: Option<String>,
    pub release_status: Option<String>,
    pub compilation: bool,
    /// The album artist tag names "Various Artists", which is no credit.
    pub various: bool,
    pub media: Option<String>,
    pub barcode: Option<String>,
    pub catalog: Option<String>,
    pub label: Option<String>,
    pub gain: Option<f64>,
    pub peak: Option<f64>,
    pub album_gain: Option<f64>,
    pub album_peak: Option<f64>,
    pub duration_ms: Option<i32>,
}

fn mbid(v: Option<&str>) -> Option<String> {
    v.and_then(|v| ExternalProvider::MusicBrainz.normalize(v.trim()))
}

fn int(n: Option<u32>) -> Option<i32> {
    n.and_then(|n| i32::try_from(n).ok())
}

/// Artists re-split on the separators; the ids go along only while they still match the names one to one.
/// Also whether a "Various Artists" part (by name or id) was dropped: that is no credit.
fn named(
    names: &[String],
    single: Option<&str>,
    ids: &[String],
    seps: &[String],
) -> (Vec<Named>, bool) {
    let mut list: Vec<String> = names.to_vec();
    if list.is_empty() {
        list.extend(single.map(str::to_owned));
    }
    let parts = split(&list, seps);
    let ids: Vec<Option<String>> = ids.iter().map(|i| mbid(Some(i))).collect();
    let aligned = ids.len() == parts.len();
    let mut dropped = false;
    let mut out = vec![];
    for (i, name) in parts.into_iter().enumerate() {
        let id = if aligned { ids[i].clone() } else { None };
        if name.eq_ignore_ascii_case("various artists") || id.as_deref() == Some(VARIOUS_ARTISTS) {
            dropped = true;
        } else {
            out.push(Named { name, mbid: id });
        }
    }
    (out, dropped)
}

/// `01 - Title`, `1. Title`, `02_Title`: the number and the title of a file stem.
pub fn stem_parts(stem: &str) -> (Option<i32>, String) {
    let digits = stem.bytes().take_while(u8::is_ascii_digit).count();
    if (1..=3).contains(&digits) {
        let rest = &stem[digits..];
        let title = rest.trim_start_matches(|c: char| c.is_whitespace() || "._-)".contains(c));
        if title.len() < rest.len() && !title.is_empty() {
            return (stem[..digits].parse().ok(), title.trim().to_owned());
        }
    }
    (None, stem.trim().to_owned())
}

/// Year, from an `originalDate` text when the year tag is missing.
fn year_of(date: Option<&str>) -> Option<i32> {
    date?.get(..4)?.parse().ok()
}

impl TrackTags {
    /// `stem` is the file name without its extension: the title and the number of a file with no tags.
    pub fn read(info: &MediaInfo, seps: &Separators, stem: &str) -> Self {
        let t = info.tags.clone().unwrap_or_default();
        Self::of(&t, info.duration_seconds, seps, stem)
    }

    pub fn of(t: &MediaTags, duration: Option<f64>, seps: &Separators, stem: &str) -> Self {
        let (stem_number, stem_title) = stem_parts(stem);
        let (album_artists, various) = named(
            &t.album_artists,
            t.album_artist.as_deref(),
            &t.musicbrainz_album_artist_ids,
            &seps.artists,
        );
        let mut genres = t.genres.clone();
        if genres.is_empty() {
            genres.extend(t.genre.clone());
        }
        let composer: Vec<String> = t.composer.iter().cloned().collect();
        let original = t.original_date.clone();
        Self {
            title: t
                .title
                .clone()
                .or(Some(stem_title).filter(|s| !s.is_empty())),
            album: t.album.clone(),
            artists: named(
                &t.artists,
                t.artist.as_deref(),
                &t.musicbrainz_artist_ids,
                &seps.artists,
            )
            .0,
            album_artists,
            composers: split(&composer, &seps.artists),
            conductor: t.conductor.clone(),
            performers: t
                .performers
                .iter()
                .map(|p| (p.name.clone(), p.instrument.clone()))
                .collect(),
            genres: split(&genres, &seps.genres),
            year: int(t.year).or_else(|| year_of(original.as_deref())),
            original_date: original,
            disc: int(t.disc),
            disc_total: int(t.disc_total),
            disc_title: t.disc_subtitle.clone(),
            track: int(t.track).or(stem_number),
            recording: mbid(t.musicbrainz_recording_id.as_deref()),
            release_track: mbid(t.musicbrainz_track_id.as_deref()),
            release: mbid(t.musicbrainz_release_id.as_deref()),
            release_group: mbid(t.musicbrainz_release_group_id.as_deref()),
            work_id: mbid(t.musicbrainz_work_id.as_deref()),
            work: t.work.clone(),
            movement: t.movement.clone(),
            movement_number: int(t.movement_number),
            isrc: t
                .isrc
                .as_deref()
                .and_then(|i| ExternalProvider::Isrc.normalize(i)),
            release_type: t.release_type.clone(),
            release_status: t.release_status.clone(),
            compilation: t.compilation.unwrap_or(false),
            various,
            media: t.media.clone(),
            barcode: t.barcode.clone(),
            catalog: t.catalog_number.clone(),
            label: t.label.clone(),
            gain: t.replay_gain_track_gain,
            peak: t.replay_gain_track_peak,
            album_gain: t.replay_gain_album_gain,
            album_peak: t.replay_gain_album_peak,
            duration_ms: duration
                .filter(|d| *d > 0.0)
                .map(|d| (d * 1000.0).round() as i32),
        }
    }

    /// The album artist, else the artist, as a line.
    pub fn artist_line(&self) -> String {
        let list = if self.album_artists.is_empty() {
            &self.artists
        } else {
            &self.album_artists
        };
        list.iter()
            .map(|n| n.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The key that tells the albums of a folder at the root apart: the release, else album and artist.
    pub fn album_key(&self) -> Option<String> {
        AlbumTags::of(std::slice::from_ref(self)).key()
    }

    /// The disc of the folder a file sits in, when the tags name none.
    pub fn with_folder_disc(mut self, rel: &str) -> Self {
        if self.disc.is_none() {
            self.disc = fliks_domain::music::group::disc_of_folder(rel);
        }
        self
    }

    pub fn disc_number(&self) -> i32 {
        self.disc.filter(|d| (1..=999).contains(d)).unwrap_or(1)
    }
}

/// What the tags of an album's files say about the album, read by one rule everywhere: the record, the
/// identification, the grouping at a library root and the settle.
#[derive(Debug, Clone, Default)]
pub struct AlbumTags {
    pub album: Option<String>,
    pub year: Option<i32>,
    /// Most frequent first, at most 20.
    pub genres: Vec<String>,
    pub release: Option<String>,
    pub compilation: bool,
    /// The credited album artists: the tagged ones, else the first track's artists unless a compilation.
    pub artists: Vec<Named>,
    /// The artist an identification searches for: none when no album artist is credited.
    pub artist: String,
}

impl AlbumTags {
    pub fn of(tags: &[TrackTags]) -> Self {
        let tagged = tags.iter().find(|t| !t.album_artists.is_empty());
        let mut firsts: Vec<String> = tags
            .iter()
            .filter_map(|t| Some(t.artists.first()?.name.to_lowercase()))
            .collect();
        firsts.sort();
        firsts.dedup();
        let compilation = tags.iter().any(|t| t.compilation || t.various)
            || (tagged.is_none() && firsts.len() > 1);
        let artists = match tagged {
            Some(t) => t.album_artists.clone(),
            None if compilation => vec![],
            None => tags
                .iter()
                .find(|t| !t.artists.is_empty())
                .map(|t| t.artists.clone())
                .unwrap_or_default(),
        };
        let artist = if artists.is_empty() {
            String::new()
        } else {
            super::most_common(
                tags.iter()
                    .map(TrackTags::artist_line)
                    .filter(|a| !a.is_empty()),
            )
            .unwrap_or_default()
        };
        let mut genres: Vec<(String, usize)> = vec![];
        for g in tags.iter().flat_map(|t| &t.genres) {
            match genres.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case(g)) {
                Some((_, n)) => *n += 1,
                None => genres.push((g.clone(), 1)),
            }
        }
        genres.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
        Self {
            album: super::most_common(tags.iter().filter_map(|t| t.album.clone())),
            year: super::most_common(tags.iter().filter_map(|t| t.year)),
            genres: genres.into_iter().take(20).map(|(g, _)| g).collect(),
            release: super::most_common(tags.iter().filter_map(|t| t.release.clone())),
            compilation,
            artists,
            artist,
        }
    }

    /// The credited album artists as a line: empty for a compilation that names none.
    pub fn credited_line(&self) -> String {
        self.artists
            .iter()
            .map(|n| n.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The key that tells the albums of a folder at the root apart: the release, else the album and its artist.
    pub fn key(&self) -> Option<String> {
        self.release.clone().or_else(|| {
            let norm = fliks_domain::music::matcher::normalize;
            Some(format!(
                "{}|{}",
                norm(self.album.as_deref()?),
                norm(&self.artist)
            ))
        })
    }
}

/// Lyrics never reach `streamInfo`: the probe answer minus `tags.lyrics` and `tags.syncedLyrics`
/// (read again from the file by the lyrics discovery).
pub fn strip_lyrics(info: &MediaInfo) -> Value {
    let mut v = serde_json::to_value(info).unwrap_or(Value::Null);
    if let Some(t) = v.get_mut("tags").and_then(Value::as_object_mut) {
        t.remove("lyrics");
        t.remove("syncedLyrics");
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
    const B: &str = "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d";

    fn tags() -> MediaTags {
        MediaTags {
            title: Some("One".into()),
            album: Some("Alpha".into()),
            artists: vec!["Ana / Bo".into()],
            musicbrainz_artist_ids: vec![A.into(), B.into()],
            album_artist: Some("Ana".into()),
            genre: Some("Rock; Pop, Folk".into()),
            year: Some(1999),
            track: Some(3),
            disc: Some(2),
            musicbrainz_release_id: Some(A.to_uppercase()),
            lyrics: Some("la la".into()),
            ..Default::default()
        }
    }

    #[test]
    fn artists_and_genres_are_re_split_and_ids_follow_the_names() {
        let t = TrackTags::of(&tags(), Some(61.5), &Separators::default(), "x");
        let names: Vec<_> = t
            .artists
            .iter()
            .map(|n| (n.name.as_str(), n.mbid.as_deref()))
            .collect();
        assert_eq!(names, [("Ana", Some(A)), ("Bo", Some(B))]);
        assert_eq!(t.genres, ["Rock", "Pop", "Folk"]);
        assert_eq!(
            (t.track, t.disc_number(), t.duration_ms),
            (Some(3), 2, Some(61500))
        );
        assert_eq!(t.release.as_deref(), Some(A));
        let mut odd = tags();
        odd.musicbrainz_artist_ids = vec![A.into()];
        let t = TrackTags::of(&odd, None, &Separators::default(), "x");
        assert!(t.artists.iter().all(|n| n.mbid.is_none()));
    }

    #[test]
    fn a_file_without_tags_is_named_by_its_stem() {
        let t = TrackTags::of(
            &MediaTags::default(),
            None,
            &Separators::default(),
            "07 - Night Ride",
        );
        assert_eq!((t.title.as_deref(), t.track), (Some("Night Ride"), Some(7)));
        assert_eq!(stem_parts("1999"), (None, "1999".into()));
        assert_eq!(stem_parts("Intro"), (None, "Intro".into()));
        assert_eq!(stem_parts("12. Coda"), (Some(12), "Coda".into()));
    }

    #[test]
    fn various_artists_is_no_credit_and_lyrics_are_stripped() {
        let mut t = tags();
        t.album_artist = Some("Various Artists".into());
        assert!(
            TrackTags::of(&t, None, &Separators::default(), "x")
                .album_artists
                .is_empty()
        );
        let info: MediaInfo = serde_json::from_value(serde_json::json!({
            "video": [], "audio": [], "subtitles": [],
            "tags": {"title": "T", "lyrics": "secret", "syncedLyrics": "[00:01.00] x"}
        }))
        .unwrap();
        let v = strip_lyrics(&info);
        assert_eq!(v["tags"], serde_json::json!({"title": "T"}));
    }

    #[test]
    fn a_compilation_is_searched_by_album_alone_and_grouped_by_album() {
        let mut various = tags();
        various.album_artist = Some("Various Artists".into());
        various.musicbrainz_release_id = None;
        let a = TrackTags::of(&various, None, &Separators::default(), "x");
        let mut b = various.clone();
        b.artists = vec!["Zed".into()];
        let b = TrackTags::of(&b, None, &Separators::default(), "y");
        let album = AlbumTags::of(&[a.clone(), b.clone()]);
        assert!(album.compilation && album.artist.is_empty() && album.artists.is_empty());
        assert_eq!(a.album_key(), b.album_key());
        let plain = TrackTags::of(&tags(), None, &Separators::default(), "x");
        let album = AlbumTags::of(&[plain]);
        assert!(!album.compilation);
        assert_eq!(album.artist, "Ana");
    }

    #[test]
    fn a_compilation_with_a_credited_album_artist_keeps_it_for_the_search() {
        let mut t = tags();
        t.compilation = Some(true);
        let t = TrackTags::of(&t, None, &Separators::default(), "x");
        let album = AlbumTags::of(&[t]);
        assert!(album.compilation);
        assert_eq!(
            (album.artist.as_str(), album.credited_line().as_str()),
            ("Ana", "Ana")
        );
    }

    #[test]
    fn various_follows_what_the_split_dropped() {
        let of = |names: &[&str], single: Option<&str>| {
            let mut t = tags();
            t.album_artists = names.iter().map(|n| (*n).into()).collect();
            t.album_artist = single.map(Into::into);
            TrackTags::of(&t, None, &Separators::default(), "x")
        };
        let t = of(&["Ana"], Some("Various Artists"));
        assert!(!t.various && t.album_artists[0].name == "Ana");
        let t = of(&[], Some("Various Artists; Ana"));
        assert!(t.various && t.album_artists.len() == 1);
        assert!(!of(&[], Some("Ana")).various);
    }
}
