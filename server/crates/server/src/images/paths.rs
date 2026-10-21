//! Where artwork lives: one table for the serving routes and the store.
use crate::metadata::MediaKind;
use std::{
    fmt,
    path::{Path, PathBuf},
};

pub fn request_key(id: &str) -> bool {
    id.strip_prefix("movie-")
        .or_else(|| id.strip_prefix("series-"))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// `0` or digits without a leading zero, within the integer range.
pub fn canonical_id(id: &str) -> bool {
    id.parse::<i32>()
        .is_ok_and(|n| n >= 0 && n.to_string() == id)
}

/// Only the variants the server writes.
pub fn media_variant(v: &str) -> bool {
    matches!(v, "poster" | "fanart" | "logo")
        || v.strip_prefix("fanart-")
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// The on-disk file under `root` for a validated request (`images.md` rule 7, `image-store.md` rule 18); `None` is a 404.
pub fn disk_path(
    root: &Path,
    kind: &str,
    id: &str,
    variant: Option<&str>,
    size: &str,
) -> Option<PathBuf> {
    let suffix = if size == "full" {
        ""
    } else {
        &format!("-{size}")
    };
    let dir = |d: &str| root.join(d);
    let flat = |d: &str| canonical_id(id).then(|| dir(d).join(format!("{id}{suffix}.jpg")));
    match kind {
        "media" | "request" => {
            let v = variant.unwrap_or("poster");
            let ok = if kind == "media" {
                canonical_id(id)
            } else {
                request_key(id)
            };
            if !ok || !media_variant(v) {
                return None;
            }
            let ext = if kind == "media" && v == "logo" {
                "png"
            } else {
                "jpg"
            };
            let root = if kind == "media" { "media" } else { "requests" };
            Some(dir(root).join(id).join(format!("{v}{suffix}.{ext}")))
        }
        "person" => flat("persons"),
        "episode" => flat("episodes"),
        "season" => flat("seasons"),
        "user" => flat("users"),
        "livetv" => canonical_id(id).then(|| dir("livetv").join(format!("{id}{suffix}.png"))),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Media,
    Person,
    Episode,
    Season,
    Request,
    User,
    Livetv,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Media => "media",
            Self::Person => "person",
            Self::Episode => "episode",
            Self::Season => "season",
            Self::Request => "request",
            Self::User => "user",
            Self::Livetv => "livetv",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Poster,
    Fanart,
    FanartN(u32),
    Logo,
}

impl fmt::Display for Variant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Poster => f.write_str("poster"),
            Self::Fanart => f.write_str("fanart"),
            Self::FanartN(n) => write!(f, "fanart-{n}"),
            Self::Logo => f.write_str("logo"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Size {
    Thumb,
    Medium,
    Full,
}

impl Size {
    fn name(self) -> &'static str {
        match self {
            Self::Thumb => "thumb",
            Self::Medium => "medium",
            Self::Full => "full",
        }
    }
}

/// What an image is stored for: only constructible from values that pass the serving validators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub kind: Kind,
    id: String,
    pub variant: Option<Variant>,
}

impl Target {
    fn new(kind: Kind, id: impl ToString, variant: Option<Variant>) -> Self {
        Self {
            kind,
            id: id.to_string(),
            variant,
        }
    }

    pub fn media(id: i32, variant: Variant) -> Self {
        Self::new(Kind::Media, id, Some(variant))
    }

    /// Request art is keyed `<movie|series>-<tmdbId>` (`image-store.md` rule 22).
    pub fn request(kind: MediaKind, tmdb_id: i64, variant: Variant) -> Self {
        let k = if kind.is_tv() { "series" } else { "movie" };
        Self::new(Kind::Request, format!("{k}-{tmdb_id}"), Some(variant))
    }

    pub fn person(id: i32) -> Self {
        Self::new(Kind::Person, id, None)
    }

    pub fn episode(id: i32) -> Self {
        Self::new(Kind::Episode, id, None)
    }

    pub fn season(id: i32) -> Self {
        Self::new(Kind::Season, id, None)
    }

    pub fn livetv(id: i32) -> Self {
        Self::new(Kind::Livetv, id, Some(Variant::Logo))
    }

    /// `false` for an id the route rules reject (negative, non-canonical): such a target has no file.
    pub fn is_valid(&self) -> bool {
        let v = self.variant.map(|v| v.to_string());
        disk_path(
            Path::new(""),
            self.kind.name(),
            &self.id,
            v.as_deref(),
            "full",
        )
        .is_some()
    }

    pub fn file(&self, root: &Path, size: Size) -> PathBuf {
        let v = self.variant.map(|v| v.to_string());
        disk_path(root, self.kind.name(), &self.id, v.as_deref(), size.name())
            .expect("a typed target always has a path")
    }

    /// The full file with its extension replaced (`media/1/poster.src.json`).
    pub fn sidecar(&self, root: &Path) -> PathBuf {
        self.file(root, Size::Full).with_extension("src.json")
    }

    pub fn api_path(&self) -> String {
        let v = self.variant.unwrap_or(Variant::Poster);
        match self.kind {
            Kind::Media | Kind::Request => {
                format!("/api/images/{}/{}/{v}", self.kind.name(), self.id)
            }
            Kind::Livetv => format!("/api/livetv/channels/{}/logo", self.id),
            k => format!("/api/images/{}/{}", k.name(), self.id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_negative_id_has_no_target() {
        assert!(!Target::media(-1, Variant::Poster).is_valid());
        assert!(!Target::person(-5).is_valid());
        assert!(!Target::request(MediaKind::Movie, -603, Variant::Poster).is_valid());
        assert!(Target::person(5).is_valid());
    }

    #[test]
    fn ids_and_variants() {
        for ok in ["0", "7", "2147483647"] {
            assert!(canonical_id(ok), "{ok}");
        }
        for bad in [
            "007",
            "0x7",
            "7.0",
            "+7",
            " 7 ",
            "7e0",
            "-5",
            "abc",
            "",
            "2147483648",
        ] {
            assert!(!canonical_id(bad), "{bad}");
        }
        assert!(request_key("movie-603") && request_key("series-1"));
        for bad in [
            "movie-",
            "movie-abc",
            "../x",
            "movie-6\u{663}",
            "movie-603x",
        ] {
            assert!(!request_key(bad), "{bad}");
        }
        for ok in ["poster", "fanart", "fanart-12", "logo"] {
            assert!(media_variant(ok), "{ok}");
        }
        for bad in ["../../persons/5", "fanart-", "fanart-x", ".x", "Poster"] {
            assert!(!media_variant(bad), "{bad}");
        }
    }

    #[test]
    fn path_table() {
        let d = Path::new("/d");
        let p = |k, id, v, s| disk_path(d, k, id, v, s);
        assert_eq!(
            p("media", "1", None, "thumb"),
            Some("/d/media/1/poster-thumb.jpg".into())
        );
        assert_eq!(
            p("media", "1", Some("logo"), "full"),
            Some("/d/media/1/logo.png".into())
        );
        assert_eq!(
            p("request", "movie-603", Some("logo"), "full"),
            Some("/d/requests/movie-603/logo.jpg".into())
        );
        assert_eq!(
            p("person", "5", Some("zzz"), "medium"),
            Some("/d/persons/5-medium.jpg".into())
        );
        assert_eq!(p("user", "2", None, "full"), Some("/d/users/2.jpg".into()));
        assert_eq!(
            p("livetv", "1", None, "thumb"),
            Some("/d/livetv/1-thumb.png".into())
        );
        assert_eq!(p("media", "1", Some("../x"), "full"), None);
        assert_eq!(p("nope", "1", None, "full"), None);
    }

    #[test]
    fn targets_build_paths_and_urls() {
        let d = Path::new("/d");
        let t = Target::media(7, Variant::FanartN(3));
        assert_eq!(
            t.file(d, Size::Medium),
            Path::new("/d/media/7/fanart-3-medium.jpg")
        );
        assert_eq!(t.sidecar(d), Path::new("/d/media/7/fanart-3.src.json"));
        assert_eq!(t.api_path(), "/api/images/media/7/fanart-3");
        let r = Target::request(MediaKind::Movie, 603, Variant::Poster);
        assert_eq!(
            r.sidecar(d),
            Path::new("/d/requests/movie-603/poster.src.json")
        );
        assert_eq!(r.api_path(), "/api/images/request/movie-603/poster");
        assert_eq!(Target::person(5).api_path(), "/api/images/person/5");
        assert_eq!(
            Target::person(5).sidecar(d),
            Path::new("/d/persons/5.src.json")
        );
        assert_eq!(Target::livetv(9).api_path(), "/api/livetv/channels/9/logo");
        assert_eq!(
            Target::livetv(9).file(d, Size::Full),
            Path::new("/d/livetv/9.png")
        );
        assert_eq!(
            Target::media(7, Variant::Logo).file(d, Size::Thumb),
            Path::new("/d/media/7/logo-thumb.png")
        );
    }
}
