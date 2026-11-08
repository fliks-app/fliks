//! Queries over the visible albums, tracks and artists, and their wire objects (`opensubsonic.md` rules 15-22).
use super::{
    ids,
    render::{Obj, SubError},
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, PgPool, types::Json};
use std::collections::HashMap;

pub const MAX_PAGE: i64 = 500;

pub fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn set(o: &mut Obj, k: &str, v: impl Into<Value>) {
    o.insert(k.into(), v.into());
}

/// An album a caller reads, with at least one track that has a file (`m` is the media alias, `libs` a bound `int[]`).
fn album_visible(libs: &str) -> String {
    format!(
        r#"m.type = 'album' AND m."libraryId" = ANY({libs}) AND EXISTS (
  SELECT 1 FROM items vi JOIN editions ve ON ve.id = vi."editionId" JOIN item_parts vp ON vp."itemId" = vi.id
  WHERE vi."mediaId" = m.id AND COALESCE(ve."libraryId", m."libraryId") = ANY({libs}))"#
    )
}

const ALBUM_ARTISTS_TEXT: &str = r#"COALESCE((SELECT string_agg(p.name, ' ' ORDER BY mc.position) FROM media_credits mc
  JOIN persons p ON p.id = mc."personId" WHERE mc."mediaId" = m.id AND mc.role = 'artist'), '')"#;

/// `ILIKE ALL` patterns for the words of a query; `None` for an empty one (rule 25).
pub fn search_patterns(q: &str) -> Option<Vec<String>> {
    let words: Vec<String> = q
        .replace(['"', '*'], " ")
        .split_whitespace()
        .map(|w| {
            format!(
                "%{}%",
                w.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        })
        .collect();
    (!words.is_empty()).then_some(words)
}

#[derive(Default)]
pub struct Filter {
    pub genre: Option<String>,
    pub from_year: Option<i32>,
    pub to_year: Option<i32>,
    pub patterns: Option<Vec<String>>,
    pub ids: Option<Vec<i32>>,
    pub album: Option<i32>,
    pub artist: Option<i32>,
    pub starred: bool,
    pub played: bool,
    pub rated: bool,
    pub limit: i64,
    pub offset: i64,
}

const GENRE_OF_ALBUM: &str = r#"EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(m.genres) = 'array'
  THEN m.genres ELSE '[]'::jsonb END) g WHERE lower(g) = lower($3))"#;

// Songs

#[derive(sqlx::FromRow)]
pub struct SongRow {
    pub item_id: i32,
    pub album_id: i32,
    pub title: Option<String>,
    pub album: String,
    pub year: Option<i32>,
    pub genres: Option<Json<Value>>,
    pub has_cover: bool,
    pub disc: i32,
    pub track: Option<i32>,
    pub recording: Option<String>,
    pub isrc: Option<String>,
    pub duration_ms: Option<i32>,
    pub explicit: bool,
    pub gain: Option<f32>,
    pub peak: Option<f32>,
    pub album_gain: Option<f32>,
    pub album_peak: Option<f32>,
    pub size: i64,
    pub rel_path: String,
    pub stream: Option<Json<Value>>,
    pub created: DateTime<Utc>,
    pub starred: Option<DateTime<Utc>>,
    pub rating: Option<i16>,
    pub plays: i64,
    pub played: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy)]
pub enum SongOrder {
    Album,
    Random,
    Title,
    Starred,
}

