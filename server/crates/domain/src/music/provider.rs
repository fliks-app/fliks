//! The records a music provider returns, checked where the host receives them
//! (`docs/spec/music.md`, section Provider records).
use crate::{
    comics::provider::{https, int, prose, text},
    external_id::ExternalProvider,
};
use chrono::NaiveDate;
use serde_json::Value;
use std::collections::HashSet;

pub const PRIMARY_TYPES: [&str; 5] = ["album", "single", "ep", "broadcast", "other"];
pub const SECONDARY_TYPES: [&str; 12] = [
    "compilation",
    "soundtrack",
    "spokenword",
    "interview",
    "audiobook",
    "audio drama",
    "live",
    "remix",
    "dj-mix",
    "mixtape/street",
    "demo",
    "field recording",
];
pub const STATUSES: [&str; 7] = [
    "official",
    "promotion",
    "bootleg",
    "pseudo-release",
    "withdrawn",
    "expunged",
    "cancelled",
];
pub const MEDIA: [&str; 5] = ["cd", "vinyl", "digital", "cassette", "other"];
pub const CREDIT_ROLES: [&str; 7] = [
    "artist",
    "composer",
    "lyricist",
    "performer",
    "conductor",
    "orchestra",
    "ensemble",
];
pub const ARTIST_TYPES: [&str; 6] = [
    "person",
    "group",
    "orchestra",
    "choir",
    "character",
    "other",
];
/// The MusicBrainz id of "Various Artists": never a person row (`isCompilation` says it).
pub const VARIOUS_ARTISTS: &str = "89ad4ac3-39f7-470e-963a-56509c546377";

const MAX_TITLE: usize = 500;
const MAX_NAME: usize = 255;
const MAX_OVERVIEW: usize = 10_000;
const MAX_JOIN: usize = 64;
const MAX_TRACKS: usize = 2_000;

/// The entry of `set` equal to `v` once trimmed and lower-cased.
fn one_of(v: &Value, key: &str, set: &'static [&'static str]) -> Option<&'static str> {
    let s = v.get(key)?.as_str()?.trim().to_lowercase();
    set.iter().find(|k| **k == s).copied()
}

fn mbid(v: &Value, key: &str) -> Option<String> {
    ExternalProvider::MusicBrainz.normalize(v.get(key)?.as_str()?.trim())
}

/// `YYYY`, `YYYY-MM` or `YYYY-MM-DD` as a date; a partial one is its first day.
pub fn partial_date(s: &str) -> Option<NaiveDate> {
    let mut parts = s.trim().splitn(3, '-');
    let year = parts.next()?;
    if year.len() != 4 || !year.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let num = |p: Option<&str>| -> Option<Option<u32>> {
        let Some(p) = p else { return Some(None) };
        (p.len() == 2 && p.bytes().all(|b| b.is_ascii_digit())).then(|| p.parse().ok())
    };
    let month = num(parts.next())?;
    let day = num(parts.next())?;
    if month.is_none() && day.is_some() {
        return None;
    }
    NaiveDate::from_ymd_opt(year.parse().ok()?, month.unwrap_or(1), day.unwrap_or(1))
}

fn date(v: &Value, key: &str) -> Option<NaiveDate> {
    partial_date(v.get(key)?.as_str()?)
}

fn float(v: &Value, key: &str, ok: impl Fn(f64) -> bool) -> Option<f64> {
    v.get(key)?.as_f64().filter(|n| n.is_finite() && ok(*n))
}

fn flag(v: &Value, key: &str) -> Option<bool> {
    v.get(key)?.as_bool()
}

/// The medium a format name says (`CD`, `Digital Media`, `12\" Vinyl`); `other` for any other.
pub fn medium(format: &str) -> &'static str {
    let f = format.to_lowercase();
    if f.contains("vinyl") {
        "vinyl"
    } else if f.contains("digital") {
        "digital"
    } else if f.contains("cassette") {
        "cassette"
    } else if f.contains("cd") {
        "cd"
    } else {
        "other"
    }
}

