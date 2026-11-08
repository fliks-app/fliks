//! System, browsing, lists, search and info endpoints (`opensubsonic.md` rules 17-25).
use super::{
    Caller, Params,
    catalog::{self, AlbumOrder, ArtistRow, Filter, MAX_PAGE, SongOrder},
    ids::{self, Id},
    render::{Answer, Obj, SubError},
};
use crate::state::AppState;
use fliks_domain::music::matcher::normalize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const IGNORED_ARTICLES: &str = "The El La Los Las Le Les";
/// A browse of everything: a library holds far fewer artists or songs of one album than this.
const ALL: i64 = 100_000;

fn one(key: &str, v: impl Into<Value>) -> Answer {
    let mut o = Obj::new();
    o.insert(key.into(), v.into());
    Ok(o)
}

pub fn extensions() -> Answer {
    one(
        "openSubsonicExtensions",
        vec![
            json!({"name": "apiKeyAuthentication", "versions": [1]}),
            json!({"name": "formPost", "versions": [1]}),
            json!({"name": "songLyrics", "versions": [1, 2]}),
        ],
    )
}

pub fn license() -> Answer {
    one("license", json!({"valid": true}))
}

pub fn token_info(c: &Caller, p: &Params) -> Answer {
    if p.get("apiKey").is_none() {
        return Err(SubError::new(44, "Not authenticated with an API key"));
    }
    one("tokenInfo", json!({"username": c.a.user.username}))
}

pub fn user(c: &Caller, p: &Params) -> Answer {
    let name = p.required("username")?;
    if name.to_lowercase() != c.a.user.username.to_lowercase() {
        return Err(SubError::new(
            50,
            "User is not authorized for the given operation",
        ));
    }
    let mut u = json!({
        "username": c.a.user.username, "scrobblingEnabled": true, "adminRole": c.a.user.is_admin,
        "settingsRole": false, "downloadRole": true, "uploadRole": false, "playlistRole": true,
        "coverArtRole": true, "commentRole": false, "podcastRole": false, "streamRole": true,
        "jukeboxRole": false, "shareRole": false, "videoConversionRole": false,
    });
    if let Some(e) = &c.a.user.email {
        u["email"] = e.clone().into();
    }
    one("user", u)
}

pub async fn music_folders(st: &AppState, c: &Caller) -> Answer {
    let rows: Vec<(i32, String)> = sqlx::query_as(
        r#"SELECT id, name FROM libraries WHERE id = ANY($1) AND "mediaTypes" @> '["album"]'::jsonb ORDER BY id"#,
    )
    .bind(&c.libraries)
    .fetch_all(&st.db)
    .await?;
    let folders: Vec<Value> = rows
        .into_iter()
        .map(|(id, name)| json!({"id": id.to_string(), "name": name}))
        .collect();
    one("musicFolders", json!({"musicFolder": folders}))
}

/// The index letter of an artist: the first letter of the sort name, else the name, minus a leading article.
fn index_letter(r: &ArtistRow) -> String {
    let key = normalize(r.sort_name.as_deref().unwrap_or(&r.name));
    let mut words = key.split(' ');
    let first = words.next().unwrap_or("");
    let article = IGNORED_ARTICLES
        .split(' ')
        .any(|a| a.eq_ignore_ascii_case(first));
    let key = if article && key.contains(' ') {
        key[first.len() + 1..].to_owned()
    } else {
        key
    };
    match key.chars().next() {
        Some(ch) if ch.is_alphabetic() => ch.to_uppercase().collect(),
        _ => "#".into(),
    }
}