pub async fn songs(
    db: &PgPool,
    user: i32,
    libs: &[i32],
    f: &Filter,
    order: SongOrder,
) -> Result<Vec<SongRow>, sqlx::Error> {
    let order = match order {
        SongOrder::Album => r#"m.id, td."discNumber", td.position, i.id"#,
        SongOrder::Random => "random()",
        SongOrder::Title => "lower(COALESCE(i.title, td.label, '')), i.id",
        SongOrder::Starred => r#"starred DESC, i.id"#,
    };
    let sql = format!(
        r#"SELECT i.id AS item_id, m.id AS album_id, COALESCE(i.title, td.label) AS title, m.title AS album, m.year,
  m.genres, m."posterUrl" IS NOT NULL AS has_cover, td."discNumber" AS disc, td."trackNumber" AS track,
  td."recordingMbid"::text AS recording, td.isrc, td."durationMs" AS duration_ms, td.explicit, td.gain, td.peak,
  e."albumGain" AS album_gain, e."albumPeak" AS album_peak, f.size, f."relativePath" AS rel_path,
  f."streamInfo" AS stream, i."createdAt" AS created,
  (SELECT l."createdAt" FROM likes l WHERE l."userId" = $1 AND l."itemId" = i.id) AS starred,
  (SELECT r.rating FROM item_ratings r WHERE r."userId" = $1 AND r."itemId" = i.id) AS rating,
  (SELECT count(*) FROM playback_history h WHERE h."userId" = $1 AND h."itemId" = i.id) AS plays,
  (SELECT max(h."playedAt") FROM playback_history h WHERE h."userId" = $1 AND h."itemId" = i.id) AS played
FROM items i
JOIN track_details td ON td."itemId" = i.id
JOIN editions e ON e.id = i."editionId"
JOIN media m ON m.id = i."mediaId" AND m.type = 'album'
JOIN LATERAL (SELECT mf.id, mf.size, mf."relativePath", mf."streamInfo" FROM item_parts ip
  JOIN media_files mf ON mf.id = ip."mediaFileId" WHERE ip."itemId" = i.id
  ORDER BY ip.version DESC, ip.position, mf.id LIMIT 1) f ON true
WHERE m."libraryId" = ANY($2) AND COALESCE(e."libraryId", m."libraryId") = ANY($2)
  AND ($3::text IS NULL OR {GENRE_OF_ALBUM})
  AND ($4::int IS NULL OR m.year >= $4) AND ($5::int IS NULL OR m.year <= $5)
  AND ($8::text[] IS NULL OR (COALESCE(i.title, td.label, '') || ' ' || m.title || ' ' || {ALBUM_ARTISTS_TEXT}) ILIKE ALL ($8))
  AND ($9::int[] IS NULL OR i.id = ANY($9))
  AND ($10::int IS NULL OR m.id = $10)
  AND (NOT $11 OR EXISTS (SELECT 1 FROM likes l WHERE l."userId" = $1 AND l."itemId" = i.id))
ORDER BY {order} LIMIT $6 OFFSET $7"#
    );
    sqlx::query_as::<_, SongRow>(AssertSqlSafe(sql))
        .bind(user)
        .bind(libs)
        .bind(&f.genre)
        .bind(f.from_year)
        .bind(f.to_year)
        .bind(f.limit)
        .bind(f.offset)
        .bind(&f.patterns)
        .bind(&f.ids)
        .bind(f.album)
        .bind(f.starred)
        .fetch_all(db)
        .await
}

// Albums

#[derive(sqlx::FromRow)]
pub struct AlbumRow {
    pub id: i32,
    pub title: String,
    pub year: Option<i32>,
    pub genres: Option<Json<Value>>,
    pub created: DateTime<Utc>,
    pub overview: Option<String>,
    pub mbid: Option<String>,
    pub has_cover: bool,
    pub songs: i32,
    pub duration: i32,
    pub plays: i64,
    pub played: Option<DateTime<Utc>>,
    pub rating: Option<f64>,
    pub starred: Option<DateTime<Utc>>,
    pub first_release: Option<String>,
    pub compilation: Option<bool>,
    pub primary_type: Option<String>,
    pub secondary: Option<Vec<String>>,
    pub publisher: Option<String>,
}

#[derive(Clone, Copy)]
pub enum AlbumOrder {
    Random,
    Newest,
    Frequent,
    Recent,
    Highest,
    Starred,
    Name,
    Artist,
    Year,
    YearDesc,
}

