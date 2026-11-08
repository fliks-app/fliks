//! M3U import and export of track playlists (`docs/spec/playlists.md` rules 55-56).
use super::{
    access::{Role, assert_role},
    smart,
    view::view_for,
};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    libraries::accessible_library_ids,
    state::AppState,
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 5000;
const TOO_LARGE: &str = "errors.playlist_m3u_too_large";

#[derive(Debug, PartialEq)]
struct Entry {
    line: usize,
    text: String,
    artist: Option<String>,
    title: Option<String>,
}

/// The entries of an M3U text: each non-comment line with the `#EXTINF` title that precedes it.
fn parse(content: &str) -> Vec<Entry> {
    let mut out = vec![];
    let mut pending: Option<(Option<String>, String)> = None;
    for (n, raw) in content.trim_start_matches('\u{feff}').lines().enumerate() {
        let l = raw.trim();
        if l.is_empty() {
            continue;
        }
        if let Some(rest) = l.strip_prefix("#EXTINF:") {
            pending = rest.split_once(',').and_then(|(_, t)| {
                let t = t.trim();
                (!t.is_empty()).then(|| match t.split_once(" - ") {
                    Some((a, t)) => (Some(a.trim().to_lowercase()), t.trim().to_lowercase()),
                    None => (None, t.to_lowercase()),
                })
            });
        } else if !l.starts_with('#') {
            let (artist, title) = pending.take().map_or((None, None), |(a, t)| (a, Some(t)));
            out.push(Entry {
                line: n + 1,
                text: l.to_owned(),
                artist,
                title,
            });
        }
    }
    out
}

fn norm_path(p: &str) -> String {
    p.trim_start_matches("file://")
        .replace('\\', "/")
        .to_lowercase()
}

fn base(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

/// Whether one path ends with the other on a segment boundary.
fn suffix_match(line: &str, rel: &str) -> bool {
    let (long, short) = if line.len() >= rel.len() {
        (line, rel)
    } else {
        (rel, line)
    };
    long == short || long.ends_with(&format!("/{short}"))
}

struct Track {
    item: i32,
    path: String,
    title: String,
    artists: Vec<String>,
}

fn find(tracks: &[Track], by_base: &HashMap<&str, Vec<usize>>, e: &Entry) -> Option<i32> {
    let path = norm_path(&e.text);
    let by_path = by_base
        .get(base(&path))
        .into_iter()
        .flatten()
        .map(|&i| &tracks[i])
        .filter(|t| suffix_match(&path, &t.path))
        .max_by_key(|t| t.path.len().min(path.len()));
    if let Some(t) = by_path {
        return Some(t.item);
    }
    let (artist, title) = (e.artist.as_deref()?, e.title.as_deref()?);
    tracks
        .iter()
        .find(|t| t.title == title && t.artists.iter().any(|a| a == artist))
        .map(|t| t.item)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportDto {
    name: String,
    content: String,
}

#[utoipa::path(post, path = "/api/playlists/import-m3u", responses((status = 201)))]
pub async fn import_m3u(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(dto): ValidJson<ImportDto>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    super::routes::check_name(Some(&dto.name))?;
    if dto.content.len() > MAX_BYTES {
        return Err(AppError::bad_request(TOO_LARGE));
    }
    let entries = parse(&dto.content);
    if entries.len() > MAX_ENTRIES {
        return Err(AppError::bad_request(TOO_LARGE));
    }
    let acl = accessible_library_ids(&st.db, &a).await?;
    let rows: Vec<(i32, String, String, Vec<String>)> = sqlx::query_as(
        r#"SELECT i.id, f."relativePath", lower(COALESCE(i.title, '')),
                  COALESCE(array(SELECT lower(p.name) FROM item_credits c JOIN persons p ON p.id = c."personId"
                    WHERE c."itemId" = i.id AND c.role = 'artist'),
                  ARRAY[]::text[]) || array(SELECT lower(p.name) FROM media_credits c JOIN persons p ON p.id = c."personId"
                    WHERE c."mediaId" = m.id AND c.role = 'artist' AND c."editionId" IS NULL)
           FROM items i JOIN media m ON m.id = i."mediaId" AND m.type = 'album'
           JOIN editions e ON e.id = i."editionId" JOIN track_details td ON td."itemId" = i.id
           JOIN LATERAL (SELECT f."relativePath" FROM item_parts p JOIN media_files f ON f.id = p."mediaFileId"
             WHERE p."itemId" = i.id ORDER BY p.version DESC, p.position LIMIT 1) f ON true
           WHERE COALESCE(e."libraryId", m."libraryId") = ANY($1)"#,
    )
    .bind(&acl)
    .fetch_all(&st.db)
    .await?;
    let tracks: Vec<Track> = rows
        .into_iter()
        .map(|(item, path, title, artists)| Track {
            item,
            path: norm_path(&path),
            title,
            artists,
        })
        .collect();
    let mut by_base: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, t) in tracks.iter().enumerate() {
        by_base.entry(base(&t.path)).or_default().push(i);
    }
    let (mut matched, mut unmatched, mut seen) = (vec![], vec![], HashSet::new());
    for e in &entries {
        match find(&tracks, &by_base, e) {
            Some(i) => {
                if seen.insert(i) {
                    matched.push(i);
                }
            }
            None => unmatched.push(json!({"line": e.line, "text": e.text})),
        }
    }
    let mut tx = st.db.begin().await?;
    let id = sqlx::query_scalar!(
        r#"INSERT INTO playlists (name, "ownerId") VALUES ($1, $2) RETURNING id"#,
        dto.name.trim(),
        a.user.id
    )
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query!(
        r#"INSERT INTO playlist_items ("playlistId", "itemId", "addedById", position)
           SELECT $1, t.i, $2, (t.n - 1)::int FROM unnest($3::int[]) WITH ORDINALITY AS t(i, n)"#,
        id,
        a.user.id,
        &matched
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let playlist = view_for(&st.db, &a, id).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"playlist": playlist, "matched": matched.len(), "unmatched": unmatched})),
    ))
}