/// A name or credit of an artist, composer or other contributor.
#[derive(Debug, Clone, PartialEq)]
pub struct Credit {
    /// MusicBrainz id; `None` when the provider has none.
    pub id: Option<String>,
    pub name: String,
    pub sort_name: Option<String>,
    /// The text printed on the release, when it differs from `name`.
    pub credited_name: Option<String>,
    /// The text that follows the credit in a line of artists (`" feat. "`), not trimmed.
    pub join_phrase: Option<String>,
    pub role: &'static str,
    /// Only for a performer.
    pub instrument: Option<String>,
}

/// A credit; `role` is the default of an entry that names none.
pub fn credit(v: &Value, role: &'static str) -> Result<Credit, &'static str> {
    if !v.is_object() {
        return Err("a credit is not an object");
    }
    let role = match v.get("role") {
        None | Some(Value::Null) => role,
        Some(_) => one_of(v, "role", &CREDIT_ROLES).ok_or("unknown credit role")?,
    };
    let join_phrase = v
        .get("joinPhrase")
        .and_then(Value::as_str)
        .filter(|s| (1..=MAX_JOIN).contains(&s.chars().count()) && !s.chars().any(char::is_control))
        .map(str::to_owned);
    Ok(Credit {
        id: mbid(v, "id").filter(|i| i != VARIOUS_ARTISTS),
        name: text(v, "name", MAX_NAME).ok_or("a credit has no name")?,
        sort_name: text(v, "sortName", MAX_NAME),
        credited_name: text(v, "creditedName", MAX_NAME),
        join_phrase,
        role,
        instrument: text(v, "instrument", MAX_NAME).filter(|_| role == "performer"),
    })
}

/// The credits of a list, in order; an entry that breaks the checks is dropped.
pub fn credits(v: Option<&Value>, role: &'static str) -> Vec<Credit> {
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| credit(c, role).ok())
        .collect()
}

/// A release group: a search hit, a work record or a discography entry.
#[derive(Debug, Clone, PartialEq)]
pub struct Album {
    pub external_id: String,
    pub title: String,
    pub overview: Option<String>,
    pub year: Option<i32>,
    pub poster_url: Option<String>,
    pub artists: Vec<Credit>,
    pub primary_type: Option<&'static str>,
    pub secondary_types: Vec<&'static str>,
    pub first_release_date: Option<NaiveDate>,
    pub is_compilation: bool,
    pub release_count: Option<i32>,
    pub popularity: Option<f64>,
    pub source_url: Option<String>,
    /// At most 20 names of 1 to 64 characters; what fills `media.genres` when the tags give none.
    pub genres: Vec<String>,
}

/// The album a record describes; `Err` when the id or the title is missing or the record is no album. An
/// optional key out of its bounds is dropped, not the record.
pub fn album(v: &Value) -> Result<Album, &'static str> {
    if !v.is_object() {
        return Err("not an object");
    }
    if v.get("mediaType").is_some_and(|m| m != "album") {
        return Err("mediaType is not album");
    }
    let mut secondary_types: Vec<&'static str> = v
        .get("secondaryTypes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let t = t.as_str()?.trim().to_lowercase();
            SECONDARY_TYPES.iter().find(|k| **k == t).copied()
        })
        .collect();
    let mut seen = HashSet::new();
    secondary_types.retain(|t| seen.insert(*t));
    let first_release_date = date(v, "firstReleaseDate");
    let artists = credits(v.get("artists"), "artist");
    let is_compilation = flag(v, "isCompilation").unwrap_or_else(|| {
        secondary_types.contains(&"compilation")
            || v.get("artists").and_then(Value::as_array).is_some_and(|a| {
                a.iter()
                    .any(|c| mbid(c, "id").as_deref() == Some(VARIOUS_ARTISTS))
            })
    });
    Ok(Album {
        external_id: text(v, "externalId", 128).ok_or("externalId is missing")?,
        title: text(v, "title", MAX_TITLE).ok_or("title is missing")?,
        overview: prose(v, "overview", MAX_OVERVIEW),
        year: int(v, "year", 1, 9999)
            .or_else(|| first_release_date.map(|d| chrono::Datelike::year(&d))),
        poster_url: https(v, "posterUrl"),
        artists,
        primary_type: one_of(v, "primaryType", &PRIMARY_TYPES),
        secondary_types,
        first_release_date,
        is_compilation,
        release_count: int(v, "releaseCount", 0, i64::from(i32::MAX)),
        popularity: float(v, "popularity", |n| n >= 0.0),
        source_url: https(v, "sourceUrl"),
        genres: genres(v),
    })
}