pub async fn albums(
    db: &PgPool,
    user: i32,
    libs: &[i32],
    f: &Filter,
    order: AlbumOrder,
) -> Result<Vec<AlbumRow>, sqlx::Error> {
    let order = match order {
        AlbumOrder::Random => "random()",
        AlbumOrder::Newest => "created DESC, id DESC",
        AlbumOrder::Frequent => "plays DESC, id",
        AlbumOrder::Recent => "played DESC, id",
        AlbumOrder::Highest => "rating DESC, id",
        AlbumOrder::Starred => "starred DESC, id",
        AlbumOrder::Name => "lower(title), id",
        AlbumOrder::Artist => "artist_sort, lower(title), id",
        AlbumOrder::Year => "year, lower(title), id",
        AlbumOrder::YearDesc => "year DESC, lower(title), id",
    };
    let visible = album_visible("$2");
    let sql = format!(
        r#"SELECT * FROM (SELECT m.id, m.title, m.year, m.genres, m."createdAt" AS created, m.overview,
  (SELECT x.value FROM media_external_ids x WHERE x."mediaId" = m.id AND x.kind = 'album' AND x.provider = 'musicbrainz' LIMIT 1) AS mbid,
  m."posterUrl" IS NOT NULL AS has_cover, st.songs, st.duration,
  (SELECT count(*) FROM playback_history h JOIN items hi ON hi.id = h."itemId" WHERE h."userId" = $1 AND hi."mediaId" = m.id) AS plays,
  (SELECT max(h."playedAt") FROM playback_history h JOIN items hi ON hi.id = h."itemId" WHERE h."userId" = $1 AND hi."mediaId" = m.id) AS played,
  (SELECT avg(r.rating)::float8 FROM item_ratings r JOIN items ri ON ri.id = r."itemId" WHERE r."userId" = $1 AND ri."mediaId" = m.id) AS rating,
  (SELECT l."createdAt" FROM likes l WHERE l."userId" = $1 AND l."mediaId" = m.id AND l."itemId" IS NULL AND l."groupId" IS NULL) AS starred,
  ad."firstReleaseDate"::text AS first_release, ad."isCompilation" AS compilation, ad."primaryType" AS primary_type,
  ad."secondaryTypes" AS secondary,
  (SELECT e2.publisher FROM editions e2 WHERE e2."mediaId" = m.id AND e2.publisher IS NOT NULL ORDER BY e2.id LIMIT 1) AS publisher,
  (SELECT lower(COALESCE(p."sortName", p.name)) FROM media_credits mc JOIN persons p ON p.id = mc."personId"
    WHERE mc."mediaId" = m.id AND mc.role = 'artist' ORDER BY mc.position LIMIT 1) AS artist_sort
FROM media m
LEFT JOIN album_details ad ON ad."mediaId" = m.id
JOIN LATERAL (SELECT count(*)::int AS songs,
    COALESCE(round(sum(COALESCE(td."durationMs" / 1000.0, (f."streamInfo"->>'durationSeconds')::float8, 0))), 0)::int AS duration
  FROM items i JOIN track_details td ON td."itemId" = i.id JOIN editions e ON e.id = i."editionId"
  JOIN LATERAL (SELECT mf."streamInfo" FROM item_parts ip JOIN media_files mf ON mf.id = ip."mediaFileId"
    WHERE ip."itemId" = i.id ORDER BY ip.version DESC, ip.position LIMIT 1) f ON true
  WHERE i."mediaId" = m.id AND COALESCE(e."libraryId", m."libraryId") = ANY($2)) st ON st.songs > 0
WHERE {visible}
  AND ($3::text IS NULL OR {GENRE_OF_ALBUM})
  AND ($4::int IS NULL OR m.year >= $4) AND ($5::int IS NULL OR m.year <= $5)
  AND ($8::text[] IS NULL OR (m.title || ' ' || {ALBUM_ARTISTS_TEXT}) ILIKE ALL ($8))
  AND ($9::int[] IS NULL OR m.id = ANY($9))
  AND ($10::int IS NULL OR EXISTS (SELECT 1 FROM media_credits mc WHERE mc."mediaId" = m.id AND mc."personId" = $10 AND mc.role = 'artist'))
) a WHERE (NOT $11 OR starred IS NOT NULL) AND (NOT $12 OR played IS NOT NULL) AND (NOT $13 OR rating IS NOT NULL)
ORDER BY {order} LIMIT $6 OFFSET $7"#
    );
    sqlx::query_as::<_, AlbumRow>(AssertSqlSafe(sql))
        .bind(user)
        .bind(libs)
        .bind(&f.genre)
        .bind(f.from_year)
        .bind(f.to_year)
        .bind(f.limit)
        .bind(f.offset)
        .bind(&f.patterns)
        .bind(&f.ids)
        .bind(f.artist)
        .bind(f.starred)
        .bind(f.played)
        .bind(f.rated)
        .fetch_all(db)
        .await
}

