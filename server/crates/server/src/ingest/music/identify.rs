//! Identification of an album built from files (`docs/spec/music.md`, section Identification): the ids the tags
//! carry first, else a search ranked by the distance of the tags to each release.
use super::{
    stored_tags,
    tags::{Named, TrackTags},
};
use crate::{
    http::AppError,
    media::external_ids::{self, Link},
    metadata::{
        Search,
        music::{Fetched, Written, aliases, fetch, fetch_edition, write_album, write_edition},
        walk,
    },
    settings::setting_value,
    state::AppState,
};
use fliks_domain::{
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::{language::Resolved, limiter::Priority},
    music::{
        matcher::{self, Config, Local, LocalTrack, Remote, RemoteTrack, Scored, Verdict},
        provider::{self, Album, Edition},
    },
};
use serde_json::Value;

const NS: Namespace = Namespace::MUSICBRAINZ;
/// Search hits worth a release lookup, and the releases of a hit worth fetching with their tracks.
const HITS: usize = 3;
const RELEASES: usize = 3;
/// A search hit whose album and artist are further than this from the tags is not looked at.
const HIT_LIMIT: f64 = 0.5;

/// A release the files may be, as a review offers it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub group: String,
    pub release: String,
    pub title: String,
    pub artists: Vec<String>,
    pub year: Option<i32>,
    /// 0 to 1.
    pub similarity: f64,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Applied,
    Review(Vec<Candidate>),
    Nothing,
}