fn one_line(s: &str) -> String {
    s.split(['\r', '\n']).collect::<Vec<_>>().join(" ")
}

#[utoipa::path(get, path = "/api/playlists/{id}/export.m3u", responses((status = 200)))]
pub async fn export_m3u(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Result<(HeaderMap, String), AppError> {
    let (playlist, _) = assert_role(&st.db, a.user.id, id, Role::Viewer).await?;
    let acl = accessible_library_ids(&st.db, &a).await?;
    let ids: Vec<i32> = match &playlist.rules {
        Some(r) => smart::evaluate(&st.db, playlist.owner_id, &acl, &r.0).await?,
        None => {
            sqlx::query_scalar!(
                r#"SELECT pi."itemId" FROM playlist_items pi JOIN items i ON i.id = pi."itemId"
                   JOIN media m ON m.id = i."mediaId" AND m.type = 'album'
                   WHERE pi."playlistId" = $1 ORDER BY pi.position, pi.id"#,
                id
            )
            .fetch_all(&st.db)
            .await?
        }
    };
    let tracks = crate::media::music::track_rows(&st.db, a.user.id, &acl, &ids).await?;
    let paths: HashMap<i32, String> = sqlx::query_as(
        r#"SELECT i.id, f."relativePath" FROM items i
           JOIN LATERAL (SELECT f."relativePath" FROM item_parts p JOIN media_files f ON f.id = p."mediaFileId"
             WHERE p."itemId" = i.id ORDER BY p.version DESC, p.position LIMIT 1) f ON true
           WHERE i.id = ANY($1)"#,
    )
    .bind(&ids)
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .collect();
    let mut body = String::from("#EXTM3U\n");
    for t in &tracks {
        let Some(path) = t["itemId"].as_i64().and_then(|i| paths.get(&(i as i32))) else {
            continue;
        };
        let artists: Vec<&str> = t["artists"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x["name"].as_str())
            .collect();
        let title = one_line(t["title"].as_str().unwrap_or_default());
        let label = if artists.is_empty() {
            title
        } else {
            format!("{} - {title}", one_line(&artists.join(", ")))
        };
        let secs = t["durationSeconds"]
            .as_f64()
            .map_or(-1, |d| d.round() as i64);
        body.push_str(&format!("#EXTINF:{secs},{label}\n{}\n", one_line(path)));
    }
    let name: String = playlist
        .name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let name = if name.trim().is_empty() {
        "playlist".into()
    } else {
        name
    };
    let mut h = HeaderMap::new();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{name}.m3u8\""))
            .map_err(|_| AppError::bad_request("name"))?,
    );
    Ok((h, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_entries_with_extinf_and_line_numbers() {
        let e = parse("\u{feff}#EXTM3U\n#EXTINF:12,Ana - One\n/m/Ana/a/1.flac\n\n# c\nplain.mp3\n");
        assert_eq!(e.len(), 2);
        assert_eq!(
            (e[0].line, e[0].artist.as_deref(), e[0].title.as_deref()),
            (3, Some("ana"), Some("one"))
        );
        assert_eq!((e[1].line, e[1].title.clone()), (6, None));
    }

    #[test]
    fn suffix_match_is_on_segment_boundaries() {
        assert!(suffix_match("/music/ana/a/1.flac", "ana/a/1.flac"));
        assert!(suffix_match("a/1.flac", "ana/a/1.flac"));
        assert!(!suffix_match("/music/bana/a/1.flac", "ana/a/1.flac"));
    }
}