// Artists

#[derive(sqlx::FromRow)]
pub struct ArtistRow {
    pub id: i32,
    pub name: String,
    pub sort_name: Option<String>,
    pub has_image: bool,
    pub biography: Option<String>,
    pub mbid: Option<String>,
    pub albums: i32,
}

/// The artists with a visible album, or exactly the `ids` (any person row).
pub async fn artists(
    db: &PgPool,
    libs: &[i32],
    patterns: &Option<Vec<String>>,
    ids: Option<&[i32]>,
    limit: i64,
    offset: i64,
) -> Result<Vec<ArtistRow>, sqlx::Error> {
    let visible = album_visible("$1");
    let sql = format!(
        r#"SELECT p.id, p.name, p."sortName" AS sort_name, p."avatarUrl" IS NOT NULL AS has_image, p.biography,
  (SELECT x.value FROM person_external_ids x WHERE x."personId" = p.id AND x.provider = 'musicbrainz' LIMIT 1) AS mbid,
  COALESCE(a.albums, 0) AS albums
FROM persons p
LEFT JOIN LATERAL (SELECT count(DISTINCT mc."mediaId")::int AS albums FROM media_credits mc
  JOIN media m ON m.id = mc."mediaId"
  WHERE mc."personId" = p.id AND mc.role = 'artist' AND {visible}) a ON true
WHERE ($3::int[] IS NULL OR p.id = ANY($3)) AND ($3::int[] IS NOT NULL OR a.albums > 0)
  AND ($2::text[] IS NULL OR p.name ILIKE ALL ($2))
ORDER BY lower(COALESCE(p."sortName", p.name)), p.name, p.id LIMIT $4 OFFSET $5"#
    );
    sqlx::query_as::<_, ArtistRow>(AssertSqlSafe(sql))
        .bind(libs)
        .bind(patterns)
        .bind(ids)
        .bind(limit)
        .bind(offset)
        .fetch_all(db)
        .await
}

/// The newest `updatedAt` of the visible albums, in milliseconds.
pub async fn last_modified(db: &PgPool, libs: &[i32]) -> Result<i64, sqlx::Error> {
    let visible = album_visible("$1");
    let sql = format!(
        r#"SELECT COALESCE((extract(epoch FROM max(m."updatedAt")) * 1000)::bigint, 0) FROM media m WHERE {visible}"#
    );
    sqlx::query_scalar(AssertSqlSafe(sql))
        .bind(libs)
        .fetch_one(db)
        .await
}

pub struct Genre {
    pub name: String,
    pub songs: i64,
    pub albums: i64,
}

pub async fn genres(db: &PgPool, libs: &[i32]) -> Result<Vec<Genre>, sqlx::Error> {
    let visible = album_visible("$1");
    let sql = format!(
        r#"SELECT min(g.name) AS name, COALESCE(sum(st.songs), 0)::bigint AS songs, count(*) AS albums
FROM media m
CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(m.genres) = 'array' THEN m.genres ELSE '[]'::jsonb END) g(name)
JOIN LATERAL (SELECT count(*) AS songs FROM items i JOIN editions e ON e.id = i."editionId"
  WHERE i."mediaId" = m.id AND COALESCE(e."libraryId", m."libraryId") = ANY($1)
    AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = i.id)) st ON true
WHERE {visible} AND g.name <> ''
GROUP BY lower(g.name) ORDER BY lower(min(g.name))"#
    );
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(AssertSqlSafe(sql))
        .bind(libs)
        .fetch_all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(name, songs, albums)| Genre {
            name,
            songs,
            albums,
        })
        .collect())
}

// Credits

/// `itemId`, `personId`, name, credited name, role, join phrase and instrument.
type ItemCreditRow = (
    i32,
    i32,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
);

pub struct ItemCredit {
    person: i32,
    name: String,
    role: String,
    join: Option<String>,
    instrument: Option<String>,
}

pub struct AlbumArtist {
    person: i32,
    name: String,
}