const MAX_GENRES: usize = 20;
const MAX_GENRE: usize = 64;

fn genres(v: &Value) -> Vec<String> {
    let mut seen = HashSet::new();
    v.get("genres")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|g| {
            let g = g.as_str()?.trim();
            let ok =
                (1..=MAX_GENRE).contains(&g.chars().count()) && !g.chars().any(char::is_control);
            (ok && seen.insert(g.to_lowercase())).then(|| g.to_owned())
        })
        .take(MAX_GENRES)
        .collect()
}

/// A list of albums that passed the checks, and what was dropped.
#[derive(Debug, Default)]
pub struct Albums {
    pub kept: Vec<Album>,
    pub invalid: usize,
    pub first_reason: Option<&'static str>,
    /// Entries of an id an earlier one already held.
    pub repeats: usize,
}

pub fn albums(list: &[Value]) -> Albums {
    let mut out = Albums::default();
    let mut seen = HashSet::new();
    for v in list {
        match album(v) {
            Err(why) => {
                out.invalid += 1;
                out.first_reason.get_or_insert(why);
            }
            Ok(a) if seen.insert(a.external_id.clone()) => out.kept.push(a),
            Ok(_) => out.repeats += 1,
        }
    }
    out
}

/// A release (a pressing), as a stub of its group's children or the head of an edition record.
#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub external_id: String,
    pub title: String,
    pub country: Option<String>,
    pub status: Option<&'static str>,
    pub media: Option<&'static str>,
    pub release_date: Option<NaiveDate>,
    pub barcode: Option<String>,
    pub catalog_number: Option<String>,
    /// The label, stored as the edition's `publisher`.
    pub label: Option<String>,
    pub track_count: Option<i32>,
    pub disc_count: Option<i32>,
}

pub fn release(v: &Value) -> Result<Release, &'static str> {
    if !v.is_object() {
        return Err("not an object");
    }
    Ok(Release {
        external_id: text(v, "externalId", 128).ok_or("externalId is missing")?,
        title: text(v, "title", MAX_TITLE).ok_or("title is missing")?,
        country: text(v, "country", 2)
            .filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_uppercase())),
        status: one_of(v, "status", &STATUSES),
        media: one_of(v, "media", &MEDIA),
        release_date: date(v, "releaseDate"),
        barcode: text(v, "barcode", 14)
            .filter(|b| (8..=14).contains(&b.len()) && b.bytes().all(|c| c.is_ascii_digit())),
        catalog_number: text(v, "catalogNumber", MAX_NAME),
        label: text(v, "label", MAX_NAME),
        track_count: int(v, "trackCount", 0, 9999),
        disc_count: int(v, "discCount", 1, 999),
    })
}

/// The releases of a group that passed the checks, and what was dropped.
#[derive(Debug, Default)]
pub struct Releases {
    pub kept: Vec<Release>,
    pub invalid: usize,
    pub first_reason: Option<&'static str>,
    pub repeats: usize,
}

pub fn releases(list: &[Value]) -> Releases {
    let mut out = Releases::default();
    let mut seen = HashSet::new();
    for v in list {
        match release(v) {
            Err(why) => {
                out.invalid += 1;
                out.first_reason.get_or_insert(why);
            }
            Ok(r) if seen.insert(r.external_id.clone()) => out.kept.push(r),
            Ok(_) => out.repeats += 1,
        }
    }
    out
}