pub async fn indexes(st: &AppState, c: &Caller, p: &Params, folders: bool) -> Answer {
    let libs = c.scope(p);
    let rows = catalog::artists(&st.db, &libs, &None, None, ALL, 0).await?;
    let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for r in &rows {
        groups
            .entry(index_letter(r))
            .or_default()
            .push(catalog::artist(r, &c.base).into());
    }
    let index: Vec<Value> = groups
        .into_iter()
        .map(|(name, artist)| json!({"name": name, "artist": artist}))
        .collect();
    let last = catalog::last_modified(&st.db, &libs).await?;
    one(
        if folders { "indexes" } else { "artists" },
        json!({"ignoredArticles": IGNORED_ARTICLES, "lastModified": last, "index": index}),
    )
}

fn parse(p: &Params, name: &str) -> Result<Id, SubError> {
    Id::parse(p.required(name)?).ok_or_else(SubError::not_found)
}

async fn artist_row(st: &AppState, c: &Caller, id: i32) -> Result<ArtistRow, SubError> {
    catalog::artists(&st.db, &c.libraries, &None, Some(&[id]), 1, 0)
        .await?
        .pop()
        .ok_or_else(SubError::not_found)
}

async fn albums_of(st: &AppState, c: &Caller, artist: i32) -> Result<Vec<Value>, SubError> {
    let f = Filter {
        artist: Some(artist),
        limit: ALL,
        ..Default::default()
    };
    let rows = catalog::albums(&st.db, c.user(), &c.libraries, &f, AlbumOrder::Year).await?;
    catalog::album_values(&st.db, &rows).await
}

pub async fn artist(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let Id::Artist(id) = parse(p, "id")? else {
        return Err(SubError::not_found());
    };
    let row = artist_row(st, c, id).await?;
    let mut o = catalog::artist(&row, &c.base);
    o.insert("album".into(), albums_of(st, c, id).await?.into());
    one("artist", o)
}

async fn album_row(st: &AppState, c: &Caller, id: i32) -> Result<catalog::AlbumRow, SubError> {
    let f = Filter {
        ids: Some(vec![id]),
        limit: 1,
        ..Default::default()
    };
    catalog::albums(&st.db, c.user(), &c.libraries, &f, AlbumOrder::Name)
        .await?
        .pop()
        .ok_or_else(SubError::not_found)
}

async fn songs_of(st: &AppState, c: &Caller, album: i32) -> Result<Vec<Value>, SubError> {
    let f = Filter {
        album: Some(album),
        limit: ALL,
        ..Default::default()
    };
    let rows = catalog::songs(&st.db, c.user(), &c.libraries, &f, SongOrder::Album).await?;
    catalog::song_values(&st.db, &rows).await
}

pub async fn album(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let Id::Album(id) = parse(p, "id")? else {
        return Err(SubError::not_found());
    };
    let row = album_row(st, c, id).await?;
    let mut o = catalog::album_values(&st.db, std::slice::from_ref(&row))
        .await?
        .remove(0);
    o["song"] = songs_of(st, c, id).await?.into();
    one("album", o)
}

pub async fn song(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let Id::Track(id) = parse(p, "id")? else {
        return Err(SubError::not_found());
    };
    let f = Filter {
        ids: Some(vec![id]),
        limit: 1,
        ..Default::default()
    };
    let rows = catalog::songs(&st.db, c.user(), &c.libraries, &f, SongOrder::Album).await?;
    let mut v = catalog::song_values(&st.db, &rows).await?;
    one("song", v.pop().ok_or_else(SubError::not_found)?)
}

/// An album as an entry of a folder listing.
fn album_as_directory(album: &Value, artist: &str) -> Value {
    let mut o = album.clone();
    o["isDir"] = true.into();
    o["parent"] = artist.into();
    o["title"] = album["name"].clone();
    o["album"] = album["name"].clone();
    o
}

