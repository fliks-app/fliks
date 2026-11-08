//! The OpenSubsonic API (`docs/spec/opensubsonic.md`): `/rest/<endpoint>` over the `album` kind.
mod annotate;
mod auth;
mod browse;
mod catalog;
mod ids;
mod media;
mod playlists;
mod render;

use crate::{auth::client_ip, http::auth::Authed, state::AppState};
use axum::{
    Router,
    body::Bytes,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, Method, Uri, header::CONTENT_TYPE},
    response::Response,
    routing::any,
};
use render::{Answer, Format, SubError, respond};
use std::net::SocketAddr;

pub fn router() -> Router<AppState> {
    Router::new().route("/rest/{endpoint}", any(rest))
}

/// The request parameters, repeated keys kept in order.
pub struct Params(Vec<(String, String)>);

impl Params {
    fn parse(query: Option<&str>, form: Option<&[u8]>) -> Self {
        let q = query.unwrap_or_default().as_bytes();
        Self(
            url::form_urlencoded::parse(q)
                .chain(url::form_urlencoded::parse(form.unwrap_or_default()))
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect(),
        )
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn all(&self, name: &str) -> Vec<&str> {
        self.0
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .collect()
    }

    pub fn required(&self, name: &str) -> Result<&str, SubError> {
        self.get(name).ok_or_else(|| SubError::missing(name))
    }

    /// A non-negative integer, `default` when absent or unreadable.
    pub fn count(&self, name: &str, default: i64, max: i64) -> i64 {
        self.get(name)
            .and_then(|v| v.trim().parse::<i64>().ok())
            .map_or(default, |n| n.clamp(0, max))
    }

    pub fn int(&self, name: &str) -> Option<i32> {
        self.get(name).and_then(|v| v.trim().parse().ok())
    }
}

/// The caller of an authenticated request.
pub struct Caller {
    pub a: Authed,
    /// The libraries the caller reads (`accessible_library_ids`), before any `musicFolderId`.
    pub libraries: Vec<i32>,
    /// The `subsonic` row that authenticated the call.
    pub token: i32,
    pub base: String,
}

impl Caller {
    pub fn user(&self) -> i32 {
        self.a.user.id
    }

    /// The libraries a call reads: all of the caller's, or only `musicFolderId` when it is one of them.
    pub fn scope(&self, p: &Params) -> Vec<i32> {
        match p.int("musicFolderId") {
            Some(f) if self.libraries.contains(&f) => vec![f],
            Some(_) => vec![],
            None => self.libraries.clone(),
        }
    }
}

async fn base_url(st: &AppState, headers: &HeaderMap) -> String {
    let public: Option<String> =
        sqlx::query_scalar(r#"SELECT value FROM app_settings WHERE key = 'public_url'"#)
            .fetch_optional(&st.db)
            .await
            .ok()
            .flatten()
            .filter(|u: &String| !u.is_empty());
    let header = |n: &str| {
        headers
            .get(n)
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty())
    };
    match (public, header("host")) {
        (Some(u), _) => u.trim_end_matches('/').to_owned(),
        (None, Some(host)) => format!("{}://{host}", header("x-forwarded-proto").unwrap_or("http")),
        (None, None) => format!("http://localhost:{}", st.cfg.port),
    }
}

async fn rest(
    State(st): State<AppState>,
    Path(endpoint): Path<String>,
    method: Method,
    uri: Uri,
    peer: Option<axum::Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let form = (method == Method::POST
        && headers
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.starts_with("application/x-www-form-urlencoded")))
    .then_some(body.as_ref());
    let p = Params::parse(uri.query(), form);
    let format = Format::of(p.get("f"), p.get("callback"));
    let endpoint = endpoint.strip_suffix(".view").unwrap_or(&endpoint);
    if endpoint == "getOpenSubsonicExtensions" {
        return respond(&format, browse::extensions());
    }
    for name in ["c", "v"] {
        if p.get(name).is_none() {
            return respond(&format, Err(SubError::missing(name)));
        }
    }
    let ip = client_ip(
        &headers,
        peer.as_ref().map(|axum::Extension(ConnectInfo(a))| a),
    );
    let answer = match auth::authenticate(&st, ip, &p).await {
        Ok((a, token)) => {
            let libraries = crate::libraries::accessible_library_ids(&st.db, &a).await;
            match libraries {
                Ok(libraries) => {
                    let caller = Caller {
                        a,
                        libraries,
                        token,
                        base: base_url(&st, &headers).await,
                    };
                    match endpoint {
                        "getCoverArt" => return media::cover_art(&st, &caller, &p, &format).await,
                        "stream" | "download" => {
                            let answer =
                                media::redirect(&st, &caller, &p, endpoint == "download").await;
                            return answer.unwrap_or_else(|e| respond(&format, Err(e)));
                        }
                        _ => dispatch(&st, &caller, endpoint, &p).await,
                    }
                }
                Err(e) => Err(e.into()),
            }
        }
        Err(e) => Err(e),
    };
    respond(&format, answer)
}

async fn dispatch(st: &AppState, c: &Caller, endpoint: &str, p: &Params) -> Answer {
    match endpoint {
        "ping" => Ok(Default::default()),
        "getLicense" => browse::license(),
        "tokenInfo" => browse::token_info(c, p),
        "getUser" => browse::user(c, p),
        "getMusicFolders" => browse::music_folders(st, c).await,
        "getIndexes" => browse::indexes(st, c, p, true).await,
        "getArtists" => browse::indexes(st, c, p, false).await,
        "getArtist" => browse::artist(st, c, p).await,
        "getAlbum" => browse::album(st, c, p).await,
        "getSong" => browse::song(st, c, p).await,
        "getMusicDirectory" => browse::directory(st, c, p).await,
        "getGenres" => browse::genres(st, c, p).await,
        "getArtistInfo2" => browse::artist_info(st, c, p).await,
        "getAlbumInfo2" => browse::album_info(st, c, p).await,
        "getAlbumList2" => browse::album_list(st, c, p).await,
        "getRandomSongs" => browse::random_songs(st, c, p).await,
        "getSongsByGenre" => browse::songs_by_genre(st, c, p).await,
        "getStarred2" => browse::starred(st, c, p).await,
        "search3" => browse::search(st, c, p).await,
        "getPlaylists" => playlists::list(st, c).await,
        "getPlaylist" => playlists::get(st, c, p).await,
        "createPlaylist" => playlists::create(st, c, p).await,
        "updatePlaylist" => playlists::update(st, c, p).await,
        "deletePlaylist" => playlists::delete(st, c, p).await,
        "star" => annotate::star(st, c, p, true).await,
        "unstar" => annotate::star(st, c, p, false).await,
        "setRating" => annotate::set_rating(st, c, p).await,
        "scrobble" => annotate::scrobble(st, c, p).await,
        _ => Err(SubError::new(0, "Unknown endpoint")),
    }
}
