//! `GET /api/fs/browse` (`docs/spec/settings.md` rules 19-25): read-only directory listing for admins.
use crate::{
    http::{AppError, auth::Authed},
    state::AppState,
};
use axum::{Json, Router, extract::Query, routing::get};
use fliks_domain::acl::{Action, Subject};
use serde::{Deserialize, Serialize};
use std::path::{Component, PathBuf};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/fs/browse", get(browse))
}

#[derive(Deserialize)]
struct Q {
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
struct Listing {
    current: String,
    parent: Option<String>,
    entries: Vec<Entry>,
}

async fn browse(authed: Authed, Query(q): Query<Q>) -> Result<Json<Listing>, AppError> {
    authed.require(Action::Manage, Subject::Settings)?;
    let raw = q.path.as_deref().map(str::trim).filter(|p| !p.is_empty());
    let dir = resolve(raw.unwrap_or("/"));
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
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(Listing {
        current: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
    }))
}

/// `path.resolve` on POSIX: against the cwd, lexically normalised, no trailing slash.
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

/// Node's `readdir` error text for the errors an admin can hit; the OS text otherwise.
fn node_message(e: &std::io::Error, path: &str) -> String {
    let (code, text) = match e.raw_os_error() {
        Some(2) => ("ENOENT", "no such file or directory"),
        Some(13) => ("EACCES", "permission denied"),
        Some(20) => ("ENOTDIR", "not a directory"),
        _ => return e.to_string(),
    };
    format!("{code}: {text}, scandir '{path}'")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn resolve_normalises() {
        assert_eq!(resolve("/a//b/./c/../d/"), Path::new("/a/b/d"));
        assert_eq!(resolve("/../.."), Path::new("/"));
        assert!(resolve("x").is_absolute());
    }
}