pub struct Credits {
    items: HashMap<i32, Vec<ItemCredit>>,
    artists: HashMap<i32, Vec<AlbumArtist>>,
}

impl Credits {
    pub async fn load(db: &PgPool, media: &[i32], items: &[i32]) -> Result<Self, sqlx::Error> {
        let rows: Vec<ItemCreditRow> = sqlx::query_as(
            r#"SELECT ic."itemId", ic."personId", p.name, ic."creditedName", ic.role, ic."joinPhrase", ic.instrument
               FROM item_credits ic JOIN persons p ON p.id = ic."personId" WHERE ic."itemId" = ANY($1)
               ORDER BY ic."itemId", ic.role, ic.position"#,
        )
        .bind(items)
        .fetch_all(db)
        .await?;
        let mut by_item: HashMap<i32, Vec<ItemCredit>> = HashMap::new();
        for (item, person, name, credited, role, join, instrument) in rows {
            by_item.entry(item).or_default().push(ItemCredit {
                person,
                name: credited.unwrap_or(name),
                role,
                join,
                instrument,
            });
        }
        let rows: Vec<(i32, i32, String)> = sqlx::query_as(
            r#"SELECT mc."mediaId", p.id, p.name FROM media_credits mc JOIN persons p ON p.id = mc."personId"
               WHERE mc."mediaId" = ANY($1) AND mc.role = 'artist' ORDER BY mc."mediaId", mc.position, mc.id"#,
        )
        .bind(media)
        .fetch_all(db)
        .await?;
        let mut artists: HashMap<i32, Vec<AlbumArtist>> = HashMap::new();
        for (media, person, name) in rows {
            artists
                .entry(media)
                .or_default()
                .push(AlbumArtist { person, name });
        }
        Ok(Self {
            items: by_item,
            artists,
        })
    }

    fn album_artists(&self, media: i32) -> &[AlbumArtist] {
        self.artists.get(&media).map_or(&[], Vec::as_slice)
    }

    fn of_item(&self, item: i32, role: &str) -> Vec<&ItemCredit> {
        self.items
            .get(&item)
            .map(|v| v.iter().filter(|c| c.role == role).collect())
            .unwrap_or_default()
    }
}

fn artist_ref(id: i32, name: &str) -> Value {
    json!({"id": ids::artist(id), "name": name})
}

fn album_artist_line(a: &[AlbumArtist]) -> String {
    if a.is_empty() {
        return "Unknown Artist".into();
    }
    a.iter()
        .map(|x| x.name.as_str())
        .collect::<Vec<_>>()
        .join(" & ")
}