/// A float setting, `default` when unset or unreadable.
async fn number(st: &AppState, key: &str, default: f64) -> f64 {
    setting_value(&st.db, key)
        .await
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

async fn list(st: &AppState, key: &str) -> Vec<String> {
    setting_value(&st.db, key)
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

/// The thresholds and the pressing preferences of the settings `music.match.auto` and `music.match.review`
/// (percent, 90 and 80), `music.pressing.countries` and `music.pressing.media` (JSON arrays).
pub async fn config(st: &AppState) -> Config {
    Config::from_percent(
        number(st, "music.match.auto", 90.0).await,
        number(st, "music.match.review", 80.0).await,
        list(st, "music.pressing.countries").await,
        list(st, "music.pressing.media").await,
    )
}

fn common<T: Clone + Eq + std::hash::Hash>(items: impl Iterator<Item = T>) -> Option<T> {
    super::most_common(items)
}

/// What the files of the album say.
fn local_of(title: &str, tags: &[TrackTags]) -> Local {
    Local {
        album: common(tags.iter().filter_map(|t| t.album.clone()))
            .unwrap_or_else(|| title.to_owned()),
        artist: common(
            tags.iter()
                .map(TrackTags::artist_line)
                .filter(|a| !a.is_empty()),
        )
        .unwrap_or_default(),
        year: common(tags.iter().filter_map(|t| t.year)),
        media: common(
            tags.iter()
                .filter_map(|t| t.media.as_deref().map(|m| provider::medium(m).to_owned())),
        ),
        label: common(tags.iter().filter_map(|t| t.label.clone())),
        catalog: common(tags.iter().filter_map(|t| t.catalog.clone())),
        discs: tags.iter().filter_map(|t| t.disc_total.or(t.disc)).max(),
        tracks: tags
            .iter()
            .map(|t| LocalTrack {
                title: t.title.clone().unwrap_or_default(),
                artist: t
                    .artists
                    .iter()
                    .map(|n: &Named| n.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
                disc: Some(t.disc_number()),
                number: t.track,
                duration_ms: t.duration_ms,
                recording: t.recording.clone(),
            })
            .collect(),
    }
}

fn remote_of(album: &Album, ed: &Edition) -> Remote {
    let artists = if ed.artists.is_empty() {
        &album.artists
    } else {
        &ed.artists
    };
    Remote {
        album: ed.release.title.clone(),
        artist: artists
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        year: ed
            .release
            .release_date
            .map(|d| chrono::Datelike::year(&d))
            .or(album.year),
        country: ed.release.country.clone(),
        media: ed.release.media.map(str::to_owned),
        label: ed.release.label.clone(),
        catalog: ed.release.catalog_number.clone(),
        discs: ed.release.disc_count,
        tracks: ed
            .tracks
            .iter()
            .map(|t| RemoteTrack {
                title: t.title.clone(),
                artist: t
                    .credits
                    .iter()
                    .filter(|c| c.role == "artist")
                    .map(|c| c.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
                disc: Some(t.disc_number),
                number: t.number,
                duration_ms: t.duration_ms,
                recording: t.recording_id.clone(),
            })
            .collect(),
    }
}

/// The release the files are best, among the releases of one group: the one the tags name, else the closest
/// to the files in track count and pressing preferences, fetched with their tracks.
async fn best_release(
    st: &AppState,
    f: &Fetched,
    local: &Local,
    wanted: Option<&str>,
    cfg: &Config,
    lang: &Resolved,
    prio: Priority,
) -> Option<(Edition, Scored)> {
    let n = i32::try_from(local.tracks.len()).unwrap_or(i32::MAX);
    let rank = |list: &[String], v: Option<&str>| {
        v.and_then(|v| list.iter().position(|p| p.eq_ignore_ascii_case(v)))
            .unwrap_or(list.len())
    };
    let mut releases = f.releases.clone();
    releases.sort_by_key(|r| {
        (
            r.track_count.map_or(i32::MAX, |c| (c - n).abs()),
            rank(&cfg.countries, r.country.as_deref()),
            rank(&cfg.media, r.media),
            r.release_date,
        )
    });
    let mut ids: Vec<String> = wanted.map(str::to_owned).into_iter().collect();
    if ids.is_empty() {
        ids = releases
            .iter()
            .take(RELEASES)
            .map(|r| r.external_id.clone())
            .collect();
    }
    let mut best: Option<(Edition, Scored)> = None;
    for id in ids {
        let ed = match fetch_edition(st, NS, &id, lang, prio).await {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("release {id} skipped: {}", e.text());
                continue;
            }
        };
        let scored = matcher::score(local, &remote_of(&f.album, &ed), cfg);
        if best
            .as_ref()
            .is_none_or(|(_, b)| scored.distance < b.distance)
        {
            best = Some((ed, scored));
        }
    }
    best
}

/// The release groups a search offers for the files, closest first.
async fn search_groups(
    st: &AppState,
    local: &Local,
    artist_id: Option<&str>,
    prio: Priority,
) -> Result<Vec<String>, AppError> {
    let query = format!("{} {}", local.artist, local.album)
        .trim()
        .to_owned();
    let search = Search {
        kind: MediaKind::Album,
        query: &query,
        year: local.year.map(i64::from),
        title: Some(&local.album),
        author: Some(local.artist.as_str()).filter(|a| !a.is_empty()),
        author_id: artist_id,
        isbn: None,
        language: None,
        page: 1,
    };
    let hits = walk(st, [NS].into_iter(), &search, prio).await?;
    let mut ranked: Vec<(f64, String)> = hits
        .iter()
        .filter_map(|h| {
            let id = h["externalId"].as_str()?.to_owned();
            let artists = h["artists"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let year = h["year"].as_i64().and_then(|y| i32::try_from(y).ok());
            let d = matcher::album_distance(
                &local.album,
                &local.artist,
                local.year,
                (h["title"].as_str().unwrap_or_default(), &artists, year),
            );
            (d <= HIT_LIMIT).then_some((d, id))
        })
        .collect();
    ranked.sort_by(|a, b| a.0.total_cmp(&b.0));
    Ok(ranked.into_iter().take(HITS).map(|(_, id)| id).collect())
}

struct Found {
    fetched: Fetched,
    edition: Edition,
    scored: Scored,
}

async fn language(st: &AppState, media: i32) -> Result<Resolved, AppError> {
    let library: Option<i32> = sqlx::query_scalar(r#"SELECT "libraryId" FROM media WHERE id = $1"#)
        .bind(media)
        .fetch_optional(&st.db)
        .await?
        .flatten();
    Ok(match library {
        Some(l) => crate::metadata::library_language(st, l).await?,
        None => st.metadata.lang.resolve(None).await?,
    })
}

/// Links `media` to the release group and writes it with the release the files were matched to. A group
/// another album already holds (its id or an alias of it) absorbs this album instead.
async fn apply(
    st: &AppState,
    media: i32,
    found: Found,
    lang: &Resolved,
    prio: Priority,
) -> Result<(), AppError> {
    let group = found.fetched.album.external_id.clone();
    if let Some(other) = aliases::album_of(&st.db, &group).await?
        && other != media
    {
        aliases::absorb_into(st, media, other).await?;
        st.ingest.settle.schedule(st, other);
        return Ok(());
    }
    let linked = {
        let mut c = st.db.acquire().await?;
        external_ids::link(
            &mut c,
            &st.namespaces(),
            media,
            MediaKind::Album,
            NS,
            &group,
        )
        .await?
    };
    if linked != Link::Linked {
        return Ok(());
    }
    if write_album(st, media, NS, &found.fetched, &group, lang, prio).await? != Written::Done {
        return Ok(());
    }
    let release = &found.edition.release.external_id;
    let edition: Option<i32> = sqlx::query_scalar(
        r#"SELECT e.id FROM editions e WHERE e."mediaId" = $1 AND e.family = 'audio'
           ORDER BY EXISTS (SELECT 1 FROM edition_external_ids x WHERE x."editionId" = e.id
                             AND x.provider = 'musicbrainz' AND x.value = $2) DESC,
                    (SELECT count(*) FROM items i WHERE i."editionId" = e.id) DESC, e.id LIMIT 1"#,
    )
    .bind(media)
    .bind(release)
    .fetch_optional(&st.db)
    .await?;
    if let Some(edition) = edition {
        write_edition(st, media, edition, &found.edition, false).await?;
    }
    Ok(())
}

/// The release groups the ids of the tags name, the group's own id first; a release id alone is resolved by
/// the provider's search.
async fn tagged_group(
    st: &AppState,
    tags: &[TrackTags],
    prio: Priority,
    local: &Local,
) -> Result<Option<String>, AppError> {
    if let Some(g) = common(tags.iter().filter_map(|t| t.release_group.clone())) {
        return Ok(Some(g));
    }
    let Some(r) = common(tags.iter().filter_map(|t| t.release.clone())) else {
        return Ok(None);
    };
    let search = Search::text(MediaKind::Album, &r, local.year.map(i64::from));
    let hits = walk(st, [NS].into_iter(), &search, prio).await?;
    Ok(hits
        .first()
        .and_then(|h| h["externalId"].as_str().map(str::to_owned)))
}

/// Identifies an album that holds no id (`identify_media` of the settle), or reads the files of one again
/// for review. The ids of the tags decide alone; otherwise the best release applies when it passes the
/// automatic threshold.
pub async fn identify_media(st: &AppState, media: i32) -> Result<Outcome, AppError> {
    let held: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM media_external_ids WHERE "mediaId" = $1 AND provider = 'musicbrainz')"#,
    )
    .bind(media)
    .fetch_one(&st.db)
    .await?;
    if held || !st.metadata.available(NS) {
        return Ok(Outcome::Nothing);
    }
    identify(st, media, None, Priority::Background, true).await
}

/// The releases the files may be, closest first, for a review: nothing is applied.
pub async fn candidates(st: &AppState, media: i32) -> Result<Vec<Candidate>, AppError> {
    match identify(st, media, None, Priority::Interactive, false).await? {
        Outcome::Review(list) => Ok(list),
        _ => Ok(vec![]),
    }
}

/// `group` given: the album is that release group, whatever the distance (a manual pick).
pub async fn identify(
    st: &AppState,
    media: i32,
    group: Option<&str>,
    prio: Priority,
    apply_best: bool,
) -> Result<Outcome, AppError> {
    let title: Option<String> = sqlx::query_scalar("SELECT title FROM media WHERE id = $1")
        .bind(media)
        .fetch_optional(&st.db)
        .await?;
    let Some(title) = title else {
        return Ok(Outcome::Nothing);
    };
    let all = stored_tags(st, media).await?;
    let tags: Vec<TrackTags> = all.into_iter().map(|(_, _, t)| t).collect();
    if tags.is_empty() {
        return Ok(Outcome::Nothing);
    }
    let cfg = config(st).await;
    let local = local_of(&title, &tags);
    let lang = language(st, media).await?;
    let release = common(tags.iter().filter_map(|t| t.release.clone()));
    let decided = match group {
        Some(g) => Some(g.to_owned()),
        None => tagged_group(st, &tags, prio, &local).await?,
    };
    if let Some(g) = decided.filter(|_| apply_best) {
        let fetched = fetch(st, NS, &g, &lang, prio).await?;
        let Some((edition, scored)) =
            best_release(st, &fetched, &local, release.as_deref(), &cfg, &lang, prio).await
        else {
            return Ok(Outcome::Nothing);
        };
        apply(
            st,
            media,
            Found {
                fetched,
                edition,
                scored,
            },
            &lang,
            prio,
        )
        .await?;
        return Ok(Outcome::Applied);
    }
    let artist_id = tags
        .iter()
        .find_map(|t| t.album_artists.first().and_then(|n| n.mbid.clone()));
    let mut best: Option<Found> = None;
    let mut review = vec![];
    for g in search_groups(st, &local, artist_id.as_deref(), prio).await? {
        let fetched = match fetch(st, NS, &g, &lang, prio).await {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!("release group {g} skipped: {}", e.text());
                continue;
            }
        };
        let Some((edition, scored)) =
            best_release(st, &fetched, &local, None, &cfg, &lang, prio).await
        else {
            continue;
        };
        if scored.verdict(&cfg) != Verdict::Reject {
            review.push(Candidate {
                group: g.clone(),
                release: edition.release.external_id.clone(),
                title: edition.release.title.clone(),
                artists: fetched
                    .album
                    .artists
                    .iter()
                    .map(|c| c.name.clone())
                    .collect(),
                year: fetched.album.year,
                similarity: scored.similarity(),
            });
        }
        if best
            .as_ref()
            .is_none_or(|b| scored.distance < b.scored.distance)
        {
            best = Some(Found {
                fetched,
                edition,
                scored,
            });
        }
    }
    review.sort_by(|a, b| b.similarity.total_cmp(&a.similarity));
    match best {
        Some(b) if apply_best && b.scored.verdict(&cfg) == Verdict::Auto => {
            apply(st, media, b, &lang, prio).await?;
            Ok(Outcome::Applied)
        }
        _ if !review.is_empty() => Ok(Outcome::Review(review)),
        _ => Ok(Outcome::Nothing),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tags(album: &str, artist: &str, n: i32) -> TrackTags {
        TrackTags {
            album: Some(album.into()),
            title: Some(format!("t{n}")),
            track: Some(n),
            artists: vec![Named {
                name: artist.into(),
                mbid: None,
            }],
            year: Some(1999),
            ..Default::default()
        }
    }

    #[test]
    fn the_local_album_is_what_most_files_say() {
        let l = local_of(
            "Folder",
            &[
                tags("Alpha", "Ana", 1),
                tags("Alpha", "Ana", 2),
                tags("Other", "Zed", 3),
            ],
        );
        assert_eq!(
            (l.album.as_str(), l.artist.as_str(), l.year),
            ("Alpha", "Ana", Some(1999))
        );
        assert_eq!(l.tracks.len(), 3);
        assert_eq!(local_of("Folder", &[TrackTags::default()]).album, "Folder");
    }

    #[test]
    fn a_release_is_scored_against_the_files() {
        let album = provider::album(
            &json!({"externalId": "5b11f4ce-a62d-471e-81fc-a69a8278c7da", "title": "Alpha",
            "artists": [{"name": "Ana"}]}),
        )
        .unwrap();
        let ed = provider::edition(&json!({"externalId": "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d", "title": "Alpha",
            "releaseDate": "1999-05-01", "tracks": [{"title": "t1", "number": 1}, {"title": "t2", "number": 2}]}))
        .unwrap();
        let local = local_of("x", &[tags("Alpha", "Ana", 1), tags("Alpha", "Ana", 2)]);
        let s = matcher::score(&local, &remote_of(&album, &ed), &Config::default());
        assert_eq!(
            s.verdict(&Config::default()),
            Verdict::Auto,
            "{}",
            s.distance
        );
    }
}