pub async fn directory(st: &AppState, c: &Caller, p: &Params) -> Answer {
    match parse(p, "id")? {
        Id::Artist(id) => {
            let row = artist_row(st, c, id).await?;
            let parent = ids::artist(id);
            let child: Vec<Value> = albums_of(st, c, id)
                .await?
                .iter()
                .map(|a| album_as_directory(a, &parent))
                .collect();
            one(
                "directory",
                json!({"id": parent, "name": row.name, "child": child}),
            )
        }
        Id::Album(id) => {
            let row = album_row(st, c, id).await?;
            let a = catalog::album_values(&st.db, std::slice::from_ref(&row))
                .await?
                .remove(0);
            let mut d = json!({"id": ids::album(id), "name": row.title, "child": songs_of(st, c, id).await?});
            if let Some(ar) = a.get("artistId") {
                d["parent"] = ar.clone();
            }
            one("directory", d)
        }
        _ => Err(SubError::not_found()),
    }
}

pub async fn genres(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let rows = catalog::genres(&st.db, &c.scope(p)).await?;
    let genre: Vec<Value> = rows
        .into_iter()
        .map(|g| json!({"value": g.name, "songCount": g.songs, "albumCount": g.albums}))
        .collect();
    one("genres", json!({"genre": genre}))
}

fn image_urls(o: &mut Value, base: &str, path: &str) {
    for (key, size) in [
        ("smallImageUrl", "thumb"),
        ("mediumImageUrl", "medium"),
        ("largeImageUrl", "full"),
    ] {
        o[key] = format!("{base}{path}?size={size}").into();
    }
}

pub async fn artist_info(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let Id::Artist(id) = parse(p, "id")? else {
        return Err(SubError::not_found());
    };
    let r = artist_row(st, c, id).await?;
    let mut o = json!({});
    if let Some(b) = r.biography.filter(|b| !b.is_empty()) {
        o["biography"] = b.into();
    }
    if let Some(m) = r.mbid {
        o["musicBrainzId"] = m.into();
    }
    if r.has_image {
        image_urls(&mut o, &c.base, &format!("/api/images/person/{id}"));
    }
    one("artistInfo2", o)
}

pub async fn album_info(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let Id::Album(id) = parse(p, "id")? else {
        return Err(SubError::not_found());
    };
    let r = album_row(st, c, id).await?;
    let mut o = json!({});
    if let Some(n) = r.overview.filter(|n| !n.is_empty()) {
        o["notes"] = n.into();
    }
    if let Some(m) = r.mbid {
        o["musicBrainzId"] = m.into();
    }
    if r.has_cover {
        image_urls(&mut o, &c.base, &format!("/api/images/media/{id}/poster"));
    }
    one("albumInfo", o)
}

fn year(p: &Params, name: &str) -> Result<i32, SubError> {
    p.int(name).ok_or_else(|| SubError::missing(name))
}

pub async fn album_list(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let kind = p.required("type")?;
    let mut f = Filter {
        limit: p.count("size", 10, MAX_PAGE),
        offset: p.count("offset", 0, i64::MAX),
        ..Default::default()
    };
    let order = match kind {
        "random" => AlbumOrder::Random,
        "newest" => AlbumOrder::Newest,
        "frequent" => {
            f.played = true;
            AlbumOrder::Frequent
        }
        "recent" => {
            f.played = true;
            AlbumOrder::Recent
        }
        "highest" => {
            f.rated = true;
            AlbumOrder::Highest
        }
        "starred" => {
            f.starred = true;
            AlbumOrder::Starred
        }
        "alphabeticalByName" => AlbumOrder::Name,
        "alphabeticalByArtist" => AlbumOrder::Artist,
        "byYear" => {
            let (from, to) = (year(p, "fromYear")?, year(p, "toYear")?);
            f.from_year = Some(from.min(to));
            f.to_year = Some(from.max(to));
            if from > to {
                AlbumOrder::YearDesc
            } else {
                AlbumOrder::Year
            }
        }
        "byGenre" => {
            f.genre = Some(p.required("genre")?.to_owned());
            AlbumOrder::Name
        }
        other => {
            return Err(SubError::new(
                0,
                format!("Invalid album list type: {other}"),
            ));
        }
    };
    let rows = catalog::albums(&st.db, c.user(), &c.scope(p), &f, order).await?;
    one(
        "albumList2",
        json!({"album": catalog::album_values(&st.db, &rows).await?}),
    )
}