fn genre_list(g: &Option<Json<Value>>) -> Vec<String> {
    g.as_ref()
        .and_then(|j| j.0.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn genres_value(names: &[String]) -> Vec<Value> {
    names.iter().map(|n| json!({"name": n})).collect()
}

// Wire objects

pub fn song(r: &SongRow, c: &Credits) -> Value {
    let album_artists = c.album_artists(r.album_id);
    let credits = c.of_item(r.item_id, "artist");
    let genres = genre_list(&r.genres);
    let mut o = Obj::new();
    set(&mut o, "id", ids::track(r.item_id));
    set(&mut o, "parent", ids::album(r.album_id));
    set(&mut o, "isDir", false);
    let title = r
        .title
        .clone()
        .unwrap_or_else(|| format!("Track {}", r.track.unwrap_or(0)));
    set(&mut o, "title", title.clone());
    set(&mut o, "sortName", title);
    set(&mut o, "album", r.album.clone());
    set(&mut o, "albumId", ids::album(r.album_id));
    let (artist, artists, display) = if credits.is_empty() {
        (
            album_artists.first().map(|a| (a.person, a.name.clone())),
            album_artists
                .iter()
                .map(|a| artist_ref(a.person, &a.name))
                .collect(),
            album_artist_line(album_artists),
        )
    } else {
        let mut line = String::new();
        for (i, cr) in credits.iter().enumerate() {
            line.push_str(&cr.name);
            if i + 1 < credits.len() {
                line.push_str(cr.join.as_deref().unwrap_or(" & "));
            }
        }
        (
            Some((credits[0].person, credits[0].name.clone())),
            credits
                .iter()
                .map(|a| artist_ref(a.person, &a.name))
                .collect::<Vec<_>>(),
            line,
        )
    };
    set(
        &mut o,
        "artist",
        artist
            .as_ref()
            .map_or_else(|| display.clone(), |a| a.1.clone()),
    );
    if let Some((id, _)) = &artist {
        set(&mut o, "artistId", ids::artist(*id));
    }
    set(&mut o, "artists", artists);
    set(&mut o, "displayArtist", display);
    set(
        &mut o,
        "albumArtists",
        album_artists
            .iter()
            .map(|a| artist_ref(a.person, &a.name))
            .collect::<Vec<_>>(),
    );
    set(
        &mut o,
        "displayAlbumArtist",
        album_artist_line(album_artists),
    );
    if let Some(t) = r.track {
        set(&mut o, "track", t);
    }
    set(&mut o, "discNumber", r.disc);
    if let Some(y) = r.year {
        set(&mut o, "year", y);
    }
    if let Some(g) = genres.first() {
        set(&mut o, "genre", g.clone());
    }
    set(&mut o, "genres", genres_value(&genres));
    if r.has_cover {
        set(&mut o, "coverArt", ids::album(r.album_id));
    }
    set(&mut o, "size", r.size);
    let file = r.rel_path.rsplit('/').next().unwrap_or(&r.rel_path);
    let suffix = file
        .rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .unwrap_or_default();
    set(
        &mut o,
        "contentType",
        crate::stream::book_format(&suffix).unwrap_or("application/octet-stream"),
    );
    set(
        &mut o,
        "path",
        format!("{}/{}/{file}", album_artist_line(album_artists), r.album),
    );
    set(&mut o, "suffix", suffix);
    let audio = r
        .stream
        .as_ref()
        .and_then(|s| s.0.get("audio"))
        .and_then(|a| a.get(0));
    let num = |v: Option<&Value>| v.and_then(Value::as_f64);
    let duration = r
        .duration_ms
        .map(|ms| f64::from(ms) / 1000.0)
        .or_else(|| num(r.stream.as_ref().and_then(|s| s.0.get("durationSeconds"))))
        .unwrap_or(0.0);
    set(&mut o, "duration", duration.round() as i64);
    let bit_rate = num(audio.and_then(|a| a.get("bitRate")))
        .or_else(|| num(r.stream.as_ref().and_then(|s| s.0.get("formatBitRate"))))
        .or_else(|| (duration > 0.0).then(|| r.size as f64 * 8.0 / duration));
    if let Some(b) = bit_rate {
        set(&mut o, "bitRate", (b / 1000.0).round() as i64);
    }
    if let Some(s) = num(audio.and_then(|a| a.get("sampleRate"))) {
        set(&mut o, "samplingRate", s as i64);
    }
    if let Some(ch) = num(audio.and_then(|a| a.get("channels"))) {
        set(&mut o, "channelCount", ch as i64);
    }
    set(&mut o, "created", iso(r.created));
    if let Some(t) = r.starred {
        set(&mut o, "starred", iso(t));
    }
    if let Some(n) = r.rating {
        set(&mut o, "userRating", n);
    }
    set(&mut o, "playCount", r.plays);
    if let Some(t) = r.played {
        set(&mut o, "played", iso(t));
    }
    set(&mut o, "type", "music");
    set(&mut o, "mediaType", "song");
    set(&mut o, "isVideo", false);
    if let Some(m) = &r.recording {
        set(&mut o, "musicBrainzId", m.clone());
    }
    if let Some(i) = &r.isrc {
        set(&mut o, "isrc", vec![i.clone()]);
    }
    let mut gain = Obj::new();
    for (k, v) in [
        ("trackGain", r.gain),
        ("albumGain", r.album_gain),
        ("trackPeak", r.peak),
        ("albumPeak", r.album_peak),
    ] {
        if let Some(v) = v {
            set(&mut gain, k, v);
        }
    }
    if !gain.is_empty() {
        set(&mut o, "replayGain", gain);
    }
    set(
        &mut o,
        "explicitStatus",
        if r.explicit { "explicit" } else { "" },
    );
    let mut contributors = vec![];
    let mut composers = vec![];
    for cr in c
        .items
        .get(&r.item_id)
        .into_iter()
        .flatten()
        .filter(|cr| cr.role != "artist")
    {
        let mut one = json!({"role": cr.role, "artist": artist_ref(cr.person, &cr.name)});
        if let Some(i) = &cr.instrument {
            one["subRole"] = i.clone().into();
        }
        if cr.role == "composer" {
            composers.push(cr.name.clone());
        }
        contributors.push(one);
    }
    if !contributors.is_empty() {
        set(&mut o, "contributors", contributors);
    }
    if !composers.is_empty() {
        set(&mut o, "displayComposer", composers.join(", "));
    }
    set(&mut o, "bpm", 0);
    set(&mut o, "comment", "");
    Value::Object(o)
}

fn partial_date(s: &str) -> Value {
    let mut it = s.split('-').map(|p| p.parse::<i32>().ok());
    let mut o = Obj::new();
    for k in ["year", "month", "day"] {
        if let Some(Some(n)) = it.next() {
            o.insert(k.into(), n.into());
        }
    }
    Value::Object(o)
}

fn type_label(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().chain(c).collect())
        .unwrap_or_default()
}

pub async fn disc_titles(
    db: &PgPool,
    media: &[i32],
) -> Result<HashMap<i32, Vec<Value>>, sqlx::Error> {
    let rows: Vec<(i32, i32, String)> = sqlx::query_as(
        r#"SELECT DISTINCT td."mediaId", td."discNumber", td."discTitle" FROM track_details td
           WHERE td."mediaId" = ANY($1) AND td."discTitle" IS NOT NULL ORDER BY 1, 2"#,
    )
    .bind(media)
    .fetch_all(db)
    .await?;
    let mut out: HashMap<i32, Vec<Value>> = HashMap::new();
    for (m, disc, title) in rows {
        out.entry(m)
            .or_default()
            .push(json!({"disc": disc, "title": title}));
    }
    Ok(out)
}

pub fn album(r: &AlbumRow, c: &Credits, discs: &HashMap<i32, Vec<Value>>) -> Obj {
    let artists = c.album_artists(r.id);
    let genres = genre_list(&r.genres);
    let mut o = Obj::new();
    set(&mut o, "id", ids::album(r.id));
    set(&mut o, "name", r.title.clone());
    set(&mut o, "sortName", r.title.clone());
    set(
        &mut o,
        "artist",
        artists
            .first()
            .map_or_else(|| "Unknown Artist".to_owned(), |a| a.name.clone()),
    );
    if let Some(a) = artists.first() {
        set(&mut o, "artistId", ids::artist(a.person));
    }
    if r.has_cover {
        set(&mut o, "coverArt", ids::album(r.id));
    }
    set(&mut o, "songCount", r.songs);
    set(&mut o, "duration", r.duration);
    set(&mut o, "playCount", r.plays);
    if let Some(t) = r.played {
        set(&mut o, "played", iso(t));
    }
    set(&mut o, "created", iso(r.created));
    if let Some(t) = r.starred {
        set(&mut o, "starred", iso(t));
    }
    if let Some(y) = r.year {
        set(&mut o, "year", y);
    }
    if let Some(g) = genres.first() {
        set(&mut o, "genre", g.clone());
    }
    set(&mut o, "genres", genres_value(&genres));
    if let Some(rt) = r.rating {
        set(&mut o, "userRating", rt.round() as i64);
    }
    if let Some(m) = &r.mbid {
        set(&mut o, "musicBrainzId", m.clone());
    }
    set(
        &mut o,
        "artists",
        artists
            .iter()
            .map(|a| artist_ref(a.person, &a.name))
            .collect::<Vec<_>>(),
    );
    set(&mut o, "displayArtist", album_artist_line(artists));
    let mut types = vec![];
    if let Some(p) = &r.primary_type {
        types.push(type_label(p));
    }
    types.extend(r.secondary.iter().flatten().map(|s| type_label(s)));
    set(&mut o, "releaseTypes", types);
    set(&mut o, "isCompilation", r.compilation.unwrap_or(false));
    if let Some(d) = &r.first_release {
        set(&mut o, "originalReleaseDate", partial_date(d));
        set(&mut o, "releaseDate", partial_date(d));
    }
    if let Some(p) = &r.publisher {
        set(&mut o, "recordLabels", vec![json!({"name": p})]);
    }
    if let Some(d) = discs.get(&r.id) {
        set(&mut o, "discTitles", d.clone());
    }
    set(&mut o, "moods", Vec::<String>::new());
    set(&mut o, "explicitStatus", "");
    o
}

pub fn artist(r: &ArtistRow, base: &str) -> Obj {
    let mut o = Obj::new();
    set(&mut o, "id", ids::artist(r.id));
    set(&mut o, "name", r.name.clone());
    set(&mut o, "albumCount", r.albums);
    if r.has_image {
        set(&mut o, "coverArt", ids::artist(r.id));
        set(
            &mut o,
            "artistImageUrl",
            format!("{base}/api/images/person/{}", r.id),
        );
    }
    if let Some(m) = &r.mbid {
        set(&mut o, "musicBrainzId", m.clone());
    }
    if let Some(s) = &r.sort_name {
        set(&mut o, "sortName", s.clone());
    }
    set(&mut o, "roles", vec!["albumartist"]);
    o
}

/// The credits of a set of songs and their albums.
pub async fn credits_of(db: &PgPool, songs: &[SongRow]) -> Result<Credits, SubError> {
    let items: Vec<i32> = songs.iter().map(|s| s.item_id).collect();
    let media: Vec<i32> = songs.iter().map(|s| s.album_id).collect();
    Ok(Credits::load(db, &media, &items).await?)
}

pub async fn song_values(db: &PgPool, rows: &[SongRow]) -> Result<Vec<Value>, SubError> {
    let c = credits_of(db, rows).await?;
    Ok(rows.iter().map(|r| song(r, &c)).collect())
}

pub async fn album_values(db: &PgPool, rows: &[AlbumRow]) -> Result<Vec<Value>, SubError> {
    let media: Vec<i32> = rows.iter().map(|r| r.id).collect();
    let c = Credits::load(db, &media, &[]).await?;
    let discs = disc_titles(db, &media).await?;
    Ok(rows
        .iter()
        .map(|r| Value::Object(album(r, &c, &discs)))
        .collect())
}

/// `(item, media)` of the tracks among `items` that the caller reads and that have a file.
pub async fn visible_tracks(
    db: &PgPool,
    libs: &[i32],
    items: &[i32],
) -> Result<Vec<(i32, i32)>, sqlx::Error> {
    sqlx::query_as(
        r#"SELECT i.id, i."mediaId" FROM items i JOIN editions e ON e.id = i."editionId"
           JOIN media m ON m.id = i."mediaId" AND m.type = 'album'
           WHERE i.id = ANY($1) AND m."libraryId" = ANY($2) AND COALESCE(e."libraryId", m."libraryId") = ANY($2)
             AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = i.id)"#,
    )
    .bind(items)
    .bind(libs)
    .fetch_all(db)
    .await
}

/// The albums among `media` that the caller reads.
pub async fn visible_albums(
    db: &PgPool,
    libs: &[i32],
    media: &[i32],
) -> Result<Vec<i32>, sqlx::Error> {
    let visible = album_visible("$2");
    let sql = format!("SELECT m.id FROM media m WHERE m.id = ANY($1) AND {visible}");
    sqlx::query_scalar(AssertSqlSafe(sql))
        .bind(media)
        .bind(libs)
        .fetch_all(db)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_words_become_escaped_contains_patterns() {
        assert_eq!(search_patterns("  "), None);
        assert_eq!(search_patterns("\"\""), None);
        assert_eq!(
            search_patterns("100% _x* a\\b").unwrap(),
            vec!["%100\\%%", "%\\_x%", "%a\\\\b%"]
        );
    }

    #[test]
    fn dates_and_types_are_shaped_for_the_wire() {
        assert_eq!(
            partial_date("1999-05-02"),
            json!({"year": 1999, "month": 5, "day": 2})
        );
        assert_eq!(partial_date("1999"), json!({"year": 1999}));
        assert_eq!(type_label("live"), "Live");
    }
}
