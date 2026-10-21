//! `GET /api/fs/browse` (`docs/spec/settings.md` rules 19-25): read-only directory listing for admins.
use crate::{
    http::{AppError, auth::Authed},
    state::AppState,
};
use axum::{Json, Router, extract::Query, routing::get};
use fliks_domain::acl::{Action, Subject};
use serde::{Deserialize, Serialize};
#[cfg(not(windows))]
use std::path::Component;
use std::path::{Path, PathBuf};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/fs/browse", get(browse))
}

#[derive(Deserialize)]
pub(crate) struct Q {
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    path: String,
    is_directory: bool,
}

#[derive(Serialize)]
pub(crate) struct Listing {
    current: String,
    parent: Option<String>,
    entries: Vec<Entry>,
}

#[utoipa::path(get, path = "/api/fs/browse", responses((status = 200)))]
pub(crate) async fn browse(authed: Authed, Query(q): Query<Q>) -> Result<Json<Listing>, AppError> {
    authed.require(Action::Manage, Subject::Settings)?;
    match q.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => list(resolve(p)).await,
        None => roots().await,
    }
}

async fn list(dir: PathBuf) -> Result<Json<Listing>, AppError> {
    let fail = |e: std::io::Error| {
        let shown = dir.display();
        AppError::bad_request(format!(
            "Cannot read \"{shown}\": {}",
            node_message(&e, &shown.to_string())
        ))
    };
    let mut rd = tokio::fs::read_dir(&dir).await.map_err(fail)?;
    let mut entries = Vec::new();
    while let Some(e) = rd.next_entry().await.map_err(fail)? {
        // Dirent semantics: a symlink to a directory is not a directory.
        if e.file_type().await.map_err(fail)?.is_dir() {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path().to_string_lossy().into_owned();
            entries.push(Entry {
                name,
                path,
                is_directory: true,
            });
        }
    }
    // ponytail: case-insensitive, lowercase first; ICU `localeCompare` also folds accents.
    entries.sort_by(|a, b| {
        let fold = |s: &str| s.to_lowercase();
        fold(&a.name)
            .cmp(&fold(&b.name))
            .then_with(|| b.name.cmp(&a.name))
    });
    Ok(Json(Listing {
        current: dir.to_string_lossy().into_owned(),
        parent: parent_of(&dir),
        entries,
    }))
}

#[cfg(not(windows))]
async fn roots() -> Result<Json<Listing>, AppError> {
    list("/".into()).await
}

/// The drive letters that exist; `current` is `""`, the roots view.
#[cfg(windows)]
async fn roots() -> Result<Json<Listing>, AppError> {
    let mut entries = Vec::new();
    for d in 'A'..='Z' {
        let root = format!("{d}:\\");
        if tokio::fs::try_exists(&root).await.unwrap_or(false) {
            entries.push(Entry {
                name: root.clone(),
                path: root,
                is_directory: true,
            });
        }
    }
    Ok(Json(Listing {
        current: String::new(),
        parent: None,
        entries,
    }))
}

/// `path.dirname`, `null` at the top; a Windows drive root goes back to the roots view (`""`).
fn parent_of(dir: &Path) -> Option<String> {
    #[cfg(windows)]
    if matches!(dir.to_string_lossy().as_bytes(), [d, b':'] | [d, b':', b'\\'] if d.is_ascii_alphabetic())
    {
        return Some(String::new());
    }
    dir.parent().map(|p| p.to_string_lossy().into_owned())
}

/// `path.resolve` on POSIX: against the cwd, lexically normalised, no trailing slash.
#[cfg(not(windows))]
fn resolve(p: &str) -> PathBuf {
    let abs = if p.starts_with('/') {
        PathBuf::from(p)
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| "/".into())
            .join(p)
    };
    let mut out = PathBuf::from("/");
    for c in abs.components() {
        match c {
            Component::Normal(n) => out.push(n),
            Component::ParentDir => {
                out.pop();
            }
            _ => {}
        }
    }
    out
}

/// `path.resolve` on Windows: `GetFullPathNameW` normalises; only a root keeps its trailing `\`.
#[cfg(windows)]
fn resolve(p: &str) -> PathBuf {
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.into());
    let trimmed = abs
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_owned();
    if abs.parent().is_some() {
        trimmed.into()
    } else {
        abs
    }
}

/// The 4.x `readdir` error text for the errors an admin can hit; the OS text otherwise.
fn node_message(e: &std::io::Error, path: &str) -> String {
    use std::io::ErrorKind::*;
    let (code, text) = match e.kind() {
        NotFound => ("ENOENT", "no such file or directory"),
        PermissionDenied => ("EACCES", "permission denied"),
        NotADirectory => ("ENOTDIR", "not a directory"),
        _ => return e.to_string(),
    };
    format!("{code}: {text}, scandir '{path}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn resolve_normalises() {
        assert_eq!(resolve("/a//b/./c/../d/"), Path::new("/a/b/d"));
        assert_eq!(resolve("/../.."), Path::new("/"));
        assert!(resolve("x").is_absolute());
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths() {
        assert_eq!(resolve(r"C:\a\.\b\..\c\"), Path::new(r"C:\a\c"));
        assert_eq!(resolve("C:/a/c"), Path::new(r"C:\a\c"));
        assert_eq!(resolve(r"C:\"), Path::new(r"C:\"));
        assert_eq!(parent_of(Path::new(r"C:\")).as_deref(), Some(""));
        assert_eq!(parent_of(Path::new(r"C:\a")).as_deref(), Some(r"C:\"));
    }
}