/// A work a track plays; a movement names its parent work.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkRef {
    pub external_id: Option<String>,
    pub title: String,
    pub parent_id: Option<String>,
    pub parent_title: Option<String>,
    pub composer: Option<Credit>,
}

fn work_ref(v: &Value) -> Option<WorkRef> {
    Some(WorkRef {
        external_id: mbid(v, "externalId"),
        title: text(v, "title", MAX_TITLE)?,
        parent_id: mbid(v, "parentId"),
        parent_title: text(v, "parentTitle", MAX_TITLE),
        composer: v.get("composer").and_then(|c| credit(c, "composer").ok()),
    })
}

/// One track of a release, as `track_details` and `item_credits` keep it.
#[derive(Debug, Clone, PartialEq)]
pub struct Track {
    pub title: String,
    pub disc_number: i32,
    pub disc_title: Option<String>,
    /// Rank in the release, disc after disc, from 1: the sort key.
    pub position: i32,
    pub number: Option<i32>,
    /// The number as printed (`A1`).
    pub label: Option<String>,
    pub recording_id: Option<String>,
    pub release_track_id: Option<String>,
    pub isrc: Option<String>,
    pub duration_ms: Option<i32>,
    pub explicit: bool,
    pub gain: Option<f64>,
    pub peak: Option<f64>,
    /// A score of the provider (a listen count), only comparable inside one provider.
    pub popularity: Option<f64>,
    pub credits: Vec<Credit>,
    pub works: Vec<WorkRef>,
}

/// `index` is the place in the list, the `position` of a track that names none.
fn track(v: &Value, index: usize) -> Result<Track, &'static str> {
    if !v.is_object() {
        return Err("a track is not an object");
    }
    let mut all = credits(v.get("artists"), "artist");
    all.extend(credits(v.get("credits"), "performer"));
    Ok(Track {
        title: text(v, "title", MAX_TITLE).ok_or("a track has no title")?,
        disc_number: int(v, "discNumber", 1, 999).unwrap_or(1),
        disc_title: text(v, "discTitle", MAX_NAME),
        position: int(v, "position", 1, i64::from(i32::MAX))
            .or_else(|| i32::try_from(index + 1).ok())
            .ok_or("too many tracks")?,
        number: int(v, "number", 0, 9999),
        label: text(v, "label", 32),
        recording_id: mbid(v, "recordingId"),
        release_track_id: mbid(v, "releaseTrackId"),
        isrc: v
            .get("isrc")
            .and_then(Value::as_str)
            .and_then(|i| ExternalProvider::Isrc.normalize(i)),
        duration_ms: int(v, "durationMs", 1, i64::from(i32::MAX)),
        explicit: flag(v, "explicit").unwrap_or(false),
        gain: float(v, "gain", |n| n.abs() <= 100.0),
        peak: float(v, "peak", |n| n > 0.0 && n <= 100.0),
        popularity: float(v, "popularity", |n| n >= 0.0),
        credits: all,
        works: v
            .get("works")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(work_ref)
            .collect(),
    })
}

/// A release with its tracklist: the answer of `fetch-edition`.
#[derive(Debug, Clone, PartialEq)]
pub struct Edition {
    pub release: Release,
    pub language: Option<String>,
    pub cover_url: Option<String>,
    pub album_gain: Option<f64>,
    pub album_peak: Option<f64>,
    pub artists: Vec<Credit>,
    pub tracks: Vec<Track>,
    /// Tracks dropped for breaking a check or for the `position` an earlier one held.
    pub dropped: usize,
}