pub async fn random_songs(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let f = Filter {
        genre: p.get("genre").map(str::to_owned),
        from_year: p.int("fromYear"),
        to_year: p.int("toYear"),
        limit: p.count("size", 10, MAX_PAGE),
        ..Default::default()
    };
    let rows = catalog::songs(&st.db, c.user(), &c.scope(p), &f, SongOrder::Random).await?;
    one(
        "randomSongs",
        json!({"song": catalog::song_values(&st.db, &rows).await?}),
    )
}

pub async fn songs_by_genre(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let f = Filter {
        genre: Some(p.required("genre")?.to_owned()),
        limit: p.count("count", 10, MAX_PAGE),
        offset: p.count("offset", 0, i64::MAX),
        ..Default::default()
    };
    let rows = catalog::songs(&st.db, c.user(), &c.scope(p), &f, SongOrder::Title).await?;
    one(
        "songsByGenre",
        json!({"song": catalog::song_values(&st.db, &rows).await?}),
    )
}

pub async fn starred(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let libs = c.scope(p);
    let f = Filter {
        starred: true,
        limit: ALL,
        ..Default::default()
    };
    let albums = catalog::albums(&st.db, c.user(), &libs, &f, AlbumOrder::Starred).await?;
    let songs = catalog::songs(&st.db, c.user(), &libs, &f, SongOrder::Starred).await?;
    one(
        "starred2",
        json!({"album": catalog::album_values(&st.db, &albums).await?, "song": catalog::song_values(&st.db, &songs).await?}),
    )
}

pub async fn search(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let libs = c.scope(p);
    let patterns = catalog::search_patterns(p.get("query").unwrap_or_default());
    let page = |count: &str, offset: &str| Filter {
        patterns: patterns.clone(),
        limit: p.count(count, 20, MAX_PAGE),
        offset: p.count(offset, 0, i64::MAX),
        ..Default::default()
    };
    let a = page("artistCount", "artistOffset");
    let artists = catalog::artists(&st.db, &libs, &a.patterns, None, a.limit, a.offset).await?;
    let albums = catalog::albums(
        &st.db,
        c.user(),
        &libs,
        &page("albumCount", "albumOffset"),
        AlbumOrder::Name,
    )
    .await?;
    // An empty query is a sync of everything, which wants a stable order across pages.
    let order = if patterns.is_none() {
        SongOrder::Album
    } else {
        SongOrder::Title
    };
    let songs = catalog::songs(
        &st.db,
        c.user(),
        &libs,
        &page("songCount", "songOffset"),
        order,
    )
    .await?;
    one(
        "searchResult3",
        json!({
            "artist": artists.iter().map(|r| Value::Object(catalog::artist(r, &c.base))).collect::<Vec<_>>(),
            "album": catalog::album_values(&st.db, &albums).await?,
            "song": catalog::song_values(&st.db, &songs).await?,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artist(name: &str, sort: Option<&str>) -> ArtistRow {
        ArtistRow {
            id: 1,
            name: name.into(),
            sort_name: sort.map(Into::into),
            has_image: false,
            biography: None,
            mbid: None,
            albums: 1,
        }
    }

    #[test]
    fn the_index_letter_skips_articles_and_folds_accents() {
        assert_eq!(index_letter(&artist("The Beatles", None)), "B");
        assert_eq!(
            index_letter(&artist("Beatles, The", Some("Beatles, The"))),
            "B"
        );
        assert_eq!(index_letter(&artist("\u{c9}douard", None)), "E");
        assert_eq!(index_letter(&artist("2Pac", None)), "#");
        assert_eq!(index_letter(&artist("The", None)), "T");
        assert_eq!(index_letter(&artist("", None)), "#");
    }
}