/// The edition a record describes; `Err` when the head fails, `tracks` is not a list or it is over 2000
/// entries. A track that breaks a check is dropped, as is a repeated `position`.
pub fn edition(v: &Value) -> Result<Edition, &'static str> {
    let release = release(v)?;
    let list = v
        .get("tracks")
        .and_then(Value::as_array)
        .ok_or("tracks is not a list")?;
    if list.len() > MAX_TRACKS {
        return Err("too many tracks");
    }
    let mut seen = HashSet::new();
    let (mut tracks, mut dropped) = (vec![], 0);
    for (i, t) in list.iter().enumerate() {
        match track(t, i) {
            Ok(t) if seen.insert(t.position) => tracks.push(t),
            _ => dropped += 1,
        }
    }
    Ok(Edition {
        language: text(v, "language", 8),
        cover_url: https(v, "coverUrl"),
        album_gain: float(v, "albumGain", |n| n.abs() <= 100.0),
        album_peak: float(v, "albumPeak", |n| n > 0.0 && n <= 100.0),
        artists: credits(v.get("artists"), "artist"),
        release,
        tracks,
        dropped,
    })
}

/// An artist as the person record of a provider says it. Every key is optional: a provider that only
/// knows images answers an `avatarUrl`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Person {
    /// The MusicBrainz id the record names: another than the one asked is the one a merge left.
    pub id: Option<String>,
    pub name: Option<String>,
    pub sort_name: Option<String>,
    pub disambiguation: Option<String>,
    pub kind: Option<&'static str>,
    pub birthday: Option<NaiveDate>,
    pub deathday: Option<NaiveDate>,
    pub place_of_birth: Option<String>,
    pub biography: Option<String>,
    pub avatar_url: Option<String>,
}

pub fn person(v: &Value) -> Result<Person, &'static str> {
    if !v.is_object() {
        return Err("not an object");
    }
    Ok(Person {
        id: mbid(v, "id"),
        name: text(v, "name", MAX_NAME),
        sort_name: text(v, "sortName", MAX_NAME),
        disambiguation: text(v, "disambiguation", MAX_NAME),
        kind: one_of(v, "type", &ARTIST_TYPES),
        birthday: date(v, "birthday"),
        deathday: date(v, "deathday"),
        place_of_birth: text(v, "placeOfBirth", MAX_NAME),
        biography: prose(v, "biography", MAX_OVERVIEW),
        avatar_url: https(v, "avatarUrl"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const A: &str = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
    const B: &str = "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d";

    #[test]
    fn partial_dates_land_on_their_first_day() {
        let d = |s| partial_date(s).map(|d| d.to_string());
        assert_eq!(d("1973"), Some("1973-01-01".into()));
        assert_eq!(d("1973-03"), Some("1973-03-01".into()));
        assert_eq!(d(" 1973-03-01 "), Some("1973-03-01".into()));
        for bad in [
            "",
            "73",
            "1973-13",
            "1973-02-30",
            "1973-3",
            "1973-03-1",
            "1973--01",
            "x973",
        ] {
            assert_eq!(d(bad), None, "{bad}");
        }
    }

    #[test]
    fn an_album_needs_an_id_and_a_title_and_drops_what_is_out_of_range() {
        let a = album(&json!({
            "externalId": A, "title": " Alpha ", "mediaType": "album", "year": 0,
            "firstReleaseDate": "1973-03", "primaryType": "EP",
            "secondaryTypes": ["Live", "live", "nope", "remix"], "popularity": -1,
            "posterUrl": "http://p", "sourceUrl": "https://s", "releaseCount": 4,
            "artists": [{"id": A, "name": "Ana", "joinPhrase": " & "}, {"name": ""}, {"name": "Bo", "id": VARIOUS_ARTISTS}]
        }))
        .unwrap();
        assert_eq!(
            (a.title.as_str(), a.year, a.primary_type),
            ("Alpha", Some(1973), Some("ep"))
        );
        assert_eq!(a.secondary_types, ["live", "remix"]);
        assert_eq!(
            (a.popularity, a.poster_url, a.release_count),
            (None, None, Some(4))
        );
        assert_eq!(
            a.first_release_date.map(|d| d.to_string()).as_deref(),
            Some("1973-03-01")
        );
        assert_eq!(a.source_url.as_deref(), Some("https://s"));
        let names: Vec<_> = a
            .artists
            .iter()
            .map(|c| (c.name.as_str(), c.join_phrase.as_deref()))
            .collect();
        assert_eq!(names, [("Ana", Some(" & ")), ("Bo", None)]);
        assert_eq!(
            a.artists[1].id, None,
            "the Various Artists id names no person"
        );
        assert!(
            a.is_compilation,
            "a Various Artists credit makes a compilation"
        );
        for bad in [
            json!([]),
            json!({"title": "A"}),
            json!({"externalId": A}),
            json!({"externalId": A, "title": "A\u{7}"}),
            json!({"externalId": A, "title": "A", "mediaType": "book"}),
        ] {
            assert!(album(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_compilation_is_flagged_by_type_by_va_or_by_the_record() {
        let base = |extra: Value| {
            let mut v = json!({"externalId": A, "title": "T"});
            v.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            album(&v).unwrap().is_compilation
        };
        assert!(base(json!({"secondaryTypes": ["compilation"]})));
        assert!(base(
            json!({"artists": [{"name": "VA", "id": VARIOUS_ARTISTS}]})
        ));
        assert!(base(json!({"isCompilation": true})));
        assert!(!base(
            json!({"secondaryTypes": ["compilation"], "isCompilation": false})
        ));
        assert!(!base(json!({})));
    }

    #[test]
    fn a_discography_keeps_the_first_of_a_repeated_id() {
        let got = albums(&[
            json!({"externalId": A, "title": "One"}),
            json!({"externalId": A, "title": "Again"}),
            json!({"externalId": B}),
        ]);
        assert_eq!((got.kept.len(), got.repeats, got.invalid), (1, 1, 1));
        assert_eq!(got.first_reason, Some("title is missing"));
    }

    #[test]
    fn credits_check_the_role_and_keep_the_instrument_of_a_performer() {
        let c = credit(
            &json!({"name": "Cy", "role": "Performer", "instrument": "oboe"}),
            "artist",
        )
        .unwrap();
        assert_eq!(
            (c.role, c.instrument.as_deref()),
            ("performer", Some("oboe"))
        );
        let c = credit(&json!({"name": "Cy", "instrument": "oboe"}), "artist").unwrap();
        assert_eq!(c.instrument, None);
        assert!(credit(&json!({"name": "Cy", "role": "producer"}), "artist").is_err());
        assert!(credit(&json!({"role": "artist"}), "artist").is_err());
        let joined = credit(&json!({"name": "Cy", "joinPhrase": ""}), "artist").unwrap();
        assert_eq!(joined.join_phrase, None);
    }

    #[test]
    fn releases_are_checked_one_by_one() {
        let r = release(&json!({
            "externalId": B, "title": "R", "country": "FR", "status": "Official", "media": "CD",
            "barcode": "0123456789012", "releaseDate": "1999", "trackCount": 12, "discCount": 0
        }))
        .unwrap();
        assert_eq!(
            (r.country.as_deref(), r.status, r.media),
            (Some("FR"), Some("official"), Some("cd"))
        );
        assert_eq!(
            (r.barcode.as_deref(), r.track_count, r.disc_count),
            (Some("0123456789012"), Some(12), None)
        );
        let r = release(&json!({"externalId": B, "title": "R", "country": "fr", "barcode": "12", "status": "x"})).unwrap();
        assert_eq!((r.country, r.barcode, r.status), (None, None, None));
        let got = releases(&[
            json!({"externalId": B, "title": "R"}),
            json!({"externalId": B, "title": "R2"}),
            json!({"title": "R"}),
        ]);
        assert_eq!((got.kept.len(), got.repeats, got.invalid), (1, 1, 1));
    }

    #[test]
    fn an_edition_carries_its_tracklist() {
        let e = edition(&json!({
            "externalId": B, "title": "R", "albumGain": -7.5, "albumPeak": 0.98, "coverUrl": "https://c",
            "artists": [{"name": "Ana", "id": A}],
            "tracks": [
                {"title": "One", "discNumber": 1, "number": 1, "label": "A1", "isrc": "us-rc1-76-07839",
                 "recordingId": A.to_uppercase(), "durationMs": 61000, "explicit": true, "gain": -6.2, "peak": 1.0,
                 "credits": [{"name": "Cy", "role": "composer"}, {"name": "Di", "instrument": "oboe"}],
                 "works": [{"externalId": B, "title": "Mvt 1", "parentId": A, "composer": {"name": "Cy"}}]},
                {"title": "Two", "discNumber": 2, "discTitle": "Bonus"},
                {"title": "Three", "position": 1},
                {"title": ""},
                "x"
            ]
        }))
        .unwrap();
        assert_eq!(
            (e.album_gain, e.album_peak, e.dropped),
            (Some(-7.5), Some(0.98), 3)
        );
        let titles: Vec<_> = e
            .tracks
            .iter()
            .map(|t| (t.title.as_str(), t.position, t.disc_number))
            .collect();
        assert_eq!(titles, [("One", 1, 1), ("Two", 2, 2)]);
        let t = &e.tracks[0];
        assert_eq!(t.isrc.as_deref(), Some("USRC17607839"));
        assert_eq!(t.recording_id.as_deref(), Some(A));
        assert_eq!(
            (t.duration_ms, t.explicit, t.label.as_deref()),
            (Some(61000), true, Some("A1"))
        );
        let roles: Vec<_> = t
            .credits
            .iter()
            .map(|c| (c.name.as_str(), c.role))
            .collect();
        assert_eq!(roles, [("Cy", "composer"), ("Di", "performer")]);
        assert_eq!(
            (
                t.works[0].parent_id.as_deref(),
                t.works[0].composer.is_some()
            ),
            (Some(A), true)
        );
        for bad in [
            json!({"externalId": B, "title": "R"}),
            json!({"externalId": B, "title": "R", "tracks": {}}),
            json!({"title": "R", "tracks": []}),
        ] {
            assert!(edition(&bad).is_err(), "{bad}");
        }
        let many = vec![json!({"title": "t"}); MAX_TRACKS + 1];
        assert_eq!(
            edition(&json!({"externalId": B, "title": "R", "tracks": many})),
            Err("too many tracks")
        );
    }

    #[test]
    fn a_person_record_holds_only_optional_keys() {
        let p = person(
            &json!({"name": "Ana", "type": "Group", "birthday": "1943-02", "deathday": "x",
            "avatarUrl": "http://a", "biography": "a\nb"}),
        )
        .unwrap();
        assert_eq!(
            (p.kind, p.deathday, p.avatar_url),
            (Some("group"), None, None)
        );
        assert_eq!(
            p.birthday.map(|d| d.to_string()).as_deref(),
            Some("1943-02-01")
        );
        assert_eq!(p.biography.as_deref(), Some("a\nb"));
        assert_eq!(person(&json!({})), Ok(Person::default()));
        assert!(person(&json!([])).is_err());
    }

    #[test]
    fn genres_and_track_popularity_are_bounded() {
        let many: Vec<String> = (0..30).map(|i| format!("g{i}")).collect();
        let a = album(&json!({"externalId": A, "title": "T", "genres": many})).unwrap();
        assert_eq!(a.genres.len(), 20);
        let a = album(&json!({"externalId": A, "title": "T",
            "genres": [" Rock ", "rock", "", "x".repeat(65), 3, "Pop"]}))
        .unwrap();
        assert_eq!(a.genres, ["Rock", "Pop"]);
        let e = edition(&json!({"externalId": A, "title": "T", "tracks": [
            {"title": "a", "popularity": 12.5}, {"title": "b", "popularity": -1}, {"title": "c", "popularity": "x"}]}))
        .unwrap();
        let p: Vec<_> = e.tracks.iter().map(|t| t.popularity).collect();
        assert_eq!(p, [Some(12.5), None, None]);
    }
}
